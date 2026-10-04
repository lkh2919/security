/**
 * Auditor calibration on seeded defects (design R6.3, R11.2 "seeded-defect recall >= 0.90").
 *
 * For each defect spec in `golden/defects/`, take a base draft of its case (a saved draft from a previous live run when one is
 * given, otherwise ONE drafting pass without the audit loop), inject the defect, run C2 and ONE isolated audit, and count the
 * defect as detected when the auditor reports the expected rule in the expected section. Only the auditor (layer llm) counts
 * toward recall; whether C2 also caught it is reported separately.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DocASTSchema, type DocAST } from "../contracts/ast";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../contracts/fact-ledger";
import { HouseStyleFileSchema } from "../contracts/house-style";
import { DefectSpecSchema, type DefectSpec } from "../contracts/rubric";
import type { LlmClient, TokenUsage } from "../llm/client";
import { TextFileSttAdapter } from "../adapters/stt";
import { buildAuditEnvelope, loadRubric, runAudit } from "../stages/audit";
import { crossFactsFor, loadCitations, runC2, statedFacts, type LexiconEntry } from "../stages/check";
import { krPaths, loadKrKnowledge, runCoverage } from "../stages/coverage";
import { draftDocument, loadRuleSections } from "../stages/draft";
import { runIntake } from "../stages/intake";
import { loadClauseLibrary, runMatch } from "../stages/match";
import { applyDefect } from "./defects";
import { defectDetected } from "./metrics";

export interface CalibrationOptions {
  readonly root: string;
  /** Folder with saved drafts named `<caseId>.<docType>.json` (from a live regression run). Missing drafts are generated. */
  readonly draftsDir?: string;
  /** Defect ids to run (default: all). */
  readonly defects?: readonly string[];
  readonly effectiveDate?: string;
}

export interface DefectOutcome {
  readonly id: string;
  readonly expectedRule: string;
  readonly expectedSection: string;
  /** The auditor reported the expected rule in the expected section. */
  readonly detected: boolean;
  /** C2 (deterministic) also flagged the section. */
  readonly c2Flagged: boolean;
  /** What the auditor reported in the expected section instead (rule ids), for misses. */
  readonly auditorRulesInSection: readonly string[];
  /** The auditor's messages in the expected section (and cross-document findings), for diagnosing misses. */
  readonly auditorMessages: readonly string[];
  readonly baseDraft: "saved" | "generated";
}

export interface CalibrationResult {
  readonly outcomes: readonly DefectOutcome[];
  readonly recall: number;
  readonly usage: TokenUsage;
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const addU = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
});

