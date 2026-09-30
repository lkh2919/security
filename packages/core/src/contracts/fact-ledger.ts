/**
 * FactLedger: the shared fact store feeding both documents (design R4.3).
 *
 * Decision: R4.3 sketches a nested, hand-typed ledger. Slot IDs are now defined at runtime by the
 * slot registry (Interview Template), so the ledger is a flat `slots` map keyed by SlotId.
 * `createFactLedgerSchema(registry)` adds the registry membership check.
 */
import { z } from "zod";
import {
  JsonValueSchema,
  MAX_QUOTE_LENGTH,
  NonEmptyString,
  RunIdSchema,
  SegmentIdSchema,
  SlotIdSchema,
  unknownSlotIds,
  type SlotRegistry,
} from "./common";
import { findSegment, type MaskedTranscript } from "./masked-transcript";

/** Evidence backed by a transcript segment. C2 verifies the segment exists and contains the quote. */
export const TranscriptEvidenceSchema = z.strictObject({
  source: z.literal("transcript"),
  segmentId: SegmentIdSchema,
  quote: z.string().min(1).max(MAX_QUOTE_LENGTH),
});

/** Evidence from other sources; `ref` is `form.flows[2]`, `Q-S09-02`, a KB default id, ... */
export const OtherEvidenceSchema = z.strictObject({
  source: z.enum(["form", "interview", "kb_default", "user_confirmed"]),
  ref: NonEmptyString,
  quote: z.string().max(MAX_QUOTE_LENGTH),
});

export const EvidenceSchema = z.union([TranscriptEvidenceSchema, OtherEvidenceSchema]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SlotStatusSchema = z.enum(["filled", "not_applicable", "missing", "conflict", "needs_manual_review"]);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

export const SlotEntrySchema = z
  .strictObject({
    value: JsonValueSchema,
    status: SlotStatusSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceSchema),
  })
  .superRefine((slot, ctx) => {
    if (slot.status === "filled") {
      if (slot.value === null) ctx.addIssue({ code: "custom", path: ["value"], message: "filled slot needs a non-null value" });
      if (slot.evidence.length === 0) ctx.addIssue({ code: "custom", path: ["evidence"], message: "filled slot needs at least one evidence item" });
    }
    if ((slot.status === "missing" || slot.status === "not_applicable") && slot.value !== null) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `${slot.status} slot must have a null value` });
    }
  });
export type SlotEntry = z.infer<typeof SlotEntrySchema>;

export const FactLedgerSchema = z.strictObject({
  runId: RunIdSchema,
  jurisdiction: z.literal("kr"),
  /** Version of the slot registry the keys belong to. */
  slotRegistryVersion: NonEmptyString,
  slots: z.record(SlotIdSchema, SlotEntrySchema),
});
export type FactLedger = z.infer<typeof FactLedgerSchema>;

/** Ledger schema that also rejects slot keys unknown to the runtime registry. */
export function createFactLedgerSchema(registry: SlotRegistry) {
  return FactLedgerSchema.superRefine((ledger, ctx) => {
    for (const id of unknownSlotIds(registry, Object.keys(ledger.slots))) {
      ctx.addIssue({ code: "custom", path: ["slots", id], message: "unknown slot id (not in slot registry)" });
    }
    if (ledger.slotRegistryVersion !== registry.version) {
      ctx.addIssue({
        code: "custom",
        path: ["slotRegistryVersion"],
        message: `ledger built for registry ${ledger.slotRegistryVersion}, runtime has ${registry.version}`,
      });
    }
  });
}

/**
 * C2 evidence check (design R4.3): every transcript evidence must point at an existing segment
 * whose text contains the quote. Returns human-readable problems; empty means all evidence holds.
 */
export function verifyTranscriptEvidence(ledger: FactLedger, transcript: MaskedTranscript): string[] {
  const problems: string[] = [];
  for (const [slotId, slot] of Object.entries(ledger.slots)) {
    slot.evidence.forEach((ev, i) => {
      if (ev.source !== "transcript") return;
      const segment = findSegment(transcript, ev.segmentId);
      if (!segment) problems.push(`${slotId}.evidence[${i}]: segment ${ev.segmentId} does not exist`);
      else if (!segment.text.includes(ev.quote)) problems.push(`${slotId}.evidence[${i}]: quote is not a substring of ${ev.segmentId}`);
    });
  }
  return problems;
}
