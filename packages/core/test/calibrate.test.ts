import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DefectSpecSchema } from "../src/contracts/rubric";
import { runDefectCalibration } from "../src/eval";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import type { AuditOutput } from "../src/stages/audit";
import type { SectionDraft } from "../src/stages/draft";

const ROOT = join(import.meta.dir, "..", "..", "..");
const specs = readdirSync(join(ROOT, "golden", "defects")).filter((f) => /^D\d\.json$/.test(f)).sort().map((f) => DefectSpecSchema.parse(JSON.parse(readFileSync(join(ROOT, "golden", "defects", f), "utf8"))));
const body = (req: StructuredCallRequest): string => req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"));
const drafter = (req: StructuredCallRequest): SectionDraft => {
  const p = JSON.parse(body(req)) as { section: { title: string } };
  return { status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: `${p.section.title} 내용입니다.` }] }, { t: "table", caption: "", header: ["a"], rows: [[[{ t: "text", text: "x" }]]] }] };
};
const scores = { legal: 5, accuracy: 5, clarity: 5, houseStyle: 5, consistency: 5 };
/** Mock auditor that recognises a text defect from its text and always reports removals (plumbing test, not a model test). */
const auditor = (skip: string[]) => (req: StructuredCallRequest): AuditOutput => {
  const env = JSON.parse(body(req)) as { docMarkdown: string; c2Results: { checks: { findings: { sectionId: string }[] }[] } };
  const c2 = new Set(env.c2Results.checks.flatMap((c) => c.findings.map((f) => f.sectionId)));
  const hits = specs.filter((s) => !skip.includes(s.id) && (s.mutation.defectiveText ? env.docMarkdown.includes(s.mutation.defectiveText) : s.mutation.kind === "remove" || c2.has(s.expected.sectionId)));
  return { scores, resolvedFindingIds: [], findings: hits.map((s) => ({ ruleId: s.expected.ruleId, docType: s.expected.docType, sectionId: s.expected.sectionId, severity: s.expected.severity, message: "m", astPath: "$", quote: "", fixHint: "f" })) };
};

describe("runDefectCalibration (mock models)", () => {
  test("drafts missing bases once per case and document, audits each defect once, and reports recall", async () => {
    const draftLlm = new MockLlmClient({ fixtures: { R5P: drafter, R5T: drafter } });
    const auditLlm = new MockLlmClient({ fixtures: { R7: auditor(["D2"]) } });
    const r = await runDefectCalibration({ draftLlm, auditLlm }, { root: ROOT });
    expect(r.outcomes.map((o) => o.id)).toEqual(specs.map((s) => s.id));
    expect(r.outcomes.find((o) => o.id === "D2")!.detected).toBe(false);
    expect(r.recall).toBe(7 / 8);
    expect(auditLlm.callCount("R7")).toBe(8);
    expect(r.outcomes.every((o) => o.baseDraft === "generated")).toBe(true);
  });

  test("a subset of defects runs only what it needs", async () => {
    const draftLlm = new MockLlmClient({ fixtures: { R5P: drafter, R5T: drafter } });
    const auditLlm = new MockLlmClient({ fixtures: { R7: auditor([]) } });
    const r = await runDefectCalibration({ draftLlm, auditLlm }, { root: ROOT, defects: ["D1"] });
    expect(r.outcomes.map((o) => [o.id, o.detected])).toEqual([["D1", true]]);
    expect(draftLlm.callCount("R5T")).toBe(0);
  });
});
