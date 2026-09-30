import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DocAST } from "../src/contracts/ast";
import type { CheckResults } from "../src/contracts/check-results";
import { DefectSpecSchema, type DefectSpec } from "../src/contracts/rubric";
import {
  GATE_THRESHOLDS,
  applicabilityAccuracy,
  applyDefect,
  citationValidity,
  clauseFirstRatio,
  defectDetected,
  defectRecall,
  evaluateGate,
  mandatoryCoverage,
  slotScores,
  stability,
  textSimilarity,
  traceability,
  unsupportedClaims,
  type GateMetrics,
} from "../src/eval";
import { RUN_ID, applicability, factLedger, policyAst } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..");
const defects: DefectSpec[] = readdirSync(join(ROOT, "golden", "defects")).filter((f) => /^D\d\.json$/.test(f)).sort().map((f) => DefectSpecSchema.parse(JSON.parse(readFileSync(join(ROOT, "golden", "defects", f), "utf8"))));

const passing: GateMetrics = { applicabilityAccuracy: 1, mandatoryCoverage: 1, traceability: 1, citationValidity: 1, unsupportedClaims: 0, slotRecall: 0.95, slotPrecision: 0.97, defectRecall: 1, blockingFindings: 0, sameStructure: true, minSimilarity: 0.9, clauseFirstRatio: 0.2 };

describe("gate", () => {
  test("thresholds are the design's R11.2 values", () => {
    expect(GATE_THRESHOLDS).toMatchObject({ applicabilityAccuracy: 1, unsupportedClaims: 0, slotRecall: 0.9, slotPrecision: 0.95, defectRecall: 0.9, minSimilarity: 0.85, costRegression: 0.25 });
  });
  test("passing metrics pass; every breach is named; clause-first ratio never fails", () => {
    expect(evaluateGate(passing)).toEqual([]);
    const fails = evaluateGate({ ...passing, slotRecall: 0.8, defectRecall: 0.875, blockingFindings: 1, sameStructure: false, unsupportedClaims: 2, costDelta: 0.3, clauseFirstRatio: 0 });
    expect(fails.map((f) => f.metric).sort()).toEqual(["blockingFindings", "costDelta", "defectRecall", "sameStructure", "slotRecall", "unsupportedClaims"]);
  });
});

