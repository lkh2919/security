/**
 * IngestedPolicy -> PolicyAST (Policy Monitor design M5, Mode A reuse). One `para` per source paragraph; consecutive table
 * rows of a section become one `table` block (so C2's recipient check sees the first column). Status is `drafted`,
 * trace arrays are empty and nothing carries a slotRef: a published policy has no ledger. UNMAPPED blocks are left out
 * of the AST (they are not a section); sections mapped twice are concatenated.
 *
 * `paraMap` maps AST paths back to (section, paragraph) for locations: `sections[2].blocks[5]`, and
 * `sections[2].blocks[4].rows[1]` for table rows.
 */
import type { Block, PolicyAST, SectionAST } from "../../contracts/ast";
import { PolicyASTSchema } from "../../contracts/ast";
import { UNMAPPED_SECTION, type IngestedPara, type IngestedPolicy } from "../../contracts/ingested-policy";

export interface ParaRef {
  readonly sectionId: string;
  /** 1-based paragraph number inside the (merged) section. */
  readonly para: number;
}

export interface PolicyAstResult {
  readonly ast: PolicyAST;
  readonly paraMap: ReadonlyMap<string, ParaRef>;
  /** Merged section paragraphs, in AST order, for quote lookup. */
  readonly sectionParas: ReadonlyMap<string, readonly IngestedPara[]>;
}

export interface AstMeta {
  readonly runId: string;
  readonly effectiveDate: string;
  readonly rulePackVersion: string;
}

const textRuns = (text: string): { t: "text"; text: string }[] => [{ t: "text", text }];
const emptyTrace = { slotRefs: [], clauseRefs: [], ruleRefs: [], styleRefs: [], citationIds: [] };

export function policyToAst(policy: IngestedPolicy, meta: AstMeta): PolicyAstResult {
  // Merge sections mapped to the same id, keeping the order of first appearance. Paragraphs are renumbered from 1.
  const order: string[] = [];
  const titles = new Map<string, string>();
  const merged = new Map<string, IngestedPara[]>();
  for (const s of policy.sections) {
    if (s.sectionId === UNMAPPED_SECTION) continue;
    if (!merged.has(s.sectionId)) {
      order.push(s.sectionId);
      titles.set(s.sectionId, s.title || s.sectionId);
      merged.set(s.sectionId, []);
    }
    const list = merged.get(s.sectionId)!;
    for (const p of s.paras) list.push({ ...p, n: list.length + 1 });
  }

  const paraMap = new Map<string, ParaRef>();
  const sections: SectionAST[] = order.map((id, si) => {
    const blocks: Block[] = [];
    const paras = merged.get(id)!;
    let i = 0;
    while (i < paras.length) {
      const p = paras[i]!;
      if (p.kind === "row" && p.cells) {
        const group: IngestedPara[] = [];
        while (i < paras.length && paras[i]!.kind === "row" && paras[i]!.cells) group.push(paras[i++]!);
        const hasHeader = group[0]!.header === true;
        const bodyRows = hasHeader ? group.slice(1) : group;
        const bi = blocks.length;
        blocks.push({ t: "table", caption: "", header: hasHeader ? [...group[0]!.cells!] : [], rows: bodyRows.map((r) => r.cells!.map(textRuns)) });
        if (hasHeader) paraMap.set(`sections[${si}].blocks[${bi}].header`, { sectionId: id, para: group[0]!.n });
        bodyRows.forEach((r, ri) => paraMap.set(`sections[${si}].blocks[${bi}].rows[${ri}]`, { sectionId: id, para: r.n }));
        paraMap.set(`sections[${si}].blocks[${bi}]`, { sectionId: id, para: bodyRows[0]?.n ?? group[0]!.n });
        continue;
      }
      paraMap.set(`sections[${si}].blocks[${blocks.length}]`, { sectionId: id, para: p.n });
      blocks.push({ t: "para", runs: textRuns(p.text) });
      i += 1;
    }
    return { id, title: titles.get(id)!, status: "drafted", blocks, trace: { ...emptyTrace } };
  });

  const ast = PolicyASTSchema.parse({
    docType: "privacy",
    meta: { runId: meta.runId, effectiveDate: meta.effectiveDate, rulePackVersion: meta.rulePackVersion, clauseLibVersion: "n/a", houseStyleVersion: "n/a", lawSnapshotId: "monitor", promptVersions: {}, models: {} },
    sections,
    warnings: [],
  });
  return { ast, paraMap, sectionParas: merged };
}

/** Resolves a C2 `astPath` (`sections[1].blocks[3].rows[0][0]`, `...runs`, `...items[2]`) to its source paragraph. */
export function locateAstPath(paraMap: ReadonlyMap<string, ParaRef>, astPath: string): ParaRef | undefined {
  const m = /^(sections\[\d+\]\.blocks\[\d+\])(\.rows\[\d+\]|\.header)?/.exec(astPath);
  if (!m) return undefined;
  return (m[2] ? paraMap.get(m[1]! + m[2]) : undefined) ?? paraMap.get(m[1]!);
}
