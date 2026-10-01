import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocAST, SectionAST } from "../src/contracts/ast";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../src/contracts/fact-ledger";
import { HouseStyleFileSchema } from "../src/contracts/house-style";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { citationsFromRulePacks, runC2, type C2Input, type LexiconEntry } from "../src/stages/check";
import { maskedTranscript } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KR = join(ROOT, "kb", "jurisdictions", "kr");
const RUN_ID = "20260930-120000-0a1b2c";
const kb = loadKrKnowledge(krPaths(ROOT));
const citations = citationsFromRulePacks(join(KR, "rulepacks"));
const lexicon = (JSON.parse(readFileSync(join(KR, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json"), "utf8")) as { entries: LexiconEntry[] }).entries;
const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(KR, "house-style", "lotte-innovate.candidates.json"), "utf8")));

const filled = (value: unknown): SlotEntry => ({ status: "filled", value: value as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: "t", quote: "" }] });
function g1(): { ledger: FactLedger; applicability: C2Input["applicability"] } {
  const expected = JSON.parse(readFileSync(join(ROOT, "golden", "cases", "G1", "expected.json"), "utf8")) as { slots: Record<string, unknown> };
  const ledger = createFactLedgerSchema(kb.registry).parse({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots: Object.fromEntries(Object.entries(expected.slots).map(([k, v]) => [k, filled(v)])) });
  const { applicability } = runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: true });
  return { ledger, applicability };
}
const { ledger, applicability } = g1();

const sec = (id: string, blocks: SectionAST["blocks"] = [{ t: "para", runs: [{ t: "text", text: "내용입니다." }] }], status: SectionAST["status"] = "drafted"): SectionAST => ({ id, title: `섹션 ${id}`, status, blocks, trace: { slotRefs: [], clauseRefs: [], ruleRefs: [], styleRefs: [], citationIds: [] } });
const meta = { runId: RUN_ID, effectiveDate: "2026-10-01", rulePackVersion: "privacy-2026.04", clauseLibVersion: "0.1.0", houseStyleVersion: "candidates-unapproved", lawSnapshotId: "law-2026-09-29", promptVersions: {}, models: {} };
const disclaimer: SectionAST["blocks"][number] = { t: "note", kind: "disclaimer", runs: [{ t: "text", text: "참고용 초안입니다." }] };
const mandatoryIds = kb.rulePackItems.filter((i) => i.classification === "mandatory" && applicability.items[i.id]?.state === "yes").map((i) => i.id);
const conditionalIds = kb.rulePackItems.filter((i) => i.classification === "conditional" && applicability.items[i.id]?.state === "yes").map((i) => i.id);

function privacyAst(extra: SectionAST[] = [], drop: string[] = []): DocAST {
  const base = [...mandatoryIds, ...conditionalIds].filter((id) => !drop.includes(id)).sort().map((id) => sec(id));
  const sections = [...base, ...extra];
  sections[0] = { ...sections[0]!, blocks: [...sections[0]!.blocks, disclaimer] };
  return { docType: "privacy", meta, sections, warnings: [] };
}
const run = (ast: unknown, extra: Partial<C2Input> = {}, docType: "privacy" | "terms" = "privacy") => runC2({ runId: RUN_ID, docType, ast, ledger, applicability, rulePackItems: kb.rulePackItems, transcript: { ...maskedTranscript, runId: RUN_ID }, citations, houseStyle, lexicon, ...extra });
const failed = (r: ReturnType<typeof run>): string[] => r.checks.filter((c) => !c.passed).map((c) => c.checkId);

