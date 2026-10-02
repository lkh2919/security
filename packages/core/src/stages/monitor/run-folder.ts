/**
 * Policy Monitor, folder mode as a library call (design M5, C2 "apps are wiring only"): ingest every policy file of a folder, run Mode A
 * on changed files, optionally Mode B for one amendment diff, write `<outRoot>/<stamp>/<policyId>.md|json`, `summary.md` (with the
 * cost line) and `usage.jsonl`, and update the watch registry. `scripts/monitor.ts` and `scripts/agent.ts` are thin wrappers.
 */
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { IngestedPolicy } from "../../contracts/ingested-policy";
import type { MonitorFinding } from "../../contracts/monitor-report";
import type { LlmClient } from "../../llm/client";
import { USAGE_FILE, appendUsageJsonl, summarizeUsage, type UsageSource, type UsageSummary } from "../../llm/usage-log";
import { krPaths, loadKrKnowledge } from "../coverage";
import { loadRuleSections } from "../draft/load-sections";
import { ingestPolicy, loadFinanceLexicon, loadHeadingPatterns } from "../ingest";
import { parseLawXml, diffArticles } from "./article-diff";
import { buildReport, numberFindings } from "./common";
import { checkCurrentPolicy } from "./current-check";
import { runImpact, type ImpactResult } from "./impact";
import { loadLegalRefMap } from "./legalref-map";
import { detectChange, loadRegistry, recordCheck, saveRegistry } from "./registry";
import { renderMonitorJson, renderMonitorMarkdown, renderSummaryMarkdown, type SummaryEntry } from "./report";

export const SUPPORTED_POLICY_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown", ".html", ".htm", ".docx", ".pdf"]);

export function listPolicyFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && SUPPORTED_POLICY_EXTENSIONS.has(extname(d.name).toLowerCase()))
    .map((d) => d.name)
    .sort();
}

/** Ingests the policy files of a folder (finance lexicon applied). Same stem in two formats: both kept, disambiguated by extension. */
export function ingestPolicyFolder(repoRoot: string, dir: string, now: Date): IngestedPolicy[] {
  const patterns = loadHeadingPatterns(repoRoot);
  const lexicon = loadFinanceLexicon(repoRoot);
  const policies: IngestedPolicy[] = [];
  const used = new Set<string>();
  for (const name of listPolicyFiles(dir)) {
    const policy = ingestPolicy({ name, content: readFileSync(join(dir, name)), path: join(basename(dir), name), fetchedAt: now }, patterns, lexicon);
    const id = used.has(policy.policyId) ? `${policy.policyId}-${extname(name).slice(1).toLowerCase()}` : policy.policyId;
    used.add(id);
    policies.push(id === policy.policyId ? policy : { ...policy, policyId: id });
  }
  return policies;
}

export interface MonitorFolderOptions {
  /** Repository root (kb lives under it). */
  readonly root: string;
  readonly watchDir: string;
  /** Tenant-prefixed output root, e.g. `runs/<tenantId>/monitor`. */
  readonly outRoot: string;
  readonly registryPath: string;
  readonly llm?: LlmClient;
  readonly usage?: UsageSource;
  readonly backendNote: string;
  readonly force?: boolean;
  readonly diff?: { readonly oldPath: string; readonly newPath: string; readonly law: string; readonly effective?: string | null };
  /** Rule-pack ids; the first one drives the C2 checks. Default `["privacy-2026.04"]`. */
  readonly rulePacks?: readonly string[];
  readonly now?: Date;
  readonly log?: (line: string) => void;
}

export interface MonitorFolderResult {
  readonly outDir: string;
  readonly stamp: string;
  readonly entries: readonly SummaryEntry[];
  readonly usage: UsageSummary;
  readonly impact: ImpactResult | null;
}

