/**
 * MonitorFinding and MonitorReport (Policy Monitor design M4, M5). A finding extends the audit `Finding` shape: the AST
 * pointer and docType are replaced by a published-text location, and severity uses the monitor scale (design M4).
 *
 * Tiers: `confirmed` findings come from rule packs the domain expert reviewed (Mode A) or from an amendment the expert verified;
 * `provisional` findings are automatic, labelled unverified and never above Medium.
 */
import { z } from "zod";
import { IsoDateSchema, IsoDateTimeSchema, MAX_QUOTE_LENGTH, NonEmptyString, RunIdSchema, Sha256Schema, VersionSchema } from "./common";
import { FindingSchema } from "./audit-report";
import { PolicyIdSchema } from "./ingested-policy";
import { UrgencySignalSchema } from "./peers";

/** The only disclaimer line a report may carry (design M1). */
export const MONITOR_DISCLAIMER = "참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다.";

export const MONITOR_SEVERITIES = ["critical", "high", "medium", "low", "confirm"] as const;
export const MonitorSeveritySchema = z.enum(MONITOR_SEVERITIES);
export type MonitorSeverity = z.infer<typeof MonitorSeveritySchema>;

export const MonitorTierSchema = z.enum(["provisional", "confirmed"]);
export type MonitorTier = z.infer<typeof MonitorTierSchema>;

export const MonitorLocationSchema = z.strictObject({
  /** `S01`..`S24`, `A1`, `X1`, or `UNMAPPED`. */
  sectionId: NonEmptyString,
  /** 1-based paragraph inside the section; null when the finding concerns the section as a whole or the text was not located. */
  para: z.number().int().positive().nullable(),
  /** Verbatim excerpt of the (masked) published text; empty for omissions. */
  quote: z.string().max(MAX_QUOTE_LENGTH),
});

export const MonitorTriggerSchema = z.strictObject({
  law: NonEmptyString,
  /** Legal-ref key of the amended unit (`PIPA:38(1)`). */
  articleKey: NonEmptyString,
  effectiveOn: IsoDateSchema.nullable(),
});

export const MonitorFindingSchema = FindingSchema.omit({ docType: true, severity: true, evidence: true })
  .extend({
    mode: z.enum(["A", "B"]),
    severity: MonitorSeveritySchema,
    tier: MonitorTierSchema,
    location: MonitorLocationSchema,
    trigger: MonitorTriggerSchema.optional(),
    /** Merged Confirm finding (Mode A): every rule id it covers, and one short question per rule. */
    ruleIds: z.array(NonEmptyString).optional(),
    questions: z.array(z.string()).optional(),
    /** Peer Watch (design C5): "raised" when a group-adoption signal attaches. Moves ordering only, never the severity. */
    priority: z.enum(["normal", "raised"]).optional(),
    /** Group-adoption signals attached to a Mode B finding (reference only, "업계 동향(참고) — 법적 요구사항 아님"). */
    evidence: z.array(UrgencySignalSchema).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.tier === "provisional" && (f.severity === "critical" || f.severity === "high")) {
      ctx.addIssue({ code: "custom", path: ["severity"], message: "a provisional finding is capped at medium" });
    }
    if (f.mode === "B" && !f.trigger) ctx.addIssue({ code: "custom", path: ["trigger"], message: "an amendment-impact finding needs its trigger" });
    if (f.sectionId !== f.location.sectionId) ctx.addIssue({ code: "custom", path: ["location", "sectionId"], message: "location.sectionId must equal sectionId" });
  });
export type MonitorFinding = z.infer<typeof MonitorFindingSchema>;

const SeverityCountsSchema = z.strictObject({ critical: z.number().int().nonnegative(), high: z.number().int().nonnegative(), medium: z.number().int().nonnegative(), low: z.number().int().nonnegative(), confirm: z.number().int().nonnegative() });

export const MonitorSummarySchema = z.strictObject({
  total: z.number().int().nonnegative(),
  bySeverity: SeverityCountsSchema,
});
export type MonitorSummary = z.infer<typeof MonitorSummarySchema>;

export function summarizeFindings(findings: readonly Pick<MonitorFinding, "severity">[]): MonitorSummary {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, confirm: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;
  return { total: findings.length, bySeverity };
}

export const MonitorReportSchema = z
  .strictObject({
    runId: RunIdSchema,
    policyId: PolicyIdSchema,
    policySha: Sha256Schema,
    rulePackVersion: VersionSchema,
    checkedAt: IsoDateTimeSchema,
    findings: z.array(MonitorFindingSchema),
    summary: MonitorSummarySchema,
    /** False when only the deterministic part ran (no model backend). */
    llmUsed: z.boolean(),
    /** Non-blocking notes: LLM skipped, unmapped blocks, hidden elements removed, unsupported format. */
    warnings: z.array(z.string()),
    disclaimer: z.literal(MONITOR_DISCLAIMER),
  })
  .superRefine((r, ctx) => {
    const ids = new Set<string>();
    r.findings.forEach((f, i) => {
      if (ids.has(f.id)) ctx.addIssue({ code: "custom", path: ["findings", i, "id"], message: `duplicate finding id ${f.id}` });
      ids.add(f.id);
    });
    const expected = summarizeFindings(r.findings);
    if (JSON.stringify(expected) !== JSON.stringify(r.summary)) ctx.addIssue({ code: "custom", path: ["summary"], message: "summary does not match the findings" });
  });
export type MonitorReport = z.infer<typeof MonitorReportSchema>;
