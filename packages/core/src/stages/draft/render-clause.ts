/**
 * Clause-first rendering (design R3 row R5P/R5T): code renders a vetted clause body when the ledger covers its
 * variables and conditions. Zero tokens, deterministic. Body syntax: `{{var}}` and `{%if slot%}..{%endif%}` /
 * `{%if not slot%}..{%endif%}` (nestable). A line holding only `{{var}}` whose slot is a table becomes a table block.
 *
 * Not renderable (returned, never guessed): a variable whose slot is not filled, or an `if` whose slot is unknown.
 * The drafter then adapts the section with the LLM, or writes a manual-review note.
 */
import type { Block, Inline } from "../../contracts/ast";
import type { ClauseRecord } from "../../contracts/clause-selection";
import type { JsonValue } from "../../contracts/common";
import type { FactLedger, SlotEntry } from "../../contracts/fact-ledger";
import { contextFromLedger, evalCond } from "../coverage/eval-cond";

type Part = { k: "text"; text: string } | { k: "var"; text: string; slotRef: string } | { k: "table"; block: Block };

type Node = { k: "text"; text: string } | { k: "var"; name: string } | { k: "if"; slot: string; negate: boolean; body: Node[] };

const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}|\{%\s*if\s+(not\s+)?([A-Za-z][A-Za-z0-9_.]*)\s*%\}|\{%\s*endif\s*%\}/g;

export class ClauseSyntaxError extends Error {}

export function parseClauseBody(body: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) stack[stack.length - 1]!.push({ k: "text", text: body.slice(last, at) });
    last = at + m[0].length;
    if (m[1]) stack[stack.length - 1]!.push({ k: "var", name: m[1] });
    else if (m[3]) {
      const node: Node = { k: "if", slot: m[3], negate: Boolean(m[2]), body: [] };
      stack[stack.length - 1]!.push(node);
      stack.push(node.body);
    } else {
      if (stack.length === 1) throw new ClauseSyntaxError("{%endif%} without {%if%}");
      stack.pop();
    }
  }
  if (stack.length !== 1) throw new ClauseSyntaxError("{%if%} without {%endif%}");
  if (last < body.length) root.push({ k: "text", text: body.slice(last) });
  return root;
}

export type RenderClauseResult =
  | { readonly rendered: true; readonly blocks: Block[]; readonly slotRefs: string[] }
  | { readonly rendered: false; readonly reason: "missing_vars" | "unknown_condition" | "syntax"; readonly missing: string[] };

const filled = (e: SlotEntry | undefined): boolean => e !== undefined && (e.status === "filled" || e.status === "not_applicable");

function scalarText(v: JsonValue): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(scalarText).filter(Boolean).join(", ");
  return Object.values(v).map(scalarText).filter(Boolean).join(" / ");
}

const isRowArray = (v: JsonValue): v is { [k: string]: JsonValue }[] => Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));

function tableBlock(slotId: string, rows: { [k: string]: JsonValue }[]): Block {
  const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return {
    t: "table",
    caption: "",
    header,
    rows: rows.map((r) => header.map((h): Inline[] => [{ t: "text", text: scalarText(r[h] ?? null), slotRef: slotId }])),
  };
}

/** Evaluates `if` nodes and substitutes variables into inline runs; `null` marks a hole that blocks code-only rendering. */
function flatten(nodes: Node[], clause: ClauseRecord, ledger: FactLedger, out: { parts: Part[]; slotRefs: Set<string>; missing: Set<string>; unknown: Set<string> }): void {
  const ctx = contextFromLedger(ledger);
  for (const n of nodes) {
    if (n.k === "text") out.parts.push({ k: "text", text: n.text });
    else if (n.k === "var") {
      const binding = clause.vars.find((v) => v.name === n.name);
      const entry = binding ? ledger.slots[binding.slotPath] : undefined;
      if (!binding || !filled(entry)) {
        out.missing.add(binding?.slotPath ?? n.name);
        continue;
      }
      out.slotRefs.add(binding.slotPath);
      const value = entry!.value;
      if (isRowArray(value as JsonValue)) out.parts.push({ k: "table", block: tableBlock(binding.slotPath, value as { [k: string]: JsonValue }[]) });
      else out.parts.push({ k: "var", text: scalarText(value as JsonValue), slotRef: binding.slotPath });
    } else {
      const t = evalCond({ slot: n.slot, op: "truthy" }, ctx);
      if (t === null) {
        out.unknown.add(n.slot);
        continue;
      }
      if (t !== n.negate) flatten(n.body, clause, ledger, out);
    }
  }
}

export function renderClause(clause: ClauseRecord, ledger: FactLedger): RenderClauseResult {
  let nodes: Node[];
  try {
    nodes = parseClauseBody(clause.body);
  } catch (e) {
    return { rendered: false, reason: "syntax", missing: [(e as Error).message] };
  }
  const out = { parts: [] as Part[], slotRefs: new Set<string>(), missing: new Set<string>(), unknown: new Set<string>() };
  flatten(nodes, clause, ledger, out);
  if (out.unknown.size) return { rendered: false, reason: "unknown_condition", missing: [...out.unknown].sort() };
  if (out.missing.size) return { rendered: false, reason: "missing_vars", missing: [...out.missing].sort() };

  // Parts to blocks: newlines split paragraphs, variables keep their slotRef, a table ends the current paragraph.
  const blocks: Block[] = [];
  let line: Inline[] = [];
  const endLine = (): void => {
    const runs = line.filter((r) => r.t !== "text" || r.text !== "");
    if (runs.length > 0) {
      const first = runs[0]!;
      const last = runs[runs.length - 1]!;
      if (first.t === "text" && !first.slotRef) runs[0] = { ...first, text: first.text.trimStart() };
      if (last.t === "text" && !last.slotRef) runs[runs.length - 1] = { ...last, text: last.text.trimEnd() };
      if (runs.some((r) => r.t !== "text" || r.text.trim() !== "")) blocks.push({ t: "para", runs });
    }
    line = [];
  };
  for (const p of out.parts) {
    if (p.k === "table") {
      endLine();
      blocks.push(p.block);
    } else if (p.k === "var") line.push({ t: "text", text: p.text, slotRef: p.slotRef });
    else {
      const segments = p.text.split(/\n/);
      segments.forEach((seg, i) => {
        if (i > 0) endLine();
        if (seg) line.push({ t: "text", text: seg });
      });
    }
  }
  endLine();
  return { rendered: true, blocks, slotRefs: [...out.slotRefs].sort() };
}
