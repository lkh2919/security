/**
 * Rubric v1 and seeded-defect specs (design R6.1, R6.3, R11.1).
 * On disk: `kb/jurisdictions/kr/rubric/rubric-v1.json` and `golden/defects/D*.json` (content owned by the
 * privacy-domain-expert). The auditor prompt (`prompts/audit/`, Row 11) is generated from the rubric; drafters never read it.
 */
import { z } from "zod";
import { ItemIdSchema, IsoDateSchema, NonEmptyString, SeveritySchema, VersionSchema } from "./common";

export const SCORE_DIMENSIONS = ["legal", "accuracy", "clarity", "houseStyle", "consistency"] as const;
export const ScoreDimensionSchema = z.enum(SCORE_DIMENSIONS);

const AnchorTableSchema = z.strictObject({
  "0": NonEmptyString,
  "1": NonEmptyString,
  "2": NonEmptyString,
  "3": NonEmptyString,
  "4": NonEmptyString,
  "5": NonEmptyString,
});

/** Cross-document check id: `X-01`..`X-04`. */
export const CrossCheckIdSchema = z.string().regex(/^X-\d{2}$/);

export const RubricSectionCheckSchema = z.strictObject({
  sectionId: ItemIdSchema,
  title: NonEmptyString,
  classification: z.enum(["mandatory", "conditional", "recommended"]),
  mustRuleIds: z.array(z.string().regex(/^R-/)),
  shouldRuleIds: z.array(z.string().regex(/^R-/)),
});

export const RubricSchema = z
  .strictObject({
    version: VersionSchema,
    status: z.enum(["draft", "approved"]),
    effective: IsoDateSchema,
    rulePackVersions: z.array(NonEmptyString).min(1),
    sharedLayer: z.strictObject({
      principles: z.array(z.strictObject({ id: NonEmptyString, name: NonEmptyString, description: NonEmptyString })).min(3),
      scoreAnchors: z.strictObject({
        legal: AnchorTableSchema,
        accuracy: AnchorTableSchema,
        clarity: AnchorTableSchema,
        houseStyle: AnchorTableSchema,
        consistency: AnchorTableSchema,
      }),
      severityGuide: z.strictObject({ blocker: NonEmptyString, major: NonEmptyString, minor: NonEmptyString, info: NonEmptyString }),
      houseStyleNote: NonEmptyString,
    }),
    profiles: z.strictObject({
      privacy: z.strictObject({ sectionChecks: z.array(RubricSectionCheckSchema).min(1), extraChecks: z.array(NonEmptyString) }),
      terms: z.strictObject({ sectionChecks: z.array(RubricSectionCheckSchema).min(1), unfairClauseLexicon: NonEmptyString, extraChecks: z.array(NonEmptyString) }),
    }),
    crossDocumentChecks: z
      .array(z.strictObject({ id: CrossCheckIdSchema, name: NonEmptyString, description: NonEmptyString, defaultSeverity: SeveritySchema }))
      .length(4),
    passRule: z.strictObject({ maxBlocker: z.literal(0), maxMajor: z.literal(0), minScore: z.literal(4), minClarityScore: z.literal(3), c2MustPass: z.literal(true) }),
    seededDefects: z.array(z.string().regex(/^D\d$/)).length(8),
    changelog: z.array(z.strictObject({ version: VersionSchema, date: IsoDateSchema, note: NonEmptyString })).min(1),
  })
  .superRefine((r, ctx) => {
    const ids = r.crossDocumentChecks.map((c) => c.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["crossDocumentChecks"], message: "duplicate cross-document check id" });
  });
export type Rubric = z.infer<typeof RubricSchema>;

/** One seeded defect: apply `mutation` to the reference draft of `baseCase`; R7 must report `expected`. */
export const DefectSpecSchema = z.strictObject({
  id: z.string().regex(/^D\d$/),
  docType: z.enum(["privacy", "terms", "cross"]),
  baseCase: z.string().regex(/^(G|W)\d[a-z]?$/),
  defectClass: NonEmptyString,
  sectionId: NonEmptyString,
  mutation: z.strictObject({
    kind: z.enum(["replace", "remove", "insert"]),
    /** English instruction for the harness, applied to the reference draft's section. */
    instruction: NonEmptyString,
    /** Korean text that IS the defect (inserted or substituted). Absent for pure removals. */
    defectiveText: z.string().optional(),
  }),
  expected: z.strictObject({
    ruleId: NonEmptyString,
    docType: z.enum(["privacy", "terms", "cross"]),
    sectionId: NonEmptyString,
    severity: SeveritySchema,
    /** Layer expected to catch it first: deterministic (C2) defects still count toward R7 recall only if `llm`. */
    layer: z.enum(["deterministic", "llm"]),
  }),
  rationale: NonEmptyString,
  sources: z.array(NonEmptyString).min(1),
});
export type DefectSpec = z.infer<typeof DefectSpecSchema>;
