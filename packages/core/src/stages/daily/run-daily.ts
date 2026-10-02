/**
 * Daily chain (design C3): (a) law freshness from the watch-target data, (b) Mode B for changed law targets whose old and new text can
 * be fetched, (c) Mode A on policies whose hash changed, (d) digest.md. Every step is a RunStore stage (`daily-*`), so a failed step is
 * rerun on the next invocation with the same run id and the finished steps are reused, not repeated.
 *
 * Everything external is injected: law.go.kr (`lawApi`, `lawText`), pages, the model client and the policy folder. Without `lawApi`
 * (no LAW_GO_KR_OC) step (a) is skipped with a note; without `lawText` step (b) lists what it could not diff.
 */
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { stampsFromManifest, type Manifest } from "../../contracts/manifest";
import type { IngestedPolicy } from "../../contracts/ingested-policy";
import type { MonitorFinding, MonitorReport } from "../../contracts/monitor-report";
import type { RuleSection } from "../../contracts/rulepack";
import { RunStore } from "../../pipeline/run-store";
import { runResumableStage } from "../../pipeline/run-resumable";
import type { LlmClient } from "../../llm/client";
import { USAGE_FILE, appendUsageJsonl, readUsageJsonl, summarizeUsage, type UsageSource, type UsageSummary } from "../../llm/usage-log";
import type { RulePackItem } from "../coverage/load-kb";
import { loadRuleIndex, runFreshnessDetailed, type LawApiPort, type PagePort } from "../freshness";
import { loadKrManifest, placeholderManifest } from "../freshness/manifest-io";
import { loadWatchTargetsDetailed } from "../freshness/watch-targets";
import type { HeadingPatterns } from "../ingest/segment-policy";
import { diffArticles, parseLawXml } from "../monitor/article-diff";
import { buildReport, numberFindings } from "../monitor/common";
import { checkCurrentPolicy } from "../monitor/current-check";
import { runImpact } from "../monitor/impact";
import { loadLegalRefMap, sourceIdToPrefix } from "../monitor/legalref-map";
import { detectChange, loadRegistry, recordCheck, saveRegistry } from "../monitor/registry";
import { renderDailyDigest } from "./digest";
import { DailyDigestSchema, DailyFreshnessSchema, DailyImpactSchema, DailyPeersSchema, DailyRecheckSchema, type DailyFreshness, type DailyImpact, type DailyPeers, type DailyRecheck } from "./schemas";
import { renderMonitorJson, renderMonitorMarkdown } from "../monitor/report";
import type { AmendmentDiff } from "../../contracts/amendment-diff";
import type { PeerRegistry } from "../../contracts/peers";
import type { PageFetcher } from "../../adapters/fetch/safe-fetch";
import type { FetchStateStore } from "../../adapters/fetch/state";
import type { FinanceLexicon } from "../ingest/finance-lexicon";
import { ingestPolicy } from "../ingest/ingest-policy";
import { attachUrgencySignals } from "../peers/signals";
import type { CaptureEntry } from "../peers/registry";
import { watchPeers } from "../peers/run-peers";

/** Full-text fetch by MST (LawApiClient implements it). */
export interface LawTextPort {
  getFullTextXml(mst: string): Promise<string>;
}

/** Peer Watch inputs of the `daily` chain (design C5). Absent, or `apps.peers` false: the step is skipped with a note. */
export interface DailyPeersDeps {
  readonly registry: PeerRegistry;
  readonly captures: readonly CaptureEntry[];
  readonly fetcher: PageFetcher;
  readonly state: FetchStateStore;
  /** `runs/<tenant>/peers` */
  readonly peersDir: string;
  readonly group?: string;
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly financeLexicon?: FinanceLexicon;
}

