/**
 * Seeded-defect calibration of the isolated auditor (design R6.3; gate: recall >= 0.90).
 *
 *   bun scripts/calibrate-defects.ts --llm claude-code [--drafts golden/runs/<stamp>] [--defects D1,D6]
 *
 * Base drafts: saved `<case>.<doc>.json` files from a live regression run (default: the newest run folder that has them);
 * missing ones are drafted once (no audit loop). Then one audit per defect. Writes golden/runs/<stamp>-defects.json
 * (gitignored) and exits 1 when recall is below 0.90. Skipped (exit 0) without a backend.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GATE_THRESHOLDS, runDefectCalibration } from "../packages/core/src/eval";
import { createBackendClient, resolveBackend } from "../packages/core/src/llm/factory";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const backend = resolveBackend(opt("llm"));
if (!backend) {
  console.log("skipped: no model backend (set ANTHROPIC_API_KEY, or pass --llm claude-code to use your Claude Code login)");
  process.exit(0);
}
const root = join(import.meta.dir, "..");
const runsDir = join(root, "golden", "runs");
const latest = existsSync(runsDir)
  ? readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(runsDir, e.name, "G1.privacy.json"))).map((e) => e.name).sort().at(-1)
  : undefined;
const draftsDir = opt("drafts") ? join(root, opt("drafts")!) : latest ? join(runsDir, latest) : undefined;
const backendClient = createBackendClient(backend);
const result = await runDefectCalibration(
  { draftLlm: backendClient.client, auditLlm: backendClient.client },
  { root, ...(draftsDir ? { draftsDir } : {}), ...(opt("defects") ? { defects: opt("defects")!.split(",") } : {}) },
);

console.log(`base drafts: ${draftsDir ?? "(none saved, all generated)"}`);
for (const o of result.outcomes) {
  console.log(`${o.id} ${o.detected ? "FOUND " : "MISSED"} expected ${o.expectedRule}@${o.expectedSection}; auditor in section: ${o.auditorRulesInSection.join(", ") || "-"}; C2 ${o.c2Flagged ? "flagged" : "silent"}; base ${o.baseDraft}`);
  if (!o.detected) for (const m of o.auditorMessages) console.log(`    ${m}`);
}
console.log(`recall ${result.recall.toFixed(3)} (gate >= ${GATE_THRESHOLDS.defectRecall})`);
for (const stage of ["R5P", "R5T", "R7"] as const) console.log(stage, backendClient.usageLine(stage) ?? "no calls");
backendClient.close();

await mkdir(runsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(join(runsDir, `${stamp}-defects.json`), JSON.stringify({ draftsDir, recall: result.recall, outcomes: result.outcomes }, null, 2));
process.exit(result.recall >= GATE_THRESHOLDS.defectRecall ? 0 : 1);
