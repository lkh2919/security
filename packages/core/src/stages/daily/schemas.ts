/** Artifacts of the daily chain steps (one typed JSON per RunStore stage). No policy text, no contacts. */
import { z } from "zod";
import { AmendmentUnitSchema } from "../../contracts/amendment-diff";
import { NonEmptyString, Sha256Schema } from "../../contracts/common";
import { FreshnessReportSchema } from "../../contracts/freshness-report";
import { MonitorFindingSchema, MonitorReportSchema } from "../../contracts/monitor-report";
import { ChangedSectionSchema, UrgencySignalSchema } from "../../contracts/peers";

export const FreshnessChangeSchema = z.strictObject({
  sourceId: NonEmptyString,
  kind: z.enum(["unstamped", "amendment_promulgated", "effective_date_reached", "upcoming_effective", "guideline_edition_change", "standard_terms_revision", "source_unreachable"]),
  severity: z.enum(["info", "warn", "error"]),
  message: z.string(),
  manualReview: z.boolean().optional(),
  affectedSections: z.array(z.string()).optional(),
  oldMst: z.string().optional(),
  newMst: z.string().optional(),
  newEffectiveOn: z.string().optional(),
});

export const DailyFreshnessSchema = z.strictObject({
  status: z.enum(["ran", "skipped"]),
  note: z.string().optional(),
  report: FreshnessReportSchema.optional(),
  changes: z.array(FreshnessChangeSchema),
  /** sourceId -> observed current law version. */
  observedLaws: z.record(z.string(), z.strictObject({ name: z.string(), target: z.enum(["law", "admrul"]), mst: z.string(), lawId: z.string(), effectiveOn: z.string().nullable() })),
});
export type DailyFreshness = z.infer<typeof DailyFreshnessSchema>;

export const DailyDiffResultSchema = z.strictObject({
  sourceId: NonEmptyString,
  lawCode: NonEmptyString,
  oldMst: NonEmptyString,
  newMst: NonEmptyString,
  effectiveOn: z.string().nullable(),
  unitCount: z.number().int().nonnegative(),
  diffHash: Sha256Schema,
  manualReview: z.boolean(),
  unmapped: z.array(MonitorFindingSchema),
  /** policyId -> Mode B findings. */
  perPolicy: z.record(z.string(), z.array(MonitorFindingSchema)),
  warnings: z.array(z.string()),
  llmUsed: z.boolean(),
  /** The changed units, kept so the peers step can align peer changes with the amendment (Peer Watch P1). */
  units: z.array(AmendmentUnitSchema).optional(),
});

export const DailyImpactSchema = z.strictObject({
  status: z.enum(["ran", "skipped"]),
  diffs: z.array(DailyDiffResultSchema),
  /** Why a change was not diffed (no old MST, admrul, no prefix, app disabled ...). */
  notes: z.array(z.string()),
});
export type DailyImpact = z.infer<typeof DailyImpactSchema>;

export const DailyRecheckSchema = z.strictObject({
  status: z.enum(["ran", "skipped"]),
  reports: z.array(MonitorReportSchema),
  skippedUnchanged: z.array(z.string()),
  notes: z.array(z.string()),
});
export type DailyRecheck = z.infer<typeof DailyRecheckSchema>;

export const PeerOutcomeSchema = z.strictObject({
  id: NonEmptyString,
  groupId: NonEmptyString,
  name: z.string(),
  kind: z.enum(["peer", "lotte"]),
  status: z.enum(["unchanged", "changed", "baseline", "cosmetic", "skipped", "failed"]),
  reason: z.string().optional(),
  changedSections: z.array(ChangedSectionSchema).optional(),
});

export const AlignmentSchema = z.strictObject({
  articleKey: NonEmptyString,
  sectionId: NonEmptyString,
  confidence: z.enum(["high", "medium", "low"]),
  basis: z.enum(["cites_article", "quotes_new_wording", "new_terms", "section_timing"]),
});

export const PeerSignalsSchema = z.strictObject({
  peerChanged: z.array(z.strictObject({ peerId: NonEmptyString, groupId: NonEmptyString, detectedAt: z.string(), sectionIds: z.array(z.string()) })),
  peerAligned: z.array(z.strictObject({ peerId: NonEmptyString, groupId: NonEmptyString, detectedAt: z.string(), alignments: z.array(AlignmentSchema) })),
  groupAdoption: z.array(UrgencySignalSchema),
});

/** Peer Watch step: outcomes and signals (hashes, short masked quotes), plus Mode A reports of changed Lotte captures. */
export const DailyPeersSchema = z.strictObject({
  status: z.enum(["ran", "skipped"]),
  notes: z.array(z.string()),
  dryRun: z.boolean().optional(),
  outcomes: z.array(PeerOutcomeSchema),
  signals: PeerSignalsSchema,
  /** Mode A reports of Lotte captures that were new or changed (policyId = capture id). */
  lotteReports: z.array(MonitorReportSchema),
  reportFile: z.string().optional(),
});
export type DailyPeers = z.infer<typeof DailyPeersSchema>;

export const DailyDigestSchema = z.strictObject({
  digestFile: NonEmptyString,
  reportFiles: z.array(NonEmptyString),
  registryUpdated: z.boolean(),
});
export type DailyDigest = z.infer<typeof DailyDigestSchema>;
