/**
 * AmendmentDiff (Policy Monitor design M3, M5): the 항/호-level difference between two versions of one law.
 * Unit keys use the rule-pack legal-ref notation (`PIPA:38(1)`, `PIPA:30(1)3-2`, `PIPA:2[2]`, `DEC:14-2`), so a unit can be
 * matched against `rule.legalRefs` by prefix.
 */
import { z } from "zod";
import { IsoDateSchema, NonEmptyString, Sha256Schema } from "./common";
import { LegalRefKeySchema } from "./rulepack";

export const AmendmentChangeSchema = z.enum(["added", "amended", "deleted"]);
export type AmendmentChange = z.infer<typeof AmendmentChangeSchema>;

export const AmendmentUnitSchema = z
  .strictObject({
    key: LegalRefKeySchema,
    change: AmendmentChangeSchema,
    /** Provision text before the amendment (absent when added). */
    oldText: z.string().optional(),
    /** Provision text after the amendment (absent when deleted). */
    newText: z.string().optional(),
  })
  .superRefine((u, ctx) => {
    if (u.change !== "added" && u.oldText === undefined) ctx.addIssue({ code: "custom", path: ["oldText"], message: `${u.change} unit needs oldText` });
    if (u.change !== "deleted" && u.newText === undefined) ctx.addIssue({ code: "custom", path: ["newText"], message: `${u.change} unit needs newText` });
  });
export type AmendmentUnit = z.infer<typeof AmendmentUnitSchema>;

export const AmendmentDiffSchema = z.strictObject({
  /** Law code used in the keys (`PIPA`, `DEC`, ...). */
  law: NonEmptyString,
  oldVersion: NonEmptyString,
  newVersion: NonEmptyString,
  /** Effective date of the new version, when known. */
  effectiveOn: IsoDateSchema.nullable(),
  units: z.array(AmendmentUnitSchema),
  /** Hash of the units (cache key part: policySha, diff hash, rulePackVersion). */
  hash: Sha256Schema,
});
export type AmendmentDiff = z.infer<typeof AmendmentDiffSchema>;
