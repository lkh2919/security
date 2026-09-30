import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ENVELOPE_KEYS } from "../src/contracts/audit-envelope";
import type { DocAST } from "../src/contracts/ast";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../src/contracts/fact-ledger";
import type { FormSlots } from "../src/contracts/form-slots";
import { HouseStyleFileSchema } from "../src/contracts/house-style";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import { buildAuditEnvelope, envelopeHash, loadRubric, renderRubric, runAudit, type AuditOutput } from "../src/stages/audit";
import { citationsFromRulePacks, runC2 } from "../src/stages/check";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { draftDocument, loadRuleSections, type SectionDraft } from "../src/stages/draft";
import { loadClauseLibrary, runMatch } from "../src/stages/match";
import { maskedTranscript } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KR = join(ROOT, "kb", "jurisdictions", "kr");
const SRC = join(import.meta.dir, "..", "src", "stages");
const RUN_ID = "20260930-120000-0a1b2c";
const kb = loadKrKnowledge(krPaths(ROOT));
const rubric = loadRubric(KR);
const library = loadClauseLibrary(KR, kb.registry);
const ruleSections = loadRuleSections(join(KR, "rulepacks"));
const citations = citationsFromRulePacks(join(KR, "rulepacks"));
const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(KR, "house-style", "lotte-innovate.candidates.json"), "utf8")));
const formSlots: FormSlots = { runId: RUN_ID, formVersion: "infosec-2026.1", serviceName: "쇼핑나우", description: "", slots: {}, fields: {}, flows: [] };

const drafter = (req: StructuredCallRequest): SectionDraft => {
  const p = JSON.parse(req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"))) as { section: { title: string } };
  return { status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: `${p.section.title} 초안입니다.` }] }] };
};

async function setup() {
  const expected = JSON.parse(readFileSync(join(ROOT, "golden", "cases", "G1", "expected.json"), "utf8")) as { slots: Record<string, unknown> };
  const slots = Object.fromEntries(Object.entries(expected.slots).map(([k, v]) => [k, { status: "filled", value: v, confidence: 1, evidence: [{ source: "user_confirmed", ref: "g", quote: "" }] } as SlotEntry]));
  const ledger: FactLedger = createFactLedgerSchema(kb.registry).parse({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots });
  const { applicability } = runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: true });
  const { selection } = await runMatch({ runId: RUN_ID, ledger, applicability, library, houseStyle });
  const { ast } = await draftDocument({ llm: new MockLlmClient({ fixtures: { R5P: drafter } }) }, { docType: "privacy", runId: RUN_ID, effectiveDate: "2026-10-01", lawSnapshotId: "snap", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library, ruleSections, houseStyle, citations });
  const transcript = { ...maskedTranscript, runId: RUN_ID };
  const c2Results = runC2({ runId: RUN_ID, docType: "privacy", ast, ledger, applicability, rulePackItems: kb.rulePackItems, transcript, citations, houseStyle });
  const envelope = buildAuditEnvelope({ ast: ast as DocAST, ledger, transcript, formSlots, applicability, ruleSections, houseStyle, c2Results });
  return { envelope, ast, c2Results };
}

const goodScores = { legal: 5, accuracy: 5, clarity: 4, houseStyle: 4, consistency: 5 };
const auditorWith = (out: Partial<AuditOutput>) => new MockLlmClient({ fixtures: { R7: { scores: goodScores, findings: [], resolvedFindingIds: [], ...out } } });

describe("audit envelope", () => {
  test("has exactly the allowlisted keys and carries no drafter or clause-selection data", async () => {
    const { envelope } = await setup();
    expect(Object.keys(envelope).sort()).toEqual([...AUDIT_ENVELOPE_KEYS]);
    expect(JSON.stringify(envelope)).not.toMatch(/rationale|draftPrompt|clauseRefs/);
    expect(envelope.houseStyle).toEqual([]); // candidates are not approved
    expect(envelope.mustRuleDigest.some((r) => r.ruleId === "R-S09-001")).toBe(true);
    expect(envelope.mustRuleDigest.every((r) => r.ruleId.startsWith("R-"))).toBe(true);
    expect(envelope.otherDocDigest).toBeNull();
  });

  test("the hash is stable and changes with the document", async () => {
    const { envelope } = await setup();
    expect(envelopeHash(envelope)).toBe(envelopeHash(structuredClone(envelope)));
    expect(envelopeHash({ ...envelope, docMarkdown: `${envelope.docMarkdown}x` })).not.toBe(envelopeHash(envelope));
  });
});

