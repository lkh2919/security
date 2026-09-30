/**
 * AuditEnvelope: the ONLY input the independent auditor (R7) may receive (design R6.3, R17).
 *
 * Isolation is encoded structurally:
 *  - the object is strict, so any extra key (`drafterPrompt`, `thinking`, `rationale`, ...) is rejected;
 *  - every nested contract is strict too;
 *  - it has no field for drafter prompts, drafter reasoning, or ClauseSelection rationale;
 *  - it contains no PiiVault data (masked transcript only).
 * The key list is exported and asserted by a unit test so that widening the allowlist is a
 * deliberate, reviewed change.
 */
import { z } from "zod";
import { ApplicabilityMapSchema } from "./applicability";
import { SectionStatusSchema } from "./ast";
import { FindingSchema } from "./audit-report";
import { CheckResultsSchema } from "./check-results";
import { DocTypeSchema, ItemIdSchema, NonEmptyString, SlotIdSchema } from "./common";
import { FactLedgerSchema } from "./fact-ledger";
import { FormSlotsSchema } from "./form-slots";
import { MaskedTranscriptSchema } from "./masked-transcript";

/** One must-level rule reduced to what the auditor needs. */
export const RuleDigestEntrySchema = z.strictObject({
  ruleId: NonEmptyString,
  sectionId: NonEmptyString,
  statement: NonEmptyString,
  legalRefs: z.array(NonEmptyString),
});

/** House-style rule as loaded from `house-style/lotte-innovate.json` (design R5.4). */
export const HouseStyleRuleSchema = z.strictObject({
  id: NonEmptyString,
  scope: z.enum(["privacy", "terms", "both"]),
  kind: z.enum(["deterministic", "llm"]),
  rule: NonEmptyString,
  example: z.string().optional(),
});

/** Structure of the document without drafting internals. */
export const AstSummaryEntrySchema = z.strictObject({
  sectionId: ItemIdSchema,
  title: NonEmptyString,
  status: SectionStatusSchema,
  slotRefs: z.array(SlotIdSchema),
  citationIds: z.array(NonEmptyString),
});

/** Digest of the sibling document for cross-document consistency checks. */
export const OtherDocDigestSchema = z.strictObject({
  docType: DocTypeSchema,
  sections: z.array(z.strictObject({ sectionId: ItemIdSchema, status: SectionStatusSchema, summary: z.string() })),
  /** Cross-check values such as organization name reference and minimum age. */
  facts: z.record(z.string(), z.string()),
});

export const AuditEnvelopeSchema = z.strictObject({
  docMarkdown: NonEmptyString,
  astSummary: z.array(AstSummaryEntrySchema),
  factLedger: FactLedgerSchema,
  maskedTranscript: MaskedTranscriptSchema,
  formSlots: FormSlotsSchema,
  applicability: ApplicabilityMapSchema,
  mustRuleDigest: z.array(RuleDigestEntrySchema),
  rubricProfile: DocTypeSchema,
  houseStyle: z.array(HouseStyleRuleSchema),
  c2Results: CheckResultsSchema,
  priorFindings: z.array(FindingSchema),
  otherDocDigest: OtherDocDigestSchema.nullable(),
});
export type AuditEnvelope = z.infer<typeof AuditEnvelopeSchema>;

/** The exact allowlist of top-level envelope keys (design R6.3). Sorted for stable comparison. */
export const AUDIT_ENVELOPE_KEYS: readonly string[] = Object.keys(AuditEnvelopeSchema.shape).sort();

/** Field names that must never appear anywhere inside the envelope schema tree. */
export const FORBIDDEN_ENVELOPE_FIELD_PATTERN = /prompt|thinking|reasoning|rationale|vault|piivault/i;
