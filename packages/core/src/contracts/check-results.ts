/**
 * CheckResults: C2 deterministic pre-output validation (design R6.2). Zero-token layer.
 */
import { z } from "zod";
import { DocTypeSchema, NonEmptyString, RunIdSchema } from "./common";
import { FindingSchema } from "./audit-report";

export const CheckCategorySchema = z.enum(["structure", "evidence", "style", "safety", "cross_doc"]);

export const CheckOutcomeSchema = z.strictObject({
  checkId: NonEmptyString,
  category: CheckCategorySchema,
  passed: z.boolean(),
  /** Deterministic-layer findings; a failed check must explain itself. */
  findings: z.array(FindingSchema),
});

export const CheckResultsSchema = z
  .strictObject({
    runId: RunIdSchema,
    docType: DocTypeSchema,
    /** True only when every check passed. */
    passed: z.boolean(),
    checks: z.array(CheckOutcomeSchema),
  })
  .superRefine((r, ctx) => {
    const allPassed = r.checks.every((c) => c.passed);
    if (r.passed !== allPassed) ctx.addIssue({ code: "custom", path: ["passed"], message: "passed must equal the conjunction of all checks" });
    r.checks.forEach((c, i) => {
      if (!c.passed && c.findings.length === 0) ctx.addIssue({ code: "custom", path: ["checks", i, "findings"], message: "failed check needs at least one finding" });
    });
  });
export type CheckResults = z.infer<typeof CheckResultsSchema>;
