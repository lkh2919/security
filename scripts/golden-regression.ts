/**
 * Golden-set regression gate (design R11.2) against the REAL API. Skipped (exit 0) without ANTHROPIC_API_KEY.
 *
 *   bun scripts/golden-regression.ts [--source expected|extract] [--runs 3] [--cases G1,G2b] [--no-defects]
 *
 * Spends real tokens: per case one draft per LLM section plus one audit per iteration, per run; plus one audit per
 * seeded defect. Start with `--cases G1 --runs 1 --no-defects`. Writes `golden/runs/<stamp>.json` (gitignored) and exits 1
 * when the gate fails. Never prints the key. Masking is off by default (user decision 2026-09-30).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AnthropicLlmClient } from "../packages/core/src/llm/anthropic-client";
import { runGoldenRegression } from "../packages/core/src/eval";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("skipped: ANTHROPIC_API_KEY is not set");
  process.exit(0);
}

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const source = (opt("source") ?? "expected") as "expected" | "extract";
if (source !== "expected" && source !== "extract") {
  console.error("--source must be expected or extract");
  process.exit(2);
}
const runs = Number(opt("runs") ?? 1);
const cases = opt("cases")?.split(",").filter(Boolean);
const root = join(import.meta.dir, "..");

const llm = new AnthropicLlmClient();
const result = await runGoldenRegression(
  { extractLlm: llm, draftLlm: llm, auditLlm: llm, matchLlm: llm },
  { root, ledgerSource: source, runs, ...(cases ? { cases } : {}), skipDefects: args.includes("--no-defects") },
);

for (const c of result.cases) console.log(`${c.caseId}: ${Object.entries(c.verdicts).map(([d, v]) => `${d}=${v}`).join(" ") || "no documents"} applicability=${c.applicabilityAccuracy.toFixed(2)} slots r=${c.slotRecall.toFixed(2)} p=${c.slotPrecision.toFixed(2)}${c.escalated ? " ESCALATED" : ""}`);
if (result.defects.length) console.log(`defects: ${result.defects.map((d) => `${d.id}=${d.detected ? "found" : "MISSED"}`).join(" ")}`);
console.log("metrics:", JSON.stringify(result.metrics));
for (const stage of ["R2", "R4-fallback", "R5P", "R5T", "R7"] as const) console.log(stage, JSON.stringify(llm.totals(stage)));

await mkdir(join(root, "golden", "runs"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(join(root, "golden", "runs", `${stamp}.json`), JSON.stringify({ source, runs, cases: cases ?? "all", metrics: result.metrics, failures: result.failures, defects: result.defects, verdicts: result.cases.map((c) => ({ caseId: c.caseId, verdicts: c.verdicts, escalated: c.escalated })) }, null, 2));

if (result.failures.length) {
  console.error("GATE FAILED:");
  for (const f of result.failures) console.error(`  ${f.metric} = ${String(f.value)} (need ${f.threshold})`);
  process.exit(1);
}
console.log("GATE PASSED");
