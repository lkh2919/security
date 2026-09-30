/** Regression tests for the independent code review of the Row 9-15 code (each test names the defect it pins). */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextFileSttAdapter } from "../src/adapters/stt";
import type { DocAST, SectionAST } from "../src/contracts/ast";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../src/contracts/fact-ledger";
import type { FormSlots } from "../src/contracts/form-slots";
import { HouseStyleFileSchema, type HouseStyleFile } from "../src/contracts/house-style";
import type { QuestionSet } from "../src/contracts/question-set";
import { RunStateSchema } from "../src/contracts/run-state";
import { runGoldenRegression } from "../src/eval";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import { buildAuditEnvelope, loadRubric, type AuditOutput } from "../src/stages/audit";
import { citationsFromRulePacks, crossFactsFor, ledgerFacts, runC2, statedFacts } from "../src/stages/check";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { loadRuleSections, type SectionDraft } from "../src/stages/draft";
import { applyAnswers } from "../src/stages/interview";
import { runDocumentLoop } from "../src/stages/loop";
import { loadClauseLibrary, runMatch } from "../src/stages/match";
import { continueRun, startRun } from "../src/stages/orchestrate";
import { maskedTranscript } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KR = join(ROOT, "kb", "jurisdictions", "kr");
const INTAKE = join(import.meta.dir, "fixtures", "intake");
const RUN_ID = "20260930-120000-0a1b2c";
const kb = loadKrKnowledge(krPaths(ROOT));
const ruleSections = loadRuleSections(join(KR, "rulepacks"));
const citations = citationsFromRulePacks(join(KR, "rulepacks"));
const library = loadClauseLibrary(KR, kb.registry);
const rubric = loadRubric(KR);
const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(KR, "house-style", "lotte-innovate.candidates.json"), "utf8")));
const tmp = mkdtempSync(join(tmpdir(), "pa-review-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function g1() {
  const expected = JSON.parse(readFileSync(join(ROOT, "golden", "cases", "G1", "expected.json"), "utf8")) as { slots: Record<string, unknown> };
  const slots = Object.fromEntries(Object.entries(expected.slots).map(([k, v]) => [k, { status: "filled", value: v, confidence: 1, evidence: [{ source: "user_confirmed", ref: "g", quote: "" }] } as SlotEntry]));
  const ledger: FactLedger = createFactLedgerSchema(kb.registry).parse({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots });
  const { applicability } = runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: true });
  return { ledger, applicability };
}
const sec = (id: string, text: string, status: SectionAST["status"] = "drafted"): SectionAST => ({ id, title: id, status, blocks: [{ t: "para", runs: [{ t: "text", text }] }], trace: { slotRefs: [], clauseRefs: [], ruleRefs: [], styleRefs: [], citationIds: [] } });
const meta = { runId: RUN_ID, effectiveDate: "2026-10-01", rulePackVersion: "p", clauseLibVersion: "0.1.0", houseStyleVersion: "c", lawSnapshotId: "s", promptVersions: {}, models: {} };
const body = (req: StructuredCallRequest): string => req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"));

