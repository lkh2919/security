/**
 * Live smoke test: intake -> extract (R2) -> coverage (C1) -> gap (R3) on the Row 7 fixture with the REAL API.
 * Runs only when ANTHROPIC_API_KEY is set; otherwise prints "skipped" and exits 0.
 *
 *   bun scripts/smoke-extract.ts
 *
 * Spends real tokens (roughly one Haiku call plus at most one Sonnet call). Prints per-stage token usage.
 * Never prints the key or any vault value.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TextFileSttAdapter } from "../packages/core/src/adapters/stt";
import { verifyTranscriptEvidence } from "../packages/core/src/contracts/fact-ledger";
import { AnthropicLlmClient } from "../packages/core/src/llm/anthropic-client";
import { krPaths, loadKrKnowledge, runCoverage } from "../packages/core/src/stages/coverage";
import { runExtract } from "../packages/core/src/stages/extract";
import { runGap } from "../packages/core/src/stages/gap";
import { runIntake } from "../packages/core/src/stages/intake";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("skipped: ANTHROPIC_API_KEY is not set");
  process.exit(0);
}

// Safety (PM hold): the intake masker is being hardened, so only the clean Row 7 fixture may go to the API.
// The script takes no input path and refuses arguments or overrides.
if (process.argv.length > 2 || process.env.SMOKE_INPUT) {
  console.error("refused: smoke-extract takes no input path; it only runs the clean Row 7 fixture (test/fixtures/intake/interview.ko.txt)");
  process.exit(2);
}

const root = join(import.meta.dir, "..");
const fixtures = join(root, "packages", "core", "test", "fixtures", "intake");
const kb = loadKrKnowledge(krPaths(root));
const runId = "20260929-101500-a1b2c3";

const transcript = await new TextFileSttAdapter().transcribe(join(fixtures, "interview.ko.txt"));
const { maskedTranscript, formSlots, vault } = runIntake({ runId, transcript, form: await readFile(join(fixtures, "form.md"), "utf8") });

const llm = new AnthropicLlmClient({ vault });
const extract = await runExtract({ llm }, { maskedTranscript, formSlots, template: kb.template, registry: kb.registry, slotHints: kb.slotHints });
const evidenceProblems = verifyTranscriptEvidence(extract.ledger, maskedTranscript);
console.log(`R2: chunks=${extract.chunks} slots=${Object.keys(extract.ledger.slots).length} dropped=${extract.dropped.length} evidenceProblems=${evidenceProblems.length}`);

const cov = runCoverage({
  runId,
  ledger: extract.ledger,
  template: kb.template,
  rulePackItems: kb.rulePackItems,
  rulePackVersion: kb.rulePackVersion,
  termsPackAvailable: kb.termsPackAvailable,
});
console.log(`C1: gaps=${cov.gapList.gaps.length} warnings=${cov.applicability.warnings.map((w) => w.code).join(",") || "none"}`);

const gap = await runGap({ llm }, { runId, round: 1, gapList: cov.gapList, template: kb.template, ledger: extract.ledger });
console.log(`R3: questions=${gap.questionSet.questions.length} deferred=${gap.deferred.length} llmUsed=${gap.llmUsed} delegationQuestion=${gap.delegationQuestion}`);

for (const stage of ["R2", "R3"] as const) console.log(stage, JSON.stringify(llm.totals(stage)));
process.exit(evidenceProblems.length === 0 ? 0 : 1);
