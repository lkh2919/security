/**
 * Seeded-defect injection for auditor calibration (design R6.3): deterministic AST mutation of a reference draft, driven by
 * the defect spec (`golden/defects/D*.json`). The mutation works at section level: `replace` swaps the section body for the
 * defective text, `insert` appends it, `remove` drops the last table or paragraph of the section. A human-reviewed reference
 * draft plus this injection is what R7 recall is measured on.
 */
import type { Block, DocAST, SectionAST } from "../contracts/ast";
import type { DefectSpec } from "../contracts/rubric";

const para = (text: string): Block => ({ t: "para", runs: [{ t: "text", text }] });

export function applyDefect(ast: DocAST, spec: DefectSpec): DocAST {
  const idx = ast.sections.findIndex((s) => s.id === spec.sectionId);
  if (idx < 0) throw new Error(`[EVAL] defect ${spec.id}: section ${spec.sectionId} not in the ${ast.docType} draft`);
  const sec = ast.sections[idx]!;
  const text = spec.mutation.defectiveText;
  let blocks: Block[];
  if (spec.mutation.kind === "remove") {
    const lastTable = [...sec.blocks].map((b, i) => [b, i] as const).reverse().find(([b]) => b.t === "table");
    const drop = lastTable ? lastTable[1] : sec.blocks.length - 1;
    blocks = sec.blocks.filter((_, i) => i !== drop);
  } else {
    if (!text) throw new Error(`[EVAL] defect ${spec.id}: ${spec.mutation.kind} needs defectiveText`);
    blocks = spec.mutation.kind === "replace" ? [para(text)] : [...sec.blocks, para(text)];
  }
  const mutated: SectionAST = { ...sec, status: "drafted", blocks };
  const sections = ast.sections.map((s, i) => (i === idx ? mutated : s));
  return { ...ast, sections } as DocAST;
}