export async function runDefectCalibration(deps: { draftLlm: LlmClient; auditLlm: LlmClient }, opts: CalibrationOptions): Promise<CalibrationResult> {
  const { root } = opts;
  const kr = join(root, "kb", "jurisdictions", "kr");
  const kb = loadKrKnowledge(krPaths(root));
  const rubric = loadRubric(kr);
  const library = loadClauseLibrary(kr, kb.registry);
  const ruleSections = loadRuleSections(join(kr, "rulepacks"));
  const citations = loadCitations(kr);
  const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(kr, "house-style", "lotte-innovate.candidates.json"), "utf8")));
  const lexicon = (JSON.parse(readFileSync(join(kr, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json"), "utf8")) as { entries: LexiconEntry[] }).entries;
  const runId = "20260930-120000-0a1b2c";
  const effectiveDate = opts.effectiveDate ?? "2026-10-01";
  const specs: DefectSpec[] = readdirSync(join(root, "golden", "defects"))
    .filter((f) => /^D\d\.json$/.test(f))
    .sort()
    .map((f) => DefectSpecSchema.parse(JSON.parse(readFileSync(join(root, "golden", "defects", f), "utf8"))))
    .filter((d) => !opts.defects || opts.defects.includes(d.id));

  let usage = ZERO;
  const cases = new Map<string, Awaited<ReturnType<typeof prepare>>>();
  async function prepare(caseId: string) {
    const dir = join(root, "golden", "cases", caseId);
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as { slots: Record<string, unknown> };
    const intake = runIntake({ runId, transcript: await new TextFileSttAdapter().transcribe(join(dir, "input", "transcript.ko.txt")), form: readFileSync(join(dir, "input", "form.ko.txt"), "utf8") });
    const slots: Record<string, SlotEntry> = {};
    for (const [k, v] of Object.entries(expected.slots)) {
      slots[k] = v === "needs_manual_review" ? { status: "needs_manual_review", value: null, confidence: 0, evidence: [] } : { status: "filled", value: v as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: `golden:${caseId}`, quote: "" }] };
    }
    const ledger: FactLedger = createFactLedgerSchema(kb.registry).parse({ runId, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots });
    const { applicability } = runCoverage({ runId, ledger, template: kb.template, rulePackItems: kb.rulePackItems, termsItems: kb.termsItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: kb.termsPackAvailable });
    const { selection } = await runMatch({ runId, ledger, applicability, library, houseStyle });
    return { intake, ledger, applicability, selection, docs: new Map<string, { ast: DocAST; source: "saved" | "generated" }>() };
  }
  async function baseDraft(caseId: string, docType: "privacy" | "terms") {
    const c = cases.get(caseId) ?? (await prepare(caseId));
    cases.set(caseId, c);
    const hit = c.docs.get(docType);
    if (hit) return { c, ...hit };
    const saved = opts.draftsDir ? join(opts.draftsDir, `${caseId}.${docType}.json`) : undefined;
    let entry: { ast: DocAST; source: "saved" | "generated" };
    if (saved && existsSync(saved)) entry = { ast: DocASTSchema.parse(JSON.parse(readFileSync(saved, "utf8"))) as DocAST, source: "saved" };
    else {
      const r = await draftDocument({ llm: deps.draftLlm }, { docType, runId, effectiveDate, lawSnapshotId: "law-2026-09-29", rulePackVersion: kb.rulePackVersion, ledger: c.ledger, applicability: c.applicability, selection: c.selection, library, ruleSections, houseStyle, citations });
      usage = addU(usage, r.usage);
      entry = { ast: r.ast, source: "generated" };
    }
    c.docs.set(docType, entry);
    return { c, ...entry };
  }

  const outcomes: DefectOutcome[] = [];
  for (const spec of specs) {
    const docType = spec.docType === "privacy" ? "privacy" : "terms";
    const { c, ast, source } = await baseDraft(spec.baseCase, docType);
    const mutated = applyDefect(ast, spec);
    const c2 = runC2({ runId, docType, ast: mutated, ledger: c.ledger, applicability: c.applicability, rulePackItems: kb.rulePackItems, transcript: c.intake.maskedTranscript, citations, houseStyle, lexicon, crossFacts: crossFactsFor(mutated, c.ledger) });
    const other = docType === "terms" ? await baseDraft(spec.baseCase, "privacy").then((p) => ({ ast: p.ast, facts: statedFacts(p.ast) })) : null;
    const envelope = buildAuditEnvelope({ ast: mutated, ledger: c.ledger, transcript: c.intake.maskedTranscript, formSlots: c.intake.formSlots, applicability: c.applicability, ruleSections, houseStyle, c2Results: c2, other });
    const audited = await runAudit({ llm: deps.auditLlm }, { runId, iteration: 1, envelope, rubric });
    usage = addU(usage, audited.usage);
    const section = spec.expected.sectionId;
    outcomes.push({
      id: spec.id,
      expectedRule: spec.expected.ruleId,
      expectedSection: section,
      detected: defectDetected(spec, audited.report),
      c2Flagged: c2.checks.some((x) => x.findings.some((f) => f.sectionId === section)),
      auditorRulesInSection: audited.report.findings.filter((f) => f.sectionId === section).map((f) => `${f.ruleId}/${f.severity}`),
      auditorMessages: audited.report.findings.filter((f) => f.sectionId === section || f.docType === "cross").map((f) => `${f.ruleId}: ${f.message.slice(0, 240)}`),
      baseDraft: source,
    });
  }
  const recall = outcomes.length === 0 ? 1 : outcomes.filter((o) => o.detected).length / outcomes.length;
  return { outcomes, recall, usage };
}
