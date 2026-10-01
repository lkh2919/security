/**
 * O0 orchestrator (design R7): intake -> extract -> coverage -> interview (human answers) -> match -> draft/check/audit loop
 * -> render, on one RunStore so a run can stop at `awaiting_answers` and resume with `continueRun`.
 *
 * Stop rules: after coverage, unanswered `must` gaps raise one interview round (max 2). With no `must` gaps, or after
 * round 2, the run proceeds; whatever is still unknown is drafted as manual review, never guessed.
 * Freshness (R6) needs the law.go.kr key and runs separately (`scripts/freshness-check.ts`); its stage is marked skipped.
 * Everything a run writes stays under `runs/<runId>/` (gitignored). The vault never leaves `pii-vault.local.json`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SttResult } from "../../adapters/stt/types";
import type { ApplicabilityMap } from "../../contracts/applicability";
import { ApplicabilityMapSchema } from "../../contracts/applicability";
import { DocASTSchema, type DocAST } from "../../contracts/ast";
import { AuditReportSchema, type AuditReport } from "../../contracts/audit-report";
import { CheckResultsSchema, type CheckResults } from "../../contracts/check-results";
import { ClauseSelectionSchema } from "../../contracts/clause-selection";
import { FactLedgerSchema, type FactLedger } from "../../contracts/fact-ledger";
import { FormSlotsSchema } from "../../contracts/form-slots";
import { HouseStyleFileSchema } from "../../contracts/house-style";
import { GapListSchema, type GapList } from "../../contracts/gap-list";
import { ManifestSchema, stampsFromManifest } from "../../contracts/manifest";
import { MaskedTranscriptSchema } from "../../contracts/masked-transcript";
import { AnswerSetSchema, MAX_INTERVIEW_ROUNDS, QuestionSetSchema, type AnswerSet, type QuestionSet } from "../../contracts/question-set";
import type { DocType } from "../../contracts/common";
import type { LlmClient } from "../../llm/client";
import { getStagePolicy } from "../../llm/models";
import { hashJson, sha256Hex } from "../../pipeline/canonical";
import { runCachedStage } from "../../pipeline/run-stage";
import { RunStore } from "../../pipeline/run-store";
import { StageCache } from "../../pipeline/stage-cache";
import { loadRubric } from "../audit";
import { loadCitations, statedFacts, type LexiconEntry } from "../check";
import { krPaths, loadKrKnowledge, runCoverage, type KrKnowledge } from "../coverage";
import { loadRuleSections } from "../draft";
import { runExtract } from "../extract";
import { runGap } from "../gap";
import { runIntake, type MaskingMode } from "../intake";
import { applyAnswers } from "../interview";
import { runDocumentLoop } from "../loop";
import { loadClauseLibrary, runMatch } from "../match";
import { decodeRenderOutput, encodeRenderOutput, evidenceFromLedger, RenderOutputStoredSchema, runRender } from "../render";

export interface PipelineDeps {
  /** One client serves every LLM stage (R2, R3, R4-fallback, R5P/R5T, R7); the stage id picks model and effort. */
  readonly llm: LlmClient;
  readonly runsRoot: string;
  /** Repository root holding `kb/` (default: derived from this file). */
  readonly root: string;
  readonly now?: () => Date;
}

export interface StartInput {
  readonly runId?: string;
  readonly transcript: SttResult;
  /** Raw service form (JSON or `key: value` Markdown). */
  readonly form: string;
  readonly masking?: MaskingMode;
  readonly effectiveDate?: string;
}

export type PipelineOutcome =
  | { readonly status: "awaiting_answers"; readonly runId: string; readonly round: number; readonly questionSet: QuestionSet }
  | { readonly status: "done"; readonly runId: string; readonly files: readonly string[]; readonly verdicts: Readonly<Record<string, string>>; readonly escalated: boolean; readonly warnings: readonly string[] };

const ExtractArtifact = z.strictObject({ ledger: FactLedgerSchema });
const CoverageArtifact = z.strictObject({ applicability: ApplicabilityMapSchema, gapList: GapListSchema });
const MaskArtifact = z.strictObject({ maskedTranscript: MaskedTranscriptSchema, formSlots: FormSlotsSchema });
const MetaArtifact = z.strictObject({ masking: z.enum(["off", "basic"]), effectiveDate: z.string() });

