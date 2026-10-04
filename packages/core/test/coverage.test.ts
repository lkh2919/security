import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../src/contracts/common";
import type { FactLedger, SlotEntry } from "../src/contracts/fact-ledger";
import { detectDelegationAmbiguity, evalCond, loadKrKnowledge, krPaths, nodeGap, runCoverage, TERMS_ITEM_IDS, type KrKnowledge } from "../src/stages/coverage";
import { RUN_ID } from "./fixtures";

const REPO = join(import.meta.dir, "..", "..", "..");
const kb: KrKnowledge = loadKrKnowledge(krPaths(REPO));
const cases = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "coverage", "cases.json"), "utf8")) as Record<string, Record<string, JsonValue>>;

const entry = (value: JsonValue, over: Partial<SlotEntry> = {}): SlotEntry => ({
  value,
  status: "filled",
  confidence: 0.9,
  evidence: [{ source: "user_confirmed", ref: "test", quote: "" }],
  ...over,
});

function ledgerOf(facts: Record<string, JsonValue>, extra: Record<string, SlotEntry> = {}): FactLedger {
  const slots: Record<string, SlotEntry> = {};
  for (const [k, v] of Object.entries(facts)) slots[k] = entry(v);
  return { runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots: { ...slots, ...extra } };
}

function cover(ledger: FactLedger, over: Partial<Parameters<typeof runCoverage>[0]> = {}) {
  return runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, termsItems: kb.termsItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: kb.termsPackAvailable, ...over });
}

const gapIds = (r: ReturnType<typeof cover>): string[] => r.gapList.gaps.map((g) => g.questionId);

describe("condition evaluator (three-valued)", () => {
  const ctx = { slots: { "gate.a": entry(true), "gate.b": entry(false), "gate.c": entry(null, { status: "missing", confidence: 0 }), "profile.t": entry(["b2c_commerce", "x"]) } };
  test("truthy / eq / in / exists and unknowns", () => {
    expect(evalCond({ slot: "gate.a", op: "truthy" }, ctx)).toBe(true);
    expect(evalCond({ slot: "gate.b", op: "truthy" }, ctx)).toBe(false);
    expect(evalCond({ slot: "gate.c", op: "truthy" }, ctx)).toBeNull();
    expect(evalCond({ slot: "gate.zzz", op: "truthy" }, ctx)).toBeNull();
    expect(evalCond({ slot: "gate.zzz", op: "exists" }, ctx)).toBe(false);
    expect(evalCond({ slot: "profile.t", op: "in", value: ["b2c_commerce"] }, ctx)).toBe(true);
    expect(evalCond({ slot: "profile.t", op: "in", value: ["internal_hr"] }, ctx)).toBe(false);
    expect(evalCond({ slot: "gate.b", op: "eq", value: false }, ctx)).toBe(true);
  });
  test("Kleene all/any/not; empty all is always true; tautology any(exists, not exists) is true", () => {
    expect(evalCond({ all: [] }, ctx)).toBe(true);
    expect(evalCond({ all: [{ slot: "gate.b", op: "truthy" }, { slot: "gate.c", op: "truthy" }] }, ctx)).toBe(false);
    expect(evalCond({ any: [{ slot: "gate.a", op: "truthy" }, { slot: "gate.c", op: "truthy" }] }, ctx)).toBe(true);
    expect(evalCond({ any: [{ slot: "gate.b", op: "truthy" }, { slot: "gate.c", op: "truthy" }] }, ctx)).toBeNull();
    expect(evalCond({ not: { slot: "gate.c", op: "truthy" } }, ctx)).toBeNull();
    expect(evalCond({ any: [{ slot: "gate.zzz", op: "exists" }, { not: { slot: "gate.zzz", op: "exists" } }] }, ctx)).toBe(true);
  });
  test('Korean negative form strings are not truthy ("예" is)', () => {
    const c = { slots: { "gate.y": entry("예"), "gate.n": entry("아니오") } };
    expect(evalCond({ slot: "gate.y", op: "truthy" }, c)).toBe(true);
    expect(evalCond({ slot: "gate.n", op: "truthy" }, c)).toBe(false);
  });
});

describe("knowledge base loading", () => {
  test("template, registry, and rule packs load; all items are covered", () => {
    expect(kb.template.modules.length).toBeGreaterThanOrEqual(10);
    const ids = kb.rulePackItems.map((i) => i.id);
    for (let n = 1; n <= 24; n++) expect(ids).toContain(`S${String(n).padStart(2, "0")}`);
    expect(ids).toContain("A1");
    expect(ids).toContain("X1");
  });
});

