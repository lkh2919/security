/**
 * Finding and AuditReport (design R4.5, R6.4). R7 emits findings only; it never edits text.
 */
import { z } from "zod";
import { DocTypeSchema, MAX_QUOTE_LENGTH, NonEmptyString, RunIdSchema, Sha256Schema, SeveritySchema, VersionSchema } from "./common";

export const MAX_AUDIT_ITERATIONS = 3;

export const FindingSchema = z.strictObject({
  id: NonEmptyString,
  layer: z.enum(["deterministic", "llm"]),
  /** `R-S05-002` (rule pack), `H-07` (house style), `U-T14-01` (unfair-clause lexicon), ... */
  ruleId: NonEmptyString,
  docType: z.enum(["privacy", "terms", "cross"]),
  sectionId: NonEmptyString,
  severity: SeveritySchema,
  message: NonEmptyString,
  /** Pointer into the AST (`sections[3].blocks[0].runs[1]`) plus a masked quote. */
  evidence: z.strictObject({
    astPath: NonEmptyString,
    quote: z.string().max(MAX_QUOTE_LENGTH),
  }),
  fixHint: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

const ScoreSchema = z.number().min(0).max(5);

export const AuditScoresSchema = z.strictObject({
  legal: ScoreSchema,
  accuracy: ScoreSchema,
  clarity: ScoreSchema,
  houseStyle: ScoreSchema,
  consistency: ScoreSchema,
});
export type AuditScores = z.infer<typeof AuditScoresSchema>;

export const AuditVerdictSchema = z.enum(["pass", "pass_with_warnings", "fail"]);

export const AuditReportSchema = z
  .strictObject({
    runId: RunIdSchema,
    docType: DocTypeSchema,
    iteration: z.number().int().min(1).max(MAX_AUDIT_ITERATIONS),
    /** Hash of the AuditEnvelope the auditor saw, proving what it was (and was not) given. */
    envelopeHash: Sha256Schema,
    rubricVersion: VersionSchema,
    profile: DocTypeSchema,
    scores: AuditScoresSchema,
    verdict: AuditVerdictSchema,
    findings: z.array(FindingSchema),
    resolvedFindingIds: z.array(NonEmptyString),
  })
  .superRefine((report, ctx) => {
    const ids = new Set<string>();
    report.findings.forEach((f, i) => {
      if (ids.has(f.id)) ctx.addIssue({ code: "custom", path: ["findings", i, "id"], message: `duplicate finding id ${f.id}` });
      ids.add(f.id);
    });
    if (report.verdict === "pass" && report.findings.some((f) => f.severity === "blocker" || f.severity === "major")) {
      ctx.addIssue({ code: "custom", path: ["verdict"], message: "verdict pass is incompatible with blocker or major findings" });
    }
  });
export type AuditReport = z.infer<typeof AuditReportSchema>;