describe("C2", () => {
  test("finding ids restart per call, so equal inputs give equal results and envelope hashes", () => {
    const { ledger, applicability } = g1();
    const ast = { docType: "privacy", meta, sections: [sec("S02", "x")], warnings: [] } as DocAST;
    const run = () => runC2({ runId: RUN_ID, docType: "privacy", ast, ledger, applicability, rulePackItems: kb.rulePackItems, transcript: { ...maskedTranscript, runId: RUN_ID }, citations });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  test("an invalid approved house-style pattern is reported, not thrown", () => {
    const { ledger, applicability } = g1();
    const bad = { ...houseStyle, rules: [{ ...houseStyle.rules[0]!, id: "H-99", status: "approved", checkType: "regex", pattern: "(", patternMode: "forbid", scope: "both" }] } as HouseStyleFile;
    const ast = { docType: "privacy", meta, sections: [sec("S02", "x")], warnings: [] } as DocAST;
    const r = runC2({ runId: RUN_ID, docType: "privacy", ast, ledger, applicability, rulePackItems: kb.rulePackItems, transcript: { ...maskedTranscript, runId: RUN_ID }, citations, houseStyle: bad });
    expect(r.checks.find((c) => c.checkId === "style.house_style")!.findings[0]).toMatchObject({ ruleId: "H-99", severity: "major" });
  });

  test("cross facts: what the document states is compared with the ledger (terms say 19, ledger says 14 -> X-02)", () => {
    const { ledger, applicability } = g1();
    const terms = { docType: "terms", meta, sections: [sec("T06", "만 19세 이상인 자만 회원으로 가입할 수 있습니다.")], warnings: [] } as DocAST;
    expect(statedFacts(terms)).toEqual({ minAge: "19" });
    expect(ledgerFacts(ledger)).toMatchObject({ minAge: "14" });
    const r = runC2({ runId: RUN_ID, docType: "terms", ast: terms, ledger, applicability, rulePackItems: [], transcript: { ...maskedTranscript, runId: RUN_ID }, citations, crossFacts: crossFactsFor(terms, ledger) });
    expect(r.checks.find((c) => c.checkId === "cross_doc.values_equal")!.findings.map((f) => f.ruleId)).toEqual(["X-02"]);
    const ok = { ...terms, sections: [sec("T06", "만 14세 이상인 자만 회원으로 가입할 수 있습니다.")] } as DocAST;
    expect(runC2({ runId: RUN_ID, docType: "terms", ast: ok, ledger, applicability, rulePackItems: [], transcript: { ...maskedTranscript, runId: RUN_ID }, citations, crossFacts: crossFactsFor(ok, ledger) }).checks.find((c) => c.checkId === "cross_doc.values_equal")!.passed).toBe(true);
  });
});

describe("applyAnswers", () => {
  test("a skipped must question does not overwrite a not_applicable slot", () => {
    const { ledger } = g1();
    const na: FactLedger = { ...ledger, slots: { ...ledger.slots, "terms.minAge": { status: "not_applicable", value: null, confidence: 1, evidence: [] } } };
    const qs: QuestionSet = { runId: RUN_ID, round: 1, questions: [{ id: "Q-T01-01", text: "?", answerType: "number", targets: ["terms.minAge"], itemRefs: ["T06"], priority: "must", origin: "template", sourceQuestionIds: ["Q-T01-01"] }] };
    const r = applyAnswers({ ledger: na, questionSet: qs, registry: kb.registry, answers: { runId: RUN_ID, round: 1, answers: [{ questionId: "Q-T01-01", value: null }] } });
    expect(r.ledger.slots["terms.minAge"]!.status).toBe("not_applicable");
    expect(r.flagged).toEqual([]);
  });
});

describe("audit envelope", () => {
  test("the must-rule digest includes applicable sections that the draft left out", () => {
    const { ledger, applicability } = g1();
    const ast = { docType: "privacy", meta, sections: [sec("S02", "x")], warnings: [] } as DocAST;
    const c2 = runC2({ runId: RUN_ID, docType: "privacy", ast, ledger, applicability, rulePackItems: kb.rulePackItems, transcript: { ...maskedTranscript, runId: RUN_ID }, citations });
    const formSlots: FormSlots = { runId: RUN_ID, formVersion: "v", serviceName: "s", description: "", slots: {}, fields: {}, flows: [] };
    const env = buildAuditEnvelope({ ast, ledger, transcript: { ...maskedTranscript, runId: RUN_ID }, formSlots, applicability, ruleSections, houseStyle, c2Results: c2 });
    expect(env.mustRuleDigest.some((r) => r.sectionId === "S05")).toBe(true); // S05 is mandatory but not in the draft
    expect(env.mustRuleDigest.some((r) => r.sectionId === "S10")).toBe(false); // S10 does not apply to G1
  });
});

describe("clause library loading", () => {
  test("a malformed clause file is skipped and reported instead of crashing the load", () => {
    const dir = join(tmp, "kr");
    mkdirSync(join(dir, "clauses", "privacy", "x"), { recursive: true });
    cpSync(join(KR, "clauses", "index.json"), join(dir, "clauses", "index.json"));
    writeFileSync(join(dir, "clauses", "privacy", "x", "bad.json"), '{"id": 1}');
    writeFileSync(join(dir, "clauses", "privacy", "x", "broken.json"), "{not json");
    const lib = loadClauseLibrary(dir);
    expect(lib.clauses).toEqual([]);
    expect(lib.skipped.map((s) => s.reason.split(":")[0]).sort()).toEqual(["not valid JSON", "schema"]);
  });
});

describe("document loop", () => {
  const scores = { legal: 5, accuracy: 5, clarity: 5, houseStyle: 5, consistency: 5 };
  async function loop(llmDraft: (req: StructuredCallRequest) => SectionDraft, hs: HouseStyleFile) {
    const { ledger, applicability } = g1();
    const { selection } = await runMatch({ runId: RUN_ID, ledger, applicability, library, houseStyle: hs });
    const transcript = { ...maskedTranscript, runId: RUN_ID };
    const formSlots: FormSlots = { runId: RUN_ID, formVersion: "v", serviceName: "s", description: "", slots: {}, fields: {}, flows: [] };
    const audit = (): AuditOutput => ({ scores, findings: [], resolvedFindingIds: [] });
    return runDocumentLoop(
      { draft: { llm: new MockLlmClient({ fixtures: { R5P: llmDraft } }) }, audit: { llm: new MockLlmClient({ fixtures: { R7: audit } }) } },
      {
        draft: { docType: "privacy", runId: RUN_ID, effectiveDate: "2026-10-01", lawSnapshotId: "s", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library, ruleSections, houseStyle: hs, citations },
        c2: { ledger, applicability, rulePackItems: kb.rulePackItems, transcript, citations, houseStyle: hs },
        envelope: { ledger, transcript, formSlots, applicability, ruleSections, houseStyle: hs },
        rubric,
      },
    );
  }

  test("a document-level house-style violation is handed to the drafters instead of escalating at iteration 1", async () => {
    const forbid = { ...houseStyle.rules.find((r) => r.checkType === "regex")!, id: "H-90", status: "approved", patternMode: "forbid", pattern: "금지어", scope: "both" } as HouseStyleFile["rules"][number];
    const hs = { ...houseStyle, rules: [forbid] } as HouseStyleFile;
    const drafter = (req: StructuredCallRequest): SectionDraft => {
      const p = JSON.parse(body(req)) as { fixFindings: { ruleId: string }[] };
      const text = p.fixFindings.some((f) => f.ruleId === "H-90") ? "고쳐 쓴 내용입니다." : "금지어가 들어 있습니다.";
      return { status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text, slotRef: "gate.membership" }] }] };
    };
    const r = await loop(drafter, hs);
    expect(r.iterations.length).toBe(2);
    expect(r.iterations[0]!.report.verdict).toBe("fail");
    expect(r.final.verdict).not.toBe("fail");
    expect(r.escalated).toBe(false);
  });

  test("missing facts reported by the drafters reach the loop result", async () => {
    const drafter = (): SectionDraft => ({ status: "manual_review", missingFacts: ["보유기간을 확인해야 합니다."], blocks: [{ t: "note", kind: "manual_review", runs: [{ t: "text", text: "확인 필요" }] }] });
    const r = await loop(drafter, houseStyle);
    expect(r.missingFacts.some((m) => m.text === "보유기간을 확인해야 합니다.")).toBe(true);
  });
});

