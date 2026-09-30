/**
 * R7 Independent Auditor (design R6.3, R6.4): one Opus call per document per iteration. The auditor receives ONLY the
 * AuditEnvelope and the rubric; it emits findings and scores, never text. Code owns everything that must be exact:
 * finding ids, evidence-quote verification, rule-id validation, the houseStyle score when no rule is approved, and the verdict.
 */
import { z } from "zod";
import { AUDIT_ENVELOPE_KEYS, type AuditEnvelope } from "../../contracts/audit-envelope";
import { AuditReportSchema, type AuditReport, type Finding } from "../../contracts/audit-report";
import { SeveritySchema } from "../../contracts/common";
import type { Rubric } from "../../contracts/rubric";
import type { LlmClient, TokenUsage } from "../../llm/client";
import { wrapUntrusted, UNTRUSTED_NOTICE } from "../intake/sanitize";
import { loadPromptFile, type PromptFile } from "../extract/prompt";
import { envelopeHash } from "./envelope";
import { renderRubric } from "./rubric-prompt";

export const AUDIT_PROMPT_PATH = "audit/v1.md";

const Score = z.number();
export const AuditOutputSchema = z.strictObject({
  scores: z.strictObject({ legal: Score, accuracy: Score, clarity: Score, houseStyle: Score, consistency: Score }),
  findings: z.array(
    z.strictObject({
      ruleId: z.string(),
      docType: z.enum(["privacy", "terms", "cross"]),
      sectionId: z.string(),
      severity: SeveritySchema,
      message: z.string(),
      astPath: z.string(),
      quote: z.string(),
      fixHint: z.string(),
    }),
  ),
  resolvedFindingIds: z.array(z.string()),
});
export type AuditOutput = z.infer<typeof AuditOutputSchema>;

export interface AuditDeps {
  readonly llm: LlmClient;
  readonly prompt?: PromptFile;
}

export interface AuditInput {
  readonly runId: string;
  readonly iteration: 1 | 2 | 3;
  readonly envelope: AuditEnvelope;
  readonly rubric: Rubric;
}

export interface AuditResult {
  readonly report: AuditReport;
  /** Findings the code re-labelled or whose quote could not be verified (for the run log). */
  readonly adjustments: readonly string[];
  readonly usage: TokenUsage;
}

const RULE_ID = /^(R-(S\d{2}|T\d{2}|A1|X1)-\d{3}|H-\d{2,3}|U-[A-Z0-9-]+|X-0[1-4])$/;
const UNMAPPED = "R7-UNMAPPED";
const clamp = (n: number): number => Math.min(5, Math.max(0, n));

export function computeVerdict(args: { scores: AuditReport["scores"]; findings: readonly Finding[]; c2Passed: boolean; rubric: Rubric; hasManualReview: boolean }): AuditReport["verdict"] {
  const r = args.rubric.passRule;
  const blockers = args.findings.filter((f) => f.severity === "blocker").length;
  const majors = args.findings.filter((f) => f.severity === "major").length;
  const low = Object.entries(args.scores).some(([dim, v]) => v < (dim === "clarity" ? r.minClarityScore : r.minScore));
  if (blockers > r.maxBlocker || majors > r.maxMajor || !args.c2Passed || low) return "fail";
  return args.findings.some((f) => f.severity === "minor") || args.hasManualReview ? "pass_with_warnings" : "pass";
}

export async function runAudit(deps: AuditDeps, input: AuditInput): Promise<AuditResult> {
  const { envelope, rubric } = input;
  const prompt = deps.prompt ?? loadPromptFile(AUDIT_PROMPT_PATH);
  const hash = envelopeHash(envelope);
  const res = await deps.llm.callStructured({
    stageId: "R7",
    system: `${prompt.body}\n\n${renderRubric(rubric, envelope.rubricProfile)}\n\n${UNTRUSTED_NOTICE}`,
    user: wrapUntrusted(JSON.stringify(envelope)),
    schema: AuditOutputSchema,
    schemaName: "AuditOutput",
    promptVersion: prompt.version,
  });
  const out = res.data;
  const adjustments: string[] = [];

  const knownRules = new Set([...envelope.mustRuleDigest.map((r) => r.ruleId), ...envelope.houseStyle.map((h) => h.id)]);
  const hasStyle = envelope.houseStyle.length > 0;
  const findings: Finding[] = [];
  let n = 0;
  for (const f of out.findings) {
    if (!hasStyle && f.ruleId.startsWith("H-")) {
      adjustments.push(`dropped house-style finding ${f.ruleId}: no approved rule`);
      continue;
    }
    let { ruleId, severity } = f;
    const shaped = RULE_ID.test(ruleId);
    const styleOk = !ruleId.startsWith("H-") || knownRules.has(ruleId);
    if (!shaped || !styleOk) {
      adjustments.push(`relabelled ${ruleId} as ${UNMAPPED} (capped to minor)`);
      ruleId = UNMAPPED;
      severity = "minor";
    } else if (/^R-/.test(ruleId) && !knownRules.has(ruleId) && (severity === "blocker" || severity === "major")) {
      // Only must rules are in the digest; a should-level (or unknown) rule cannot carry a blocking severity.
      adjustments.push(`capped ${ruleId} to minor: not a must rule of this document`);
      severity = "minor";
    }
    let quote = f.quote.slice(0, 300);
    if (quote && !envelope.docMarkdown.includes(quote) && !quote.split(/\s+/).every((w) => envelope.docMarkdown.includes(w))) {
      adjustments.push(`cleared unverifiable quote of ${ruleId} in ${f.sectionId}`);
      quote = "";
    }
    n += 1;
    findings.push({ id: `A${input.iteration}-${String(n).padStart(2, "0")}`, layer: "llm", ruleId, docType: f.docType, sectionId: f.sectionId, severity, message: f.message, evidence: { astPath: f.astPath || "$", quote }, fixHint: f.fixHint });
  }

  const scores = { ...Object.fromEntries(Object.entries(out.scores).map(([k, v]) => [k, clamp(v)])) } as AuditReport["scores"];
  if (!hasStyle) scores.houseStyle = 5; // nothing approved to violate (rubric houseStyleNote)
  const priorIds = new Set(envelope.priorFindings.map((p) => p.id));
  const resolved = out.resolvedFindingIds.filter((id) => priorIds.has(id));
  const hasManualReview = envelope.astSummary.some((s) => s.status === "manual_review");
  const verdict = computeVerdict({ scores, findings, c2Passed: envelope.c2Results.passed, rubric, hasManualReview });

  const report = AuditReportSchema.parse({
    runId: input.runId,
    docType: envelope.rubricProfile,
    iteration: input.iteration,
    envelopeHash: hash,
    rubricVersion: rubric.version,
    profile: envelope.rubricProfile,
    scores,
    verdict,
    findings,
    resolvedFindingIds: resolved,
  });
  return { report, adjustments, usage: res.usage };
}

/** Top-level keys the auditor can see; asserted in tests together with `AUDIT_ENVELOPE_KEYS`. */
export const AUDITOR_VISIBLE_KEYS: readonly string[] = AUDIT_ENVELOPE_KEYS;
