/**
 * On-disk clause file (Row 6b, `kb/jurisdictions/kr/clauses/<docType>/<group>/<clauseId>.json`).
 *
 * The runtime `ClauseRecordSchema` (clause-selection.ts, design R5.3) predates the files and differs in
 * shape. This schema describes the FILE; `kbClauseToRecord` maps a file to the runtime record.
 *
 * Differences handled by the adapter:
 *  - `id` -> `clauseId`, `text` -> `body`, `sectionId` -> `itemIds: [sectionId]`, `houseStyleTags` -> `styleRefs`.
 *  - `variables[].slotId` -> `vars[].slotPath`. A variable WITHOUT `slotId` cannot be bound to the ledger,
 *    so the adapter rejects such a clause instead of guessing.
 *  - `provenance` is an ARRAY on disk (a clause can merge several captures) but one object at runtime; the adapter
 *    keeps the first entry (files list the primary capture first). `policyVersionOrEffectiveDate` is free
 *    text, so `policyEffectiveDate` is left unset.
 *  - `vettedAgainst` is absent on disk until the privacy-domain-expert vets the clause.
 */
import { z } from "zod";
import { CondSchema, DocTypeSchema, IsoDateSchema, ItemIdSchema, NonEmptyString, Sha256Schema, SlotIdSchema, type SlotRegistry } from "./common";
import { ClauseRecordSchema, type ClauseRecord } from "./clause-selection";

export const KbClauseProvenanceSchema = z.strictObject({
  captureId: NonEmptyString,
  sourceUrl: z.url(),
  affiliate: NonEmptyString,
  businessGroup: NonEmptyString,
  captureDate: IsoDateSchema,
  policyVersionOrEffectiveDate: z.string(),
  contentHash: Sha256Schema,
});

export const KbClauseFileSchema = z.strictObject({
  id: z.string().regex(/^[a-z]+\.(privacy|terms)\.[A-Z]\d{1,2}\.[a-z_]+\.\d{2}$/, "id must look like lotte.privacy.S02.cross_group.01"),
  docType: DocTypeSchema,
  sectionId: ItemIdSchema,
  domainGroup: NonEmptyString,
  sourceCaptureIds: z.array(NonEmptyString).min(1),
  sourceSites: z.array(NonEmptyString).min(1),
  policyVersionOrDate: z.string(),
  layout: z.enum(["legacy_article", "guideline_numbered"]),
  text: NonEmptyString,
  variables: z.array(
    z.strictObject({
      name: NonEmptyString,
      /** Missing on some variables today (see header). */
      slotId: SlotIdSchema.optional(),
      description: z.string(),
    }),
  ),
  conditions: z.array(CondSchema),
  /** Rule IDs the clause covers (`R-S02-001`). */
  coversElements: z.array(z.string().regex(/^R-/)),
  gapsVsGuideline: z.array(z.strictObject({ ruleId: z.string().regex(/^R-/).optional(), level: z.enum(["must", "should", "may"]).optional(), note: NonEmptyString })),
  vetted: z.boolean(),
  vettingNotes: z.string(),
  frequency: z.number().int().nonnegative(),
  frequencyBase: z.number().int().nonnegative(),
  houseStyleTags: z.array(z.string().regex(/^H-\d+/)),
  provenance: z.array(KbClauseProvenanceSchema).min(1),
});
export type KbClauseFile = z.infer<typeof KbClauseFileSchema>;

/** Placeholders (`{{name}}`) used in `text`. */
export function clauseTextVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))];
}

/** Consistency problems beyond schema shape (empty when consistent). */
export function kbClauseProblems(c: KbClauseFile, registry?: SlotRegistry): string[] {
  const problems: string[] = [];
  const declared = new Set(c.variables.map((v) => v.name));
  for (const used of clauseTextVariables(c.text)) if (!declared.has(used)) problems.push(`text uses {{${used}}} but variables does not declare it`);
  for (const v of c.variables) {
    if (!v.slotId) problems.push(`variable ${v.name} has no slotId`);
    else if (registry && !registry.has(v.slotId)) problems.push(`variable ${v.name} references unknown slot ${v.slotId}`);
  }
  if (!c.id.includes(`.${c.docType}.${c.sectionId}.`)) problems.push(`id ${c.id} does not match docType/sectionId`);
  return problems;
}

/** Maps a clause file to the runtime record. Throws when a variable has no slot binding. */
export function kbClauseToRecord(file: KbClauseFile): ClauseRecord {
  const vars = file.variables.map((v) => {
    if (!v.slotId) throw new Error(`[KB] clause ${file.id}: variable ${v.name} has no slotId`);
    return { name: v.name, slotPath: v.slotId };
  });
  const p = file.provenance[0]!;
  return ClauseRecordSchema.parse({
    clauseId: file.id,
    docType: file.docType,
    itemIds: [file.sectionId],
    body: file.text,
    vars,
    conditions: file.conditions,
    provenance: { sourceUrl: p.sourceUrl, affiliate: p.affiliate, businessGroup: p.businessGroup, captureDate: p.captureDate, contentHash: p.contentHash },
    vetted: file.vetted,
    styleRefs: file.houseStyleTags,
  });
}