describe("C1 applicability and gaps", () => {
  test("empty ledger: core gate questions are gaps, nothing conditional is entered, every item is reported", () => {
    const r = cover(ledgerOf({}));
    const ids = gapIds(r);
    for (const id of ["Q-P-01", "Q-P-02", "Q-S07-01", "Q-S09-01", "Q-S10-01"]) expect(ids).toContain(id);
    expect(ids).not.toContain("Q-S07-02"); // detail nodes wait for their gate
    expect(r.gapList.gaps.every((g) => g.reason === "missing")).toBe(true);
    expect(Object.keys(r.applicability.items).length).toBe(kb.rulePackItems.length + 15);
    expect(r.applicability.items.S01.state).toBe("yes");
    expect(r.applicability.items.S07.state).toBe("unknown");
    expect(r.applicability.items.S07.basisSlots).toEqual(["gate.thirdPartyProvision"]);
  });

  test("B2C commerce: S09 and S14 apply, S07/S10/S04 do not, b2c nodes asked, no HR or children nodes", () => {
    const r = cover(ledgerOf(cases.b2c_commerce));
    const it = r.applicability.items;
    expect(it.S09.state).toBe("yes");
    expect(it.S14.state).toBe("yes");
    for (const id of ["S07", "S10", "S04", "S21", "A1", "X1", "S17"]) expect(it[id].state).toBe("no");
    expect(r.applicability.documents.terms.applicable).toBe(true);
    const ids = gapIds(r);
    expect(ids).toContain("Q-S09-02"); // outsourcing is true -> detail asked
    expect(ids).toContain("Q-S05-20"); // b2c retention
    expect(ids).not.toContain("Q-S03-40"); // internal_hr module
    expect(ids).not.toContain("Q-S07-02");
    expect(ids.some((id) => /^Q-S04-8/.test(id))).toBe(false); // children module
    expect(r.applicability.warnings.filter((w) => w.kind === "special_type")).toEqual([]);
    expect(r.gapList.warnings).toEqual(r.applicability.warnings);
  });

  test("terms packs absent: T01-T15 are pending with a TERMS_PACK_PENDING warning; present: each article follows its own condition", () => {
    const pending = cover(ledgerOf(cases.b2c_commerce), { termsPackAvailable: false });
    for (const id of TERMS_ITEM_IDS) expect(pending.applicability.items[id]).toEqual({ state: "pending", basisSlots: [] });
    expect(pending.applicability.warnings.map((w) => w.code)).toContain("TERMS_PACK_PENDING");
    const ready = cover(ledgerOf(cases.b2c_commerce), { termsPackAvailable: true });
    // The commerce sample confirms membership but not paid features or user content: T09/T10/T12 stay open, the rest apply.
    const states = Object.fromEntries(TERMS_ITEM_IDS.map((id) => [id, ready.applicability.items[id].state]));
    expect(Object.entries(states).filter(([, s]) => s !== "yes").map(([id, s]) => `${id}:${s}`)).toEqual(["T09:unknown", "T10:unknown", "T12:unknown"]);
    expect(ready.applicability.warnings.map((w) => w.code)).not.toContain("TERMS_PACK_PENDING");
    const free = cover({ ...ledgerOf(cases.b2c_commerce), slots: { ...ledgerOf(cases.b2c_commerce).slots, "terms.paid": { status: "filled", value: false, confidence: 1, evidence: [{ source: "user_confirmed", ref: "t", quote: "" }] } } }, { termsPackAvailable: true });
    expect(free.applicability.items["T10"]!.state).toBe("no");
  });

  test("internal HR: terms document not applicable with a reason, no terms nodes, HR nodes asked", () => {
    const r = cover(ledgerOf(cases.internal_hr), { termsPackAvailable: true });
    expect(r.applicability.documents.terms.applicable).toBe(false);
    expect(r.applicability.documents.terms.reason).toContain("HR");
    for (const id of TERMS_ITEM_IDS) expect(r.applicability.items[id].state).toBe("no");
    const ids = gapIds(r);
    expect(ids).toContain("Q-S03-40");
    expect(ids.some((id) => id.startsWith("Q-T"))).toBe(false);
    expect(ids).not.toContain("Q-S05-20"); // b2c-only
  });

  test("children + CCTV + location + gen-AI: special-type warnings, items apply, warn-only modules are walked", () => {
    const r = cover(ledgerOf(cases.children_cctv));
    const codes = r.applicability.warnings.map((w) => w.code);
    for (const code of ["SPECIAL_CHILDREN", "SPECIAL_CCTV_FIXED", "SPECIAL_LOCATION", "SPECIAL_GENAI"]) expect(codes).toContain(code);
    expect(codes).not.toContain("SPECIAL_CCTV_MOBILE");
    for (const id of ["S04", "S21", "X1", "A1"]) expect(r.applicability.items[id].state).toBe("yes");
    expect(r.applicability.items.S22.state).toBe("no");
    const gapModules = new Set(r.gapList.gaps.map((g) => g.questionId));
    const nodeIds = (moduleId: string): string[] => kb.template.modules.find((m) => m.id === moduleId)!.nodes.map((n) => n.id);
    for (const moduleId of ["children", "cctv_location", "ai_feature"]) {
      expect(nodeIds(moduleId).some((id) => gapModules.has(id))).toBe(true);
    }
    for (const w of r.applicability.warnings.filter((x) => x.kind === "special_type")) expect(w.itemId).toBeDefined();
  });

  test("gap reasons: conflict > manual review > low confidence > missing; resolved slots leave no gap", () => {
    const node = kb.template.modules[0].nodes.find((n) => n.id === "Q-S05-01")!;
    const at = (over: Record<string, SlotEntry>) => nodeGap(node, { slots: over });
    const t = node.targets[0];
    expect(at({})?.reason).toBe("missing");
    expect(at({ [t]: entry([{ a: 1 }]) })).toBeNull();
    expect(at({ [t]: entry([{ a: 1 }], { confidence: 0.4 }) })?.reason).toBe("low_confidence");
    expect(at({ [t]: entry(null, { status: "needs_manual_review", confidence: 0 }) })?.reason).toBe("needs_manual_review");
    expect(at({ [t]: entry(null, { status: "conflict", confidence: 0 }) })?.reason).toBe("conflict");
    expect(at({ [t]: entry(null, { status: "not_applicable", confidence: 1 }) })).toBeNull();
  });

  test("preAnswered lets an intake sheet pre-answer a node without touching the ledger", () => {
    const base = cover(ledgerOf(cases.b2c_commerce));
    const target = base.gapList.gaps.find((g) => g.questionId === "Q-S05-20")!;
    expect(target).toBeDefined();
    const withSheet = cover(ledgerOf(cases.b2c_commerce), { preAnswered: { "Q-S05-20": target.targets } });
    expect(gapIds(withSheet)).not.toContain("Q-S05-20");
    expect(gapIds(withSheet).length).toBe(gapIds(base).length - 1);
  });

  test("round is carried into the GapList", () => {
    expect(cover(ledgerOf({}), { round: 2 }).gapList.round).toBe(2);
  });
});

