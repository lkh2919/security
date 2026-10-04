import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DefectSpecSchema } from "../src/contracts/rubric";
import { runGoldenRegression } from "../src/eval";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import type { AuditOutput } from "../src/stages/audit";
import type { SectionDraft } from "../src/stages/draft";

const ROOT = join(import.meta.dir, "..", "..", "..");
const specs = readdirSync(join(ROOT, "golden", "defects")).filter((f) => /^D\d\.json$/.test(f)).sort().map((f) => DefectSpecSchema.parse(JSON.parse(readFileSync(join(ROOT, "golden", "defects", f), "utf8"))));

const body = (req: StructuredCallRequest): string => req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"));
const drafter = (req: StructuredCallRequest): SectionDraft => {
  const p = JSON.parse(body(req)) as { section: { id: string; title: string }; facts: Record<string, unknown> };
  const slot = Object.keys(p.facts)[0];
  // Like the real prompt asks: the operative withdrawal/refund sentence in T10 is bold.
  return { status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: `${p.section.title} 내용입니다.`, ...(slot ? { slotRef: slot } : {}), ...(p.section.id === "T10" ? { strong: true } : {}) }] }] };
};
const goodScores = { legal: 5, accuracy: 5, clarity: 5, houseStyle: 5, consistency: 5 };
/** Mock auditor that "detects" exactly the seeded defects whose text appears in the document (recall is then a property of the harness). */
const auditor = (skip: string[] = []) => (req: StructuredCallRequest): AuditOutput => {
  const env = JSON.parse(body(req)) as { docMarkdown: string; c2Results: { checks: { findings: { sectionId: string }[] }[] } };
  const c2Sections = new Set(env.c2Results.checks.flatMap((c) => c.findings.map((f) => f.sectionId)));
  // Text defects are visible in the document; a pure removal shows up as a structural C2 finding in that section.
  const hits = specs.filter((s) => !skip.includes(s.id) && (s.mutation.defectiveText ? env.docMarkdown.includes(s.mutation.defectiveText) : c2Sections.has(s.expected.sectionId)));
  return {
    scores: hits.length ? { ...goodScores, accuracy: 2 } : goodScores,
    resolvedFindingIds: [],
    findings: hits.map((s) => ({ ruleId: s.expected.ruleId, docType: s.expected.docType, sectionId: s.expected.sectionId, severity: s.expected.severity, message: s.rationale, astPath: "$", quote: "", fixHint: "fix" })),
  };
};
const deps = (skip: string[] = []) => ({ draftLlm: new MockLlmClient({ fixtures: { R5P: drafter, R5T: drafter } }), auditLlm: new MockLlmClient({ fixtures: { R7: auditor(skip) } }) });

describe("runGoldenRegression (mock models)", () => {
  test("all nine golden cases run; the gate passes when the auditor finds every seeded defect", async () => {
    const r = await runGoldenRegression(deps(), { root: ROOT, ledgerSource: "expected", runs: 2 });
    expect(r.cases.map((c) => c.caseId)).toEqual(["G1", "G1b", "G2", "G2b", "G3", "W1", "W2", "W3", "W4"]);
    expect(r.failures).toEqual([]);
    expect(r.metrics).toMatchObject({ applicabilityAccuracy: 1, mandatoryCoverage: 1, slotRecall: 1, slotPrecision: 1, defectRecall: 1, blockingFindings: 0, sameStructure: true, unsupportedClaims: 0 });
    expect(r.defects.map((d) => d.id)).toEqual(specs.map((s) => s.id));
    const g2 = r.cases.find((c) => c.caseId === "G2")!;
    expect(Object.keys(g2.docs)).toEqual(["privacy"]); // terms not applicable
    expect(r.cases.find((c) => c.caseId === "G1")!.docs.terms).toBeDefined();
  });

  test("a blind auditor is caught by the recall gate", async () => {
    const r = await runGoldenRegression(deps(["D1", "D2", "D3", "D6"]), { root: ROOT, ledgerSource: "expected", cases: ["G1", "G1b", "G2b"] });
    expect(r.metrics.defectRecall).toBeLessThan(0.9);
    expect(r.failures.map((f) => f.metric)).toContain("defectRecall");
  });

  test("an unstable drafter is caught by the structure/similarity gate", async () => {
    let n = 0;
    const flaky = (req: StructuredCallRequest): SectionDraft => ({ ...drafter(req), blocks: [{ t: "para", runs: [{ t: "text", text: `완전히 다른 문장 ${(n += 1)} ${"가나다라마바사".repeat(n % 3 + 1)}`, slotRef: "gate.membership" }] }] });
    const r = await runGoldenRegression({ draftLlm: new MockLlmClient({ fixtures: { R5P: flaky, R5T: flaky } }), auditLlm: new MockLlmClient({ fixtures: { R7: auditor() } }) }, { root: ROOT, ledgerSource: "expected", cases: ["G1"], runs: 2, skipDefects: true });
    expect(r.metrics.minSimilarity).toBeLessThan(1);
  });

  test("extract mode needs an extraction client", async () => {
    await expect(runGoldenRegression(deps(), { root: ROOT, ledgerSource: "extract", cases: ["G1"] })).rejects.toThrow(/extractLlm/);
  });
});
