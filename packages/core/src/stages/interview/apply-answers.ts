/**
 * Interview stage: folds a human `AnswerSet` (`--answers a.json`) into the FactLedger (design R3, R7).
 * Code only, zero LLM tokens. Human answers are the highest-trust evidence (`source: "interview"`).
 *
 *  - an answer to a single-target question fills that slot (typed by the registry);
 *  - a multi-target question needs an object keyed by target slot id (each key is filled separately);
 *  - `null` (skipped) leaves the slot as it is, except that a skipped `must` question turns a slot that is not
 *    `filled` into `needs_manual_review`;
 *  - an answer that cannot be typed is rejected (reported, slot untouched), never guessed.
 */
import {
  ContractError,
  type JsonValue,
  type SlotRegistry,
} from "../../contracts/common";
import { FactLedgerSchema, createFactLedgerSchema, type FactLedger, type SlotEntry } from "../../contracts/fact-ledger";
import { AnswerSetSchema, type AnswerSet, type QuestionSet } from "../../contracts/question-set";
import { coerce } from "../extract/ledger-builder";

export interface RejectedAnswer {
  readonly questionId: string;
  readonly slotId?: string;
  readonly reason: "type_mismatch" | "needs_slot_keyed_object" | "unknown_target_key";
}

export interface ApplyAnswersResult {
  readonly ledger: FactLedger;
  /** Slot ids filled from answers. */
  readonly applied: readonly string[];
  /** Slot ids turned into `needs_manual_review` because a `must` question was skipped. */
  readonly flagged: readonly string[];
  readonly rejected: readonly RejectedAnswer[];
}

const isRecord = (v: JsonValue): v is { [key: string]: JsonValue } => v !== null && typeof v === "object" && !Array.isArray(v);

function interviewEntry(questionId: string, value: JsonValue): SlotEntry {
  return { status: "filled", value, confidence: 1, evidence: [{ source: "interview", ref: questionId, quote: "" }] };
}

export function applyAnswers(args: { ledger: FactLedger; questionSet: QuestionSet; answers: AnswerSet; registry: SlotRegistry }): ApplyAnswersResult {
  const answers = AnswerSetSchema.parse(args.answers);
  const { ledger, questionSet, registry } = args;
  if (answers.runId !== ledger.runId || questionSet.runId !== ledger.runId) {
    throw new ContractError("AnswerSet", [`runId mismatch: ledger ${ledger.runId}, questions ${questionSet.runId}, answers ${answers.runId}`]);
  }
  if (answers.round !== questionSet.round) {
    throw new ContractError("AnswerSet", [`round mismatch: questions are round ${questionSet.round}, answers are round ${answers.round}`]);
  }
  const questions = new Map(questionSet.questions.map((q) => [q.id, q]));
  const unknown = answers.answers.filter((a) => !questions.has(a.questionId)).map((a) => `unknown question id ${a.questionId}`);
  if (unknown.length) throw new ContractError("AnswerSet", unknown);
  const seen = new Set<string>();
  const dup = answers.answers.filter((a) => (seen.has(a.questionId) ? true : (seen.add(a.questionId), false))).map((a) => `duplicate answer for ${a.questionId}`);
  if (dup.length) throw new ContractError("AnswerSet", dup);

  const slots: Record<string, SlotEntry> = { ...ledger.slots };
  const applied: string[] = [];
  const flagged: string[] = [];
  const rejected: RejectedAnswer[] = [];

  const fill = (questionId: string, slotId: string, raw: JsonValue): void => {
    const typed = coerce(registry.get(slotId)?.type ?? "", raw);
    if (typed === undefined) {
      rejected.push({ questionId, slotId, reason: "type_mismatch" });
      return;
    }
    slots[slotId] = interviewEntry(questionId, typed);
    applied.push(slotId);
  };

  for (const a of answers.answers) {
    const q = questions.get(a.questionId)!;
    if (a.value === null) {
      if (q.priority !== "must") continue;
      for (const t of q.targets) {
        if (slots[t]?.status === "filled") continue;
        slots[t] = { status: "needs_manual_review", value: null, confidence: 0, evidence: slots[t]?.evidence ?? [] };
        flagged.push(t);
      }
      continue;
    }
    if (q.targets.length === 1) {
      fill(q.id, q.targets[0], a.value);
      continue;
    }
    if (!isRecord(a.value)) {
      rejected.push({ questionId: q.id, reason: "needs_slot_keyed_object" });
      continue;
    }
    for (const [key, v] of Object.entries(a.value)) {
      if (!q.targets.includes(key)) rejected.push({ questionId: q.id, slotId: key, reason: "unknown_target_key" });
      else if (v !== null) fill(q.id, key, v);
    }
  }

  const next = createFactLedgerSchema(registry).parse(FactLedgerSchema.parse({ ...ledger, slots }));
  return { ledger: next, applied, flagged, rejected };
}
