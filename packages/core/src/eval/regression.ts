/**
 * Golden-set regression runner (design R11, Row 13). For each golden case it runs coverage -> match -> draft/C2/audit
 * loop for every applicable document, then calibrates the auditor on the seeded defects and reports the gate metrics.
 *
 * `ledgerSource: "expected"` feeds the expected slots (deterministic; isolates drafter and auditor), `"extract"` runs
 * intake + R2 from the case inputs (measures slot recall and precision). Model clients are injected, so the same runner
 * serves mock-LLM tests and the live Batch/real-API run.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DocAST } from "../contracts/ast";
import type { Finding } from "../contracts/audit-report";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../contracts/fact-ledger";
import type { FormSlots } from "../contracts/form-slots";
import type { HouseStyleFile } from "../contracts/house-style";
import { HouseStyleFileSchema } from "../contracts/house-style";
import { DefectSpecSchema, type DefectSpec } from "../contracts/rubric";
import type { LlmClient, TokenUsage } from "../llm/client";
import { TextFileSttAdapter } from "../adapters/stt";
import { buildAuditEnvelope, loadRubric, runAudit } from "../stages/audit";
import { loadCitations, crossFactsFor, runC2, statedFacts, type LexiconEntry } from "../stages/check";
import { krPaths, loadKrKnowledge, runCoverage } from "../stages/coverage";
import { loadRuleSections, draftDocument, WARN_ONLY, type DraftResult } from "../stages/draft";
import { runExtract } from "../stages/extract";
import { runIntake } from "../stages/intake";
import { runDocumentLoop } from "../stages/loop";
import { loadClauseLibrary, runMatch } from "../stages/match";
import { applyDefect } from "./defects";
import { withEffectiveDate } from "../stages/orchestrate/run-pipeline";
import {
  applicabilityAccuracy,
  citationValidity,
  clauseFirstRatio,
  defectDetected,
  evaluateGate,
  mandatoryCoverage,
  slotScores,
  stability,
  traceability,
  warnOnlyBodies,
  unsupportedClaims,
  type ExpectedCase,
  type GateFailure,
  type GateMetrics,
} from "./metrics";

const EFFECTIVE_DATE = "2026-10-01";

export interface RegressionDeps {
  /** R2 (extraction) client; only used with `ledgerSource: "extract"`. */
  readonly extractLlm?: LlmClient;
  readonly draftLlm: LlmClient;
  readonly auditLlm: LlmClient;
  readonly matchLlm?: LlmClient;
}

export interface RegressionOptions {
  readonly root: string;
  readonly ledgerSource: "expected" | "extract";
  /** Case ids to run (default: all). */
  readonly cases?: readonly string[];
  /** Runs per case for the stability metric (design: 3). */
  readonly runs?: number;
  readonly skipDefects?: boolean;
  readonly runId?: string;
}

export interface CaseOutcome {
  readonly caseId: string;
  readonly verdicts: Readonly<Record<string, string>>;
  readonly applicabilityAccuracy: number;
  readonly slotRecall: number;
  readonly slotPrecision: number;
  readonly blockingFindings: number;
  readonly escalated: boolean;
  readonly docs: Readonly<Record<string, DocAST>>;
  /** Findings still open at the end of each document's loop (C2 and auditor), for diagnosis. */
  readonly openFindings: Readonly<Record<string, readonly Finding[]>>;
  /** Verdict per iteration, per document. */
  readonly iterationVerdicts: Readonly<Record<string, readonly string[]>>;
  /** Final auditor scores and C2 status per document (why a verdict is fail even without blocking findings). */
  readonly finalScores: Readonly<Record<string, { scores: Record<string, number>; c2Passed: boolean }>>;
}

export interface RegressionResult {
  readonly cases: readonly CaseOutcome[];
  readonly defects: readonly { id: string; detected: boolean }[];
  readonly metrics: GateMetrics;
  readonly failures: readonly GateFailure[];
  /** Metrics that could not be measured in this run (for example no seeded defect ran). A passing gate with entries here is incomplete. */
  readonly unmeasured: readonly string[];
  readonly usage: TokenUsage;
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const addU = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
});
const docText = (ast: DocAST): string => JSON.stringify(ast.sections.map((s) => s.blocks));
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 1 : xs.reduce((a, b) => a + b, 0) / xs.length);