describe("orchestrator", () => {
  const r2 = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "extract", "r2-output.json"), "utf8"));
  const drafter = (req: StructuredCallRequest): SectionDraft => ({ status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: `${(JSON.parse(body(req)) as { section: { title: string } }).section.title} 내용입니다.` }] }] });
  const scores = { legal: 5, accuracy: 5, clarity: 5, houseStyle: 5, consistency: 5 };
  async function input() {
    return { transcript: await new TextFileSttAdapter().transcribe(join(INTAKE, "interview.ko.txt")), form: readFileSync(join(INTAKE, "form.md"), "utf8") };
  }
  const answerFor = (q: QuestionSet["questions"][number]) => (q.answerType === "yes_no" ? false : q.answerType === "number" ? 14 : q.answerType === "table" ? [{ name: "해당 없음" }] : q.answerType === "multi" ? [q.options?.[0] ?? "해당 없음"] : q.answerType === "single" ? (q.options?.[0] ?? "해당 없음") : "해당 없음");

  test("a failure after valid answers puts the run back to awaiting_answers so the same answers can be retried", async () => {
    let failAudit = true;
    const llm = new MockLlmClient({ fixtures: { R2: r2, R3: { followups: [] }, "R4-fallback": { group: "cross_group" }, R5P: drafter, R5T: drafter, R7: () => { if (failAudit) throw new Error("boom"); return { scores, findings: [], resolvedFindingIds: [] }; } } });
    const deps = { llm, runsRoot: join(tmp, "runs-retry"), root: ROOT };
    const { transcript, form } = await input();
    let out = await startRun(deps, { runId: "20260930-140000-dddddd", transcript, form });
    let failures = 0;
    while (out.status === "awaiting_answers") {
      const answers = { runId: out.runId, round: out.round, answers: out.questionSet.questions.map((q) => ({ questionId: q.id, value: answerFor(q) })) };
      try {
        out = await continueRun(deps, { runId: out.runId, answers });
      } catch {
        // The audit failed after valid answers: the run must be resumable with the very same answers.
        failures += 1;
        const state = RunStateSchema.parse(JSON.parse(readFileSync(join(tmp, "runs-retry", out.runId, "run-state.json"), "utf8")));
        expect(state.status).toBe("awaiting_answers");
        expect(state.currentStage).toBe("interview");
        failAudit = false;
      }
    }
    expect(failures).toBe(1);
    expect(out.status).toBe("done");
    const state = RunStateSchema.parse(JSON.parse(readFileSync(join(tmp, "runs-retry", out.runId, "run-state.json"), "utf8")));
    expect(state.stages.interview?.status).toBe("done"); // not overwritten by "skipped"
  });

  test("a failure in a fresh run marks it failed", async () => {
    const llm = new MockLlmClient({ fixtures: { R2: () => { throw new Error("extract down"); } } });
    const deps = { llm, runsRoot: join(tmp, "runs-fail"), root: ROOT };
    const { transcript, form } = await input();
    await expect(startRun(deps, { runId: "20260930-140000-eeeeee", transcript, form })).rejects.toThrow();
    const state = RunStateSchema.parse(JSON.parse(readFileSync(join(tmp, "runs-fail", "20260930-140000-eeeeee", "run-state.json"), "utf8")));
    expect(state.status).toBe("failed");
  });
});

describe("regression gate honesty", () => {
  test("a run that did not measure defects, slots and stability says so", async () => {
    const drafter = (req: StructuredCallRequest): SectionDraft => ({ status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: `${(JSON.parse(body(req)) as { section: { title: string } }).section.title} 내용입니다.`, slotRef: "gate.membership" }] }] });
    const r = await runGoldenRegression(
      { draftLlm: new MockLlmClient({ fixtures: { R5P: drafter, R5T: drafter } }), auditLlm: new MockLlmClient({ fixtures: { R7: { scores: { legal: 5, accuracy: 5, clarity: 5, houseStyle: 5, consistency: 5 }, findings: [], resolvedFindingIds: [] } } }) },
      { root: ROOT, ledgerSource: "expected", cases: ["G1"], skipDefects: true },
    );
    expect(r.unmeasured).toEqual(["defectRecall", "slotRecall", "slotPrecision", "stability"]);
  });
});
