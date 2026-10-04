/**
 * Policy / Terms AST (design R4.5). One DocAST schema, two docType instances:
 * `PolicyASTSchema` (privacy) and `TermsASTSchema` (terms).
 *
 * Factual text runs carry `slotRef` (evidence trace); statute citations are `cite` inlines that
 * C2 resolves against `citations.json`. Rendering to MD/HTML/DOCX happens in R8 from this tree.
 */
import { z } from "zod";
import { IsoDateSchema, ItemIdSchema, NonEmptyString, RunIdSchema, SlotIdSchema, VersionSchema, WarningSchema, type DocType } from "./common";

export const InlineSchema = z.discriminatedUnion("t", [
  /** `strong`: important content the reader must notice (ARTC 3(1): withdrawal, refund, liability, fees); rendered bold. */
  z.strictObject({ t: z.literal("text"), text: z.string(), slotRef: SlotIdSchema.optional(), strong: z.boolean().optional() }),
  z.strictObject({ t: z.literal("placeholder"), key: NonEmptyString }),
  /** Statute citation, e.g. `PIPA-25`. */
  z.strictObject({ t: z.literal("cite"), citationId: NonEmptyString }),
  z.strictObject({ t: z.literal("link"), text: z.string(), href: NonEmptyString }),
]);
export type Inline = z.infer<typeof InlineSchema>;

const RunsSchema = z.array(InlineSchema);

export const BlockSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("para"), runs: RunsSchema }),
  z.strictObject({ t: z.literal("list"), ordered: z.boolean(), items: z.array(RunsSchema) }),
  /** Table cells are inline runs. Tables are code-rendered from slot data whenever possible. */
  z.strictObject({ t: z.literal("table"), caption: z.string(), header: z.array(z.string()), rows: z.array(z.array(RunsSchema)) }),
  z.strictObject({ t: z.literal("note"), kind: z.enum(["info", "manual_review", "freshness", "disclaimer"]), runs: RunsSchema }),
]);
export type Block = z.infer<typeof BlockSchema>;

export const SectionStatusSchema = z.enum(["drafted", "not_processed_statement", "omitted_recommended", "manual_review", "not_applicable"]);
export type SectionStatus = z.infer<typeof SectionStatusSchema>;

export const SectionTraceSchema = z.strictObject({
  slotRefs: z.array(SlotIdSchema),
  clauseRefs: z.array(NonEmptyString),
  ruleRefs: z.array(NonEmptyString),
  styleRefs: z.array(NonEmptyString),
  citationIds: z.array(NonEmptyString),
});

export const SectionASTSchema = z.strictObject({
  id: ItemIdSchema,
  title: NonEmptyString,
  status: SectionStatusSchema,
  blocks: z.array(BlockSchema),
  trace: SectionTraceSchema,
});
export type SectionAST = z.infer<typeof SectionASTSchema>;

export const DocMetaSchema = z.strictObject({
  runId: RunIdSchema,
  effectiveDate: IsoDateSchema,
  rulePackVersion: VersionSchema,
  clauseLibVersion: VersionSchema,
  houseStyleVersion: VersionSchema,
  lawSnapshotId: NonEmptyString,
  /** Stage id -> prompt semver used to produce this document. */
  promptVersions: z.record(z.string(), z.string()),
  /** Stage id -> pinned model ID. */
  models: z.record(z.string(), z.string()),
});
export type DocMeta = z.infer<typeof DocMetaSchema>;

function makeDocAstSchema<T extends DocType>(docType: T) {
  const idPrefix = docType === "privacy" ? /^(S\d{2}|A1|X1)$/ : /^T\d{2}$/;
  return z
    .strictObject({
      docType: z.literal(docType),
      meta: DocMetaSchema,
      sections: z.array(SectionASTSchema),
      warnings: z.array(WarningSchema),
    })
    .superRefine((doc, ctx) => {
      const seen = new Set<string>();
      doc.sections.forEach((section, i) => {
        if (!idPrefix.test(section.id)) ctx.addIssue({ code: "custom", path: ["sections", i, "id"], message: `section ${section.id} does not belong to a ${docType} document` });
        if (seen.has(section.id)) ctx.addIssue({ code: "custom", path: ["sections", i, "id"], message: `duplicate section id ${section.id}` });
        seen.add(section.id);
      });
    });
}

export const PolicyASTSchema = makeDocAstSchema("privacy");
export const TermsASTSchema = makeDocAstSchema("terms");
export type PolicyAST = z.infer<typeof PolicyASTSchema>;
export type TermsAST = z.infer<typeof TermsASTSchema>;
export type DocAST = PolicyAST | TermsAST;
export const DocASTSchema = z.union([PolicyASTSchema, TermsASTSchema]);

// --- Walkers used by C2 and the auditor summary ---------------------------------------------------

function* inlinesOf(block: Block): Generator<Inline> {
  switch (block.t) {
    case "para":
    case "note":
      yield* block.runs;
      return;
    case "list":
      for (const item of block.items) yield* item;
      return;
    case "table":
      for (const row of block.rows) for (const cell of row) yield* cell;
      return;
  }
}

export function* sectionInlines(section: SectionAST): Generator<Inline> {
  for (const block of section.blocks) yield* inlinesOf(block);
}

/** Distinct `slotRef` values used by inline text in a section, sorted. */
export function collectSlotRefs(section: SectionAST): string[] {
  const refs = new Set<string>();
  for (const inline of sectionInlines(section)) if (inline.t === "text" && inline.slotRef) refs.add(inline.slotRef);
  return [...refs].sort();
}

/** Distinct citation IDs used by `cite` inlines in a section, sorted. */
export function collectCitationIds(section: SectionAST): string[] {
  const ids = new Set<string>();
  for (const inline of sectionInlines(section)) if (inline.t === "cite") ids.add(inline.citationId);
  return [...ids].sort();
}
