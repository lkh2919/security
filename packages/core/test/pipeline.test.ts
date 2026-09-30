import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextFileSttAdapter } from "../src/adapters/stt";
import type { JsonValue } from "../src/contracts/common";
import type { QuestionSet } from "../src/contracts/question-set";
import { RunStateSchema } from "../src/contracts/run-state";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import type { AuditOutput } from "../src/stages/audit";
import type { SectionDraft } from "../src/stages/draft";
import type { ExtractOutput } from "../src/stages/extract";
import { continueRun, startRun } from "../src/stages/orchestrate";

const ROOT = join(import.meta.dir, "..", "..", "..");
const INTAKE = join(import.meta.dir, "fixtures", "intake");
const r2 = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "extract", "r2-output.json"), "utf8")) as ExtractOutput;
const tmp = mkdtempSync(join(tmpdir(), "pa-pipeline-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const body = (req: StructuredCallRequest): string => req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"));
const drafter = (req: StructuredCallRequest): SectionDraft => {
  const p = JSON.parse(body(req)) as { section: { title: string }; facts: Record<string, unknown> };
  const slot = Object.keys(p.facts)[0];
  return { status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: `${p.section.title} 내용입니다.`, ...(slot ? { slotRef: slot } : {}) }] }] };
};
const scores = { legal: 5, accuracy: 5, clarity: 5, houseStyle: 5, consistency: 5 };
const auditor = (): AuditOutput => ({ scores, findings: [], resolvedFindingIds: [] });
const llm = () => new MockLlmClient({ fixtures: { R2: r2, R3: { followups: [] }, "R4-fallback": { group: "cross_group" }, R5P: drafter, R5T: drafter, R7: auditor } });

const answerFor = (q: QuestionSet["questions"][number]): JsonValue => {
  switch (q.answerType) {
    case "yes_no": return false;
    case "number": return 14;
    case "single": return q.options?.[0] ?? "해당 없음";
    case "multi": return [q.options?.[0] ?? "해당 없음"];
    case "table": return [{ name: "해당 없음" }];
    case "date": return "2026-10-01";
    default: return "해당 없음";
  }
};

async function input() {
  return { transcript: await new TextFileSttAdapter().transcribe(join(INTAKE, "interview.ko.txt")), form: readFileSync(join(INTAKE, "form.md"), "utf8") };
}

describe("pipeline orchestration (mock models)", () => {
  test("start -> awaiting answers -> continue -> done, with files, state and isolation", async () => {
    const client = llm();
    const deps = { llm: client, runsRoot: join(tmp, "runs"), root: ROOT };
    const { transcript, form } = await input();
    let outcome = await startRun(deps, { runId: "20260930-130000-aaaaaa", transcript, form });

    let rounds = 0;
    while (outcome.status === "awaiting_answers") {
      rounds += 1;
      expect(outcome.questionSet.questions.length).toBeGreaterThan(0);
      expect(outcome.round).toBe(rounds);
      const state = RunStateSchema.parse(JSON.parse(readFileSync(join(tmp, "runs", outcome.runId, "run-state.json"), "utf8")));
      expect(state.status).toBe("awaiting_answers");
      expect(state.currentStage).toBe("interview");
      outcome = await continueRun(deps, { runId: outcome.runId, answers: { runId: outcome.runId, round: outcome.round, answers: outcome.questionSet.questions.map((q) => ({ questionId: q.id, value: answerFor(q) })) } });
      expect(rounds).toBeLessThanOrEqual(2);
    }
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;

    const runDir = join(tmp, "runs", outcome.runId);
    const state = RunStateSchema.parse(JSON.parse(readFileSync(join(runDir, "run-state.json"), "utf8")));
    expect(state.status).toBe("done");
    expect(state.stages.render?.status).toBe("done");
    expect(state.stages.freshness?.status).toBe("skipped");
    expect(outcome.files).toContain("output/privacy-policy.md");
    expect(outcome.files).toContain("output/reviewer-sheet.md");
    for (const f of outcome.files) expect(existsSync(join(runDir, f))).toBe(true);
    const md = readFileSync(join(runDir, "output", "privacy-policy.md"), "utf8");
    expect(md).toContain("참고용 초안");

    // The input snapshot holds hashes, never raw text.
    const snapshot = readFileSync(join(runDir, "00-input.json"), "utf8");
    expect(snapshot).not.toContain("쇼핑나우");
    expect(snapshot).toMatch(/transcriptSha256/);
    // Masking is off by default: no vault file is written.
    expect(readdirSync(runDir)).not.toContain("pii-vault.local.json");
    // The auditor saw only envelopes; the drafters never saw an audit prompt.
    expect(client.calls.filter((c) => c.stageId === "R7").every((c) => !c.system.includes("You draft ONE section"))).toBe(true);
    expect(client.calls.filter((c) => c.stageId === "R5P").every((c) => !/RUBRIC/.test(c.system))).toBe(true);
  });

  test("skipped must questions trigger a second round, then the run finishes with manual-review sections", async () => {
    const deps = { llm: llm(), runsRoot: join(tmp, "runs-skip"), root: ROOT };
    const { transcript, form } = await input();
    let outcome = await startRun(deps, { runId: "20260930-130000-cccccc", transcript, form });
    const seen: number[] = [];
    while (outcome.status === "awaiting_answers") {
      seen.push(outcome.round);
      outcome = await continueRun(deps, { runId: outcome.runId, answers: { runId: outcome.runId, round: outcome.round, answers: outcome.questionSet.questions.map((q) => ({ questionId: q.id, value: null })) } });
    }
    expect(seen).toEqual([1, 2]); // never a third round (design: max 2)
    expect(outcome.status).toBe("done");
    if (outcome.status === "done") {
      const md = readFileSync(join(tmp, "runs-skip", outcome.runId, "output", "reviewer-sheet.md"), "utf8");
      expect(md.length).toBeGreaterThan(100);
    }
  });

  test("masking basic writes the local vault and keeps raw values out of the snapshot and the model payloads", async () => {
    const client = llm();
    const deps = { llm: client, runsRoot: join(tmp, "runs-basic"), root: ROOT };
    const { transcript, form } = await input();
    const first = await startRun(deps, { runId: "20260930-130000-bbbbbb", transcript, form, masking: "basic" });
    expect(readdirSync(join(tmp, "runs-basic", first.runId))).toContain("pii-vault.local.json");
    const payloads = client.calls.map((c) => c.user + c.system).join("\n");
    expect(payloads).not.toContain("jihoon.park@shopnow-corp.co.kr");
    expect(payloads).not.toContain("900101-1234567");
  });

  test("continuing a run that is not awaiting answers is refused", async () => {
    const deps = { llm: llm(), runsRoot: join(tmp, "runs"), root: ROOT };
    await expect(continueRun(deps, { runId: "20260930-130000-aaaaaa", answers: { runId: "20260930-130000-aaaaaa", round: 1, answers: [] } })).rejects.toThrow(/not awaiting answers/);
  });

  test("a run id is never reused", async () => {
    const deps = { llm: llm(), runsRoot: join(tmp, "runs"), root: ROOT };
    const { transcript, form } = await input();
    await expect(startRun(deps, { runId: "20260930-130000-aaaaaa", transcript, form })).rejects.toThrow(/already exists/);
  });
});