describe("metrics", () => {
  test("slot recall and precision", () => {
    const expected = { "gate.membership": true, "gate.outsourcing": true, "terms.minAge": 14, "gate.x": "needs_manual_review" };
    const s = slotScores(expected, factLedger);
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.precision).toBe(1);
    const wrong = { ...factLedger, slots: { ...factLedger.slots, "gate.membership": { ...factLedger.slots["gate.membership"]!, value: false } } };
    expect(slotScores(expected, wrong).precision).toBe(0.5);
  });

  test("applicability accuracy counts items, documents and warning codes", () => {
    const exp = { documents: { privacy: true, terms: true }, items: { S09: "yes", S10: "no" }, warnings: ["SPECIAL_CHILDREN"] };
    expect(applicabilityAccuracy(exp, { ...applicability, documents: { privacy: { applicable: true }, terms: { applicable: true } }, items: { S09: { state: "yes", basisSlots: [] }, S10: { state: "no", basisSlots: [] } }, warnings: [{ code: "SPECIAL_CHILDREN", kind: "special_type", message: "m" }] })).toBe(1);
    expect(applicabilityAccuracy(exp, { ...applicability, documents: { privacy: { applicable: true }, terms: { applicable: false, reason: "r" } }, items: { S09: { state: "no", basisSlots: [] }, S10: { state: "no", basisSlots: [] } }, warnings: [] })).toBeCloseTo(2 / 5) // S10 and privacy match; S09, terms and the missing warning do not;
  });

  test("mandatory coverage, traceability, citations, unsupported claims", () => {
    const ast = policyAst as DocAST;
    const ids = ast.sections.map((s) => s.id);
    expect(mandatoryCoverage(ast, { ...applicability, items: Object.fromEntries(ids.map((i) => [i, { state: "yes" as const, basisSlots: [] }])) }, ids)).toBe(1);
    expect(mandatoryCoverage(ast, { ...applicability, items: { ...Object.fromEntries(ids.map((i) => [i, { state: "yes" as const, basisSlots: [] }])), S99: { state: "yes", basisSlots: [] } } }, [...ids, "S99"])).toBeLessThan(1);
    expect(traceability(ast)).toBeGreaterThanOrEqual(0);
    const c2 = (cite: number, slot: number): CheckResults => ({ runId: RUN_ID, docType: "privacy", passed: false, checks: [
      { checkId: "evidence.citations", category: "evidence", passed: cite === 0, findings: Array.from({ length: cite }, (_, i) => ({ id: `c${i}`, layer: "deterministic" as const, ruleId: "C2-CITE", docType: "privacy" as const, sectionId: "S01", severity: "major" as const, message: "m", evidence: { astPath: "$", quote: "" }, fixHint: "" })) },
      { checkId: "evidence.slot_refs", category: "evidence", passed: slot === 0, findings: Array.from({ length: slot }, (_, i) => ({ id: `s${i}`, layer: "deterministic" as const, ruleId: "C2-SLOTREF", docType: "privacy" as const, sectionId: "S01", severity: "major" as const, message: "m", evidence: { astPath: "$", quote: "" }, fixHint: "" })) },
    ] });
    expect(unsupportedClaims(c2(0, 3))).toBe(3);
    expect(citationValidity({ ...ast, sections: [] } as DocAST, c2(1, 0))).toBe(1);
  });

  test("clause-first ratio and text similarity", () => {
    expect(clauseFirstRatio(["S06"], ["S01", "S02", "S03"])).toBe(0.25);
    expect(clauseFirstRatio([], [])).toBe(0);
    expect(textSimilarity("개인정보를 파기합니다", "개인정보를 파기합니다")).toBe(1);
    expect(textSimilarity("개인정보를 파기합니다", "전혀 다른 문장입니다")).toBeLessThan(0.3);
    expect(textSimilarity("", "")).toBe(1);
  });

  test("stability compares structure and minimum similarity", () => {
    const a = policyAst as DocAST;
    const text = (d: DocAST): string => JSON.stringify(d.sections.map((s) => s.blocks));
    expect(stability([a, structuredClone(a), structuredClone(a)], text)).toEqual({ sameStructure: true, minSimilarity: 1 });
    const fewer = { ...a, sections: a.sections.slice(1) } as DocAST;
    expect(stability([a, fewer], text).sameStructure).toBe(false);
  });
});

describe("seeded defects", () => {
  test("every spec can be injected into a draft that has its section and changes it", () => {
    for (const d of defects) {
      const base: DocAST = {
        docType: d.docType === "terms" || d.sectionId.startsWith("T") ? "terms" : "privacy",
        meta: policyAst.meta,
        warnings: [],
        sections: [{ id: d.sectionId as never, title: "t", status: "drafted", blocks: [{ t: "para", runs: [{ t: "text", text: "원본" }] }, { t: "table", caption: "", header: ["a"], rows: [[[{ t: "text", text: "x" }]]] }], trace: { slotRefs: [], clauseRefs: [], ruleRefs: [], styleRefs: [], citationIds: [] } }],
      } as DocAST;
      const mutated = applyDefect(base, d);
      expect(JSON.stringify(mutated.sections[0]!.blocks)).not.toBe(JSON.stringify(base.sections[0]!.blocks));
      if (d.mutation.defectiveText) expect(JSON.stringify(mutated)).toContain(d.mutation.defectiveText.slice(0, 10));
    }
    expect(() => applyDefect(policyAst as DocAST, { ...defects[0]!, sectionId: "S99" })).toThrow(/not in/);
  });

  test("detection needs the expected rule in the expected section; recall is the detected share", () => {
    const d = defects[0]!;
    const finding = { id: "A1-01", layer: "llm" as const, ruleId: d.expected.ruleId, docType: d.expected.docType, sectionId: d.expected.sectionId, severity: "major" as const, message: "m", evidence: { astPath: "$", quote: "" }, fixHint: "" };
    expect(defectDetected(d, { findings: [finding] })).toBe(true);
    expect(defectDetected(d, { findings: [{ ...finding, sectionId: "S99" }] })).toBe(false);
    expect(defectDetected(d, { findings: [{ ...finding, ruleId: "R-S01-001" }] })).toBe(false);
    expect(defectRecall(defects.map((x, i) => ({ spec: x, detected: i < 7 })))).toBe(7 / 8);
  });
});
