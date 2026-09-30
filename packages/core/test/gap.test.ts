import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TextFileSttAdapter } from "../src/adapters/stt";
import type { JsonValue } from "../src/contracts/common";
import type { FactLedger, SlotEntry } from "../src/contracts/fact-ledger";
import { findVaultLeaks } from "../src/contracts/pii-vault";
import { MAX_QUESTIONS_PER_ROUND } from "../src/contracts/question-set";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { runExtract, type ExtractOutput } from "../src/stages/extract";
import { DELEGATION_QUESTION_ID, GAP_PROMPT_PATH, runGap, type GapOutput } from "../src/stages/gap";
import { runIntake } from "../src/stages/intake";
import { loadPromptFile } from "../src/stages/extract/prompt";
import { RUN_ID } from "./fixtures";

const REPO = join(import.meta.dir, "..", "..", "..");
const kb = loadKrKnowledge(krPaths(REPO));
const r2Fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "extract", "r2-output.json"), "utf8")) as ExtractOutput;
const followupTemplate = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "gap", "followup-template.json"), "utf8")) as { text: string; help: string };

const nodeById = new Map(kb.template.modules.flatMap((m) => m.nodes.map((n) => [n.id, n] as const)));

const entry = (value: JsonValue, over: Partial<SlotEntry> = {}): SlotEntry => ({
  value,
  status: "filled",
  confidence: 0.9,
  evidence: [{ source: "user_confirmed", ref: "test", quote: "" }],
  ...over,
});
const ledgerOf = (facts: Record<string, JsonValue>, extra: Record<string, SlotEntry> = {}): FactLedger => ({
  runId: RUN_ID,
  jurisdiction: "kr",
  slotRegistryVersion: kb.registry.version,
  slots: { ...Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, entry(v)])), ...extra },
});
const coverage = (ledger: FactLedger, round: 0 | 1 | 2 = 0) =>
  runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: false, round });

/** R3 mock: merges all low-confidence / conflict gaps that share a question-ID family into one follow-up. */
function mergeByFamily(request: StructuredCallRequest): GapOutput {
  const { gaps } = JSON.parse(request.user) as { gaps: Array<{ id: string }> };
  const families = new Map<string, string[]>();
  for (const g of gaps) families.set(g.id.split("-")[1], [...(families.get(g.id.split("-")[1]) ?? []), g.id]);
  return { followups: [...families.values()].map((ids) => ({ sourceQuestionIds: ids, text: followupTemplate.text, help: followupTemplate.help })) };
}

describe("R3 on the Row 7 fixture (intake -> extract -> coverage -> gap, all mocked)", () => {
  test("template questions verbatim; follow-up merges the vague answers; <= 10; no transcript reaches R3", async () => {
    const transcript = await new TextFileSttAdapter().transcribe(join(import.meta.dir, "fixtures", "intake", "interview.ko.txt"));
    const { maskedTranscript, formSlots, vault } = runIntake({ runId: RUN_ID, transcript, form: await readFile(join(import.meta.dir, "fixtures", "intake", "form.md"), "utf8") });
    const llm = new MockLlmClient({ fixtures: { R2: r2Fixture, R3: mergeByFamily }, vault });
    const { ledger } = await runExtract({ llm }, { maskedTranscript, formSlots, template: kb.template, registry: kb.registry, slotHints: kb.slotHints });
    const cov = coverage(ledger);
    expect(cov.gapList.gaps.some((g) => g.reason === "low_confidence")).toBe(true);

    const res = await runGap({ llm }, { runId: RUN_ID, round: 1, gapList: cov.gapList, template: kb.template, ledger });
    const qs = res.questionSet.questions;
    expect(qs.length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_ROUND);
    expect(res.llmUsed).toBe(true);
    expect(llm.callCount("R3")).toBe(1);

    // The merged follow-up cites the template IDs it covers.
    const followup = qs.find((q) => q.origin === "followup" && q.sourceQuestionIds.every((id) => id.startsWith("Q-S05")))!;
    expect(followup.id).toMatch(/^QF-R1-\d{2}$/);
    expect(followup.text).toBe(followupTemplate.text);
    expect(followup.sourceQuestionIds.every((id) => id.startsWith("Q-S05"))).toBe(true);
    expect(followup.sourceQuestionIds.length).toBeGreaterThan(1);
    expect(followup.targets).toContain("privacy.S05_retention");

    // Verbatim Korean template text for every code-emitted question; nothing is invented.
    for (const q of qs.filter((x) => x.origin === "template")) {
      const node = nodeById.get(q.id)!;
      expect(q.text).toBe(node.text);
      expect(q.targets).toEqual(node.targets);
      expect(q.sourceQuestionIds).toEqual([q.id]);
    }
    // Must questions are asked before should questions.
    const firstShould = qs.findIndex((q) => q.priority === "should");
    if (firstShould >= 0) expect(qs.slice(firstShould).every((q) => q.priority === "should")).toBe(true);
    // Overflow is reported, not dropped silently.
    expect(res.deferred.length + qs.reduce((n, q) => n + q.sourceQuestionIds.length, 0)).toBeGreaterThanOrEqual(cov.gapList.gaps.length - 2);

    // R3 call: Sonnet, effort low, no transcript block, no vault values, quotes only.
    const call = llm.calls.find((c) => c.stageId === "R3")!;
    expect(call).toMatchObject({ modelId: "claude-sonnet-5-5", effort: "low", promptVersion: loadPromptFile(GAP_PROMPT_PATH).version });
    expect(call.user).not.toContain("untrusted_transcript");
    expect(call.system).not.toContain("untrusted_transcript");
    expect(findVaultLeaks(`${call.system}\n${call.user}`, vault)).toEqual([]);
    for (const c of llm.calls) expect(findVaultLeaks(`${c.system}\n${c.user}`, vault)).toEqual([]);
  });
});

