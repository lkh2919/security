/**
 * R6 Law Freshness Watcher: compares live law.go.kr / official-page state with the manifest stamps (design R5.6).
 * Drift never blocks drafting; the report carries notes. All source failures -> status "unverified".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LawTargetKind, LawVersion } from "../../adapters/lawapi/client";
import type { PageSnapshot, PageTarget } from "../../adapters/pages/watcher";
import { FreshnessReportSchema, type FreshnessReport } from "../../contracts/freshness-report";
import type { Manifest } from "../../contracts/manifest";
import type { LlmClient } from "../../llm/client";

export interface LawWatchTarget {
  readonly sourceId: string;
  readonly name: string;
  readonly target: LawTargetKind;
  /** Key of `lawCodes` in the rule-pack index (PIPA, DEC, STDG, ...), used to map changes to sections. */
  readonly lawCode?: string;
  /** `manualReview`: changes are reported with `manualReview: true` and never mapped to rule-pack sections (design C6). Default `mapped`. */
  readonly monitorMode?: "mapped" | "manualReview";
}
export interface PageWatchTarget extends PageTarget {
  /** Changed pages map to all rule-pack sections (the guideline is the pack source). */
  readonly affectsAllSections?: boolean;
}
export interface FreshnessTargets {
  readonly laws: readonly LawWatchTarget[];
  readonly pages: readonly PageWatchTarget[];
}

export interface RuleIndex {
  readonly lawCodes: Record<string, string>;
  /** `PIPA:15(1)` -> section IDs. */
  readonly lawIndex: Record<string, string[]>;
  readonly sectionIds: string[];
}

export interface LawApiPort {
  getCurrentVersion(name: string, target: LawTargetKind): Promise<LawVersion | null>;
  listScheduledVersions(lawId: string): Promise<LawVersion[]>;
}
export interface PagePort {
  snapshot(target: PageTarget): Promise<PageSnapshot>;
}

export type ChangeKind =
  | "unstamped"
  | "amendment_promulgated"
  | "effective_date_reached"
  | "upcoming_effective"
  | "guideline_edition_change"
  | "standard_terms_revision"
  | "source_unreachable";

export interface FreshnessChange {
  readonly sourceId: string;
  readonly kind: ChangeKind;
  readonly severity: "info" | "warn" | "error";
  /** Korean + English one-liner. */
  readonly message: string;
  /** Set (true) on changes of a `manualReview` law target: `affectedSections` is then always []. */
  readonly manualReview?: boolean;
  /** Rule-pack sections this change maps to; set on manualReview changes (always []). */
  readonly affectedSections?: readonly string[];
  /** law.go.kr MSTs for fetching the old and new text (Mode B); absent when unknown. */
  readonly oldMst?: string;
  readonly newMst?: string;
  /** Effective date (ISO) of the new version, when known. */
  readonly newEffectiveOn?: string;
}

export interface Observed {
  readonly laws: Record<string, LawVersion>;
  readonly pages: Record<string, PageSnapshot>;
}

export interface FreshnessDeps {
  readonly lawApi: LawApiPort;
  readonly pages: PagePort;
  readonly ruleIndex?: RuleIndex;
  /** Optional R6 (haiku) change summaries. Default off. */
  readonly llm?: LlmClient;
  readonly summarize?: boolean;
  readonly now?: () => Date;
  readonly runId?: string;
  /** Warn when a scheduled version takes effect within this many days (default 60). */
  readonly upcomingDays?: number;
}

export interface FreshnessResult {
  readonly report: FreshnessReport;
  readonly changes: FreshnessChange[];
  readonly observed: Observed;
}

const DAY = 86_400_000;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const daysBetween = (fromIso: string, toIso: string): number => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY);

