/**
 * Law watch targets as data (design C4): `kb/jurisdictions/kr/statutes/law-targets.watch.json` plus the optional
 * `law-targets.watch-additions.json`. The TypeScript list in stages/freshness/targets.ts is only the fallback.
 * Same shape as `FreshnessTargets`, with an optional `monitorMode` per law.
 */
import { z } from "zod";
import { NonEmptyString } from "./common";
import { MonitorModeSchema } from "./legalref-map";

export const LawWatchTargetSchema = z.strictObject({
  sourceId: NonEmptyString,
  name: NonEmptyString,
  target: z.enum(["law", "admrul"]),
  /** Key of `lawCodes` in the rule-pack index (PIPA, DEC, STDG, ...). */
  lawCode: NonEmptyString.optional(),
  /** `manualReview`: a change is reported but never mapped to rule-pack sections. Default `mapped`. */
  monitorMode: MonitorModeSchema.optional(),
});

export const PageWatchTargetSchema = z.strictObject({
  sourceId: NonEmptyString,
  name: NonEmptyString,
  kind: z.enum(["pipc-board", "privacy-board", "ftc-list", "ftc-view"]),
  url: z.url(),
  affectsAllSections: z.boolean().optional(),
});

export const WatchTargetsFileSchema = z.strictObject({
  version: NonEmptyString,
  generated: z.string().optional(),
  note: z.string().optional(),
  laws: z.array(LawWatchTargetSchema),
  pages: z.array(PageWatchTargetSchema),
});
export type WatchTargetsFile = z.infer<typeof WatchTargetsFileSchema>;

/** An addition row may carry the domain expert's provenance (lawId, mst, articlesOfInterest, ...); only the watch fields are used. */
const LawAdditionSchema = z.looseObject(LawWatchTargetSchema.shape).transform(({ sourceId, name, target, lawCode, monitorMode }) => ({
  sourceId,
  name,
  target,
  ...(lawCode !== undefined ? { lawCode } : {}),
  ...(monitorMode !== undefined ? { monitorMode } : {}),
}));

/**
 * Additions: both lists optional; `targets` is accepted as an alias of `laws` (the KB file's name). Other top-level keys
 * (generator, pending, supervisoryRegulations) are provenance and ignored. Entries whose sourceId already exists in the main
 * file are ignored with a warning.
 */
export const WatchTargetsAdditionsSchema = z
  .looseObject({
    laws: z.array(LawAdditionSchema).optional(),
    targets: z.array(LawAdditionSchema).optional(),
    pages: z.array(PageWatchTargetSchema).optional(),
  })
  .transform((a) => ({ laws: [...(a.laws ?? []), ...(a.targets ?? [])], pages: a.pages ?? [] }));
export type WatchTargetsAdditions = z.infer<typeof WatchTargetsAdditionsSchema>;
