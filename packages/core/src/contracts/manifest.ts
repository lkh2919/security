/**
 * Manifest: KB version stamps (design R5.6) and the derived VersionStamps recorded per run.
 */
import { z } from "zod";
import { IsoDateSchema, IsoDateTimeSchema, NonEmptyString, Sha256Schema, VersionSchema } from "./common";

export const ManifestSchema = z.strictObject({
  manifestVersion: VersionSchema,
  /** KB release label and the guideline edition, as written by the Row 6b manifest builder. */
  kbVersion: VersionSchema.optional(),
  guideline: z.string().optional(),
  rulePacks: z.array(z.strictObject({ id: NonEmptyString, version: VersionSchema, sha256: Sha256Schema })),
  lawSnapshot: z.strictObject({
    id: NonEmptyString,
    note: z.string().optional(),
    laws: z.array(
      z.strictObject({
        name: NonEmptyString,
        target: z.enum(["law", "admrul"]),
        /** law.go.kr ID or MST used for the version comparison. */
        id: NonEmptyString,
        effective: IsoDateSchema,
      }),
    ),
  }),
  clauseLib: z.strictObject({
    version: VersionSchema,
    capturedAt: IsoDateTimeSchema,
    /** Source site URLs that were captured. */
    sites: z.array(z.url()),
    vettedClauses: z.number().int().nonnegative(),
    /** Build metadata written by scripts/build-clauses.ts. */
    builtAt: IsoDateTimeSchema.optional(),
    count: z.number().int().nonnegative().optional(),
    captureIndexSha256: Sha256Schema.optional(),
  }),
  houseStyle: z.strictObject({
    version: VersionSchema,
    /** `candidate` until the user approves the rules (Q6). */
    status: z.enum(["candidate", "approved"]).optional(),
    candidates: z.number().int().nonnegative().optional(),
    file: z.string().optional(),
  }),
  pages: z.array(z.strictObject({ url: z.url(), titleHash: Sha256Schema, checkedAt: IsoDateTimeSchema })),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Version stamps written to `RunState`, used in stage-cache keys and copied into `DocAST.meta`.
 * A stamp change invalidates dependent cache entries.
 */
export const VersionStampsSchema = z.strictObject({
  manifestVersion: VersionSchema,
  rulePacks: z.record(z.string(), VersionSchema),
  lawSnapshotId: NonEmptyString,
  clauseLibVersion: VersionSchema,
  houseStyleVersion: VersionSchema,
  interviewTemplateVersion: VersionSchema,
  slotRegistryVersion: VersionSchema,
  /** Prompt file semvers by stage ID. */
  prompts: z.record(z.string(), VersionSchema),
});
export type VersionStamps = z.infer<typeof VersionStampsSchema>;

/** Builds the per-run stamps from a manifest plus the other runtime versions. */
export function stampsFromManifest(
  manifest: Manifest,
  extra: { interviewTemplateVersion: string; slotRegistryVersion: string; prompts: Record<string, string> },
): VersionStamps {
  return VersionStampsSchema.parse({
    manifestVersion: manifest.manifestVersion,
    rulePacks: Object.fromEntries(manifest.rulePacks.map((p) => [p.id, p.version])),
    lawSnapshotId: manifest.lawSnapshot.id,
    clauseLibVersion: manifest.clauseLib.version,
    houseStyleVersion: manifest.houseStyle.version,
    ...extra,
  });
}
