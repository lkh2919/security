/**
 * R8 Renderer (design R3 row R8): AST -> Markdown / HTML / DOCX plus the Reviewer Sheet.
 * Pure and deterministic; zero LLM calls. Placeholder rehydration happens here, locally, from the PiiVault.
 *
 * Caching note: output rendered with a vault contains real PII. Do not push vault-rehydrated output
 * through StageCache; use `encodeRenderOutput` only for vault-less renders.
 */
import { z } from "zod";
import type { DocAST } from "../../contracts/ast";
import type { PolicyAST, TermsAST } from "../../contracts/ast";
import type { AuditReport } from "../../contracts/audit-report";
import type { CheckResults } from "../../contracts/check-results";
import { docToDocx } from "./docx";
import { docToHtml } from "./html";
import { docToMarkdown } from "./markdown";
import { Collector, buildDoc } from "./resolve";
import { buildReviewerSheet } from "./reviewer-sheet";
import type { RenderOptions } from "./types";

export * from "./types";
export { evidenceFromLedger, buildReviewerSheet, STATUS_LABEL, type ReviewerSheetInput, type ReviewedDoc } from "./reviewer-sheet";
export { DEFAULT_DISCLAIMER, DEFAULT_DRAFT_BANNER, formatCitation } from "./resolve";

export function renderMarkdown(ast: DocAST, opts: RenderOptions = {}): string {
  return docToMarkdown(buildDoc(ast, opts, new Collector()));
}

export function renderHtml(ast: DocAST, opts: RenderOptions = {}): string {
  return docToHtml(buildDoc(ast, opts, new Collector()));
}

/** Async because the DOCX packer is async. Bytes are normalized (fixed zip/core timestamps). */
export function renderDocx(ast: DocAST, opts: RenderOptions = {}): Promise<Uint8Array> {
  return docToDocx(buildDoc(ast, opts, new Collector()));
}

/** Warnings a render of `ast` would raise (unresolved placeholders/citations, manual-review sections, AST warnings). */
export function collectRenderWarnings(ast: DocAST, opts: RenderOptions = {}): string[] {
  const col = new Collector();
  buildDoc(ast, opts, col);
  return col.warnings;
}

export interface RenderInput {
  readonly policy?: PolicyAST;
  readonly terms?: TermsAST;
  /** Stated in the Reviewer Sheet when C1 marked the terms `not_applicable`. */
  readonly termsNotApplicableReason?: string;
  readonly options?: RenderOptions;
  /** Latest audit report per document (highest iteration wins). */
  readonly audits?: readonly AuditReport[];
  readonly checks?: readonly CheckResults[];
  readonly slotEvidence?: Readonly<Record<string, readonly string[]>>;
  readonly openQuestions?: readonly string[];
}

export interface RenderedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}
export interface RenderOutput {
  readonly files: RenderedFile[];
  readonly warnings: string[];
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export async function runRender(input: RenderInput): Promise<RenderOutput> {
  const base = input.options ?? {};
  const col = new Collector();
  const files: RenderedFile[] = [];
  const docs: { ast: DocAST; audit?: AuditReport; checks?: CheckResults }[] = [];

  const targets: [DocAST | undefined, string][] = [
    [input.policy, "privacy-policy"],
    [input.terms, "terms"],
  ];
  for (const [ast, stem] of targets) {
    if (!ast) continue;
    const audit = (input.audits ?? []).filter((a) => a.docType === ast.docType).sort((a, b) => b.iteration - a.iteration)[0];
    const checks = (input.checks ?? []).find((c) => c.docType === ast.docType);
    const unresolvedOpen = audit?.verdict === "fail";
    const opts: RenderOptions = { ...base, draftBanner: base.draftBanner ?? (unresolvedOpen ? true : undefined) };
    const rdoc = buildDoc(ast, opts, col);
    files.push({ name: `${stem}.md`, bytes: utf8(docToMarkdown(rdoc)) }, { name: `${stem}.html`, bytes: utf8(docToHtml(rdoc)) }, { name: `${stem}.docx`, bytes: await docToDocx(rdoc) });
    docs.push({ ast, audit, checks });
  }

  const warnings = col.warnings;
  if (!input.policy && !input.terms) warnings.push("렌더링할 문서가 없습니다");
  const sheet = buildReviewerSheet({ docs, slotEvidence: input.slotEvidence, openQuestions: input.openQuestions, termsNotApplicableReason: input.terms ? undefined : input.termsNotApplicableReason, warnings });
  files.push({ name: "reviewer-sheet.md", bytes: utf8(docToMarkdown(sheet)) }, { name: "reviewer-sheet.html", bytes: utf8(docToHtml(sheet)) });
  return { files, warnings };
}

// --- JSON-safe form for runCachedStage / RunStore artifacts (vault-less renders only) ---------------

export const RenderOutputStoredSchema = z.strictObject({
  files: z.array(z.strictObject({ name: z.string(), base64: z.string() })),
  warnings: z.array(z.string()),
});
export type RenderOutputStored = z.infer<typeof RenderOutputStoredSchema>;

export const encodeRenderOutput = (o: RenderOutput): RenderOutputStored => ({
  files: o.files.map((f) => ({ name: f.name, base64: Buffer.from(f.bytes).toString("base64") })),
  warnings: o.warnings,
});
export const decodeRenderOutput = (s: RenderOutputStored): RenderOutput => ({
  files: s.files.map((f) => ({ name: f.name, bytes: new Uint8Array(Buffer.from(f.base64, "base64")) })),
  warnings: s.warnings,
});
