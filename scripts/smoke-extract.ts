/**
 * Live smoke test: intake -> extract (R2) -> coverage (C1) -> gap (R3) on the Row 7 fixture with the REAL API.
 * Backend: the Anthropic API when ANTHROPIC_API_KEY is set, or `--llm claude-code` (Claude Code login, no API key).
 * With neither, prints "skipped" and exits 0.
 *
 *   bun scripts/smoke-extract.ts [transcript.txt [form.md]] [--llm api|claude-code]
 *
 * Masking is off by default (user decision 2026-09-30); the input is sanitized and sent as-is.
 *
 * Spends real tokens (roughly one Haiku call plus at most one Sonnet call). Prints per-stage token usage.
 * Never prints the key or any vault value.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TextFileSttAdapter } from "../packages/core/src/adapters/stt";
import { verifyTranscriptEvidence } from "../packages/core/src/contracts/fact-ledger";
import { createBackendClient, resolveBackend } from "../packages/core/src/llm/factory";
import { krPaths, loadKrKnowledge, runCoverage } from "../packages/core/src/stages/coverage";
import { runExtract } from "../packages/core/src/stages/extract";
import { runGap } from "../packages/core/src/stages/gap";
import { runIntake } from "../packages/core/src/stages/intake";

const argv = process.argv.slice(2);
const llmAt = argv.indexOf("--llm");
const backend = resolveBackend(llmAt >= 0 ? argv[llmAt + 1] : undefined);
if (!backend) {
  console.log("skipped: no model backend (set ANTHROPIC_API_KEY, or pass --llm claude-code to use your Claude Code login)");
  process.exit(0);
}
const positional = argv.filter((_, i) => llmAt < 0 || (i !== llmAt && i !== llmAt + 1));

const root = join(import.meta.dir, "..");
const fixtures = join(root, "packages", "core", "test", "fixtures", "intake");
const kb = loadKrKnowledge(krPaths(root));
const runId = "20260929-101500-a1b2c3";

const [transcriptPath = join(fixtures, "interview.ko.txt"), formPath = join(fixtures, "form.md")] = positional;
const transcript = await new TextFileSttAdapter().transcribe(transcriptPath);
const { maskedTranscript, formSlots, vault } = runIntake({ runId, transcript, form: await readFile(formPath, "utf8") });

const backendClient = createBackendClient(backend, { vault });
const llm = backendClient.client;
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

for (const stage of ["R2", "R3"] as const) console.log(stage, backendClient.usageLine(stage) ?? "no calls");
backendClient.close();
process.exit(evidenceProblems.length === 0 ? 0 : 1);
