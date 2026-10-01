import { describe, expect, test } from "bun:test";
import { AmendmentDiffSchema } from "../src/contracts/amendment-diff";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm";
import { formatLegalRefKey } from "../src/stages/render/resolve";
import { diffArticles, flattenArticles, impactSeverity, mapUnitsToSections, parseLawXml, refsRelated, runImpact, type ImpactJudgeOutput } from "../src/stages/monitor";
import { NOW, ingestFixture, readFixture, ruleSections } from "./monitor-fixtures";

const oldArticles = parseLawXml(readFixture("law-old.xml"));
const newArticles = parseLawXml(readFixture("law-new.xml"));
const diff = diffArticles("PIPA", oldArticles, newArticles, { oldVersion: "old", newVersion: "new" });

describe("parseLawXml", () => {
  test("articles only (chapter headings skipped), with branches, 항 and 호", () => {
    expect(oldArticles.map((a) => `${a.number}${a.branch ? `-${a.branch}` : ""}`)).toEqual(["2", "30", "22-2", "45", "50"]);
    const a30 = oldArticles.find((a) => a.number === "30")!;
    expect(a30.title).toBe("개인정보 처리방침의 수립 및 공개");
    expect(a30.paragraphs.map((p) => p.number)).toEqual(["1", "2"]);
    expect(a30.paragraphs[0]!.items.map((i) => [i.number, i.branch])).toEqual([["1", undefined], ["2", undefined], ["3", "2"]]);
    // 호 directly under an article without 항
    expect(oldArticles.find((a) => a.number === "2")!.items).toHaveLength(2);
  });

  test("keys use the legal-ref notation of the rule packs", () => {
    expect([...flattenArticles(oldArticles).keys()]).toEqual(["2[1]", "2[2]", "30(1)", "30(1)1", "30(1)2", "30(1)3-2", "30(2)", "22-2", "45", "50"]);
    expect(formatLegalRefKey("PIPA:30(1)3-2")).toBe("「개인정보 보호법」 제30조제1항제3호의2");
  });
});

describe("article diff", () => {
  test("changes are found at 항/호 level: item, article, new 항, repeal; tag-only edits and unchanged units are not changes", () => {
    expect(AmendmentDiffSchema.safeParse(diff).success).toBe(true);
    expect(diff.units.map((u) => [u.key, u.change])).toEqual([
      ["PIPA:2[2]", "amended"],
      ["PIPA:30(1)1", "amended"],
      ["PIPA:30(3)", "added"],
      ["PIPA:22-2", "amended"],
      ["PIPA:45", "deleted"],
    ]);
    // 30(1) lead-in only changed its <개정 ...> tag; 30(1)2, 30(1)3-2, 30(2) and article 50 are untouched
    expect(diff.units.some((u) => u.key === "PIPA:30(1)" || u.key === "PIPA:30(1)2" || u.key === "PIPA:50")).toBe(false);
  });

  test("units carry old and new text; a repeal has no new text; an addition has no old text", () => {
    const by = Object.fromEntries(diff.units.map((u) => [u.key, u]));
    expect(by["PIPA:30(1)1"]!.oldText).toContain("개인정보의 처리 목적");
    expect(by["PIPA:30(1)1"]!.newText).toContain("이용 범위");
    expect(by["PIPA:45"]!.newText).toBeUndefined();
    expect(by["PIPA:30(3)"]!.oldText).toBeUndefined();
  });

  test("the diff hash is stable and depends on the units; identical versions give an empty diff", () => {
    expect(diffArticles("PIPA", oldArticles, newArticles).hash).toBe(diff.hash);
    expect(diffArticles("DEC", oldArticles, newArticles).units[0]!.key).toBe("DEC:2[2]");
    const same = diffArticles("PIPA", oldArticles, oldArticles);
    expect(same.units).toEqual([]);
    expect(same.hash).not.toBe(diff.hash);
  });
});

