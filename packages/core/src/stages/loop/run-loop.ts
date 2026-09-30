/**
 * Draft -> C2 -> R7 fix loop for ONE document (design R6.4): at most 3 iterations. Each iteration: draft (first pass) or
 * redraft only the flagged sections, run the deterministic checks, build the audit envelope, run the isolated auditor.
 * The loop ends on a `pass` / `pass_with_warnings` verdict, when nothing fixable remains, or after the cap, in which case
 * the document is returned with `escalated: true` so R8 renders the "DRAFT — unresolved findings" banner.
 */
import type { DocAST } from "../../contracts/ast";
import type { Finding } from "../../contracts/audit-report";
import { MAX_AUDIT_ITERATIONS, type AuditReport } from "../../contracts/audit-report";
import type { CheckResults } from "../../contracts/check-results";
import type { Rubric } from "../../contracts/rubric";
import type { TokenUsage } from "../../llm/client";
import { buildAuditEnvelope, runAudit, type AuditDeps, type EnvelopeInput } from "../audit";
import { runC2, type C2Input } from "../check";
import { draftDocument, type DraftDeps, type DraftInput } from "../draft";

export interface LoopInput {
  readonly draft: Omit<DraftInput, "previous" | "fixFindings">;
  readonly c2: Omit<C2Input, "runId" | "docType" | "ast">;
  readonly envelope: Omit<EnvelopeInput, "ast" | "c2Results" | "priorFindings">;
  readonly rubric: Rubric;
  readonly maxIterations?: number;
}

export interface LoopIteration {
  readonly iteration: number;
  readonly redrafted: readonly string[];
  readonly c2: CheckResults;
  readonly report: AuditReport;
}

export interface LoopResult {
  readonly ast: DocAST;
  readonly iterations: readonly LoopIteration[];
  readonly final: AuditReport;
  readonly finalC2: CheckResults;
  /** True when the cap was hit or nothing fixable remained while the verdict was still `fail`. */
  readonly escalated: boolean;
  /** Findings still open at the end: C2 (deterministic) and R7 findings, blocker/major/minor. */
  readonly openFindings: readonly Finding[];
  readonly usage: TokenUsage;
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
});

/** Findings a drafter can act on: they name a real section of the document (or a section that should exist). */
const fixable = (f: Finding): boolean => f.severity !== "info" && f.sectionId !== "-" && f.sectionId !== "$" && /^(S\d{2}|T\d{2}|A1|X1)$/.test(f.sectionId);

export async function runDocumentLoop(deps: { draft: DraftDeps; audit: AuditDeps }, input: LoopInput): Promise<LoopResult> {
  const cap = Math.min(input.maxIterations ?? MAX_AUDIT_ITERATIONS, MAX_AUDIT_ITERATIONS);
  const docType = input.draft.docType;
  const iterations: LoopIteration[] = [];
  let usage = ZERO;
  let ast: DocAST | undefined;
  let fix: Finding[] = [];
  let prior: Finding[] = [];
  let last: { report: AuditReport; c2: CheckResults } | undefined;

  for (let i = 1; i <= cap; i++) {
    const drafted = await draftDocument(deps.draft, { ...input.draft, ...(ast ? { previous: ast, fixFindings: fix } : {}) });
    usage = add(usage, drafted.usage);
    ast = drafted.ast;
    const c2 = runC2({ ...input.c2, runId: input.draft.runId, docType, ast });
    const c2Findings = c2.checks.flatMap((c) => c.findings);
    const envelope = buildAuditEnvelope({ ...input.envelope, ast, c2Results: c2, priorFindings: prior });
    const audited = await runAudit(deps.audit, { runId: input.draft.runId, iteration: i as 1 | 2 | 3, envelope, rubric: input.rubric });
    usage = add(usage, audited.usage);
    iterations.push({ iteration: i, redrafted: [...new Set([...drafted.llmSections, ...drafted.clauseSections])], c2, report: audited.report });
    last = { report: audited.report, c2 };
    if (audited.report.verdict !== "fail") break;

    fix = [...c2Findings, ...audited.report.findings].filter(fixable);
    prior = audited.report.findings;
    if (fix.length === 0) break; // nothing a drafter can fix: escalate now
  }

  const { report, c2 } = last!;
  const open = [...c2.checks.flatMap((c) => c.findings), ...report.findings].filter((f) => f.severity !== "info");
  return { ast: ast!, iterations, final: report, finalC2: c2, escalated: report.verdict === "fail", openFindings: open, usage };
}