export interface DailyDeps {
  /** `kb/jurisdictions/kr` */
  readonly krDir: string;
  readonly tenantId: string;
  /** `<runs>/<tenant>/daily` */
  readonly runsRoot: string;
  /** Default `daily-YYYYMMDD` (UTC): one chain run per day, so a rerun the same day resumes. */
  readonly runId?: string;
  readonly registryPath: string;
  /** Which monitor apps the org enabled; a disabled app's step is skipped. */
  readonly apps: { readonly check: boolean; readonly impact: boolean; readonly peers?: boolean };
  readonly peers?: DailyPeersDeps;
  /** The org's policies, ingested (called by each step that needs them). */
  readonly loadPolicies: () => IngestedPolicy[];
  readonly ruleSections: ReadonlyMap<string, RuleSection>;
  readonly rulePackItems: readonly RulePackItem[];
  readonly rulePackVersion: string;
  readonly patterns: HeadingPatterns;
  readonly titles?: Readonly<Record<string, string>>;
  /** Absent: freshness is skipped with a note (LAW_GO_KR_OC not set). */
  readonly lawApi?: LawApiPort;
  readonly lawText?: LawTextPort;
  readonly pages?: PagePort;
  readonly llm?: LlmClient;
  readonly usage?: UsageSource;
  /** Overrides `kb/.../manifest.json` (tests). */
  readonly manifest?: Manifest;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface DailyResult {
  readonly runId: string;
  readonly dir: string;
  /** Steps in order with whether an earlier invocation's artifact was reused. */
  readonly steps: readonly { readonly stage: string; readonly resumed: boolean }[];
  readonly digestFile: string;
  readonly usage: UsageSummary;
}

const IMPACT_KINDS = new Set(["amendment_promulgated", "effective_date_reached", "upcoming_effective"]);

export async function runDaily(deps: DailyDeps): Promise<DailyResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const day = now().toISOString().slice(0, 10);
  const runId = deps.runId ?? `daily-${day.replace(/-/g, "")}`;
  const manifest = deps.manifest ?? loadKrManifest(deps.krDir) ?? placeholderManifest(now());

  let store: RunStore;
  try {
    store = await RunStore.open(deps.runsRoot, runId, now);
  } catch {
    store = await RunStore.create({
      runsRoot: deps.runsRoot,
      runId,
      input: { kind: "daily", tenantId: deps.tenantId, date: day, apps: deps.apps },
      stamps: stampsFromManifest(manifest, { interviewTemplateVersion: "n/a", slotRegistryVersion: "n/a", prompts: {} }),
      documents: ["privacy"],
      now,
    });
  }

  // usage.jsonl: flush the calls made since the last flush after every step (also after a failed one), so a resumed run appends.
  let flushed = 0;
  const flushUsage = async (): Promise<void> => {
    if (!deps.usage) return;
    const all = deps.usage.usageRecords();
    await appendUsageJsonl(store.path(USAGE_FILE), all.slice(flushed));
    flushed = all.length;
  };
  const steps: { stage: string; resumed: boolean }[] = [];
  const step = async <T>(stage: "daily-freshness" | "daily-impact" | "daily-recheck" | "daily-peers" | "daily-digest", run: () => Promise<{ output: T; resumed: boolean }>): Promise<T> => {
    try {
      const r = await run();
      steps.push({ stage, resumed: r.resumed });
      log(`${stage}: ${r.resumed ? "reused from an earlier invocation" : "done"}`);
      return r.output;
    } finally {
      await flushUsage();
    }
  };

  const targetsInfo = loadWatchTargetsDetailed(deps.krDir);
  const legalRefMap = loadLegalRefMap(deps.krDir);