describe("legal-ref matching", () => {
  test("equal, ancestor and descendant refs are related; siblings are not", () => {
    expect(refsRelated("PIPA:30(1)1", "PIPA:30(1)1")).toBe(true);
    expect(refsRelated("PIPA:30(1)", "PIPA:30(1)1")).toBe(true);
    expect(refsRelated("PIPA:30", "PIPA:30(1)1")).toBe(true);
    expect(refsRelated("PIPA:30(1)1", "PIPA:30(1)")).toBe(true);
    expect(refsRelated("PIPA:30(1)1", "PIPA:30(1)2")).toBe(false);
    expect(refsRelated("PIPA:30(1)1", "PIPA:30(2)")).toBe(false);
    expect(refsRelated("PIPA:30(1)3", "PIPA:30(1)3-2")).toBe(false); // 제3호의2 is a sibling inserted after 제3호, not its child
    expect(refsRelated("PIPA:30(1)3-2", "PIPA:30(1)3-3")).toBe(false);
    expect(refsRelated("PIPA:28-8(2)", "PIPA:28(2)")).toBe(false);
    expect(refsRelated("PIPA:2[2]", "PIPA:2[2]")).toBe(true);
    expect(refsRelated("PIPA:30(1)1", "DEC:30(1)1")).toBe(false);
  });

  test("a change in PIPA:30(1)1 reaches the rules citing it or its parent, not a sibling item's rules", () => {
    const m = mapUnitsToSections([{ key: "PIPA:30(1)1", change: "amended", oldText: "a", newText: "b" }], ruleSections);
    expect(m.sections.map((s) => s.sectionId)).toEqual(["S01", "S02"]); // S01: R-S01-003 cites PIPA:30(1); S02: R-S02-001 cites PIPA:30(1)1
    expect(m.sections.find((s) => s.sectionId === "S02")!.rules.map((r) => r.ruleId)).toEqual(["R-S02-001"]);
    expect(m.unmapped).toEqual([]);
  });

  test("item-level decoy: a change in PIPA:30(1)2 does NOT affect the rule citing only PIPA:30(1)1", () => {
    const m = mapUnitsToSections([{ key: "PIPA:30(1)2", change: "amended", oldText: "a", newText: "b" }], ruleSections);
    expect(m.sections.map((s) => s.sectionId)).toEqual(["S01", "S05"]);
    expect(m.sections.some((s) => s.rules.some((r) => r.ruleId === "R-S02-001"))).toBe(false);
  });

  test("a change in a parent reaches the rules that cite its children; units no rule cites are unmapped", () => {
    const m = mapUnitsToSections(
      [
        { key: "PIPA:22-2", change: "amended", oldText: "a", newText: "b" },
        { key: "PIPA:45", change: "deleted", oldText: "a" },
        { key: "PIPA:30(3)", change: "added", newText: "c" },
      ],
      ruleSections,
    );
    expect(m.sections.map((s) => s.sectionId)).toEqual(["S04"]);
    expect(m.unmapped.map((u) => u.key)).toEqual(["PIPA:45", "PIPA:30(3)"]);
  });
});

