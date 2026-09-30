/**
 * FormSlots: the parsed service description form (design R1, R3 row R1).
 * All text is already masked; the form parser (R1) runs the masker before emitting this.
 */
import { z } from "zod";
import { NonEmptyString, RunIdSchema, SlotIdSchema } from "./common";

const FormValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/** One data flow row of the service form (`form.flows[2]` in evidence refs). */
export const FormFlowSchema = z.strictObject({
  name: NonEmptyString,
  dataItems: z.array(NonEmptyString),
  purposes: z.array(NonEmptyString),
  recipients: z.array(NonEmptyString),
  retention: z.string().optional(),
});
export type FormFlow = z.infer<typeof FormFlowSchema>;

export const FormSlotsSchema = z.strictObject({
  runId: RunIdSchema,
  /** Version of the form layout that was parsed (InfoSec form or the built-in fallback). */
  formVersion: NonEmptyString,
  serviceName: NonEmptyString,
  description: z.string(),
  /** Slot-keyed answers taken directly from the form. Keys are checked against the registry by callers. */
  slots: z.record(SlotIdSchema, FormValueSchema),
  /** Free-form form fields that have no slot yet, keyed by form field name. */
  fields: z.record(NonEmptyString, FormValueSchema),
  flows: z.array(FormFlowSchema),
});
export type FormSlots = z.infer<typeof FormSlotsSchema>;
