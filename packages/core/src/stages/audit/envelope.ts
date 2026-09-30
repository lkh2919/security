/**
 * Builds the AuditEnvelope (design R6.3): the ONLY input the isolated auditor receives. Everything goes through the
 * strict `AuditEnvelopeSchema`, which has no field for drafter prompts, drafter reasoning or clause-selection rationale.
 * This module deliberately takes no ClauseSelection and no prompt text.
 */
import { AuditEnvelopeSchema, type AuditEnvelope } from "../../contracts/audit-envelope";
import type { ApplicabilityMap } from "../../contracts/applicability";
import type { DocAST } from "../../contracts/ast";
import type { Finding } from "../../contracts/audit-report";
import type { CheckResults } from "../../contracts/check-results";
import type { FactLedger } from "../../contracts/fact-ledger";
import type { FormSlots } from "../../contracts/form-slots";
import { houseStyleDigest, type HouseStyleFile } from "../../contracts/house-style";
import type { MaskedTranscript } from "../../contracts/masked-transcript";
import type { RuleSection } from "../../contracts/rulepack";
import { hashJson } from "../../pipeline/canonical";
import { renderMarkdown } from "../render";

export interface EnvelopeInput {
  readonly ast: DocAST;
  readonly ledger: FactLedger;
  readonly transcript: MaskedTranscript;
  readonly formSlots: FormSlots;
  readonly applicability: ApplicabilityMap;
  readonly ruleSections: ReadonlyMap<string, RuleSection>;
  readonly houseStyle: HouseStyleFile;
  readonly c2Results: CheckResults;
  readonly priorFindings?: readonly Finding[];
  /** Sibling document and its cross-check facts; null for a single-document run. */
  readonly other?: { readonly ast: DocAST; readonly facts: Readonly<Record<string, string>> } | null;
}

const summary = (ast: DocAST): string[] =>
  ast.sections.map((s) => {
    const t = s.blocks
      .map((b) => (b.t === "para" || b.t === "note" ? b.runs.map((r) => (r.t === "text" || r.t === "link" ? r.text : "")).join("") : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return t.slice(0, 200);
  });

export function buildAuditEnvelope(input: EnvelopeInput): AuditEnvelope {
  const { ast } = input;
  // Must rules of the sections the document actually contains: the compressed digest, not the whole pack.
  const mustRuleDigest = ast.sections
    .filter((s) => s.status !== "not_applicable")
    .flatMap((s) => (input.ruleSections.get(s.id)?.rules ?? []).filter((r) => r.level === "must").map((r) => ({ ruleId: r.ruleId, sectionId: r.sectionId, statement: r.statement, legalRefs: [...r.legalRefs] })));
  const approved = input.houseStyle.rules.filter((r) => r.status === "approved" && (r.scope === ast.docType || r.scope === "both"));
  const otherSummaries = input.other ? summary(input.other.ast) : [];
  return AuditEnvelopeSchema.parse({
    docMarkdown: renderMarkdown(ast),
    astSummary: ast.sections.map((s) => ({ sectionId: s.id, title: s.title, status: s.status, slotRefs: s.trace.slotRefs, citationIds: s.trace.citationIds })),
    factLedger: input.ledger,
    maskedTranscript: input.transcript,
    formSlots: input.formSlots,
    applicability: input.applicability,
    mustRuleDigest,
    rubricProfile: ast.docType,
    houseStyle: approved.map(houseStyleDigest),
    c2Results: input.c2Results,
    priorFindings: [...(input.priorFindings ?? [])],
    otherDocDigest: input.other
      ? { docType: input.other.ast.docType, sections: input.other.ast.sections.map((s, i) => ({ sectionId: s.id, status: s.status, summary: otherSummaries[i] ?? "" })), facts: { ...input.other.facts } }
      : null,
  });
}

/** Proves what the auditor saw (and therefore did not see): stored in the AuditReport. */
export const envelopeHash = (envelope: AuditEnvelope): string => hashJson(envelope);