  // (a) freshness --------------------------------------------------------------------------------------------
  const freshness: DailyFreshness = await step("daily-freshness", () =>
    runResumableStage(store, {
      stage: "daily-freshness",
      schema: DailyFreshnessSchema,
      now,
      compute: async (): Promise<DailyFreshness> => {
        if (!deps.lawApi) return { status: "skipped", note: "LAW_GO_KR_OC가 설정되지 않아 법령 최신성 점검을 건너뜀 / freshness skipped: LAW_GO_KR_OC is not set", changes: [], observedLaws: {} };
        const targets = deps.pages ? targetsInfo.targets : { laws: targetsInfo.targets.laws, pages: [] };
        const pages: PagePort = deps.pages ?? { snapshot: async () => { throw new Error("no page port"); } };
        const r = await runFreshnessDetailed(manifest, targets, { lawApi: deps.lawApi, pages, ruleIndex: loadRuleIndex(join(deps.krDir, "rulepacks")), now, runId: `fresh-${runId}`.slice(0, 64) });
        return {
          status: "ran",
          ...(targetsInfo.warnings.length > 0 ? { note: targetsInfo.warnings.join("; ") } : {}),
          report: r.report,
          changes: r.changes.map(({ affectedSections, ...c }) => ({ ...c, ...(affectedSections ? { affectedSections: [...affectedSections] } : {}) })),
          observedLaws: Object.fromEntries(Object.entries(r.observed.laws).map(([id, v]) => [id, { name: v.name, target: v.target, mst: v.mst, lawId: v.lawId, effectiveOn: v.effectiveOn }])),
        };
      },
    }),
  );

