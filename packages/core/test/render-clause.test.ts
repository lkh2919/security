import { describe, expect, test } from "bun:test";
import type { ClauseRecord } from "../src/contracts/clause-selection";
import type { FactLedger, SlotEntry } from "../src/contracts/fact-ledger";
import { ClauseSyntaxError, parseClauseBody, renderClause } from "../src/stages/draft";
import { RUN_ID } from "./fixtures";

const entry = (value: unknown, status: SlotEntry["status"] = "filled"): SlotEntry => ({ status, value: value as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: "t", quote: "" }] });
const ledger = (slots: Record<string, SlotEntry>): FactLedger => ({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: "test-1.0.0", slots });
const clause = (body: string, vars: Record<string, string> = {}): ClauseRecord => ({
  clauseId: "lotte.privacy.S09.test.01",
  docType: "privacy",
  itemIds: ["S09"],
  body,
  vars: Object.entries(vars).map(([name, slotPath]) => ({ name, slotPath })),
  conditions: [],
  provenance: { sourceUrl: "https://example.com/p", affiliate: "a", businessGroup: "retail_ecommerce", captureDate: "2026-09-29", contentHash: "a".repeat(64) },
  vetted: true,
  vettedAgainst: "privacy-2026.04",
  styleRefs: [],
});

describe("parseClauseBody", () => {
  test("nested if blocks and variables", () => {
    const n = parseClauseBody("a{%if gate.x%}b{%if not gate.y%}{{v}}{%endif%}{%endif%}c");
    expect(n.map((x) => x.k)).toEqual(["text", "if", "text"]);
  });
  test("unbalanced blocks throw", () => {
    expect(() => parseClauseBody("{%if gate.x%}a")).toThrow(ClauseSyntaxError);
    expect(() => parseClauseBody("a{%endif%}")).toThrow(ClauseSyntaxError);
  });
});

describe("renderClause", () => {
  test("substitutes variables with slotRef runs and splits paragraphs on newlines", () => {
    const r = renderClause(clause("{{op}}는 개인정보를 처리합니다.\n\n문의: {{contact}}", { op: "profile.orgNameRef", contact: "privacy.S16_requestDept" }), ledger({ "profile.orgNameRef": entry("쇼핑나우"), "privacy.S16_requestDept": entry("고객지원팀") }));
    expect(r.rendered).toBe(true);
    if (!r.rendered) return;
    expect(r.blocks).toEqual([
      { t: "para", runs: [{ t: "text", text: "쇼핑나우", slotRef: "profile.orgNameRef" }, { t: "text", text: "는 개인정보를 처리합니다." }] },
      { t: "para", runs: [{ t: "text", text: "문의: " }, { t: "text", text: "고객지원팀", slotRef: "privacy.S16_requestDept" }] },
    ]);
    expect(r.slotRefs).toEqual(["privacy.S16_requestDept", "profile.orgNameRef"]);
  });

  test("if / not-if follow known gate values", () => {
    const body = "기본.\n{%if gate.outsourcing%}위탁 있음.\n{%endif%}{%if not gate.outsourcing%}위탁 없음.\n{%endif%}";
    const text = (g: boolean): string[] => {
      const r = renderClause(clause(body), ledger({ "gate.outsourcing": entry(g) }));
      expect(r.rendered).toBe(true);
      return r.rendered ? r.blocks.map((b) => (b.t === "para" ? b.runs.map((x) => (x.t === "text" ? x.text : "")).join("") : "")) : [];
    };
    expect(text(true)).toEqual(["기본.", "위탁 있음."]);
    expect(text(false)).toEqual(["기본.", "위탁 없음."]);
  });

  test("an unknown gate blocks code-only rendering", () => {
    const r = renderClause(clause("{%if gate.outsourcing%}x{%endif%}"), ledger({}));
    expect(r).toEqual({ rendered: false, reason: "unknown_condition", missing: ["gate.outsourcing"] });
    const manual = renderClause(clause("{%if gate.outsourcing%}x{%endif%}"), ledger({ "gate.outsourcing": { status: "needs_manual_review", value: null, confidence: 0, evidence: [] } }));
    expect(manual.rendered).toBe(false);
  });

  test("a missing or unbound variable blocks rendering and is reported", () => {
    expect(renderClause(clause("{{a}} {{b}}", { a: "profile.orgNameRef" }), ledger({ "profile.orgNameRef": entry("x") }))).toEqual({ rendered: false, reason: "missing_vars", missing: ["b"] });
    expect(renderClause(clause("{{a}}", { a: "profile.orgNameRef" }), ledger({}))).toEqual({ rendered: false, reason: "missing_vars", missing: ["profile.orgNameRef"] });
  });

  test("a not_applicable variable renders empty; a row array becomes a table", () => {
    const na: SlotEntry = { status: "not_applicable", value: null, confidence: 1, evidence: [] };
    const r = renderClause(clause("표:\n{{tbl}}\n끝.", { tbl: "privacy.S09_processors" }), ledger({ "privacy.S09_processors": entry([{ name: "한빛택배", task: "배송" }, { name: "메시지허브", task: "문자" }]) }));
    expect(r.rendered).toBe(true);
    if (r.rendered) {
      expect(r.blocks.map((b) => b.t)).toEqual(["para", "table", "para"]);
      const t = r.blocks[1]!;
      if (t.t === "table") {
        expect(t.header).toEqual(["name", "task"]);
        expect(t.rows).toHaveLength(2);
      }
    }
    expect(renderClause(clause("값:{{v}}", { v: "terms.minAge" }), ledger({ "terms.minAge": na })).rendered).toBe(true);
  });

  test("deterministic", () => {
    const c = clause("{{a}}\n{%if gate.x%}y{%endif%}", { a: "profile.orgNameRef" });
    const l = ledger({ "profile.orgNameRef": entry("Z"), "gate.x": entry(true) });
    expect(renderClause(c, l)).toEqual(renderClause(c, l));
  });
});