describe("R3 rules", () => {
  test("only missing answers: zero LLM calls, questions are the template texts", async () => {
    const llm = new MockLlmClient({ fixtures: {} }); // any R3 call would throw: no fixture
    const ledger = ledgerOf({});
    const res = await runGap({ llm }, { runId: RUN_ID, round: 1, gapList: coverage(ledger).gapList, template: kb.template, ledger });
    expect(res.llmUsed).toBe(false);
    expect(llm.callCount()).toBe(0);
    expect(res.questionSet.questions).toHaveLength(MAX_QUESTIONS_PER_ROUND);
    expect(res.questionSet.questions.every((q) => q.origin === "template")).toBe(true);
    expect(res.deferred.length).toBeGreaterThan(0);
    expect(res.questionSet.questions[0].priority).toBe("must");
  });

  test("model output that names unknown IDs or leaves gaps uncovered falls back to verbatim template questions", async () => {
    const ledger = ledgerOf({}, { "privacy.S05_retention": entry([{ target: "회원" }], { confidence: 0.3 }) });
    const cov = coverage(ledger);
    const refined = cov.gapList.gaps.filter((g) => g.reason === "low_confidence").map((g) => g.questionId);
    expect(refined.length).toBeGreaterThan(0);
    const bogus: GapOutput = { followups: [{ sourceQuestionIds: ["Q-ZZZ-99"], text: "임의 질문", help: "" }, { sourceQuestionIds: [refined[0]], text: "   ", help: "" }] };
    const llm = new MockLlmClient({ fixtures: { R3: bogus } });
    const res = await runGap({ llm }, { runId: RUN_ID, round: 1, gapList: cov.gapList, template: kb.template, ledger });
    const ids = res.questionSet.questions.map((q) => q.id);
    for (const id of refined.slice(0, 2)) if (res.questionSet.questions.length < 10) expect(ids).toContain(id);
    expect(res.questionSet.questions.some((q) => q.origin === "followup")).toBe(false);
    expect(res.questionSet.questions.some((q) => q.text === "임의 질문")).toBe(false);
  });

  test("rounds: 1 and 2 accepted, 0 and 3 rejected", async () => {
    const ledger = ledgerOf({});
    const gapList = coverage(ledger, 1).gapList;
    const llm = new MockLlmClient({ fixtures: {} });
    expect((await runGap({ llm }, { runId: RUN_ID, round: 2, gapList, template: kb.template, ledger })).questionSet.round).toBe(2);
    await expect(runGap({ llm }, { runId: RUN_ID, round: 3, gapList, template: kb.template, ledger })).rejects.toThrow(/round/);
    await expect(runGap({ llm }, { runId: RUN_ID, round: 0, gapList, template: kb.template, ledger })).rejects.toThrow(/round/);
  });
});

describe("delegation vs third-party provision (user decision: always a manual-review question)", () => {
  const rows = (name: string): JsonValue => [{ processor: name, recipient: name }];

  test("ambiguity emits the fixed manual-review question first, without any LLM call, replacing the two gate questions", async () => {
    const ledger = ledgerOf({ "profile.serviceTypes": ["b2c_commerce"], "gate.outsourcing": true, "gate.thirdPartyProvision": true, "privacy.S09_processors": rows("알림톡 업체"), "privacy.S07_thirdParties": rows("알림톡 업체") });
    const llm = new MockLlmClient({ fixtures: {} });
    const res = await runGap({ llm }, { runId: RUN_ID, round: 1, gapList: coverage(ledger).gapList, template: kb.template, ledger });
    expect(res.delegationQuestion).toBe(true);
    const first = res.questionSet.questions[0];
    expect(first.id).toBe(DELEGATION_QUESTION_ID);
    expect(first.priority).toBe("must");
    expect(first.itemRefs).toEqual(["S07", "S09"]);
    expect(first.targets).toEqual(["gate.outsourcing", "gate.thirdPartyProvision"]);
    expect(first.text).toContain("위탁");
    expect(first.text).toContain("제3자 제공");
    expect(first.text).toContain("법무");
    expect(res.questionSet.questions.filter((q) => q.id === "Q-S07-01" || q.id === "Q-S09-01")).toHaveLength(0);
    expect(res.questionSet.questions.filter((q) => q.id === DELEGATION_QUESTION_ID)).toHaveLength(1);
    expect(llm.callCount()).toBe(0);
  });

  test("it survives the 10-question cap and does not depend on the model's cooperation", async () => {
    const ledger = ledgerOf({}, { "gate.outsourcing": entry(null, { status: "conflict", confidence: 0 }) });
    const cov = coverage(ledger);
    const llm = new MockLlmClient({ fixtures: { R3: { followups: [] } } });
    const res = await runGap({ llm }, { runId: RUN_ID, round: 1, gapList: cov.gapList, template: kb.template, ledger });
    expect(res.questionSet.questions).toHaveLength(MAX_QUESTIONS_PER_ROUND);
    expect(res.questionSet.questions[0].id).toBe(DELEGATION_QUESTION_ID);
  });

  test("a clean ledger produces no manual-review question", async () => {
    const ledger = ledgerOf({ "gate.outsourcing": true, "gate.thirdPartyProvision": false, "privacy.S09_processors": rows("택배사") });
    const res = await runGap({ llm: new MockLlmClient({ fixtures: {} }) }, { runId: RUN_ID, round: 1, gapList: coverage(ledger).gapList, template: kb.template, ledger });
    expect(res.delegationQuestion).toBe(false);
    expect(res.questionSet.questions.some((q) => q.id === DELEGATION_QUESTION_ID)).toBe(false);
  });
});
