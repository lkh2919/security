/**
 * RulePack contracts: the on-disk shape of `kb/jurisdictions/kr/rulepacks/<pack>/` (design R5.2).
 *
 * Derived from the REAL files of `privacy-2026.04` (S01-S24, A1) and `terms-kftc-10023` (T01-T15).
 * Rules and legal-ref entries are strict, so a typo in a KB key fails the KB integrity test. Section files
 * and index files are loose: they carry many per-section notes (`consentValidityNote`, `measureCatalog`,
 * `riskSignals`, ...) that are content for humans and prompts, not contract surface.
 *
 * Known drift the schemas tolerate on purpose (owners may normalize later):
 *  - `needsVerification` (boolean, 2 rules) and `needs_verification` (boolean, 1 rule) both exist on rules.
 *  - `verifiedBy` on a legal ref is a source key (string), one `{url, fetched, version}` object, or a list of them.
 *  - Section-level `applicability.when` uses `{ all: [] }` for "always" (accepted by `CondSchema`).
 */
import { z } from "zod";
import { CondSchema, IsoDateSchema, ItemIdSchema, NonEmptyString } from "./common";

/** Legal-ref key: `PIPA:30(1)1`, `ARTC:7[1]`, `ECA-DEC:6(1)1`, `ARTC:19-3(6)`, `STD10023:1`, `DEC:14-2`. */
export const LEGAL_REF_KEY_PATTERN = /^[A-Z][A-Z0-9-]*:\d+(-\d+)?(\(\d+(-\d+)?\)|\[\d+(-\d+)?\])*\d*(-\d+)?$/;
export const LegalRefKeySchema = z.string().regex(LEGAL_REF_KEY_PATTERN, "legal ref key must look like PIPA:30(1)1 or ARTC:7[1]");

/** Provision read on law.go.kr: OC key already removed from the URL. */
export const ApiVerificationSchema = z.looseObject({
  url: NonEmptyString,
  fetched: IsoDateSchema,
  version: z.string().optional(),
  note: z.string().optional(),
});

export const LegalRefEntrySchema = z.strictObject({
  law: NonEmptyString,
  article: NonEmptyString,
  paragraph: z.string().optional(),
  item: z.string().optional(),
  /** Source key (`pipc-guideline-2026-04`, `kftc-10023-2015-06-26`, `spike-2026-09-29`) or API read record(s). */
  verifiedBy: z.union([NonEmptyString, ApiVerificationSchema, z.array(ApiVerificationSchema).min(1)]),
  /** Location inside the source (`p18 L530`). */
  at: z.string().optional(),
  /** True only where the provision text was read on law.go.kr. */
  lawGoKr: z.boolean(),
  lawGoKrSource: z.string().optional(),
  lawGoKrCheck: ApiVerificationSchema.optional(),
  status: z.string().optional(),
  note: z.string().optional(),
  effectiveFrom: IsoDateSchema.optional(),
});
export type LegalRefEntry = z.infer<typeof LegalRefEntrySchema>;

export const RuleCheckSchema = z.strictObject({
  kind: z.enum(["deterministic", "llm"]),
  /** Pseudo-DSL evaluated by C2 (`match(...)`, `lex.<id>`); absent for pure-LLM rules. */
  expr: z.string().optional(),
});

export const RuleLevelSchema = z.enum(["must", "should", "may"]);

