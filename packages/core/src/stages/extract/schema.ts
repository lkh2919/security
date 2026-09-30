/**
 * R2 model-facing output schema. It is deliberately flatter and weaker than the FactLedger:
 * structured outputs cannot express dynamic slot keys, arbitrary JSON values or numeric ranges, so
 *  - slots are an array with `slotId` (checked against the registry in code, never trusted),
 *  - the value is JSON text (`valueJson`) parsed in code,
 *  - confidence is a 3-level enum mapped to numbers in code,
 *  - the model may only say `filled` or `needs_manual_review`; absence means missing.
 */
import { z } from "zod";

export const ExtractOutputSchema = z.strictObject({
  slots: z.array(
    z.strictObject({
      slotId: z.string(),
      status: z.enum(["filled", "needs_manual_review"]),
      valueJson: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      evidence: z.array(z.strictObject({ segmentId: z.string(), quote: z.string() })),
    }),
  ),
});
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

export const CONFIDENCE_VALUE = { high: 0.9, medium: 0.7, low: 0.4 } as const;