describe("C2", () => {
  test("a complete, clean privacy document passes every check", () => {
    const r = run(privacyAst());
    expect(failed(r)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  test("schema: an invalid or wrong-type AST fails fast", () => {
    expect(failed(run({ docType: "privacy" }))).toEqual(["structure.schema"]);
    expect(failed(run({ ...privacyAst(), docType: "privacy" }, {}, "terms"))).toEqual(["structure.schema"]);
  });

  test("unresolved clause syntax is flagged, PII placeholders are not", () => {
    const bad = privacyAst([sec("S09", [{ t: "para", runs: [{ t: "text", text: "{{operatorName}}는 {%if gate.x%}처리합니다" }] }])], ["S09"]);
    expect(failed(run(bad))).toContain("structure.unresolved_syntax");
    const ok = privacyAst([sec("S09", [{ t: "para", runs: [{ t: "text", text: "{{PERSON_1}}님이 담당합니다" }] }])], ["S09"]);
    expect(failed(run(ok))).not.toContain("structure.unresolved_syntax");
  });

  test("empty sections and missing mandatory items", () => {
    expect(failed(run(privacyAst([sec("S09", [])], ["S09"])))).toContain("structure.empty_sections");
    const r = run(privacyAst([], ["S05"]));
    expect(failed(r)).toContain("structure.mandatory_present");
    expect(r.checks.find((c) => c.checkId === "structure.mandatory_present")!.findings[0]).toMatchObject({ ruleId: "C2-M-S05", severity: "blocker", layer: "deterministic" });
  });

  test("a conditional item whose gate applies must be drafted; unknown gates must be manual_review", () => {
    expect(failed(run(privacyAst([], ["S09"])))).toContain("structure.conditional_handled");
    const unknownApplic = { ...applicability, items: { ...applicability.items, S07: { state: "unknown" as const, basisSlots: [] } } };
    const ast = privacyAst([sec("S07")]);
    expect(failed(run(ast, { applicability: unknownApplic }))).toContain("structure.conditional_handled");
    const manual = privacyAst([sec("S07", [{ t: "note", kind: "manual_review", runs: [{ t: "text", text: "확인 필요" }] }], "manual_review")]);
    expect(failed(run(manual, { applicability: unknownApplic }))).not.toContain("structure.conditional_handled");
  });

  test("slotRef must point at a filled slot; citations must resolve", () => {
    const ast = privacyAst([sec("S09", [{ t: "para", runs: [{ t: "text", text: "한빛택배", slotRef: "privacy.S09_processors" }, { t: "text", text: "없는 슬롯", slotRef: "privacy.S23_voluntary" }, { t: "cite", citationId: "PIPA:26" }, { t: "cite", citationId: "PIPA:9999" }] }])], ["S09"]);
    const r = run(ast);
    expect(r.checks.find((c) => c.checkId === "evidence.slot_refs")!.findings.map((f) => f.evidence.quote)).toEqual(["없는 슬롯"]);
    expect(r.checks.find((c) => c.checkId === "evidence.citations")!.findings.map((f) => f.evidence.quote)).toEqual(["PIPA:9999"]);
  });

  test("ledger evidence with a quote that is not in the transcript fails", () => {
    const bad: FactLedger = { ...ledger, slots: { ...ledger.slots, "gate.membership": { status: "filled", value: true, confidence: 1, evidence: [{ source: "transcript", segmentId: "T0001", quote: "this quote is not there" }] } } };
    expect(failed(run(privacyAst(), { ledger: bad }))).toContain("evidence.transcript_quotes");
  });

  test("recipients abbreviated with 등 are flagged in S09 tables", () => {
    const table = (name: string): SectionAST => sec("S09", [{ t: "table", caption: "", header: ["수탁자", "업무"], rows: [[[{ t: "text", text: name }], [{ t: "text", text: "배송" }]]] }]);
    expect(failed(run(privacyAst([table("한빛택배 등")], ["S09"])))).toContain("safety.vague_recipients");
    expect(failed(run(privacyAst([table("한빛택배")], ["S09"])))).not.toContain("safety.vague_recipients");
  });

  test("the disclaimer is supplied by the renderer unless an AST note is required", () => {
    const ast = privacyAst();
    const noDisc = { ...ast, sections: ast.sections.map((s) => ({ ...s, blocks: s.blocks.filter((b) => !(b.t === "note" && b.kind === "disclaimer")) })) };
    expect(failed(run(noDisc))).toEqual([]);
    expect(failed(run(noDisc, { disclaimerByRenderer: false }))).toEqual(["safety.disclaimer"]);
    expect(failed(run(ast, { disclaimerByRenderer: false }))).toEqual([]);
  });

  test("terms: a blanket liability exclusion hits the unfair-clause lexicon as a blocker (seeded defect D6)", () => {
    const d6 = JSON.parse(readFileSync(join(ROOT, "golden", "defects", "D6.json"), "utf8")) as { mutation: { defectiveText: string } };
    const terms: DocAST = { docType: "terms", meta, warnings: [], sections: [{ ...sec("T14", [{ t: "para", runs: [{ t: "text", text: d6.mutation.defectiveText }] }, disclaimer]) }] };
    const r = run(terms, { rulePackItems: [] }, "terms");
    const c = r.checks.find((x) => x.checkId === "safety.unfair_clauses")!;
    expect(c.passed).toBe(false);
    expect(c.findings.some((f) => f.ruleId === "U-ARTC7-01" && f.severity === "blocker")).toBe(true);
  });

  test("house style: only approved regex rules are enforced", () => {
    const forbid = { ...houseStyle.rules.find((r) => r.checkType === "regex")!, id: "H-90", status: "approved" as const, patternMode: "forbid" as const, pattern: "내용입니다", scope: "both" as const };
    const hs = { ...houseStyle, rules: [forbid, { ...forbid, id: "H-91", status: "candidate" as const }] };
    const r = run(privacyAst(), { houseStyle: hs as never });
    expect(r.checks.find((c) => c.checkId === "style.house_style")!.findings.map((f) => f.ruleId)).toEqual(["H-90"]);
    expect(failed(run(privacyAst()))).not.toContain("style.house_style"); // candidates alone never fail a document
  });

  test("cross-document values must match (org name, minimum age)", () => {
    const r = run(privacyAst(), { crossFacts: { own: { org: "쇼핑나우", minAge: "14" }, other: { org: "쇼핑나우", minAge: "19" } } });
    expect(r.checks.find((c) => c.checkId === "cross_doc.values_equal")!.findings.map((f) => f.ruleId)).toEqual(["X-02"]);
  });

  test("deterministic output", () => {
    const strip = (r: ReturnType<typeof run>) => JSON.stringify(r.checks.map((c) => [c.checkId, c.passed, c.findings.length]));
    expect(strip(run(privacyAst()))).toBe(strip(run(privacyAst())));
  });
});

describe("citationsFromRulePacks", () => {
  test("covers the legal refs of the packs and resolves PIPA:30(1)1", () => {
    expect(citations.length).toBeGreaterThan(100);
    expect(citations.find((c) => c.citationId === "PIPA:30(1)1")?.law).toContain("개인정보");
  });
});

describe("unfair-clause lexicon", () => {
  const sentences = (id: string) => lexicon.find((e) => e.id === id)!;
  const flagged = (id: string, s: string): boolean => {
    const e = sentences(id);
    return new RegExp(e.pattern, "u").test(s) && !(e.suppress ?? []).some((p) => new RegExp(p, "u").test(s));
  };

  test("every testPositive violation is still flagged (suppression never hides the lexicon's own examples)", () => {
    const raw = JSON.parse(readFileSync(join(KR, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json"), "utf8")) as { entries: (LexiconEntry & { testPositive?: string })[] };
    for (const e of raw.entries.filter((x) => x.testPositive)) expect(flagged(e.id, e.testPositive!)).toBe(true);
  });

  test("lawful wording that the notes describe is not flagged", () => {
    expect(flagged("U-ARTC9-01", "앞 항의 제2호부터 제5호까지에 해당하는 경우에도, 회사가 청약철회가 제한된다는 사실을 표시하지 않았다면 이용자의 청약철회 등은 제한되지 않습니다.")).toBe(false);
    expect(flagged("U-ARTC12-01", "공지 후 거부 의사를 표시하지 않으면 동의한 것으로 본다는 내용을 다른 공지와 구분하여 명확하게 별도로 알린 경우에 한하여 동의한 것으로 봅니다.")).toBe(false);
    expect(flagged("U-ECA18-02", "회사는 청약철회를 이유로 위약금을 청구하지 않습니다.")).toBe(false);
    // wording variants seen in live drafts
    expect(flagged("U-ARTC9-01", "회사의 주소 변경 등으로 제1항의 기간 안에 청약철회를 할 수 없었던 경우에는 그 사실을 안 날부터 청약철회 기간을 계산합니다.")).toBe(false);
    expect(flagged("U-ARTC9-01", "이 약관의 내용은 법률이 보장하는 청약철회 기간을 줄이거나 청약철회에 조건을 붙이는 것으로 해석되지 않습니다.")).toBe(false);
    expect(flagged("U-ARTC12-01", "개정 약관을 알리면서 기간 안에 의사표시를 하지 않으면 동의한 것으로 본다는 내용을 별도로 분명하게 알렸는데도 거부하지 않으면 동의한 것으로 봅니다.")).toBe(false);
  });

  test("real violations next to similar wording are still flagged", () => {
    expect(flagged("U-ARTC9-01", "전자제품은 개봉 후 환불이 불가합니다.")).toBe(true);
    expect(flagged("U-ARTC12-01", "이용자가 접속하면 변경된 약관에 동의한 것으로 봅니다.")).toBe(true);
    expect(flagged("U-ECA18-02", "청약철회 시 결제금액의 10%를 위약금으로 부과합니다.")).toBe(true);
  });
});