export const RuleSchema = z.strictObject({
  ruleId: z.string().regex(/^R-(S\d{2}|T\d{2}|A1|X1)-\d{3}$/, "ruleId must look like R-S05-007"),
  sectionId: ItemIdSchema,
  level: RuleLevelSchema,
  element: NonEmptyString,
  statement: NonEmptyString,
  /** Keys into the section's `legalRefs` map. */
  legalRefs: z.array(LegalRefKeySchema),
  check: RuleCheckSchema,
  sourceSpan: NonEmptyString,
  verifiedAt: IsoDateSchema,
  // --- dated amendments -----------------------------------------------------------------------
  effectiveFrom: IsoDateSchema.optional(),
  effectiveStatus: z.enum(["in_force", "upcoming"]).optional(),
  effectiveNote: z.string().optional(),
  source: z.string().optional(),
  // --- provenance flags -----------------------------------------------------------------------
  beyondGuideline: z.boolean().optional(),
  new2026: z.boolean().optional(),
  newIn: z.string().optional(),
  lawChange: z.string().optional(),
  flagRef: z.string().optional(),
  /** Both spellings exist in the KB today. */
  needsVerification: z.boolean().optional(),
  needs_verification: z.boolean().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const NeedsVerificationEntrySchema = z.looseObject({
  id: NonEmptyString,
  note: z.string(),
  status: z.string().optional(),
  resolvedAt: z.string().optional(),
});

export const CommonDefectSchema = z.looseObject({
  id: NonEmptyString,
  severity: z.enum(["blocker", "major", "minor", "info"]),
  defect: NonEmptyString,
  seedCandidate: z.boolean().optional(),
});

export const SectionApplicabilitySchema = z.looseObject({
  when: CondSchema,
  /** What to do when not applicable (`omit`, `not_processed_statement_allowed`). */
  ifNot: z.string().optional(),
  notApplicableWhen: CondSchema.optional(),
  signals: z.array(z.string()).optional(),
  note: z.string().optional(),
});

/** Section file: one privacy item (S01..S24, A1) or terms article (T01..T15). */
export const RuleSectionSchema = z.looseObject({
  id: ItemIdSchema,
  packVersion: NonEmptyString,
  title: z.strictObject({ ko: NonEmptyString, en: NonEmptyString }),
  attribution: NonEmptyString,
  classification: z.enum(["mandatory", "conditional", "recommended"]),
  catalogClass: z.enum(["M", "C", "R", "R+C"]).optional(),
  /** Terms sections only. */
  module: z.enum(["core", "member", "commerce", "community"]).optional(),
  handling: z.enum(["clause", "clause+lexicon", "clause_checklist", "llm", "llm+statute_table", "llm+manual_flag", "llm_optional", "warn", "cross_doc"]),
  applicability: SectionApplicabilitySchema,
  rules: z.array(RuleSchema).min(1),
  goodPatterns: z.array(z.string()),
  commonDefects: z.array(CommonDefectSchema),
  extractionHints: z.array(z.string()),
  /** Interview Template node IDs (`Q-S05-41`). Cross-checked by the KB integrity test. */
  interviewNodes: z.array(z.string().regex(/^Q-/)),
  legalRefs: z.record(LegalRefKeySchema, LegalRefEntrySchema),
  needsVerification: z.array(NeedsVerificationEntrySchema),
  /** Terms sections only: Interview Template slots the article reads. */
  slots: z.array(z.string()).optional(),
  missingSlots: z.array(z.string()).optional(),
  unfairPatterns: z.array(z.looseObject({ lexiconId: z.string().optional() })).optional(),
})
  .superRefine((sec, ctx) => {
    sec.rules.forEach((r, i) => {
      if (r.sectionId !== sec.id) ctx.addIssue({ code: "custom", path: ["rules", i, "sectionId"], message: `rule belongs to ${r.sectionId}, section is ${sec.id}` });
      for (const ref of r.legalRefs) {
        if (!(ref in sec.legalRefs)) ctx.addIssue({ code: "custom", path: ["rules", i, "legalRefs"], message: `legal ref ${ref} is not in the section legalRefs map` });
      }
    });
  });
export type RuleSection = z.infer<typeof RuleSectionSchema>;

export const RulePackIndexSectionSchema = z.looseObject({
  id: ItemIdSchema,
  file: z.string().regex(/^[A-Za-z0-9]+\.json$/),
  title: z.string(),
  classification: z.enum(["mandatory", "conditional", "recommended"]),
  handling: z.string(),
  /** Either a bare Cond (`{slot,op}` / `{all:[...]}`). */
  applicability: CondSchema,
  rules: z.number().int().nonnegative(),
});

export const RulePackIndexSchema = z.looseObject({
  packVersion: NonEmptyString,
  generated: IsoDateSchema,
  sections: z.array(RulePackIndexSectionSchema).min(1),
  /** Legal ref key -> section IDs citing it. */
  lawIndex: z.record(LegalRefKeySchema, z.array(ItemIdSchema).min(1)),
  lawCodes: z.record(z.string(), z.string()),
});
export type RulePackIndex = z.infer<typeof RulePackIndexSchema>;

/** `unfair-clause-lexicon.json` of the terms pack. */
export const LexiconEntrySchema = z.looseObject({
  id: z.string().regex(/^U-/),
  pattern: NonEmptyString,
  statuteRef: z.array(LegalRefKeySchema),
  severity: z.enum(["blocker", "major", "minor", "info"]),
  sections: z.array(ItemIdSchema),
  explanation_ko: z.string(),
  testPositive: z.string().optional(),
  check: z.string().optional(),
  effectiveFrom: IsoDateSchema.optional(),
});
export const UnfairClauseLexiconSchema = z.looseObject({
  packVersion: NonEmptyString,
  entries: z.array(LexiconEntrySchema).min(1),
});
