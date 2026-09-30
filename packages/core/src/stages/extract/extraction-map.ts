/**
 * Builds the static slot map that forms the cached prefix of every R2 call: for each registry slot,
 * its value type, table columns, option codes, and the template `evidenceHint`s that say what to
 * listen for. Output is fully deterministic (sorted, no timestamps) so the prompt cache stays warm.
 */
import type { SlotRegistry } from "../../contracts/common";
import type { InterviewTemplate } from "../../contracts/interview-template";
import type { SlotHint } from "../coverage/load-kb";

export interface SlotMapInput {
  readonly template: InterviewTemplate;
  readonly registry: SlotRegistry;
  readonly slotHints?: Readonly<Record<string, SlotHint>>;
}

const FORMAT_BY_TYPE: Record<string, string> = {
  yes_no: "true | false",
  single: "one string",
  multi: "array of strings",
  text: "string",
  table: "array of row objects",
  date: "YYYY-MM-DD string",
  contact_ref: "title/department string only (never a personal name)",
  number: "number",
};

export function buildSlotMap({ template, registry, slotHints = {} }: SlotMapInput): string {
  const hintsBySlot = new Map<string, string[]>();
  const optionsBySlot = new Map<string, Set<string>>();
  for (const mod of template.modules) {
    for (const node of mod.nodes) {
      for (const target of node.targets) {
        const list = hintsBySlot.get(target) ?? [];
        list.push(`${node.id}: ${node.evidenceHint}`);
        hintsBySlot.set(target, list);
        if (node.options && node.targets.length === 1) {
          const set = optionsBySlot.get(target) ?? new Set<string>();
          node.options.forEach((o) => set.add(o));
          optionsBySlot.set(target, set);
        }
      }
    }
  }

  const lines: string[] = [];
  for (const id of registry.ids()) {
    const def = registry.get(id);
    if (!def) continue;
    const hint = slotHints[id];
    const parts = [`- ${id} [${def.type}: ${FORMAT_BY_TYPE[def.type] ?? "JSON"}]`];
    if (hint?.columns?.length) parts.push(`columns=${hint.columns.join("|")}`);
    const options = new Set<string>([...(hint?.options ?? []), ...(optionsBySlot.get(id) ?? [])]);
    if (options.size > 0) parts.push(`options=${[...options].join("|")}`);
    if (def.desc) parts.push(`desc: ${def.desc}`);
    const hints = hintsBySlot.get(id);
    if (hints?.length) parts.push(`listen for: ${hints.join(" / ")}`);
    lines.push(parts.join(" ; "));
  }
  return lines.join("\n");
}
