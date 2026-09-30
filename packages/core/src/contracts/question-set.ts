/**
 * QuestionSet (R3 output, at most 10) and AnswerSet (`--answers a.json` input) (design R3, R7).
 */
import { z } from "zod";
import { ItemIdSchema, JsonValueSchema, NonEmptyString, RunIdSchema, SlotIdSchema } from "./common";
import { QuestionIdSchema } from "./gap-list";

export const ANSWER_TYPES = ["yes_no", "single", "multi", "text", "table", "date", "contact_ref", "number"] as const;
export const AnswerTypeSchema = z.enum(ANSWER_TYPES);
export type AnswerType = z.infer<typeof AnswerTypeSchema>;

export const MAX_QUESTIONS_PER_ROUND = 10;
export const MAX_INTERVIEW_ROUNDS = 2;

export const QuestionSchema = z.strictObject({
  id: NonEmptyString,
  text: NonEmptyString,
  help: z.string().optional(),
  answerType: AnswerTypeSchema,
  options: z.array(NonEmptyString).optional(),
  targets: z.array(SlotIdSchema).min(1),
  itemRefs: z.array(ItemIdSchema).min(1),
  priority: z.enum(["must", "should"]),
  /** `template` = emitted verbatim by code; `followup` = merged or rephrased by the R3 LLM. */
  origin: z.enum(["template", "followup"]),
  /** Template question IDs this question covers (merged questions cover several). */
  sourceQuestionIds: z.array(QuestionIdSchema),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionSetSchema = z.strictObject({
  runId: RunIdSchema,
  round: z.number().int().min(1).max(MAX_INTERVIEW_ROUNDS),
  questions: z.array(QuestionSchema).max(MAX_QUESTIONS_PER_ROUND),
});
export type QuestionSet = z.infer<typeof QuestionSetSchema>;

export const AnswerSchema = z.strictObject({
  questionId: NonEmptyString,
  /** `null` means the human skipped the question (leaves the item `manual_review` for must questions). */
  value: JsonValueSchema,
});

export const AnswerSetSchema = z.strictObject({
  runId: RunIdSchema,
  round: z.number().int().min(1).max(MAX_INTERVIEW_ROUNDS),
  answers: z.array(AnswerSchema),
});
export type AnswerSet = z.infer<typeof AnswerSetSchema>;
