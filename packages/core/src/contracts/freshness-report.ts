/**
 * FreshnessReport: R6 output (design R5.6). Drift never blocks drafting; it adds notes and a watermark.
 */
import { z } from "zod";
import { IsoDateTimeSchema, ItemIdSchema, NonEmptyString, RunIdSchema } from "./common";

export const FreshnessSourceSchema = z.strictObject({
  sourceId: NonEmptyString,
  kind: z.enum(["law_api", "official_page"]),
  name: NonEmptyString,
  /** Version stamp in the manifest (law ID/MST, or page title hash). */
  stampedVersion: z.string(),
  /** Version observed now. Null when the check failed. */
  observedVersion: z.string().nullable(),
  outcome: z.enum(["unchanged", "changed", "check_failed"]),
  /** True when the official page was used because the law API failed. */
  fallbackUsed: z.boolean(),
});

export const FreshnessReportSchema = z
  .strictObject({
    runId: RunIdSchema,
    checkedAt: IsoDateTimeSchema,
    /** Results are cached for 24 hours (design R5.6). */
    validUntil: IsoDateTimeSchema,
    /** `unverified` means every source failed: the Reviewer Sheet states "freshness unverified". */
    status: z.enum(["current", "drift", "unverified"]),
    sources: z.array(FreshnessSourceSchema),
    /** Sections touched by changed laws, mapped by code from the legalRefs reverse index. */
    affectedSections: z.array(
      z.strictObject({
        itemId: ItemIdSchema,
        sourceIds: z.array(NonEmptyString).min(1),
        /** Short Haiku-written summary of the change; may be empty when unavailable. */
        summary: z.string(),
      }),
    ),
  })
  .superRefine((r, ctx) => {
    const failed = r.sources.filter((s) => s.outcome === "check_failed").length;
    if (r.status === "unverified" && r.sources.length > 0 && failed !== r.sources.length) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "unverified requires every source check to have failed" });
    }
    if (r.status === "drift" && !r.sources.some((s) => s.outcome === "changed")) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "drift requires at least one changed source" });
    }
  });
export type FreshnessReport = z.infer<typeof FreshnessReportSchema>;