interface Kb {
  readonly kr: string;
  readonly knowledge: KrKnowledge;
  readonly manifest: ReturnType<typeof ManifestSchema.parse>;
}

function loadKb(root: string): Kb {
  const kr = join(root, "kb", "jurisdictions", "kr");
  return { kr, knowledge: loadKrKnowledge(krPaths(root)), manifest: ManifestSchema.parse(JSON.parse(readFileSync(join(kr, "manifest.json"), "utf8"))) };
}

function coverageFor(runId: string, ledger: FactLedger, kb: Kb, round: 0 | 1 | 2): { applicability: ApplicabilityMap; gapList: GapList } {
  const k = kb.knowledge;
  return runCoverage({ runId, ledger, template: k.template, rulePackItems: k.rulePackItems, rulePackVersion: k.rulePackVersion, termsPackAvailable: k.termsPackAvailable, round });
}

const mustGaps = (g: GapList): number => g.gaps.filter((x) => x.priority === "must").length;

/** Starts a run: intake, extract, coverage, then either one interview round or straight to the documents. */
export async function startRun(deps: PipelineDeps, input: StartInput): Promise<PipelineOutcome> {
  const kb = loadKb(deps.root);
  const masking = input.masking ?? "off";
  const effectiveDate = input.effectiveDate ?? (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const stamps = stampsFromManifest(kb.manifest, { interviewTemplateVersion: kb.knowledge.template.version, slotRegistryVersion: kb.knowledge.registry.version, prompts: {} });
  const store = await RunStore.create({
    runsRoot: deps.runsRoot,
    ...(input.runId ? { runId: input.runId } : {}),
    // Hashes only: the snapshot never holds raw transcript or form text.
    input: { transcriptSha256: hashJson(input.transcript), formSha256: sha256Hex(input.form), masking, source: input.transcript.source },
    stamps,
    documents: ["privacy", "terms"],
    now: deps.now,
  });

  try {
    return await runStart(deps, store, kb, input, masking, effectiveDate);
  } catch (err) {
    await failRun(store, err);
    throw err;
  }
}

async function failRun(store: RunStore, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await store
    .updateState((s) => {
      s.status = "failed";
      if (s.currentStage) s.stages[s.currentStage] = { ...(s.stages[s.currentStage] ?? { status: "failed" }), status: "failed", error: message };
    })
    .catch(() => undefined);
}

async function runStart(deps: PipelineDeps, store: RunStore, kb: Kb, input: StartInput, masking: MaskingMode, effectiveDate: string): Promise<PipelineOutcome> {
  const cache = new StageCache({ dir: join(deps.runsRoot, ".cache"), now: deps.now });
  await store.markStage("intake", { status: "running" });
  const intake = runIntake({ runId: store.runId, transcript: input.transcript, form: input.form }, { masking });
  await store.markStage("intake", { status: "done" });
  await store.writeArtifact("mask", { maskedTranscript: intake.maskedTranscript, formSlots: intake.formSlots }, { schema: MaskArtifact });
  await store.markStage("mask", { status: "done", artifact: store.artifactName("mask") });
  if (masking === "basic") await store.writeLocalVault(intake.vault);
  await store.writeArtifact("intake", { masking, effectiveDate }, { schema: MetaArtifact });

  const extract = await runCachedStage(
    { store, cache, now: deps.now },
    {
      stage: "extract",
      parts: { stageId: "R2", input: { transcript: hashJson(intake.maskedTranscript), form: hashJson(intake.formSlots), slotRegistry: kb.knowledge.registry.version, template: kb.knowledge.template.version }, promptVersion: "1.0.0", modelId: getStagePolicy("R2").modelId, versions: { rulePack: kb.knowledge.rulePackVersion, template: kb.knowledge.template.version } },
      schema: ExtractArtifact,
      compute: async () => {
        const r = await runExtract({ llm: deps.llm }, { maskedTranscript: intake.maskedTranscript, formSlots: intake.formSlots, template: kb.knowledge.template, registry: kb.knowledge.registry, slotHints: kb.knowledge.slotHints });
        return { ledger: r.ledger };
      },
    },
  );
  return afterLedger(deps, store, kb, extract.output.ledger, 0);
}

async function afterLedger(deps: PipelineDeps, store: RunStore, kb: Kb, ledger: FactLedger, round: 0 | 1 | 2): Promise<PipelineOutcome> {
  const cov = coverageFor(store.runId, ledger, kb, round);
  await store.writeArtifact("coverage", cov, { schema: CoverageArtifact, variant: `r${round}` });
  await store.markStage("coverage", { status: "done", artifact: store.artifactName("coverage", `r${round}`) });
  await store.updateState((s) => {
    s.documents = (["privacy", "terms"] as const).filter((d) => cov.applicability.documents[d].applicable);
  });

  if (mustGaps(cov.gapList) > 0 && round < MAX_INTERVIEW_ROUNDS) {
    const nextRound = round + 1;
    const gap = await runGap({ llm: deps.llm }, { runId: store.runId, round: nextRound, gapList: cov.gapList, template: kb.knowledge.template, ledger });
    await store.writeArtifact("interview", gap.questionSet, { schema: QuestionSetSchema, variant: `q${nextRound}` });
    await store.updateState((s) => {
      s.status = "awaiting_answers";
      s.currentStage = "interview";
      s.interviewRound = nextRound;
      s.stages.interview = { status: "running", artifact: store.artifactName("interview", `q${nextRound}`) };
    });
    return { status: "awaiting_answers", runId: store.runId, round: nextRound, questionSet: gap.questionSet };
  }
  if (round === 0) await store.markStage("interview", { status: "skipped" });
  return finishRun(deps, store, kb, ledger, cov.applicability);
}

/** Resumes a run that stopped at `awaiting_answers`: folds the answers into the ledger and moves on. */
export async function continueRun(deps: PipelineDeps, args: { runId: string; answers: AnswerSet }): Promise<PipelineOutcome> {
  const kb = loadKb(deps.root);
  const store = await RunStore.open(deps.runsRoot, args.runId, deps.now);
  const state = await store.readState();
  if (state.status !== "awaiting_answers") throw new Error(`[PIPELINE] run ${args.runId} is ${state.status}, not awaiting answers`);
  const round = state.interviewRound;
  const answers = AnswerSetSchema.parse(args.answers);
  const questionSet = await store.readArtifact("interview", { variant: `q${round}`, schema: QuestionSetSchema });
  const prevLedger = round === 1 ? (await store.readArtifact("extract", { schema: ExtractArtifact })).ledger : (await store.readArtifact("extract", { variant: `a${round - 1}`, schema: ExtractArtifact })).ledger;
  const applied = applyAnswers({ ledger: prevLedger, questionSet, answers, registry: kb.knowledge.registry });
  await store.writeArtifact("extract", { ledger: applied.ledger }, { variant: `a${round}`, schema: ExtractArtifact });
  await store.updateState((s) => {
    s.status = "running";
    s.stages.interview = { status: "done", artifact: store.artifactName("interview", `q${round}`) };
  });
  try {
    return await afterLedger(deps, store, kb, applied.ledger, round as 1 | 2);
  } catch (err) {
    // The answers were valid; the failure is later. Put the run back where it can be resumed with the same answers.
    await store
      .updateState((s) => {
        s.status = "awaiting_answers";
        s.currentStage = "interview";
        s.interviewRound = round;
        s.stages.interview = { status: "running", artifact: store.artifactName("interview", `q${round}`) };
      })
      .catch(() => undefined);
    throw err;
  }
}

async function finishRun(deps: PipelineDeps, store: RunStore, kb: Kb, ledgerIn: FactLedger, applicability: ApplicabilityMap): Promise<PipelineOutcome> {
  const { kr, knowledge } = kb;
  let ledger = ledgerIn;
  const meta = await store.readArtifact("intake", { schema: MetaArtifact });
  const { maskedTranscript, formSlots } = await store.readArtifact("mask", { schema: MaskArtifact });
  const ruleSections = loadRuleSections(join(kr, "rulepacks"));
  const citations = loadCitations(kr);
  const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(kr, "house-style", existsApproved(kr) ? "lotte-innovate.json" : "lotte-innovate.candidates.json"), "utf8")));
  const lexicon = (JSON.parse(readFileSync(join(kr, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json"), "utf8")) as { entries: LexiconEntry[] }).entries;
  const library = loadClauseLibrary(kr, knowledge.registry);
  const rubric = loadRubric(kr);

  await store.markStage("freshness", { status: "skipped" });
  // The effective date is chosen by whoever runs the pipeline (--effective-date, default today): record it as a confirmed fact so
  // drafters and the auditor see the same source for it.
  ledger = withEffectiveDate(ledger, meta.effectiveDate);
  const match = await runMatch({ runId: store.runId, ledger, applicability, library, houseStyle, llm: deps.llm });
  await store.writeArtifact("match", match.selection, { schema: ClauseSelectionSchema });
  await store.markStage("match", { status: "done", artifact: store.artifactName("match") });

  const docs: Partial<Record<DocType, DocAST>> = {};
  const audits: AuditReport[] = [];
  const checks: CheckResults[] = [];
  const verdicts: Record<string, string> = {};
  const openQuestions: string[] = [];
  let escalated = false;
  for (const docType of ["privacy", "terms"] as const) {
    if (!applicability.documents[docType].applicable) continue;
    await store.markStage("draft", { status: "running" });
    const other = docType === "terms" && docs.privacy ? { ast: docs.privacy, facts: statedFacts(docs.privacy) } : null;
    const res = await runDocumentLoop(
      { draft: { llm: deps.llm }, audit: { llm: deps.llm } },
      {
        draft: { docType, runId: store.runId, effectiveDate: meta.effectiveDate, lawSnapshotId: kb.manifest.lawSnapshot.id, rulePackVersion: knowledge.rulePackVersion, ledger, applicability, selection: match.selection, library, ruleSections, houseStyle, citations },
        c2: { ledger, applicability, rulePackItems: knowledge.rulePackItems, transcript: maskedTranscript, citations, houseStyle, lexicon },
        envelope: { ledger, transcript: maskedTranscript, formSlots, applicability, ruleSections, houseStyle, other },
        rubric,
      },
    );
    docs[docType] = res.ast;
    for (const m of res.missingFacts) openQuestions.push(`[${docType} ${m.sectionId}] ${m.text}`);
    audits.push(res.final);
    checks.push(res.finalC2);
    verdicts[docType] = res.final.verdict;
    escalated ||= res.escalated;
    await store.writeArtifact("draft", res.ast, { variant: docType, schema: DocASTSchema });
    await store.writeArtifact("check", res.finalC2, { variant: docType, schema: CheckResultsSchema });
    await store.writeArtifact("audit", res.final, { variant: docType, schema: AuditReportSchema });
    await store.updateState((s) => {
      s.auditIteration[docType] = res.iterations.length;
    });
  }
  await store.markStage("draft", { status: "done" });
  await store.markStage("check", { status: "done" });
  await store.markStage("audit", { status: "done" });

  const orgSlot = ledger.slots["profile.orgNameRef"];
  const vault = meta.masking === "basic" ? await store.readLocalVault() : undefined;
  const rendered = await runRender({
    ...(docs.privacy ? { policy: docs.privacy as never } : {}),
    ...(docs.terms ? { terms: docs.terms as never } : {}),
    ...(applicability.documents.terms.applicable ? {} : { termsNotApplicableReason: applicability.documents.terms.reason }),
    options: { ...(vault ? { vault } : {}), ...(orgSlot?.status === "filled" && typeof orgSlot.value === "string" ? { organizationName: orgSlot.value } : {}) },
    audits,
    checks,
    slotEvidence: evidenceFromLedger(ledger),
    openQuestions,
  });
  await store.writeArtifact("render", encodeRenderOutput(rendered), { schema: RenderOutputStoredSchema });
  const outDir = store.path("output");
  await mkdir(outDir, { recursive: true });
  const names: string[] = [];
  for (const f of decodeRenderOutput(encodeRenderOutput(rendered)).files) {
    await writeFile(join(outDir, f.name), f.bytes);
    names.push(`output/${f.name}`);
  }
  await store.markStage("render", { status: "done", artifact: store.artifactName("render") });
  await store.updateState((s) => {
    s.status = "done";
  });
  return { status: "done", runId: store.runId, files: names, verdicts, escalated, warnings: rendered.warnings };
}

function existsApproved(kr: string): boolean {
  try {
    readFileSync(join(kr, "house-style", "lotte-innovate.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Records the operator-chosen effective date as the confirmed fact `privacy.S24_effectiveDate` unless the ledger already has one. */
export function withEffectiveDate(ledger: FactLedger, effectiveDate: string): FactLedger {
  if (ledger.slots["privacy.S24_effectiveDate"]) return ledger;
  return { ...ledger, slots: { ...ledger.slots, "privacy.S24_effectiveDate": { status: "filled", value: effectiveDate, confidence: 1, evidence: [{ source: "user_confirmed", ref: "run.effectiveDate", quote: "" }] } } };
}
