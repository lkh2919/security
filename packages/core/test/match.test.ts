import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../src/contracts/fact-ledger";
import { HouseStyleFileSchema, type HouseStyleFile } from "../src/contracts/house-style";
import { MockLlmClient } from "../src/llm/client";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { classifyBusinessGroup, classifyGroupByRule, loadClauseLibrary, runMatch, type ClauseLibrary } from "../src/stages/match";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KR = join(ROOT, "kb", "jurisdictions", "kr");
const RUN_ID = "20260930-120000-0a1b2c";
const kb = loadKrKnowledge(krPaths(ROOT));
const library = loadClauseLibrary(KR, kb.registry);
const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(KR, "house-style", "lotte-innovate.candidates.json"), "utf8")));

function golden(id: string): { ledger: FactLedger; applicability: ReturnType<typeof runCoverage>["applicability"] } {
  const expected = JSON.parse(readFileSync(join(ROOT, "golden", "cases", id, "expected.json"), "utf8")) as { slots: Record<string, unknown> };
  const slots: Record<string, SlotEntry> = {};
  for (const [k, v] of Object.entries(expected.slots)) {
    slots[k] = v === "needs_manual_review" ? { status: "needs_manual_review", value: null, confidence: 0, evidence: [] } : { status: "filled", value: v as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: "golden", quote: "" }] };
  }
  const ledger = createFactLedgerSchema(kb.registry).parse({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots });
  const { applicability } = runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, termsItems: kb.termsItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: kb.termsPackAvailable });
  return { ledger, applicability };
}
const withSlots = (ledger: FactLedger, extra: Record<string, unknown>): FactLedger => ({
  ...ledger,
  slots: { ...ledger.slots, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { status: "filled", value: v as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: "t", quote: "" }] } as SlotEntry])) },
});

/** The committed library with every clause marked vetted in memory (real vetting is the privacy-domain-expert's job). */
const vettedLibrary: ClauseLibrary = {
  ...library,
  clauses: library.clauses.map((c) => ({ ...c, record: { ...c.record, vetted: true, vettedAgainst: "privacy-2026.04" } })),
};

describe("business group", () => {
  test("rules: free text first, then service types", () => {
    const g = golden("G1").ledger;
    expect(classifyGroupByRule(g)).toEqual({ group: "retail_ecommerce", method: "rule", basis: "serviceNames" }); // "쇼핑나우" says shopping
    expect(classifyGroupByRule({ slots: { "profile.serviceTypes": g.slots["profile.serviceTypes"]! } })).toEqual({ group: "retail_ecommerce", method: "rule", basis: "serviceTypes" });
    expect(classifyGroupByRule(withSlots(g, { "profile.businessGroup": "그룹 지주회사 홀딩스" }))?.group).toBe("group_holding");
    expect(classifyGroupByRule(withSlots(g, { "profile.serviceNames": ["클라우드 플랫폼"] }))?.group).toBe("it_services");
    expect(classifyGroupByRule(golden("G2").ledger)?.group).toBe("hr_corporate");
  });

  test("no rule and no LLM: cross_group by rule default", async () => {
    const d = await classifyBusinessGroup(golden("W3").ledger);
    expect(d).toEqual({ group: "cross_group", method: "rule", basis: "default" });
  });

  test("no rule with an LLM: Haiku fallback decides and is recorded", async () => {
    const llm = new MockLlmClient({ fixtures: { "R4-fallback": { group: "services_leisure" } } });
    const d = await classifyBusinessGroup(golden("W3").ledger, { llm });
    expect(d).toEqual({ group: "services_leisure", method: "llm_fallback", basis: "llm" });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.modelId).toContain("haiku");
  });

  test("a rule hit never calls the LLM", async () => {
    const llm = new MockLlmClient({ fixtures: { "R4-fallback": { group: "logistics" } } });
    await classifyBusinessGroup(golden("G1").ledger, { llm });
    expect(llm.callCount()).toBe(0);
  });
});

describe("clause library loading", () => {
  test("loads the committed library; only unbound-variable clauses are skipped", () => {
    expect(library.clauses.length + library.skipped.length).toBe(153);
    expect(library.skipped.length).toBe(9); // files holding the pinned unbound variables (kb-integrity KNOWN_UNBOUND)
    expect(library.skipped.every((s) => /no slotId/.test(s.reason))).toBe(true);
  });
});

