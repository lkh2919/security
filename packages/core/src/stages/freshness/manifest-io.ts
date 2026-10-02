import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ManifestSchema, type Manifest } from "../../contracts/manifest";

/** Empty manifest used when no real one exists yet (every watched source then reads as "unstamped"). */
export function placeholderManifest(now: Date): Manifest {
  return {
    manifestVersion: "0.0.0-placeholder",
    rulePacks: [],
    lawSnapshot: { id: "none", laws: [] },
    clauseLib: { version: "0.0.0", capturedAt: now.toISOString(), sites: [], vettedClauses: 0 },
    houseStyle: { version: "0.0.0" },
    pages: [],
  };
}

/** `kb/jurisdictions/kr/manifest.json`, or null when missing, invalid or without law stamps. */
export function loadKrManifest(krDir: string): Manifest | null {
  const file = join(krDir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success || parsed.data.lawSnapshot.laws.length === 0) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