export async function runGoldenRegression(deps: RegressionDeps, opts: RegressionOptions): Promise<RegressionResult> {
  const { root } = opts;
  const kr = join(root, "kb", "jurisdictions", "kr");
  const kb = loadKrKnowledge(krPaths(root));
  const rubric = loadRubric(kr);
  const library = loadClauseLibrary(kr, kb.registry);
  const ruleSections = loadRuleSections(join(kr, "rulepacks"));
  const citations = loadCitations(kr);
  const houseStyle: HouseStyleFile = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(kr, "house-style", "lotte-innovate.candidates.json"), "utf8")));
  const lexicon = (JSON.parse(readFileSync(join(kr, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json"), "utf8")) as { entries: LexiconEntry[] }).entries;
  const mandatory = kb.rulePackItems.filter((i) => i.classification === "mandatory").map((i) => i.id);
  const runId = opts.runId ?? "20260930-120000-0a1b2c";
  const runs = Math.max(1, opts.runs ?? 1);
  const ids = (opts.cases ?? readdirSync(join(root, "golden", "cases"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)).slice().sort();

  let usage = ZERO;
  const outcomes: CaseOutcome[] = [];
  const all = { mandatory: [] as number[], trace: [] as number[], cites: [] as number[], unsupported: 0, recall: [] as number[], precision: [] as number[], applic: [] as number[], blocking: 0, warnBodies: 0, sameStructure: true, minSim: 1, clauseSections: 0, llmSections: 0 };
  const references = new Map<string, { docs: Record<string, DocAST>; ledger: FactLedger; applicability: ReturnType<typeof runCoverage>["applicability"]; formSlots: FormSlots }>();
  const transcripts = new Map<string, ReturnType<typeof runIntake>["maskedTranscript"]>();

  for (const id of ids) {
    const dir = join(root, "golden", "cases", id);
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as ExpectedCase & { caseId: string };
    const isG = id.startsWith("G");

    // --- facts -------------------------------------------------------------------------------------------------------
    const transcript = await new TextFileSttAdapter().transcribe(join(dir, "input", "transcript.ko.txt"));
    const form = readFileSync(join(dir, "input", "form.ko.txt"), "utf8");
    const intake = runIntake({ runId, transcript, form });
    transcripts.set(id, intake.maskedTranscript);
    let ledger: FactLedger;
    if (opts.ledgerSource === "extract") {
      if (!deps.extractLlm) throw new Error("[EVAL] ledgerSource extract needs extractLlm");
      const ex = await runExtract({ llm: deps.extractLlm }, { maskedTranscript: intake.maskedTranscript, formSlots: intake.formSlots, template: kb.template, registry: kb.registry, slotHints: kb.slotHints });
      usage = addU(usage, ex.usage);
      ledger = ex.ledger;
    } else {
      const slots: Record<string, SlotEntry> = {};
      for (const [k, v] of Object.entries(expected.slots)) {
        slots[k] = v === "needs_manual_review" ? { status: "needs_manual_review", value: null, confidence: 0, evidence: [] } : { status: "filled", value: v as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: `golden:${id}`, quote: "" }] };
      }
      ledger = createFactLedgerSchema(kb.registry).parse({ runId, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots });
    }
    const { recall, precision } = slotScores(expected.slots, ledger);
    ledger = withEffectiveDate(ledger, EFFECTIVE_DATE); // as the orchestrator does: the run's effective date is a confirmed fact
    const { applicability } = runCoverage({ runId, ledger, template: kb.template, rulePackItems: kb.rulePackItems, termsItems: kb.termsItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: kb.termsPackAvailable });
    const accuracy = applicabilityAccuracy(expected.applicability, applicability);
    const { selection } = await runMatch({ runId, ledger, applicability, library, houseStyle, llm: deps.matchLlm });

    // --- documents ---------------------------------------------------------------------------------------------------
    const verdicts: Record<string, string> = {};
    const docs: Record<string, DocAST> = {};
    const openFindings: Record<string, Finding[]> = {};
    const iterationVerdicts: Record<string, string[]> = {};
    const finalScores: Record<string, { scores: Record<string, number>; c2Passed: boolean }> = {};
    let blocking = 0;
    let escalated = false;
    for (const docType of ["privacy", "terms"] as const) {
      if (!applicability.documents[docType].applicable) continue;
      const asts: DocAST[] = [];
      for (let r = 0; r < runs; r++) {
        const res = await runDocumentLoop(
          { draft: { llm: deps.draftLlm }, audit: { llm: deps.auditLlm } },
          {
            draft: { docType, runId, effectiveDate: EFFECTIVE_DATE, lawSnapshotId: "law-2026-09-29", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library, ruleSections, houseStyle, citations },
            c2: { ledger, applicability, rulePackItems: kb.rulePackItems, transcript: intake.maskedTranscript, citations, houseStyle, lexicon },
            envelope: { ledger, transcript: intake.maskedTranscript, formSlots: intake.formSlots, applicability, ruleSections, houseStyle },
            rubric,
          },
        );
        usage = addU(usage, res.usage);
        asts.push(res.ast);
        if (r === 0) {
          docs[docType] = res.ast;
          openFindings[docType] = [...res.openFindings];
          iterationVerdicts[docType] = res.iterations.map((i) => i.report.verdict);
          finalScores[docType] = { scores: { ...res.final.scores }, c2Passed: res.finalC2.passed };
          verdicts[docType] = res.final.verdict;
          escalated = escalated || res.escalated;
          if (isG) blocking += res.openFindings.filter((f) => f.severity === "blocker" || f.severity === "major").length;
          all.mandatory.push(mandatoryCoverage(res.ast, applicability, mandatory.filter((m) => (docType === "privacy" ? /^(S\d{2}|A1|X1)$/ : /^T\d{2}$/).test(m))));
          // Traceability is a G-case gate: W cases are sparse by design and are judged on warnings and warn-only bodies.
          if (isG) all.trace.push(traceability(res.ast));
          else all.warnBodies += warnOnlyBodies(res.ast, WARN_ONLY);
          all.cites.push(citationValidity(res.ast, res.finalC2));
          all.unsupported += unsupportedClaims(res.finalC2);
        }
      }
      const st = stability(asts, docText);
      all.sameStructure &&= st.sameStructure;
      all.minSim = Math.min(all.minSim, st.minSimilarity);
    }
    // clause-first ratio on a fresh draft of the first applicable document (cheap with the LLM mocked or cached)
    const probe: DraftResult = await draftDocument({ llm: deps.draftLlm }, { docType: "privacy", runId, effectiveDate: EFFECTIVE_DATE, lawSnapshotId: "law-2026-09-29", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library, ruleSections, houseStyle, citations });
    usage = addU(usage, probe.usage);
    all.clauseSections += probe.clauseSections.length;
    all.llmSections += probe.llmSections.length;

    all.recall.push(recall);
    all.precision.push(precision);
    all.applic.push(accuracy);
    all.blocking += blocking;
    references.set(id, { docs, ledger, applicability, formSlots: intake.formSlots });
    outcomes.push({ caseId: id, verdicts, applicabilityAccuracy: accuracy, slotRecall: recall, slotPrecision: precision, blockingFindings: blocking, escalated, docs, openFindings, iterationVerdicts, finalScores });
  }

  // --- auditor calibration on seeded defects ---------------------------------------------------------------------------
  const defectResults: { id: string; detected: boolean }[] = [];
  if (!opts.skipDefects) {
    const specs: DefectSpec[] = readdirSync(join(root, "golden", "defects")).filter((f) => /^D\d\.json$/.test(f)).sort().map((f) => DefectSpecSchema.parse(JSON.parse(readFileSync(join(root, "golden", "defects", f), "utf8"))));
    for (const spec of specs) {
      const base = references.get(spec.baseCase);
      const docType = spec.docType === "cross" ? "terms" : spec.docType;
      const ast = base?.docs[docType];
      if (!base || !ast) continue; // base case not part of this run
      const mutated = applyDefect(ast, spec);
      const transcript = transcripts.get(spec.baseCase)!;
      const c2 = runC2({ runId, docType, ast: mutated, ledger: base.ledger, applicability: base.applicability, rulePackItems: kb.rulePackItems, transcript, citations, houseStyle, lexicon, crossFacts: crossFactsFor(mutated, base.ledger) });
      const other = docType === "terms" && base.docs.privacy ? { ast: base.docs.privacy, facts: statedFacts(base.docs.privacy) } : null;
      const envelope = buildAuditEnvelope({ ast: mutated, ledger: base.ledger, transcript, formSlots: base.formSlots, applicability: base.applicability, ruleSections, houseStyle, c2Results: c2, other });
      const audited = await runAudit({ llm: deps.auditLlm }, { runId, iteration: 1, envelope, rubric });
      usage = addU(usage, audited.usage);
      defectResults.push({ id: spec.id, detected: defectDetected(spec, audited.report) });
    }
  }

  const specsForRecall = defectResults.length;
  const metrics: GateMetrics = {
    applicabilityAccuracy: mean(all.applic),
    mandatoryCoverage: mean(all.mandatory),
    traceability: mean(all.trace),
    citationValidity: mean(all.cites),
    unsupportedClaims: all.unsupported,
    slotRecall: mean(all.recall),
    slotPrecision: mean(all.precision),
    defectRecall: specsForRecall === 0 ? 1 : defectResults.filter((d) => d.detected).length / specsForRecall,
    blockingFindings: all.blocking,
    warnOnlyBodies: all.warnBodies,
    sameStructure: all.sameStructure,
    minSimilarity: all.minSim,
    clauseFirstRatio: clauseFirstRatio(new Array(all.clauseSections).fill(""), new Array(all.llmSections).fill("")),
  };
  const unmeasured = [...(specsForRecall === 0 ? ["defectRecall"] : []), ...(opts.ledgerSource === "expected" ? ["slotRecall", "slotPrecision"] : []), ...(runs < 2 ? ["stability"] : [])];
  return { cases: outcomes, defects: defectResults, metrics, failures: evaluateGate(metrics), unmeasured, usage };
}
