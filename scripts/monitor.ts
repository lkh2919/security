/**
 * Policy Monitor, folder mode (design M5, Phase A1). Checks the policy files of a folder against the rule packs in force (Mode A)
 * and, with `--diff`, reports which sections an amendment affects (Mode B).
 *
 *   bun scripts/monitor.ts --watch ./watch [--llm api|claude-code] [--diff old.xml,new.xml --law PIPA [--effective 2026-12-01]] [--tenant default] [--out runs/<tenant>/monitor] [--force]
 *
 * Reads .md, .html and .htm files (.docx and .pdf are reported as "manual review required"). Writes
 * `<out>/<stamp>/<policyId>.md|json`, `summary.md` (with a cost line) and `usage.jsonl`; the default `<out>` is `runs/<tenant>/monitor` (tenant "default"); `<out>/registry.json` remembers the SHA-256 of every policy, and an unchanged
 * policy skips Mode A unless `--force`. Backend: ANTHROPIC_API_KEY (API) or `--llm claude-code`; with neither, only the deterministic
 * part runs and the reports say so. Policies and reports stay under gitignored `watch/` and `runs/`. Every output is a reference
 * ("참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다."): unverified amendment findings are provisional and capped at Medium.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tenantPaths } from "../packages/core/src/config";
import { createBackendClient, resolveBackend } from "../packages/core/src/llm/factory";
import { listPolicyFiles, runMonitorFolder } from "../packages/core/src/stages/monitor";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = join(import.meta.dir, "..");
const tenant = tenantPaths(join(root, "runs"), opt("tenant"));
const watchDir = resolve(opt("watch") ?? "./watch");
const outRoot = resolve(opt("out") ?? tenant.monitorDir);
const registryPath = opt("registry") ? resolve(opt("registry")!) : join(outRoot, "registry.json");
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
if (listPolicyFiles(watchDir).length === 0) {
  console.log(`no policy files (.md, .html, .htm) in ${watchDir}`);
  process.exit(0);
}

const backend = resolveBackend(opt("llm"));
const backendClient = backend ? createBackendClient(backend) : null;
const backendNote = backendClient ? `model backend: ${backend}` : "no model backend: deterministic checks only (set ANTHROPIC_API_KEY or pass --llm claude-code for the LLM judge)";
console.log(backendNote);

const [oldPath, newPath] = diffArg ? (diffArg.split(",") as [string, string]) : ["", ""];
const result = await runMonitorFolder({
  root,
  watchDir,
  outRoot,
  registryPath,
  backendNote,
  force: args.includes("--force"),
  ...(backendClient ? { llm: backendClient.client, usage: backendClient } : {}),
  ...(diffArg ? { diff: { oldPath, newPath, law: law!, effective: opt("effective") ?? null } } : {}),
  log: (l) => console.log(l),
});
if (backendClient) {
  console.log("M1", backendClient.usageLine("M1") ?? "no calls");
  backendClient.close();
}
console.log(`reports: ${result.outDir}`);
