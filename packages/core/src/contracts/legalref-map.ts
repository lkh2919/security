/**
 * LegalRefMap (design C2/C6): `kb/jurisdictions/kr/statutes/legalref-map.json`, prefix -> law. The prefix is the law code used in
 * rule-pack legal-ref keys and amendment-diff unit keys (`PIPA`, `DEC`, `CIA`, `EFTA`, `FCPA`).
 *  - `mapped`: changes reach rule-pack sections through `rule.legalRefs`.
 *  - `manualReview`: no rule pack covers the law (finance, monitoring only); a change is never auto-mapped to sections and
 *    produces one "금융 법령 해당 – 수동 검토" Confirm finding per policy.
 * The file is owned by the domain expert; entries carry `verifiedAt`/`verifiedBy` once checked.
 */
import { z } from "zod";
import { IsoDateSchema, NonEmptyString } from "./common";

export const MonitorModeSchema = z.enum(["mapped", "manualReview"]);
export type MonitorMode = z.infer<typeof MonitorModeSchema>;

export const LegalRefPrefixSchema = z.string().regex(/^[A-Z][A-Z0-9-]*$/, "prefix must look like PIPA, DEC, ECA-DEC");

export const LegalRefMapEntrySchema = z.strictObject({
  /** Watch-target id (`law:pipa`), the join key to `law-targets.watch.json`. */
  sourceId: NonEmptyString,
  lawNameKo: NonEmptyString,
  lawId: NonEmptyString.optional(),
  currentMst: NonEmptyString.optional(),
  /** Free label: `act`, `decree`, `notice`, `rule`. */
  kind: NonEmptyString,
  aliases: z.array(NonEmptyString),
  monitorMode: MonitorModeSchema,
  verifiedAt: IsoDateSchema.optional(),
  verifiedBy: NonEmptyString.optional(),
});
export type LegalRefMapEntry = z.infer<typeof LegalRefMapEntrySchema>;

export const LegalRefMapSchema = z.record(LegalRefPrefixSchema, LegalRefMapEntrySchema);
export type LegalRefMap = z.infer<typeof LegalRefMapSchema>;

export const EMPTY_LEGALREF_MAP: LegalRefMap = {};
