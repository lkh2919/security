/**
 * Runs the privacy-policy / terms pipeline with the REAL API (design R7).
 *
 *   bun scripts/run-pipeline.ts start  --transcript interview.txt --form form.md [--masking basic] [--run-id ID] [--runs-dir runs]
 *   bun scripts/run-pipeline.ts answer --run ID --answers answers.json [--runs-dir runs]
 *
 * `start` stops at `awaiting_answers` when must-level facts are missing and prints the questions
 * (also saved as runs/<ID>/*-interview.q<round>.json); `answer` folds an AnswerSet in and continues.
 * Outputs land in runs/<ID>/output/ (MD, HTML, DOCX, Reviewer Sheet). Skipped (exit 0) without ANTHROPIC_API_KEY.
 * Masking is off by default (user decision 2026-09-30); pass `--masking basic` to mask before any model call.
 * Never prints the key, transcript text or vault values.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TextFileSttAdapter } from "../packages/core/src/adapters/stt";
import { AnswerSetSchema } from "../packages/core/src/contracts/question-set";
import { AnthropicLlmClient } from "../packages/core/src/llm/anthropic-client";
import { continueRun, startRun, type PipelineOutcome } from "../packages/core/src/stages/orchestrate";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("skipped: ANTHROPIC_API_KEY is not set");
  process.exit(0);
}

const [command, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = opt(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
};
const root = join(import.meta.dir, "..");
const runsRoot = join(root, opt("runs-dir") ?? "runs");
const llm = new AnthropicLlmClient();
const deps = { llm, runsRoot, root };

function report(o: PipelineOutcome): void {
  if (o.status === "awaiting_answers") {
    console.log(`awaiting answers: run ${o.runId}, round ${o.round}, ${o.questionSet.questions.length} question(s)`);
    for (const q of o.questionSet.questions) console.log(`  [${q.priority}] ${q.id} (${q.answerType}): ${q.text}`);
    console.log(`next: bun scripts/run-pipeline.ts answer --run ${o.runId} --answers answers.json`);
    return;
  }
  console.log(`done: run ${o.runId}; verdicts ${Object.entries(o.verdicts).map(([d, v]) => `${d}=${v}`).join(" ")}${o.escalated ? " (ESCALATED: unresolved findings, draft banner set)" : ""}`);
  for (const f of o.files) console.log(`  runs/${o.runId}/${f}`);
  for (const w of o.warnings) console.log(`  warning: ${w}`);
}

if (command === "start") {
  const masking = (opt("masking") ?? "off") as "off" | "basic";
  if (masking !== "off" && masking !== "basic") {
    console.error("--masking must be off or basic");
    process.exit(2);
  }
  const transcript = await new TextFileSttAdapter().transcribe(need("transcript"));
  const form = await readFile(need("form"), "utf8");
  report(await startRun(deps, { transcript, form, masking, ...(opt("run-id") ? { runId: opt("run-id") } : {}) }));
} else if (command === "answer") {
  const answers = AnswerSetSchema.parse(JSON.parse(await readFile(need("answers"), "utf8")));
  report(await continueRun(deps, { runId: need("run"), answers }));
} else {
  console.error("usage: bun scripts/run-pipeline.ts start|answer ... (see the file header)");
  process.exit(2);
}
for (const stage of ["R2", "R3", "R4-fallback", "R5P", "R5T", "R7"] as const) {
  const t = llm.totals(stage);
  if (t.calls) console.log(stage, JSON.stringify(t));
}
