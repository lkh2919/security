/**
 * IngestedPolicy (Policy Monitor design M5): a published privacy policy turned into plain text, split into paragraphs
 * and mapped to section ids by the heading rules. Everything here is UNTRUSTED text from a third party; contacts are
 * masked before the object is built (flags only), so the contract carries no phone numbers or e-mail addresses.
 *
 * `span` values are half-open character offsets (`start` inclusive, `end` exclusive) into `text`, so
 * `text.slice(span.start, span.end) === para.text` always holds (span fidelity, design M8).
 */
import { z } from "zod";
import { IsoDateTimeSchema, ItemIdSchema, NonEmptyString, Sha256Schema } from "./common";

/** Section id of a block the segmenter could not place. Shown in the report, never silently dropped. */
export const UNMAPPED_SECTION = "UNMAPPED";

/** File name stem or registry key: `acme-privacy`, `policy_2026`. Also a directory-safe report name. */
export const PolicyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/, "policyId must be 2-64 chars of [A-Za-z0-9_-]");
export type PolicyId = z.infer<typeof PolicyIdSchema>;

export const SpanSchema = z
  .strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((s) => s.end >= s.start, { message: "span end must not precede start" });
export type Span = z.infer<typeof SpanSchema>;

export const IngestFormatSchema = z.enum(["md", "html", "docx", "pdf", "unknown"]);
export type IngestFormat = z.infer<typeof IngestFormatSchema>;

export const IngestedParaSchema = z.strictObject({
  /** 1-based paragraph number inside its section. */
  n: z.number().int().positive(),
  span: SpanSchema,
  text: z.string(),
  /** `row`: one table row; `cells` then holds the (masked) cells and `text` is the cells joined by " | ". */
  kind: z.enum(["heading", "para", "row"]).default("para"),
  cells: z.array(z.string()).optional(),
  /** Table header row (`<th>` cells or the first Markdown table row). */
  header: z.boolean().optional(),
});
export type IngestedPara = z.infer<typeof IngestedParaSchema>;

export const SectionMappedBySchema = z.enum(["heading_exact", "heading_keyword", "preamble", "llm", "none"]);

export const IngestedSectionSchema = z.strictObject({
  sectionId: z.union([ItemIdSchema, z.literal(UNMAPPED_SECTION)]),
  /** The heading as written (masked, numbering kept). */
  title: z.string(),
  span: SpanSchema,
  paras: z.array(IngestedParaSchema),
  mappedBy: SectionMappedBySchema,
  /** 1.0 exact heading, 0.8 keyword, 0.5 preamble, 0 unmapped. Low confidence means "not located", never "missing". */
  confidence: z.number().min(0).max(1),
  /** Contact presence before masking (format flags only). */
  contacts: z.strictObject({ phone: z.boolean(), email: z.boolean() }),
});
export type IngestedSection = z.infer<typeof IngestedSectionSchema>;

export const IngestedPolicySchema = z
  .strictObject({
    policyId: PolicyIdSchema,
    source: z.strictObject({
      path: NonEmptyString.optional(),
      url: NonEmptyString.optional(),
      /** SHA-256 of the raw bytes: the change-detection key of the registry. */
      sha256: Sha256Schema,
      format: IngestFormatSchema,
      fetchedAt: IsoDateTimeSchema,
    }),
    docType: z.literal("privacy"),
    /** `needs_manual_review`: nothing could be read (unsupported format, empty, over the byte cap). Fails closed. */
    status: z.enum(["ok", "needs_manual_review"]),
    sections: z.array(IngestedSectionSchema),
    /** Masked plain text of the whole document; paragraphs are separated by "\n". */
    text: z.string(),
    warnings: z.array(z.string()),
  })
  .superRefine((p, ctx) => {
    p.sections.forEach((s, i) => {
      s.paras.forEach((para, j) => {
        if (p.text.slice(para.span.start, para.span.end) !== para.text) ctx.addIssue({ code: "custom", path: ["sections", i, "paras", j, "span"], message: "span does not reproduce the paragraph text" });
      });
    });
  });
export type IngestedPolicy = z.infer<typeof IngestedPolicySchema>;
