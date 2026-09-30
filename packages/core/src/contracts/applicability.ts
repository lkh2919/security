/**
 * ApplicabilityMap: C1 output. Which items and documents apply (design R3 row C1, R4.3).
 */
import { z } from "zod";
import { DocTypeSchema, ItemIdSchema, NonEmptyString, RunIdSchema, SlotIdSchema, WarningSchema } from "./common";

/** `pending`: the rule pack for the item is absent, so applicability cannot be decided yet. `unknown` means a rule exists but an answer is missing. */
export const ApplicabilityStateSchema = z.enum(["yes", "no", "unknown", "pending"]);
export type ApplicabilityState = z.infer<typeof ApplicabilityStateSchema>;

export const ItemApplicabilitySchema = z.strictObject({
  state: ApplicabilityStateSchema,
  /** Slots that decided the state (`basisSlots` in R4.3). */
  basisSlots: z.array(SlotIdSchema),
});

export const DocApplicabilitySchema = z.strictObject({
  applicable: z.boolean(),
  /** Required when not applicable (e.g. internal HR system has no terms); R8 prints it. */
  reason: z.string().optional(),
});

export const ApplicabilityMapSchema = z
  .strictObject({
    runId: RunIdSchema,
    ruleSetVersions: z.array(NonEmptyString),
    documents: z.strictObject({ privacy: DocApplicabilitySchema, terms: DocApplicabilitySchema }),
    items: z.record(ItemIdSchema, ItemApplicabilitySchema),
    /** Special types detected by C1 (children, CCTV, gen-AI, location): `warn` handling only. */
    warnings: z.array(WarningSchema),
  })
  .superRefine((map, ctx) => {
    for (const doc of DocTypeSchema.options) {
      const d = map.documents[doc];
      if (!d.applicable && !d.reason) {
        ctx.addIssue({ code: "custom", path: ["documents", doc, "reason"], message: "non-applicable document needs a reason" });
      }
    }
  });
export type ApplicabilityMap = z.infer<typeof ApplicabilityMapSchema>;
