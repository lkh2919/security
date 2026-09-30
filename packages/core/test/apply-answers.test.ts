import { describe, expect, test } from "bun:test";
import { applyAnswers } from "../src/stages/interview";
import { ContractError } from "../src/contracts/common";
import type { QuestionSet } from "../src/contracts/question-set";
import { RUN_ID, factLedger, slotRegistry } from "./fixtures";

const q = (id: string, targets: string[], answerType: "yes_no" | "number" | "table" | "text", priority: "must" | "should" = "must") => ({
  id,
  text: "?",
  answerType,
  targets,
  itemRefs: ["S09"],
  priority,
  origin: "template" as const,
  sourceQuestionIds: [id],
});
const questionSet: QuestionSet = {
  runId: RUN_ID,
  round: 1,
  questions: [
    q("Q-T01-01", ["terms.minAge"], "number"),
    q("Q-S09-01", ["gate.membership"], "yes_no"),
    q("Q-S09-02", ["gate.outsourcing", "privacy.S09_processors"], "table"),
    q("Q-S09-03", ["gate.outsourcing"], "yes_no", "should"),
  ],
};
const run = (answers: { questionId: string; value: unknown }[], round = 1) =>
  applyAnswers({ ledger: factLedger, questionSet, registry: slotRegistry, answers: { runId: RUN_ID, round, answers: answers as never } });

describe("applyAnswers", () => {
  test("fills a missing slot with interview evidence, typed by the registry", () => {
    const r = run([{ questionId: "Q-T01-01", value: "14" }]);
    expect(r.ledger.slots["terms.minAge"]).toEqual({ status: "filled", value: 14, confidence: 1, evidence: [{ source: "interview", ref: "Q-T01-01", quote: "" }] });
    expect(r.applied).toEqual(["terms.minAge"]);
    expect(factLedger.slots["terms.minAge"]?.status).toBe("missing"); // input untouched
  });

  test("a human answer replaces an existing value", () => {
    const r = run([{ questionId: "Q-S09-01", value: "아니오" }]);
    expect(r.ledger.slots["gate.membership"]?.value).toBe(false);
    expect(r.ledger.slots["gate.membership"]?.evidence[0]).toMatchObject({ source: "interview" });
  });

  test("a value that cannot be typed is rejected and the slot is left alone", () => {
    const r = run([{ questionId: "Q-T01-01", value: "열네 살" }]);
    expect(r.rejected).toEqual([{ questionId: "Q-T01-01", slotId: "terms.minAge", reason: "type_mismatch" }]);
    expect(r.ledger.slots["terms.minAge"]?.status).toBe("missing");
  });

  test("a skipped must question flags a non-filled slot; a filled slot and a should question stay as they are", () => {
    const r = run([
      { questionId: "Q-T01-01", value: null },
      { questionId: "Q-S09-01", value: null },
      { questionId: "Q-S09-03", value: null },
    ]);
    expect(r.ledger.slots["terms.minAge"]?.status).toBe("needs_manual_review");
    expect(r.flagged).toEqual(["terms.minAge"]);
    expect(r.ledger.slots["gate.membership"]).toEqual(factLedger.slots["gate.membership"]);
    expect(r.ledger.slots["gate.outsourcing"]).toEqual(factLedger.slots["gate.outsourcing"]);
  });

  test("a multi-target question needs an object keyed by target slot id", () => {
    expect(run([{ questionId: "Q-S09-02", value: "x" }]).rejected).toEqual([{ questionId: "Q-S09-02", reason: "needs_slot_keyed_object" }]);
    const r = run([{ questionId: "Q-S09-02", value: { "gate.outsourcing": "예", "privacy.S09_processors": [{ name: "A" }], "terms.minAge": 1 } }]);
    expect(r.ledger.slots["gate.outsourcing"]?.value).toBe(true);
    expect(r.ledger.slots["privacy.S09_processors"]?.value).toEqual([{ name: "A" }]);
    expect(r.rejected).toEqual([{ questionId: "Q-S09-02", slotId: "terms.minAge", reason: "unknown_target_key" }]);
  });

  test("run id, round, unknown and duplicate question ids throw", () => {
    expect(() => run([], 2)).toThrow(ContractError);
    expect(() => run([{ questionId: "Q-NOPE-01", value: 1 }])).toThrow(ContractError);
    expect(() => run([{ questionId: "Q-T01-01", value: 1 }, { questionId: "Q-T01-01", value: 2 }])).toThrow(ContractError);
    expect(() => applyAnswers({ ledger: factLedger, questionSet, registry: slotRegistry, answers: { runId: "20260101-000000-ffffff", round: 1, answers: [] } })).toThrow(ContractError);
  });
});