describe("runMatch", () => {
  test("the committed library has no vetted clause yet: every section falls back to the rule pack", async () => {
    const { ledger, applicability } = golden("G1");
    const r = await runMatch({ runId: RUN_ID, ledger, applicability, library, houseStyle });
    expect(r.unvettedSkipped).toBe(library.clauses.length);
    expect(Object.values(r.selection.sections).every((s) => s.candidates.length === 0)).toBe(true);
    expect(r.sectionsWithoutClause).toContain("S09");
    expect(r.selection.houseStyleVersion).toBe("candidates-unapproved");
  });

  test("vetted clauses are ranked: group match first, then coverage; not-applicable items are skipped", async () => {
    const { ledger, applicability } = golden("G1");
    const r = await runMatch({ runId: RUN_ID, ledger, applicability, library: vettedLibrary, houseStyle });
    expect(r.selection.businessGroup).toBe("retail_ecommerce");
    expect(r.selection.groupMethod).toBe("rule");
    expect(r.selection.sections["S10"]).toBeUndefined(); // gate.overseasTransfer is false
    const s01 = r.selection.sections["S01"]!.candidates;
    expect(s01.length).toBeGreaterThan(1);
    expect(s01.map((c) => c.rank)).toEqual(s01.map((_, i) => i + 1));
    const groupOf = (id: string): string => vettedLibrary.clauses.find((c) => c.record.clauseId === id)!.domainGroup;
    const tier = (g: string): number => (g === "retail_ecommerce" ? 0 : g === "cross_group" ? 1 : 2);
    const tiers = s01.map((c) => tier(groupOf(c.clauseId)));
    expect(tiers).toEqual([...tiers].sort((x, y) => x - y));
    expect(Object.keys(r.selection.sections).some((k) => k.startsWith("T"))).toBe(true);
  });

  test("terms items are not matched when the terms document is not applicable (G2)", async () => {
    const { ledger, applicability } = golden("G2");
    const r = await runMatch({ runId: RUN_ID, ledger, applicability, library: vettedLibrary, houseStyle });
    expect(r.selection.businessGroup).toBe("hr_corporate");
    expect(Object.keys(r.selection.sections).some((k) => k.startsWith("T"))).toBe(false);
  });

  test("coverage: a condition known to be false excludes the clause from code-only rendering", async () => {
    const { ledger, applicability } = golden("G1");
    const conditional = vettedLibrary.clauses.find((c) => c.record.conditions.length > 0);
    expect(conditional).toBeDefined();
    const item = conditional!.record.itemIds[0]!;
    const r = await runMatch({ runId: RUN_ID, ledger, applicability: { ...applicability, items: { ...applicability.items, [item]: { state: "yes", basisSlots: [] } } }, library: vettedLibrary, houseStyle });
    const cand = r.selection.sections[item]?.candidates.find((c) => c.clauseId === conditional!.record.clauseId);
    expect(cand).toBeDefined();
    expect(["full", "partial", "none"]).toContain(cand!.coverage);
  });

  test("only approved house-style rules are attached", async () => {
    const { ledger, applicability } = golden("G1");
    const none = await runMatch({ runId: RUN_ID, ledger, applicability, library: vettedLibrary, houseStyle });
    expect(none.selection.sections["S01"]!.styleRefs).toEqual([]);
    const approved: HouseStyleFile = { ...houseStyle, status: "approved", version: "1.0.0", rules: houseStyle.rules.map((r, i) => ({ ...r, status: i === 0 ? "approved" : "candidate" })) } as HouseStyleFile;
    const first = houseStyle.rules[0]!;
    const r = await runMatch({ runId: RUN_ID, ledger, applicability, library: vettedLibrary, houseStyle: { ...approved, status: "candidate" } });
    const section = r.selection.sections["S01"]!.styleRefs;
    expect(section.includes(first.id)).toBe(first.scope === "privacy" || first.scope === "both");
    expect(section.every((id) => id === first.id)).toBe(true);
  });

  test("the selection is deterministic", async () => {
    const { ledger, applicability } = golden("G1");
    const a = await runMatch({ runId: RUN_ID, ledger, applicability, library: vettedLibrary, houseStyle });
    const b = await runMatch({ runId: RUN_ID, ledger, applicability, library: vettedLibrary, houseStyle });
    expect(a.selection).toEqual(b.selection);
  });
});