describe("delegation vs third-party provision detector", () => {
  const rows = (names: string[]): JsonValue => names.map((n) => ({ processor: n, recipient: n }));
  test("clean cases are not ambiguous", () => {
    expect(detectDelegationAmbiguity(ledgerOf({})).ambiguous).toBe(false);
    expect(detectDelegationAmbiguity(ledgerOf({ "gate.outsourcing": true, "gate.thirdPartyProvision": false, "privacy.S09_processors": rows(["택배사"]) })).ambiguous).toBe(false);
  });
  test("same recipient in both lists, conflicting gates, or mixed wording are ambiguous", () => {
    expect(detectDelegationAmbiguity(ledgerOf({ "gate.outsourcing": true, "gate.thirdPartyProvision": true, "privacy.S09_processors": rows(["알림톡 업체"]), "privacy.S07_thirdParties": rows(["알림톡 업체"]) })).ambiguous).toBe(true);
    expect(detectDelegationAmbiguity(ledgerOf({}, { "gate.outsourcing": entry(null, { status: "conflict", confidence: 0 }) })).ambiguous).toBe(true);
    const mixed = ledgerOf({ "gate.outsourcing": true }, { "privacy.S09_processors": entry(rows(["A사"]), { evidence: [{ source: "transcript", segmentId: "T0001", quote: "A사에 맡기는데 사실상 제공에 가깝습니다" }] }) });
    expect(detectDelegationAmbiguity(mixed).ambiguous).toBe(true);
  });
  test("C1 raises a DELEGATION_VS_PROVISION manual_review warning", () => {
    const ledger = ledgerOf({ "gate.outsourcing": true, "gate.thirdPartyProvision": true, "privacy.S09_processors": rows(["X사"]), "privacy.S07_thirdParties": rows(["X사"]) });
    const w = cover(ledger).applicability.warnings.find((x) => x.code === "DELEGATION_VS_PROVISION");
    expect(w?.kind).toBe("manual_review");
  });
});