export function loadRuleIndex(rulepacksDir: string): RuleIndex {
  const empty: RuleIndex = { lawCodes: {}, lawIndex: {}, sectionIds: [] };
  try {
    if (!existsSync(rulepacksDir)) return empty;
    const packs = readdirSync(rulepacksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const merged = { lawCodes: {} as Record<string, string>, lawIndex: {} as Record<string, string[]>, sectionIds: new Set<string>() };
    for (const pack of packs) {
      const file = join(rulepacksDir, pack, "index.json");
      if (!existsSync(file)) continue;
      const j = JSON.parse(readFileSync(file, "utf8")) as { lawCodes?: Record<string, string>; lawIndex?: Record<string, string[]>; sections?: { id?: string }[] };
      Object.assign(merged.lawCodes, j.lawCodes ?? {});
      for (const [k, v] of Object.entries(j.lawIndex ?? {})) merged.lawIndex[k] = [...new Set([...(merged.lawIndex[k] ?? []), ...v])];
      for (const s of j.sections ?? []) if (s.id) merged.sectionIds.add(s.id);
    }
    return { lawCodes: merged.lawCodes, lawIndex: merged.lawIndex, sectionIds: [...merged.sectionIds] };
  } catch {
    return empty;
  }
}

function sectionsForLawCode(idx: RuleIndex | undefined, code: string | undefined): string[] {
  if (!idx || !code) return [];
  const out = new Set<string>();
  for (const [key, secs] of Object.entries(idx.lawIndex)) if (key.startsWith(`${code}:`)) for (const s of secs) out.add(s);
  return [...out];
}

const SummarySchema = z.strictObject({ summary: z.string().max(400) });

interface SourceState {
  sourceId: string;
  kind: "law_api" | "official_page";
  name: string;
  stamped: string;
  observed: string | null;
  outcome: "unchanged" | "changed" | "check_failed";
}

export async function runFreshnessDetailed(manifest: Manifest, targets: FreshnessTargets, deps: FreshnessDeps): Promise<FreshnessResult> {
  const now = (deps.now ?? (() => new Date()))();
  const today = isoDate(now);
  const upcomingDays = deps.upcomingDays ?? 60;
  const states: SourceState[] = [];
  const changes: FreshnessChange[] = [];
  const observed: { laws: Record<string, LawVersion>; pages: Record<string, PageSnapshot> } = { laws: {}, pages: {} };
  const affected = new Map<string, Set<string>>();
  const mark = (sourceId: string, sections: string[]): void => {
    for (const s of sections) {
      if (!/^(S\d{2}|T\d{2}|A1|X1)$/.test(s)) continue;
      if (!affected.has(s)) affected.set(s, new Set());
      affected.get(s)!.add(sourceId);
    }
  };

  for (const t of targets.laws) {
    const stamp = manifest.lawSnapshot.laws.find((l) => l.name === t.name && l.target === t.target);
    const st: SourceState = { sourceId: t.sourceId, kind: "law_api", name: t.name, stamped: stamp?.id ?? "", observed: null, outcome: "unchanged" };
    states.push(st);
    let cur: LawVersion | null;
    try {
      cur = await deps.lawApi.getCurrentVersion(t.name, t.target);
    } catch (err) {
      st.outcome = "check_failed";
      changes.push({ sourceId: t.sourceId, kind: "source_unreachable", severity: "error", message: `${t.name}: 확인 실패 / check failed (${err instanceof Error ? err.message : "error"})` });
      continue;
    }
    if (!cur) {
      st.outcome = "check_failed";
      changes.push({ sourceId: t.sourceId, kind: "source_unreachable", severity: "error", message: `${t.name}: 검색 결과 없음 / not found in law.go.kr` });
      continue;
    }
    observed.laws[t.sourceId] = cur;
    st.observed = cur.mst;
    const manual = t.monitorMode === "manualReview";
    const sections = manual ? [] : sectionsForLawCode(deps.ruleIndex, t.lawCode);
    const flag = (c: FreshnessChange): FreshnessChange => (manual ? { ...c, manualReview: true, affectedSections: [] } : c);
    const oldMst = stamp && stamp.id !== cur.lawId ? stamp.id : undefined;
    const label = `${t.name} (MST ${cur.mst}, 공포 ${cur.promulgatedOn ?? "?"} 제${cur.promulgationNo}호, 시행 ${cur.effectiveOn ?? "?"}, ${cur.revisionType})`;

    if (!stamp) {
      st.outcome = "changed";
      changes.push(flag({ sourceId: t.sourceId, kind: "unstamped", severity: "warn", message: `${t.name}: 매니페스트에 기준값 없음 / no manifest stamp; ${label}`, newMst: cur.mst }));
      mark(t.sourceId, sections);
    } else {
      // Manifest stamps read "011357/MST283839" (law id + MST); older stamps carry one of the two.
      const compound = /^(\d+)\/MST(\d+)$/.exec(stamp.id);
      const stampMst = compound ? compound[2]! : stamp.id;
      const stampLawId = compound ? compound[1]! : stamp.id;
      const sameId = stampMst === cur.mst || (!compound && stamp.id === cur.lawId);
      const idOnlyLaw = !compound && stampLawId === cur.lawId && stampMst !== cur.mst;
      if (!sameId || (idOnlyLaw && stamp.effective !== cur.effectiveOn)) {
        st.outcome = "changed";
        const wasScheduled = cur.promulgatedOn !== null && cur.promulgatedOn <= stamp.effective && cur.effectiveOn !== null && cur.effectiveOn <= today;
        if (wasScheduled) {
          changes.push(flag({ sourceId: t.sourceId, kind: "effective_date_reached", severity: "warn", message: `${t.name}: 시행일 도래 / effective date reached; ${label}`, newMst: cur.mst, ...(cur.effectiveOn ? { newEffectiveOn: cur.effectiveOn } : {}), ...(oldMst ? { oldMst } : {}) }));
        } else {
          changes.push(flag({ sourceId: t.sourceId, kind: "amendment_promulgated", severity: "warn", message: `${t.name}: 새 개정 공포 / new amendment; ${label}`, newMst: cur.mst, ...(cur.effectiveOn ? { newEffectiveOn: cur.effectiveOn } : {}), ...(oldMst ? { oldMst } : {}) }));
        }
        mark(t.sourceId, sections);
      }
    }

    if (t.target === "law" && cur.lawId) {
      try {
        const scheduled = (await deps.lawApi.listScheduledVersions(cur.lawId))
          .filter((v) => v.effectiveOn !== null && v.mst !== stamp?.id && !(stamp && stamp.id.endsWith(`/MST${v.mst}`)))
          .filter((v) => {
            const d = daysBetween(today, v.effectiveOn!);
            return d >= 0 && d <= upcomingDays;
          })
          .sort((a, b) => (a.effectiveOn! < b.effectiveOn! ? -1 : 1));
        const next = scheduled[0];
        if (next) {
          if (st.outcome === "unchanged") {
            st.outcome = "changed";
            st.observed = next.mst;
          }
          changes.push(
            flag({
              sourceId: t.sourceId,
              kind: "upcoming_effective",
              severity: "warn",
              message: `${t.name}: ${daysBetween(today, next.effectiveOn!)}일 내 시행 예정 / takes effect within ${upcomingDays} days: MST ${next.mst}, 제${next.promulgationNo}호, 시행 ${next.effectiveOn}`,
              newMst: next.mst,
              newEffectiveOn: next.effectiveOn!,
              oldMst: oldMst ?? cur.mst,
            }),
          );
          mark(t.sourceId, sections);
        }
      } catch (err) {
        changes.push({ sourceId: t.sourceId, kind: "source_unreachable", severity: "info", message: `${t.name}: 시행예정 조회 실패 / scheduled lookup failed (${err instanceof Error ? err.message : "error"})` });
      }
    }
  }

  for (const t of targets.pages) {
    const stamp = manifest.pages.find((p) => p.url === t.url);
    const st: SourceState = { sourceId: t.sourceId, kind: "official_page", name: t.name, stamped: stamp?.titleHash ?? "", observed: null, outcome: "unchanged" };
    states.push(st);
    const snap = await deps.pages.snapshot(t);
    observed.pages[t.sourceId] = snap;
    if (!snap.ok) {
      st.outcome = "check_failed";
      changes.push({ sourceId: t.sourceId, kind: "source_unreachable", severity: "error", message: `${t.name}: 확인 실패 / ${snap.problem}${snap.detail ? ` (${snap.detail})` : ""}` });
      continue;
    }
    st.observed = snap.titleHash;
    const isFtc = t.kind === "ftc-list" || t.kind === "ftc-view";
    if (!stamp) {
      st.outcome = "changed";
      changes.push({ sourceId: t.sourceId, kind: "unstamped", severity: "warn", message: `${t.name}: 매니페스트에 기준값 없음 / no manifest stamp (edition ${snap.latestEdition ?? "n/a"})` });
    } else if (stamp.titleHash !== snap.titleHash) {
      st.outcome = "changed";
      changes.push({
        sourceId: t.sourceId,
        kind: isFtc ? "standard_terms_revision" : "guideline_edition_change",
        severity: "warn",
        message: isFtc
          ? `${t.name}: 표준약관 변경 감지 / standard terms changed`
          : `${t.name}: 지침 판 변경 감지 / guideline edition changed (latest ${snap.latestEdition ?? "n/a"})`,
      });
    }
    if (st.outcome === "changed" && t.affectsAllSections) mark(t.sourceId, deps.ruleIndex?.sectionIds ?? []);
  }

  const failed = states.filter((s) => s.outcome === "check_failed").length;
  const anyChanged = states.some((s) => s.outcome === "changed");
  const status: FreshnessReport["status"] = states.length > 0 && failed === states.length ? "unverified" : anyChanged ? "drift" : "current";

  const summaries = new Map<string, string>();
  if (deps.llm && deps.summarize) {
    for (const c of changes.filter((x) => x.severity === "warn")) {
      try {
        const res = await deps.llm.callStructured({
          stageId: "R6",
          system: "You summarise one legal-source change for a Korean privacy policy drafter in at most two sentences. Facts only; no legal advice.",
          user: c.message,
          schema: SummarySchema,
          schemaName: "FreshnessChangeSummary",
          promptVersion: "1.0.0",
        });
        summaries.set(c.sourceId, res.data.summary);
      } catch {
        /* summary is optional */
      }
    }
  }

  const iso = now.toISOString();
  const report: FreshnessReport = FreshnessReportSchema.parse({
    runId: deps.runId ?? `fresh-${iso.replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    checkedAt: iso,
    validUntil: new Date(now.getTime() + DAY).toISOString(),
    status,
    sources: states.map((s) => ({
      sourceId: s.sourceId,
      kind: s.kind,
      name: s.name,
      stampedVersion: s.stamped,
      observedVersion: s.observed,
      outcome: s.outcome,
      fallbackUsed: false,
    })),
    affectedSections: [...affected.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([itemId, srcs]) => ({
        itemId,
        sourceIds: [...srcs].sort(),
        summary: [...srcs].map((s) => summaries.get(s)).filter(Boolean).join(" "),
      })),
  });
  return { report, changes, observed };
}

export async function runFreshness(manifest: Manifest, targets: FreshnessTargets, deps: FreshnessDeps): Promise<FreshnessReport> {
  return (await runFreshnessDetailed(manifest, targets, deps)).report;
}

/** Baseline stamp (lawSnapshot + pages) from current observations, for when no real manifest exists yet. */
export function buildBaselineStamp(observed: Observed, now: Date): { lawSnapshot: Manifest["lawSnapshot"]; pages: Manifest["pages"] } {
  const laws = Object.values(observed.laws).map((v) => ({
    name: v.name,
    target: v.target,
    id: v.mst,
    effective: v.effectiveOn ?? isoDate(now),
  }));
  const pages = Object.values(observed.pages)
    .filter((p) => p.ok)
    .map((p) => ({ url: p.target.url, titleHash: p.titleHash, checkedAt: now.toISOString() }));
  return { lawSnapshot: { id: `baseline-${isoDate(now)}`, laws }, pages };
}
