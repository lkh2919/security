/**
 * Statute tables under `kb/jurisdictions/kr/statutes/` (design R5.5 / R6).
 *
 * - `retention-periods.json`: statutory retention periods (S05 statute table, Interview node Q-S05-41).
 * - `citations.json`: citation table `{ citationId, law, article, title, effectiveFrom, sourceId, verifiedAt }`
 *   (created when items are verified; absent today, so loaders must tolerate a missing file).
 * - `law-targets.json`, `pending-verification.json`, `verification-log-*.json`: freshness and verification inputs.
 *
 * Source URLs in these files never contain the law.go.kr OC key. The schemas do not enforce that; the
 * KB integrity test scans for it.
 */
import { z } from "zod";
import { IsoDateSchema, NonEmptyString } from "./common";

const ApiSourceSchema = z.looseObject({ url: NonEmptyString, fetched: IsoDateSchema, version: z.string().optional(), note: z.string().optional() });

const BilingualSchema = z.strictObject({ ko: NonEmptyString, en: NonEmptyString });

export const RetentionEntrySchema = z.strictObject({
  id: z.string().regex(/^KR-RET-[A-Z]+-\d{2}$/),
  /** Key of `groups`. */
  group: NonEmptyString,
  statute: NonEmptyString,
  /** Free text in the KB (`42`, `42 / 22`, `85-3`); not parsed. */
  article: NonEmptyString,
  paragraph: z.string().optional(),
  item: z.string().optional(),
  /** `LSA:42` or a combined form (`LSA:42+DEC:22(1)1`). Not the single-ref `LegalRefKey` shape. */
  citationId: NonEmptyString,
  recordType: BilingualSchema,
  /** `{ ko, years }`, or `{ ko, minDays, maxDays }`, plus optional `offshoreYears` / `specialYears` / `extendedYears`. */
  period: z.looseObject({ ko: NonEmptyString, years: z.number().positive().optional(), minDays: z.number().optional(), maxDays: z.number().optional() }),
  startsFrom: z.looseObject({ ko: NonEmptyString, basis: z.string().optional() }).optional(),
  /** `internal_hr`, `internal_hr | b2c_commerce`, `all`. */
  appliesIf: NonEmptyString,
  verifiedBy: z.array(ApiSourceSchema).min(1),
  caveat: z.string().optional(),
});
export type RetentionEntry = z.infer<typeof RetentionEntrySchema>;

export const RetentionPeriodsSchema = z
  .strictObject({
    version: NonEmptyString,
    note: z.string(),
    groups: z.record(z.string(), NonEmptyString),
    unverified: z.array(z.strictObject({ topic: NonEmptyString, note: NonEmptyString })),
    entries: z.array(RetentionEntrySchema).min(1),
  })
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    t.entries.forEach((e, i) => {
      if (ids.has(e.id)) ctx.addIssue({ code: "custom", path: ["entries", i, "id"], message: `duplicate retention id ${e.id}` });
      ids.add(e.id);
      if (!(e.group in t.groups)) ctx.addIssue({ code: "custom", path: ["entries", i, "group"], message: `unknown group ${e.group}` });
    });
  });
export type RetentionPeriods = z.infer<typeof RetentionPeriodsSchema>;

/** `citations.json` (optional file). `citationId` is a legal-ref key (`PIPA:30(1)1`). */
export const CitationSchema = z.strictObject({
  citationId: NonEmptyString,
  law: NonEmptyString,
  article: NonEmptyString,
  title: z.string(),
  effectiveFrom: IsoDateSchema.optional(),
  sourceId: NonEmptyString,
  verifiedAt: IsoDateSchema,
});
export type Citation = z.infer<typeof CitationSchema>;

export const CitationTableSchema = z.array(CitationSchema).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (seen.has(r.citationId)) ctx.addIssue({ code: "custom", path: [i, "citationId"], message: `duplicate citationId ${r.citationId}` });
    seen.add(r.citationId);
  });
});
export type CitationTable = z.infer<typeof CitationTableSchema>;

export const LawTargetSchema = z.looseObject({
  name_ko: NonEmptyString,
  name_en: NonEmptyString,
  api_target: NonEmptyString,
  lookup_hint: NonEmptyString,
  id_if_found: z.string().optional(),
  page_url: z.string().optional(),
});
export const LawTargetsSchema = z.array(LawTargetSchema).min(1);

export const PendingVerificationSchema = z.array(
  z.looseObject({ claim: NonEmptyString, verdict: NonEmptyString, sources: z.array(ApiSourceSchema), notes: z.string().optional() }),
);

export const VerificationLogSchema = z.looseObject({
  version: NonEmptyString,
  run: z.string(),
  claims: z.array(z.looseObject({ id: NonEmptyString, claim: NonEmptyString, verdict: NonEmptyString, detail: z.string().optional() })),
  unverified: z.array(z.unknown()),
});
