/**
 * GapList: C1 output listing unanswered template questions (design R3 rows C1/R3).
 */
import { z } from "zod";
import { ItemIdSchema, NonEmptyString, RunIdSchema, SlotIdSchema, WarningSchema } from "./common";

/** Interview Template question ID, e.g. `Q-S09-02`. */
export const QuestionIdSchema = z.string().regex(/^Q-[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/, "question id must look like Q-S09-02");
export type QuestionId = z.infer<typeof QuestionIdSchema>;

export const GapSchema = z.strictObject({
  questionId: QuestionIdSchema,
  itemRefs: z.array(ItemIdSchema).min(1),
  /** Slot paths the question would fill. */
  targets: z.array(SlotIdSchema).min(1),
  priority: z.enum(["must", "should"]),
  reason: z.enum(["missing", "conflict", "low_confidence", "needs_manual_review"]),
});
export type Gap = z.infer<typeof GapSchema>;

export const GapListSchema = z.strictObject({
  runId: RunIdSchema,
  templateVersion: NonEmptyString,
  /** Interview round this list was computed for (0 = after first extraction). */
  round: z.number().int().min(0).max(2),
  gaps: z.array(GapSchema),
  warnings: z.array(WarningSchema),
});
export type GapList = z.infer<typeof GapListSchema>;