describe("Mode B runner (mock LLM)", () => {
  const policies = [ingestFixture("policy-clean.md", "policy-a"), ingestFixture("policy-vague.md", "policy-b")];
  const sectionOf = (r: StructuredCallRequest): string => /^SECTION (\S+):/m.exec(r.user)![1]!;
  const must = (quote: string): ImpactJudgeOutput => ({ verdict: "must_change", quote, suggestedWording: "처리 목적 및 이용 범위를 함께 적습니다. 문의 privacy@example.com" });
  const llmFor = (s02: ImpactJudgeOutput) => new MockLlmClient({ fixtures: { M1: (r: StructuredCallRequest): ImpactJudgeOutput => (sectionOf(r) === "S02" ? s02 : { verdict: "still_compliant", quote: "", suggestedWording: "" }) } });
  const run = (llm: MockLlmClient | undefined, extra: { confirmed?: boolean; effectiveOn?: string | null } = {}) =>
    runImpact({ ...(llm ? { llm } : {}) }, { diff: { ...diff, effectiveOn: extra.effectiveOn ?? null }, policies, ruleSections, now: NOW, ...(extra.confirmed ? { confirmed: true } : {}) });

  test("one call per (policy, affected section that the policy contains); absent sections are 'not located' without a call", async () => {
    const llm = llmFor(must("회원 가입 및 관리: 본인 확인, 서비스 제공"));
    const r = await run(llm);
    // affected sections: S01, S02, S04; the fixtures contain S01 and S02 but not S04
    expect(llm.callCount("M1")).toBe(4);
    expect(llm.calls.every((c) => c.modelId === "claude-opus-5-5" && c.user.includes("AMENDED PROVISIONS"))).toBe(true);
    const a = r.perPolicy.get("policy-a")!;
    const s04 = a.find((f) => f.sectionId === "S04")!;
    expect([s04.severity, s04.location.para]).toEqual(["confirm", null]);
  });

  test("provisional findings: capped at Medium, located, trigger set, wording marked non-final, contacts masked", async () => {
    const r = await run(llmFor(must("회원 가입 및 관리: 본인 확인, 서비스 제공")));
    const f = r.perPolicy.get("policy-a")!.find((x) => x.sectionId === "S02")!;
    expect([f.mode, f.tier, f.severity, f.layer, f.ruleId]).toEqual(["B", "provisional", "medium", "llm", "R-S02-001"]);
    expect(f.location).toEqual({ sectionId: "S02", para: 2, quote: "회원 가입 및 관리: 본인 확인, 서비스 제공" });
    expect(f.trigger).toEqual({ law: "PIPA", articleKey: "PIPA:2[2]", effectiveOn: null });
    expect(f.message).toContain("가능성");
    expect(f.fixHint).toContain("확정 아님");
    expect(f.fixHint).not.toContain("privacy@example.com");
    expect(f.fixHint).toContain("[이메일]");
    for (const list of r.perPolicy.values()) for (const x of list) expect(["critical", "high"]).not.toContain(x.severity);
  });

  test("a changed unit that no rule cites is reported once (not per policy) as UNMAPPED/Confirm", async () => {
    const r = await run(llmFor(must("")));
    expect(r.unmapped.map((f) => [f.sectionId, f.severity, f.tier, f.trigger!.articleKey])).toEqual([["UNMAPPED", "confirm", "provisional", "PIPA:30(3)"], ["UNMAPPED", "confirm", "provisional", "PIPA:45"]]);
    for (const list of r.perPolicy.values()) expect(list.some((f) => f.sectionId === "UNMAPPED")).toBe(false);
  });

  test("a quote that is not verbatim is cleared and the finding drops to Confirm", async () => {
    const r = await run(llmFor(must("이 문장은 존재하지 않습니다")));
    const f = r.perPolicy.get("policy-a")!.find((x) => x.sectionId === "S02")!;
    expect([f.severity, f.location.quote, f.location.para]).toEqual(["confirm", "", null]);
    expect(r.adjustments.join(" ")).toContain("not verbatim");
  });

  test("still_compliant yields no finding; review yields Confirm", async () => {
    const none = await run(llmFor({ verdict: "still_compliant", quote: "", suggestedWording: "" }));
    expect(none.perPolicy.get("policy-a")!.filter((f) => f.sectionId === "S02")).toEqual([]);
    const review = await run(llmFor({ verdict: "review", quote: "", suggestedWording: "" }));
    expect(review.perPolicy.get("policy-a")!.find((f) => f.sectionId === "S02")!.severity).toBe("confirm");
  });

  test("severity follows timing: due within 90 days Medium, later Low; confirmed in-force must is High", async () => {
    expect(impactSeverity({ hasMust: true, effectiveOn: "2026-12-01", now: NOW, confirmed: false })).toBe("medium");
    expect(impactSeverity({ hasMust: true, effectiveOn: "2027-06-01", now: NOW, confirmed: false })).toBe("low");
    expect(impactSeverity({ hasMust: true, effectiveOn: "2026-09-01", now: NOW, confirmed: false })).toBe("medium");
    expect(impactSeverity({ hasMust: true, effectiveOn: "2026-09-01", now: NOW, confirmed: true })).toBe("high");
    expect(impactSeverity({ hasMust: false, effectiveOn: null, now: NOW, confirmed: true })).toBe("low");
    const later = await run(llmFor(must("")), { effectiveOn: "2027-06-01" });
    expect(later.perPolicy.get("policy-a")!.find((f) => f.sectionId === "S02")!.severity).toBe("low");
    const confirmed = await run(llmFor(must("")), { confirmed: true });
    const f = confirmed.perPolicy.get("policy-a")!.find((x) => x.sectionId === "S02")!;
    expect([f.tier, f.severity]).toEqual(["confirmed", "high"]);
    expect(f.fixHint).not.toContain("확정 아님");
  });

  test("without an LLM the affected sections are listed as Confirm and the run says so", async () => {
    const r = await run(undefined);
    expect(r.llmUsed).toBe(false);
    expect(r.warnings.join(" ")).toContain("without a model judgement");
    const f = r.perPolicy.get("policy-a")!.filter((x) => x.severity === "confirm");
    expect(f.map((x) => x.sectionId).sort()).toEqual(["S01", "S02", "S04"]);
  });

  test("an unreadable policy gets one manual-review finding instead of a silent pass", async () => {
    const docx = { ...ingestFixture("policy-clean.md", "policy-c"), status: "needs_manual_review" as const, sections: [], text: "" };
    const r = await runImpact({}, { diff, policies: [docx], ruleSections, now: NOW });
    expect(r.perPolicy.get("policy-c")!.map((f) => [f.ruleId, f.severity])).toEqual([["MON-INGEST", "confirm"]]);
  });
});
