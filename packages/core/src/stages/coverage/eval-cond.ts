/**
 * Three-valued evaluator for Interview Template conditions (`showIf`, `enterIf`) and rule-pack
 * applicability against a FactLedger.
 *
 * Semantics (kb/jurisdictions/kr/interview/README.md "Branching"):
 *  - `true` / `false` are known answers; `null` means "not known yet" (slot missing, conflict, manual review).
 *  - `truthy`: true, non-empty string/array/object, non-zero number. A `not_applicable` slot is known-false.
 *  - `eq`: strict JSON equality. `in`: scalar is a member of the list, or a multi-value slot overlaps the list.
 *  - `exists`: known either way; only a `filled` slot with a non-null value exists.
 *  - all/any/not use Kleene logic. `{ always: true }` is the explicit "always"; the legacy `{ all: [] }` form used by
 *    rule packs also evaluates to true (the contract `Cond` accepts both).
 */
import type { Cond, JsonValue } from "../../contracts/common";
import type { FactLedger, SlotEntry } from "../../contracts/fact-ledger";

export type Tri = boolean | null;

/** Loose condition accepted from rule packs (empty `all` allowed). */
export type LooseCond =
  | { always: true }
  | { all: LooseCond[] }
  | { any: LooseCond[] }
  | { not: LooseCond }
  | { slot: string; op: "eq" | "in" | "exists" | "truthy"; value?: JsonValue };

export interface EvalContext {
  readonly slots: Readonly<Record<string, SlotEntry | undefined>>;
}

export function contextFromLedger(ledger: Pick<FactLedger, "slots">): EvalContext {
  return { slots: ledger.slots };
}

function isTruthy(v: JsonValue): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return !["", "false", "no", "n", "0", "아니오", "아니요", "없음"].includes(v.trim().toLowerCase());
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v).length > 0;
}

function jsonEq(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function evalLeaf(cond: { slot: string; op: "eq" | "in" | "exists" | "truthy"; value?: JsonValue }, ctx: EvalContext): Tri {
  const entry = ctx.slots[cond.slot];
  const filled = entry !== undefined && entry.status === "filled" && entry.value !== null;
  if (cond.op === "exists") return filled;
  if (entry !== undefined && entry.status === "not_applicable") return false;
  if (!filled) return null; // missing / conflict / needs_manual_review: unknown until answered
  const value = entry.value as JsonValue;
  switch (cond.op) {
    case "truthy":
      return isTruthy(value);
    case "eq":
      return cond.value === undefined ? null : jsonEq(value, cond.value);
    case "in": {
      const list: JsonValue[] = Array.isArray(cond.value) ? cond.value : cond.value === undefined ? [] : [cond.value];
      const has = (x: JsonValue): boolean => list.some((l) => jsonEq(l, x));
      return Array.isArray(value) ? value.some(has) : has(value);
    }
  }
}

export function evalCond(cond: Cond | LooseCond | undefined, ctx: EvalContext): Tri {
  if (cond === undefined) return true;
  if ("always" in cond) return true;
  if ("all" in cond) {
    let unknown = false;
    for (const c of cond.all) {
      const r = evalCond(c, ctx);
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ("any" in cond) {
    if (cond.any.length === 0) return false;
    let unknown = false;
    for (const c of cond.any) {
      const r = evalCond(c, ctx);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ("not" in cond) {
    const r = evalCond(cond.not, ctx);
    return r === null ? null : !r;
  }
  return evalLeaf(cond, ctx);
}

export function looseCondSlotIds(cond: LooseCond | undefined): string[] {
  if (!cond) return [];
  if ("always" in cond) return [];
  if ("all" in cond) return cond.all.flatMap(looseCondSlotIds);
  if ("any" in cond) return cond.any.flatMap(looseCondSlotIds);
  if ("not" in cond) return looseCondSlotIds(cond.not);
  return [cond.slot];
}