export async function runMonitorFolder(opts: MonitorFolderOptions): Promise<MonitorFolderResult> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  const rulePacks = opts.rulePacks ?? ["privacy-2026.04"];
  const krDir = join(opts.root, "kb", "jurisdictions", "kr");
  const kb = loadKrKnowledge(krPaths(opts.root, rulePacks[0]));
  const ruleSections = loadRuleSections(join(krDir, "rulepacks"), rulePacks);
  const patterns = loadHeadingPatterns(opts.root);
  const legalRefMap = loadLegalRefMap(krDir);
  const titles = Object.fromEntries([...ruleSections].map(([id, s]) => [id, s.title.ko]));
  const llm = opts.llm;
  const notes: string[] = [opts.backendNote];

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const runId = `monitor-${stamp}`;
  const outDir = join(opts.outRoot, stamp);
  await mkdir(outDir, { recursive: true });

  const policies = ingestPolicyFolder(opts.root, opts.watchDir, now);

  let impact: ImpactResult | null = null;
  if (opts.diff) {
    const { oldPath, newPath, law } = opts.diff;
    const diff = diffArticles(law, parseLawXml(readFileSync(resolve(oldPath), "utf8")), parseLawXml(readFileSync(resolve(newPath), "utf8")), { oldVersion: basename(oldPath), newVersion: basename(newPath), effectiveOn: opts.diff.effective ?? null });
    log(`amendment diff ${law}: ${diff.units.length} changed unit(s)`);
    impact = await runImpact({ ...(llm ? { llm } : {}) }, { diff, policies, ruleSections, legalRefMap, now });
    await writeFile(join(outDir, `amendment-${law}.json`), `${JSON.stringify({ diff, unmapped: impact.unmapped }, null, 2)}\n`);
  }

  let registry = loadRegistry(opts.registryPath);
  const entries: SummaryEntry[] = [];
  for (const policy of policies) {
    const change = detectChange(registry, policy.policyId, policy.source.sha256);
    const modeB = impact?.perPolicy.get(policy.policyId) ?? [];
    let findings: MonitorFinding[] = [];
    let llmUsed = false;
    const warnings = [...policy.warnings];
    const skipA = change === "unchanged" && !opts.force && policy.status === "ok";
    if (skipA) {
      log(`${policy.policyId}: unchanged since the last check, Mode A skipped`);
      if (modeB.length === 0) {
        registry = recordCheck(registry, policy, now);
        entries.push({ policyId: policy.policyId, status: "skipped_unchanged" });
        continue;
      }
    } else {
      const a = await checkCurrentPolicy({ ...(llm ? { llm } : {}) }, { runId, policy, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now });
      findings = [...a.report.findings];
      llmUsed = a.report.llmUsed;
      warnings.splice(0, warnings.length, ...a.report.warnings);
    }
    findings = [...findings, ...modeB];
    if (impact?.llmUsed) llmUsed = true;
    const report = buildReport({ runId, policyId: policy.policyId, policySha: policy.source.sha256, rulePackVersion: kb.rulePackVersion, now, findings: numberFindings("F", findings).map((f, i) => ({ ...f, id: `${f.mode}-${String(i + 1).padStart(4, "0")}` })), llmUsed, warnings: [...warnings, ...(skipA ? ["Mode A skipped: unchanged hash"] : [])] });
    const file = join(outDir, `${policy.policyId}.md`);
    await writeFile(file, renderMonitorMarkdown(report, { titles }));
    await writeFile(join(outDir, `${policy.policyId}.json`), renderMonitorJson(report));
    registry = recordCheck(registry, policy, now, { report, file: join(stamp, `${policy.policyId}.md`) });
    entries.push({ policyId: policy.policyId, status: policy.status === "ok" ? "checked" : "manual_review", report });
    log(`${policy.policyId}: ${report.summary.total} finding(s) ${JSON.stringify(report.summary.bySeverity)}`);
  }

  const records = opts.usage?.usageRecords() ?? [];
  await appendUsageJsonl(join(outDir, USAGE_FILE), records);
  const usage = summarizeUsage(records);
  await writeFile(join(outDir, "summary.md"), renderSummaryMarkdown({ stamp, entries, usage, ...(impact ? { unmapped: impact.unmapped } : {}), notes: [...notes, ...(impact?.warnings ?? [])] }));
  await saveRegistry(opts.registryPath, registry);
  return { outDir, stamp, entries, usage, impact };
}

