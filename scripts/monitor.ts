/**
 * Policy Monitor, folder mode (design M5, Phase A1). Checks the policy files of a folder against the rule packs in force (Mode A)
 * and, with `--diff`, reports which sections an amendment affects (Mode B).
 *
 *   bun scripts/monitor.ts --watch ./watch [--llm api|claude-code] [--diff old.xml,new.xml --law PIPA [--effective 2026-12-01]] [--out runs/monitor] [--force]
 *
 * Reads .md, .html and .htm files (.docx and .pdf are reported as "manual review required"). Writes
 * `<out>/<stamp>/<policyId>.md|json` and `summary.md`; `<out>/registry.json` remembers the SHA-256 of every policy, and an unchanged
 * policy skips Mode A unless `--force`. Backend: ANTHROPIC_API_KEY (API) or `--llm claude-code`; with neither, only the deterministic
 * part runs and the reports say so. Policies and reports stay under gitignored `watch/` and `runs/`. Every output is a reference
 * ("참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다."): unverified amendment findings are provisional and capped at Medium.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createBackendClient, resolveBackend } from "../packages/core/src/llm/factory";
import { krPaths, loadKrKnowledge } from "../packages/core/src/stages/coverage";
import { loadRuleSections } from "../packages/core/src/stages/draft/load-sections";
import { ingestPolicy, loadHeadingPatterns } from "../packages/core/src/stages/ingest";
import { buildReport, checkCurrentPolicy, detectChange, diffArticles, loadRegistry, numberFindings, parseLawXml, recordCheck, renderMonitorJson, renderMonitorMarkdown, renderSummaryMarkdown, runImpact, saveRegistry, type SummaryEntry } from "../packages/core/src/stages/monitor";
import type { IngestedPolicy } from "../packages/core/src/contracts/ingested-policy";
import type { MonitorFinding } from "../packages/core/src/contracts/monitor-report";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = join(import.meta.dir, "..");
const watchDir = resolve(opt("watch") ?? "./watch");
const outRoot = resolve(opt("out") ?? join(root, "runs", "monitor"));
const registryPath = opt("registry") ? resolve(opt("registry")!) : join(outRoot, "registry.json");
const force = args.includes("--force");
const diffArg = opt("diff");
const law = opt("law");
if (diffArg && (!law || diffArg.split(",").length !== 2)) {
  console.error("--diff needs old.xml,new.xml and --law <CODE> (for example --law PIPA)");
  process.exit(2);
}
if (!existsSync(watchDir)) {
  console.error(`watch folder not found: ${watchDir}`);
  process.exit(2);
}

const SUPPORTED = new Set([".md", ".markdown", ".html", ".htm", ".docx", ".pdf"]);
const files = readdirSync(watchDir, { withFileTypes: true })
  .filter((d) => d.isFile() && SUPPORTED.has(extname(d.name).toLowerCase()))
  .map((d) => d.name)
  .sort();
if (files.length === 0) {
  console.log(`no policy files (.md, .html, .htm) in ${watchDir}`);
  process.exit(0);
}

const backend = resolveBackend(opt("llm"));
const backendClient = backend ? createBackendClient(backend) : null;
const llm = backendClient?.client;
const notes: string[] = [llm ? `model backend: ${backend}` : "no model backend: deterministic checks only (set ANTHROPIC_API_KEY or pass --llm claude-code for the LLM judge)"];
console.log(notes[0]);

const kb = loadKrKnowledge(krPaths(root));
const ruleSections = loadRuleSections(join(root, "kb", "jurisdictions", "kr", "rulepacks"), ["privacy-2026.04"]);
const patterns = loadHeadingPatterns(root);
const titles = Object.fromEntries([...ruleSections].map(([id, s]) => [id, s.title.ko]));

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const runId = `monitor-${stamp}`;
const outDir = join(outRoot, stamp);
await mkdir(outDir, { recursive: true });

// --- ingest every file (Mode B needs all policies, even unchanged ones) ------------------------------
const policies: IngestedPolicy[] = [];
const usedIds = new Set<string>();
for (const name of files) {
  const policy = ingestPolicy({ name, content: readFileSync(join(watchDir, name)), path: join(basename(watchDir), name), fetchedAt: now }, patterns);
  // Same stem in two formats (a.md, a.html): keep both, disambiguate by extension.
  const id = usedIds.has(policy.policyId) ? `${policy.policyId}-${extname(name).slice(1).toLowerCase()}` : policy.policyId;
  usedIds.add(id);
  policies.push(id === policy.policyId ? policy : { ...policy, policyId: id });
}

// --- Mode B inputs ----------------------------------------------------------------------------------------
let impact: Awaited<ReturnType<typeof runImpact>> | null = null;
if (diffArg) {
  const [oldPath, newPath] = diffArg.split(",") as [string, string];
  const diff = diffArticles(law!, parseLawXml(readFileSync(resolve(oldPath), "utf8")), parseLawXml(readFileSync(resolve(newPath), "utf8")), { oldVersion: basename(oldPath), newVersion: basename(newPath), effectiveOn: opt("effective") ?? null });
  console.log(`amendment diff ${law}: ${diff.units.length} changed unit(s)`);
  impact = await runImpact({ ...(llm ? { llm } : {}) }, { diff, policies, ruleSections, now });
  await writeFile(join(outDir, `amendment-${law}.json`), `${JSON.stringify({ diff, unmapped: impact.unmapped }, null, 2)}\n`);
}

// --- Mode A + reports -------------------------------------------------------------------------------------
let registry = loadRegistry(registryPath);
const entries: SummaryEntry[] = [];
for (const policy of policies) {
  const change = detectChange(registry, policy.policyId, policy.source.sha256);
  const modeB = impact?.perPolicy.get(policy.policyId) ?? [];
  let findings: MonitorFinding[] = [];
  let llmUsed = false;
  const warnings = [...policy.warnings];
  const skipA = change === "unchanged" && !force && policy.status === "ok";
  if (skipA) {
    console.log(`${policy.policyId}: unchanged since the last check, Mode A skipped`);
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
  console.log(`${policy.policyId}: ${report.summary.total} finding(s) ${JSON.stringify(report.summary.bySeverity)}`);
}

await writeFile(join(outDir, "summary.md"), renderSummaryMarkdown({ stamp, entries, ...(impact ? { unmapped: impact.unmapped } : {}), notes: [...notes, ...(impact?.warnings ?? [])] }));
await saveRegistry(registryPath, registry);
if (backendClient) {
  console.log("M1", backendClient.usageLine("M1") ?? "no calls");
  backendClient.close();
}
console.log(`reports: ${outDir}`);
