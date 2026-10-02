/**
 * Hash-only baselines in git (design C5 "Storage", amended): `<baselinesDir>/<peerId>.json` holds the last known content and section
 * hashes of each peer policy. The cloud container is ephemeral and `runs/` is gitignored, so without these files every run would start
 * as a "first snapshot". A baseline is the "previous" side of a comparison when no local snapshot exists; it carries no text and no
 * quotes (a change event takes its quote from the fresh fetch).
 *
 * Written only on the first snapshot of a peer and when its content changed (never for an unchanged or cosmetic-only page), so
 * committed files do not churn on `fetchedAt`.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../pipeline/fs-atomic";
import { PeerBaselineSchema, PeerIdSchema, type PeerBaseline } from "../../contracts/peers";
import { extractEffectiveDateText, type NormalizedPolicy } from "./normalize";
import type { PrevPolicy } from "./changes";
import type { SnapshotStore } from "./snapshots";

export function baselineFromPolicy(peerId: string, url: string, fetchedAt: string, policy: NormalizedPolicy): PeerBaseline {
  const effective = extractEffectiveDateText(policy.text);
  return PeerBaselineSchema.parse({
    peerId,
    url,
    fetchedAt,
    contentSha256: policy.contentSha256,
    neutralContentSha256: policy.neutralContentSha256,
    sections: policy.sections.map((s) => ({ sectionId: s.sectionId, sha256: s.sha256, neutralSha256: s.neutralSha256, charCount: s.charCount })),
    ...(effective ? { effectiveDateText: effective } : {}),
  });
}

/** A baseline as the "previous" policy of a comparison (hashes only). */
export const baselineAsPrev = (b: PeerBaseline): PrevPolicy => ({ contentSha256: b.contentSha256, neutralContentSha256: b.neutralContentSha256, sections: b.sections });

export class BaselineStore {
  constructor(readonly dir: string) {}

  private file(peerId: string): string {
    return join(this.dir, `${PeerIdSchema.parse(peerId)}.json`);
  }

  has(peerId: string): boolean {
    return existsSync(this.file(peerId));
  }

  /** Null when absent. A present but invalid file throws (a silent "first snapshot" would hide every change). */
  load(peerId: string): PeerBaseline | null {
    const f = this.file(peerId);
    if (!existsSync(f)) return null;
    try {
      return PeerBaselineSchema.parse(JSON.parse(readFileSync(f, "utf8")));
    } catch (err) {
      throw new Error(`[PEER_BASELINE] ${f} is not a valid baseline (${err instanceof Error ? err.message.slice(0, 120) : "error"})`);
    }
  }

  /** Writes the baseline unless one with the same content hash is already stored. Returns true when the file was written. */
  async save(baseline: PeerBaseline): Promise<boolean> {
    const parsed = PeerBaselineSchema.parse(baseline);
    const cur = this.load(parsed.peerId);
    if (cur && cur.contentSha256 === parsed.contentSha256 && cur.neutralContentSha256 === parsed.neutralContentSha256) return false;
    await mkdir(this.dir, { recursive: true });
    await atomicWriteFile(this.file(parsed.peerId), `${JSON.stringify(parsed, null, 2)}\n`);
    return true;
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return (await readdir(this.dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => PeerIdSchema.safeParse(id).success).sort();
  }
}

/** Migration: one baseline per peer from the newest local snapshot (`--export-baselines`). */
export async function exportBaselines(snapshots: SnapshotStore, baselines: BaselineStore, peerIds: readonly string[]): Promise<{ written: string[]; unchanged: string[]; missing: string[] }> {
  const out = { written: [] as string[], unchanged: [] as string[], missing: [] as string[] };
  for (const id of peerIds) {
    const s = await snapshots.latest(id);
    if (!s) {
      out.missing.push(id);
      continue;
    }
    const wrote = await baselines.save(baselineFromPolicy(id, s.snapshot.url, s.snapshot.fetchedAt, s.policy));
    (wrote ? out.written : out.unchanged).push(id);
  }
  return out;
}
