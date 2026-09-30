/**
 * ClauseRecord (Lotte clause library entry, design R5.3) and ClauseSelection (R4 output).
 */
import { z } from "zod";
import {
  CondSchema,
  DocTypeSchema,
  IsoDateSchema,
  ItemIdSchema,
  NonEmptyString,
  RunIdSchema,
  Sha256Schema,
  SlotIdSchema,
  VersionSchema,
} from "./common";

export const ClauseProvenanceSchema = z.strictObject({
  sourceUrl: z.url(),
  affiliate: NonEmptyString,
  businessGroup: NonEmptyString,
  captureDate: IsoDateSchema,
  policyEffectiveDate: IsoDateSchema.optional(),
  contentHash: Sha256Schema,
});

export const ClauseRecordSchema = z.strictObject({
  clauseId: NonEmptyString,
  docType: DocTypeSchema,
  itemIds: z.array(ItemIdSchema).min(1),
  /** Body with `{{var}}` substitution and `{%if cond%}...{%endif%}` blocks, rendered by code. */
  body: NonEmptyString,
  vars: z.array(z.strictObject({ name: NonEmptyString, slotPath: SlotIdSchema })),
  conditions: z.array(CondSchema),
  provenance: ClauseProvenanceSchema,
  vetted: z.boolean(),
  /** Rule pack version the clause was vetted against. Required when vetted. */
  vettedAgainst: VersionSchema.optional(),
  styleRefs: z.array(NonEmptyString),
});
export type ClauseRecord = z.infer<typeof ClauseRecordSchema>;

/** Only vetted clauses may reach R4 (design R5.3). */
export const VettedClauseRecordSchema = ClauseRecordSchema.refine((c) => c.vetted && !!c.vettedAgainst, {
  message: "clause must be vetted and record vettedAgainst",
});

export const ClauseCandidateSchema = z.strictObject({
  clauseId: NonEmptyString,
  rank: z.number().int().positive(),
  /** Whether the ledger covers all vars and conditions: `full` allows code-only rendering. */
  coverage: z.enum(["full", "partial", "none"]),
  missingVars: z.array(SlotIdSchema),
});

export const ClauseSelectionSchema = z.strictObject({
  runId: RunIdSchema,
  clauseLibVersion: VersionSchema,
  houseStyleVersion: VersionSchema,
  businessGroup: NonEmptyString,
  /** How the group was decided: pure code rules or the haiku fallback (R4). */
  groupMethod: z.enum(["rule", "llm_fallback"]),
  /** Candidates per item, best first. Items without vetted clauses map to an empty candidate list. */
  sections: z.record(ItemIdSchema, z.strictObject({ candidates: z.array(ClauseCandidateSchema), styleRefs: z.array(NonEmptyString) })),
  /**
   * Human-readable selection rationale. NEVER forwarded to the auditor: it is deliberately absent
   * from AuditEnvelope (design R6.3).
   */
  rationale: z.string().optional(),
});
export type ClauseSelection = z.infer<typeof ClauseSelectionSchema>;
