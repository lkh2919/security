import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../src/contracts/fact-ledger";
import type { FormSlots } from "../src/contracts/form-slots";
import { HouseStyleFileSchema } from "../src/contracts/house-style";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import { loadRubric, type AuditOutput } from "../src/stages/audit";
import { citationsFromRulePacks } from "../src/stages/check";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { loadRuleSections, type SectionDraft } from "../src/stages/draft";
import { runDocumentLoop } from "../src/stages/loop";
import { loadClauseLibrary, runMatch } from "../src/stages/match";
import { maskedTranscript } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KR = join(ROOT, "kb", "jurisdictions", "kr");
const RUN_ID = "20260930-120000-0a1b2c";
const kb = loadKrKnowledge(krPaths(ROOT));
const rubric = loadRubric(KR);
const library = loadClauseLibrary(KR, kb.registry);
const ruleSections = loadRuleSections(join(KR, "rulepacks"));
const citations = citationsFromRulePacks(join(KR, "rulepacks"));
const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(KR, "house-style", "lotte-innovate.candidates.json"), "utf8")));
const formSlots: FormSlots = { runId: RUN_ID, formVersion: "infosec-2026.1", serviceName: "쇼핑나우", description: "", slots: {}, fields: {}, flows: [] };

const payload = (req: StructuredCallRequest) => JSON.parse(req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"))) as { section: { id: string; title: string }; fixFindings: { message: string }[] };
/** Drafter that writes a defect into S09 until it receives a fix finding for it. */
const drafter = (req: StructuredCallRequest): SectionDraft => {
  const p = payload(req);
  const bad = p.section.id === "S09" && p.fixFindings.length === 0;
  return { status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: bad ? "수탁자: 새벽로지스" : `${p.section.title} 내용입니다.` }] }] };
};
const goodScores = { legal: 5, accuracy: 5, clarity: 5, houseStyle: 5, consistency: 5 };
/** Auditor that reports the S09 defect whenever the draft still contains it. */
const auditor = (req: StructuredCallRequest): AuditOutput => {
  const env = JSON.parse(req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"))) as { docMarkdown: string };
  const defect = env.docMarkdown.includes("새벽로지스");
  return { scores: defect ? { ...goodScores, accuracy: 2 } : goodScores, resolvedFindingIds: [], findings: defect ? [{ ruleId: "R-S09-001", docType: "privacy", sectionId: "S09", severity: "major", message: "수탁자가 원장과 다릅니다.", astPath: "sections[5]", quote: "", fixHint: "원장의 수탁자를 쓰세요." }] : [] };
};

async function setup(mode: "fixable" | "stubborn") {
  const expected = JSON.parse(readFileSync(join(ROOT, "golden", "cases", "G1", "expected.json"), "utf8")) as { slots: Record<string, unknown> };
  const slots = Object.fromEntries(Object.entries(expected.slots).map(([k, v]) => [k, { status: "filled", value: v, confidence: 1, evidence: [{ source: "user_confirmed", ref: "g", quote: "" }] } as SlotEntry]));
  const ledger: FactLedger = createFactLedgerSchema(kb.registry).parse({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots });
  const { applicability } = runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: true });
  const { selection } = await runMatch({ runId: RUN_ID, ledger, applicability, library, houseStyle });
  const transcript = { ...maskedTranscript, runId: RUN_ID };
  const drafterLlm = new MockLlmClient({ fixtures: { R5P: mode === "fixable" ? drafter : (req: StructuredCallRequest) => ({ ...drafter(req), blocks: [{ t: "para" as const, runs: [{ t: "text" as const, text: payload(req).section.id === "S09" ? "수탁자: 새벽로지스" : "내용입니다." }] }] }) } });
  const auditLlm = new MockLlmClient({ fixtures: { R7: auditor } });
  const result = await runDocumentLoop(
    { draft: { llm: drafterLlm }, audit: { llm: auditLlm } },
    {
      draft: { docType: "privacy", runId: RUN_ID, effectiveDate: "2026-10-01", lawSnapshotId: "snap", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library, ruleSections, houseStyle, citations },
      c2: { ledger, applicability, rulePackItems: kb.rulePackItems, transcript, citations, houseStyle },
      envelope: { ledger, transcript, formSlots, applicability, ruleSections, houseStyle },
      rubric,
    },
  );
  return { result, drafterLlm, auditLlm };
}

describe("runDocumentLoop", () => {
  test("a defect is found in iteration 1, only that section is redrafted, iteration 2 passes", async () => {
    const { result, drafterLlm, auditLlm } = await setup("fixable");
    expect(result.iterations.map((i) => i.report.verdict)).toEqual(["fail", "pass"]);
    expect(result.iterations[1]!.redrafted).toEqual(["S09"]);
    expect(result.escalated).toBe(false);
    expect(result.openFindings).toEqual([]);
    expect(auditLlm.callCount("R7")).toBe(2);
    // first pass drafts every section, the fix pass one section
    const fixCalls = drafterLlm.calls.filter((c) => c.user.includes("수탁자가 원장과 다릅니다"));
    expect(fixCalls).toHaveLength(1);
    expect(result.final.resolvedFindingIds).toEqual([]);
    expect(JSON.stringify(result.ast)).not.toContain("새벽로지스");
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
  });

  test("an unfixable defect stops at the cap of 3 iterations and escalates with the open findings", async () => {
    const { result, auditLlm } = await setup("stubborn");
    expect(result.iterations).toHaveLength(3);
    expect(auditLlm.callCount("R7")).toBe(3);
    expect(result.final.verdict).toBe("fail");
    expect(result.escalated).toBe(true);
    expect(result.openFindings.some((f) => f.ruleId === "R-S09-001")).toBe(true);
    expect(result.iterations.map((i) => i.report.iteration)).toEqual([1, 2, 3]);
  });
});