  // (b) Mode B for changed law targets -----------------------------------------------------------------------
  const impact: DailyImpact = await step("daily-impact", () =>
    runResumableStage(store, {
      stage: "daily-impact",
      schema: DailyImpactSchema,
      now,
      compute: async (): Promise<DailyImpact> => {
        if (!deps.apps.impact) return { status: "skipped", diffs: [], notes: ["impact app is not enabled for this org"] };
        const notes: string[] = [];
        const diffs: DailyImpact["diffs"] = [];
        const policies = deps.loadPolicies();
        const seen = new Set<string>();
        for (const c of freshness.changes) {
          if (!IMPACT_KINDS.has(c.kind)) continue;
          const target = targetsInfo.targets.laws.find((t) => t.sourceId === c.sourceId);
          if (!target) continue;
          const label = target.name;
          if (target.target !== "law") {
            notes.push(`${label}: 행정규칙 본문 비교는 아직 지원하지 않음 / admrul text diff is not supported yet`);
            continue;
          }
          if (!c.oldMst || !c.newMst) {
            notes.push(`${label}: 비교할 이전 버전(MST)을 알 수 없어 조문 비교를 건너뜀 / old MST unknown, article diff skipped`);
            continue;
          }
          const lawCode = target.lawCode ?? sourceIdToPrefix(legalRefMap, c.sourceId);
          if (!lawCode) {
            notes.push(`${label}: 법령 약칭(legal-ref prefix)이 없어 조문 비교를 건너뜀 / no legal-ref prefix`);
            continue;
          }
          const key = `${c.sourceId}|${c.oldMst}|${c.newMst}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!deps.lawText) {
            notes.push(`${label}: 법령 본문을 가져올 수 없어 조문 비교를 건너뜀 / no law text port`);
            continue;
          }
          const oldXml = await deps.lawText.getFullTextXml(c.oldMst);
          const newXml = await deps.lawText.getFullTextXml(c.newMst);
          const effectiveOn = c.newEffectiveOn ?? freshness.observedLaws[c.sourceId]?.effectiveOn ?? null;
          const diff = diffArticles(lawCode, parseLawXml(oldXml), parseLawXml(newXml), { oldVersion: c.oldMst, newVersion: c.newMst, effectiveOn });
          if (diff.units.length === 0) {
            notes.push(`${label}: 조문 변경 없음 (MST ${c.oldMst} -> ${c.newMst}) / no article-level change`);
            continue;
          }
          const res = await runImpact({ ...(deps.llm ? { llm: deps.llm } : {}) }, { diff, policies, ruleSections: deps.ruleSections, legalRefMap, now: now() });
          diffs.push({
            sourceId: c.sourceId,
            lawCode,
            oldMst: c.oldMst,
            newMst: c.newMst,
            effectiveOn,
            unitCount: diff.units.length,
            diffHash: diff.hash,
            manualReview: legalRefMap[lawCode]?.monitorMode === "manualReview" || target.monitorMode === "manualReview",
            unmapped: res.unmapped,
            perPolicy: Object.fromEntries(res.perPolicy),
            warnings: [...res.warnings],
            llmUsed: res.llmUsed,
            units: diff.units.map((u) => ({ ...u })),
          });
        }
        return { status: "ran", diffs, notes };
      },
    }),
  );

  // (c) Mode A on changed hashes -----------------------------------------------------------------------------
  const recheck: DailyRecheck = await step("daily-recheck", () =>
    runResumableStage(store, {
      stage: "daily-recheck",
      schema: DailyRecheckSchema,
      now,
      compute: async (): Promise<DailyRecheck> => {
        if (!deps.apps.check) return { status: "skipped", reports: [], skippedUnchanged: [], notes: ["check app is not enabled for this org"] };
        const registry = loadRegistry(deps.registryPath);
        const reports: MonitorReport[] = [];
        const skippedUnchanged: string[] = [];
        for (const policy of deps.loadPolicies()) {
          if (detectChange(registry, policy.policyId, policy.source.sha256) === "unchanged" && policy.status === "ok") {
            skippedUnchanged.push(policy.policyId);
            continue;
          }
          const a = await checkCurrentPolicy({ ...(deps.llm ? { llm: deps.llm } : {}) }, { runId, policy, ruleSections: deps.ruleSections, rulePackItems: deps.rulePackItems, rulePackVersion: deps.rulePackVersion, patterns: deps.patterns, now: now() });
          reports.push(a.report);
        }
        return { status: "ran", reports, skippedUnchanged, notes: [] };
      },
    }),
  );

  // (c2) Peer Watch: peers' public policies, and Mode A re-check of Lotte captures whose page changed ----------------
  const peers: DailyPeers = await step("daily-peers", () =>
    runResumableStage(store, {
      stage: "daily-peers",
      schema: DailyPeersSchema,
      now,
      compute: async (): Promise<DailyPeers> => {
        const empty = { outcomes: [], signals: { peerChanged: [], peerAligned: [], groupAdoption: [] }, lotteReports: [] };
        if (!deps.apps.peers) return { status: "skipped", notes: ["peers app is not enabled for this org"], ...empty };
        const pd = deps.peers;
        if (!pd) return { status: "skipped", notes: ["no peer registry configured (peersFile)"], ...empty };
        const diffs: AmendmentDiff[] = impact.diffs.flatMap((d) =>
          d.units ? [{ law: d.lawCode, oldVersion: d.oldMst, newVersion: d.newMst, effectiveOn: d.effectiveOn, units: d.units, hash: d.diffHash }] : [],
        );
        const lotteReports: MonitorReport[] = [];
        const notes: string[] = [];
        const r = await watchPeers({
          registry: pd.registry,
          captures: pd.captures,
          fetcher: pd.fetcher,
          state: pd.state,
          patterns: deps.patterns,
          peersDir: pd.peersDir,
          tenantId: deps.tenantId,
          ...(pd.group ? { group: pd.group } : {}),
          ...(pd.limit !== undefined ? { limit: pd.limit } : {}),
          ...(pd.dryRun ? { dryRun: true } : {}),
          now,
          amendmentDiffs: diffs,
          ruleSections: deps.ruleSections,
          lawNames: (prefix) => {
            const e = legalRefMap[prefix];
            return e ? [e.lawNameKo, ...e.aliases] : [];
          },
          log,
          // Mode A on a Lotte policy whose published page is new or changed (the same check as a changed hash in the policy folder).
          onLotteChange: async (target, html) => {
            if (!deps.apps.check) {
              notes.push(`${target.id}: 현행 점검(check) 앱이 꺼져 있어 재점검을 건너뜀 / check app disabled, re-check skipped`);
              return;
            }
            const policy = ingestPolicy({ name: `${target.id}.html`, policyId: target.id, content: html, url: target.url, fetchedAt: now() }, deps.patterns, pd.financeLexicon);
            const a = await checkCurrentPolicy({ ...(deps.llm ? { llm: deps.llm } : {}) }, { runId, policy, ruleSections: deps.ruleSections, rulePackItems: deps.rulePackItems, rulePackVersion: deps.rulePackVersion, patterns: deps.patterns, now: now() });
            lotteReports.push(a.report);
          },
        });
        return {
          status: "ran",
          notes,
          ...(r.dryRun ? { dryRun: true } : {}),
          outcomes: r.outcomes.map(({ changedSections, ...o }) => ({ ...o, ...(changedSections ? { changedSections: changedSections.map((c) => ({ ...c })) } : {}) })),
          signals: { peerChanged: r.signals.peerChanged.map((p) => ({ ...p, sectionIds: [...p.sectionIds] })), peerAligned: r.signals.peerAligned.map((p) => ({ ...p, alignments: p.alignments.map((a) => ({ ...a })) })), groupAdoption: r.signals.groupAdoption.map((g) => ({ ...g })) },
          lotteReports,
          ...(r.reportFile ? { reportFile: r.reportFile } : {}),
        };
      },
    }),
  );

  // (d) digest + per-policy reports + registry ---------------------------------------------------------------
  const digest = await step("daily-digest", () =>
    runResumableStage(store, {
      stage: "daily-digest",
      schema: DailyDigestSchema,
      now,
      compute: async () => {
        const policies = deps.loadPolicies();
        const reportsDir = store.path("reports");
        await mkdir(reportsDir, { recursive: true });
        const reportFiles: string[] = [];
        const merged = new Map<string, MonitorReport>();
        let registry = loadRegistry(deps.registryPath);
        const at = now();
        for (const policy of policies) {
          const a = recheck.reports.find((r) => r.policyId === policy.policyId);
          const modeB: MonitorFinding[] = attachUrgencySignals(impact.diffs.flatMap((d) => d.perPolicy[policy.policyId] ?? []), peers.signals.groupAdoption);
          if (!a && modeB.length === 0) {
            registry = recordCheck(registry, policy, at);
            continue;
          }
          const warnings = [...(a?.warnings ?? policy.warnings), ...(a ? [] : ["Mode A skipped: unchanged hash"])];
          const findings = numberFindings("F", [...(a?.findings ?? []), ...modeB]).map((f, i) => ({ ...f, id: `${f.mode}-${String(i + 1).padStart(4, "0")}` }));
          const report = buildReport({ runId, policyId: policy.policyId, policySha: policy.source.sha256, rulePackVersion: deps.rulePackVersion, now: at, findings, llmUsed: (a?.llmUsed ?? false) || impact.diffs.some((d) => d.llmUsed), warnings });
          const md = join("reports", `${policy.policyId}.md`);
          await writeFile(store.path(md), renderMonitorMarkdown(report, { titles: deps.titles ?? {} }));
          await writeFile(store.path("reports", `${policy.policyId}.json`), renderMonitorJson(report));
          reportFiles.push(md);
          merged.set(policy.policyId, report);
          registry = recordCheck(registry, policy, at, { report, file: join(runId, md) });
        }
        // Mode A reports of Lotte captures fetched by the peers step (kept apart from the policy-folder registry).
        for (const report of peers.lotteReports) {
          const md = join("reports", `${report.policyId}.md`);
          await writeFile(store.path(md), renderMonitorMarkdown(report, { titles: deps.titles ?? {} }));
          await writeFile(store.path("reports", `${report.policyId}.json`), renderMonitorJson(report));
          reportFiles.push(md);
          merged.set(report.policyId, report);
        }
        await saveRegistry(deps.registryPath, registry);
        // cost line from everything this run has logged, across resumed invocations
        await flushUsage();
        const usage = summarizeUsage(await readUsageJsonl(store.path(USAGE_FILE)));
        await writeFile(store.path("digest.md"), renderDailyDigest({ runId, tenantId: deps.tenantId, date: day, freshness, impact, recheck, ...(deps.apps.peers ? { peers } : {}), reports: [...merged.values()], usage, ...(targetsInfo.warnings.length > 0 ? { warnings: targetsInfo.warnings } : {}) }));
        return { digestFile: "digest.md", reportFiles, registryUpdated: true };
      },
    }),
  );
  void digest;

  const usage = summarizeUsage(await readUsageJsonl(store.path(USAGE_FILE)));
  return { runId, dir: store.dir, steps, digestFile: store.path("digest.md"), usage };
}