describe("runAudit", () => {
  test("the auditor gets the envelope and the rubric on Opus, and nothing from the drafters", async () => {
    const { envelope } = await setup();
    const llm = auditorWith({});
    await runAudit({ llm }, { runId: RUN_ID, iteration: 1, envelope, rubric });
    const call = llm.calls[0]!;
    expect(call.modelId).toContain("opus");
    expect(call.system).toContain("# RUBRIC 1.0.0 (profile: privacy)");
    expect(call.system).toContain("X-02 Minimum age");
    expect(call.system).not.toContain("You draft ONE section");
    const body = JSON.parse(call.user.slice(call.user.indexOf("\n") + 1, call.user.lastIndexOf("\n"))) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...AUDIT_ENVELOPE_KEYS]);
  });

  test("a clean audit passes; minor findings or manual-review sections give pass_with_warnings", async () => {
    const { envelope } = await setup();
    const clean = await runAudit({ llm: auditorWith({}) }, { runId: RUN_ID, iteration: 1, envelope, rubric });
    expect(clean.report.verdict).toBe("pass");
    expect(clean.report.envelopeHash).toBe(envelopeHash(envelope));
    expect(clean.report.rubricVersion).toBe("1.0.0");
    const minor = await runAudit(
      { llm: auditorWith({ findings: [{ ruleId: "R-S02-005", docType: "privacy", sectionId: "S02", severity: "minor", message: "m", astPath: "sections[1]", quote: "", fixHint: "h" }] }) },
      { runId: RUN_ID, iteration: 1, envelope, rubric },
    );
    expect(minor.report.verdict).toBe("pass_with_warnings");
    const withManual = { ...envelope, astSummary: envelope.astSummary.map((s, i) => (i === 0 ? { ...s, status: "manual_review" as const } : s)) };
    expect((await runAudit({ llm: auditorWith({}) }, { runId: RUN_ID, iteration: 1, envelope: withManual, rubric })).report.verdict).toBe("pass_with_warnings");
  });

  test("a major finding, a low score or failing C2 makes the verdict fail; the cap is code, not the model", async () => {
    const { envelope } = await setup();
    const major = await runAudit({ llm: auditorWith({ findings: [{ ruleId: "R-S09-001", docType: "privacy", sectionId: "S09", severity: "major", message: "m", astPath: "sections[1]", quote: "", fixHint: "h" }] }) }, { runId: RUN_ID, iteration: 1, envelope, rubric });
    expect(major.report.verdict).toBe("fail");
    expect(major.report.findings[0]).toMatchObject({ id: "A1-01", layer: "llm", severity: "major" });
    expect((await runAudit({ llm: auditorWith({ scores: { ...goodScores, accuracy: 3.9 } }) }, { runId: RUN_ID, iteration: 1, envelope, rubric })).report.verdict).toBe("fail");
    expect((await runAudit({ llm: auditorWith({ scores: { ...goodScores, clarity: 3 } }) }, { runId: RUN_ID, iteration: 1, envelope, rubric })).report.verdict).toBe("pass");
    const c2Failed = { ...envelope, c2Results: { ...envelope.c2Results, passed: false, checks: [{ checkId: "x", category: "structure" as const, passed: false, findings: [{ id: "C2-1", layer: "deterministic" as const, ruleId: "C2", docType: "privacy" as const, sectionId: "-", severity: "major" as const, message: "m", evidence: { astPath: "$", quote: "" }, fixHint: "" }] }] } };
    expect((await runAudit({ llm: auditorWith({}) }, { runId: RUN_ID, iteration: 1, envelope: c2Failed, rubric })).report.verdict).toBe("fail");
  });

  test("unverifiable quotes are cleared, unknown rule ids re-labelled, should-level rules cannot block, house style is not raised", async () => {
    const { envelope } = await setup();
    const real = envelope.docMarkdown.split("\n").find((l) => l.length > 10)!.slice(0, 20);
    const r = await runAudit(
      {
        llm: auditorWith({
          findings: [
            { ruleId: "R-S09-001", docType: "privacy", sectionId: "S09", severity: "major", message: "a", astPath: "sections[1]", quote: "이 문장은 문서에 없습니다", fixHint: "h" },
            { ruleId: "made-up", docType: "privacy", sectionId: "S02", severity: "blocker", message: "b", astPath: "", quote: real, fixHint: "h" },
            { ruleId: "R-S16-006", docType: "privacy", sectionId: "S16", severity: "major", message: "c", astPath: "sections[2]", quote: "", fixHint: "h" },
            { ruleId: "H-01", docType: "privacy", sectionId: "S01", severity: "major", message: "d", astPath: "$", quote: "", fixHint: "h" },
          ],
        }),
      },
      { runId: RUN_ID, iteration: 2, envelope, rubric },
    );
    expect(r.report.findings.map((f) => [f.id, f.ruleId, f.severity, f.evidence.quote === ""])).toEqual([
      ["A2-01", "R-S09-001", "major", true],
      ["A2-02", "R7-UNMAPPED", "minor", false],
      ["A2-03", "R-S16-006", "minor", true],
    ]);
    expect(r.adjustments.length).toBe(4);
    expect(r.report.scores.houseStyle).toBe(5);
  });

  test("resolved ids must be prior findings", async () => {
    const { envelope } = await setup();
    const prior = { id: "A1-01", layer: "llm" as const, ruleId: "R-S09-001", docType: "privacy" as const, sectionId: "S09", severity: "major" as const, message: "m", evidence: { astPath: "$", quote: "" }, fixHint: "" };
    const r = await runAudit({ llm: auditorWith({ resolvedFindingIds: ["A1-01", "A9-99"] }) }, { runId: RUN_ID, iteration: 2, envelope: { ...envelope, priorFindings: [prior] }, rubric });
    expect(r.report.resolvedFindingIds).toEqual(["A1-01"]);
  });

  test("renderRubric is deterministic and profile specific", () => {
    expect(renderRubric(rubric, "terms")).toBe(renderRubric(rubric, "terms"));
    expect(renderRubric(rubric, "terms")).toContain("profile: terms");
    expect(renderRubric(rubric, "privacy")).not.toContain("profile: terms");
  });
});

describe("isolation by construction (design R6.3)", () => {
  const read = (dir: string): string => readdirSync(join(SRC, dir)).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(SRC, dir, f), "utf8")).join("\n");
  test("the auditor code never touches drafter prompts, clause selection or clause rationale", () => {
    const audit = read("audit").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(audit).not.toMatch(/draft-privacy|draft-terms|ClauseSelection|rationale/);
  });
  test("the drafter code never touches the auditor prompt or the rubric", () => {
    const draft = read("draft").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(draft).not.toMatch(/audit\/v1|rubric|stages\/audit/i);
  });
});
