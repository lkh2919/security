/**
 * Snapshot store (design C5 "Storage"): `<peersDir>/snapshots/<peerId>/<YYYY-MM-DD>.json` (hashes) and `.txt` (normalized, masked
 * text), outside git (`runs/` is ignored), file mode 0600. Written only when the content hash changed; snapshots older than 90 days
 * are deleted, except the newest one of each peer (it is the baseline of the next comparison).
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../pipeline/fs-atomic";
import { PeerIdSchema, PolicySnapshotSchema, type PolicySnapshot } from "../../contracts/peers";
import { parseNormalizedText, type NormalizedPolicy } from "./normalize";

export const SNAPSHOT_RETENTION_DAYS = 90;
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export interface StoredSnapshot {
  readonly date: string;
  readonly snapshot: PolicySnapshot;
  readonly policy: NormalizedPolicy;
}

export class SnapshotStore {
  constructor(readonly dir: string) {}

  private peerDir(peerId: string): string {
    return join(this.dir, PeerIdSchema.parse(peerId));
  }

  private async dates(peerId: string): Promise<string[]> {
    const d = this.peerDir(peerId);
    if (!existsSync(d)) return [];
    return (await readdir(d)).map((f) => DATE_FILE.exec(f)?.[1]).filter((x): x is string => x !== undefined).sort();
  }

  private load(peerId: string, date: string): StoredSnapshot {
    const base = join(this.peerDir(peerId), date);
    const snapshot = PolicySnapshotSchema.parse(JSON.parse(readFileSync(`${base}.json`, "utf8")));
    return { date, snapshot, policy: parseNormalizedText(readFileSync(`${base}.txt`, "utf8")) };
  }

  async latest(peerId: string): Promise<StoredSnapshot | null> {
    const dates = await this.dates(peerId);
    const last = dates[dates.length - 1];
    return last ? this.load(peerId, last) : null;
  }

  /** Peer ids that have a snapshot folder. */
  async peerIds(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return (await readdir(this.dir)).filter((id) => PeerIdSchema.safeParse(id).success).sort();
  }

  async hasSnapshot(peerId: string): Promise<boolean> {
    return (await this.dates(peerId)).length > 0;
  }

  /** The stored policy whose content hash is `sha`, newest first; null when it was pruned. */
  async findBySha(peerId: string, sha: string): Promise<NormalizedPolicy | null> {
    for (const date of (await this.dates(peerId)).reverse()) {
      const s = this.load(peerId, date);
      if (s.snapshot.contentSha256 === sha) return s.policy;
    }
    return null;
  }

  async write(snapshot: PolicySnapshot, text: string): Promise<string> {
    const parsed = PolicySnapshotSchema.parse(snapshot);
    const date = parsed.fetchedAt.slice(0, 10);
    const dir = this.peerDir(parsed.peerId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const base = join(dir, date);
    await atomicWriteFile(`${base}.txt`, text);
    await atomicWriteFile(`${base}.json`, `${JSON.stringify(parsed, null, 2)}\n`);
    await Promise.all([chmod(`${base}.txt`, 0o600), chmod(`${base}.json`, 0o600)]).catch(() => undefined);
    return base;
  }

  /** Deletes snapshots older than `days`, never the newest of a peer. Returns the number of snapshots removed. */
  async prune(now: Date, days = SNAPSHOT_RETENTION_DAYS): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const peerId of await readdir(this.dir)) {
      if (!PeerIdSchema.safeParse(peerId).success) continue;
      const dates = await this.dates(peerId);
      for (const date of dates.slice(0, -1)) {
        if (date >= cutoff) continue;
        await rm(join(this.peerDir(peerId), `${date}.json`), { force: true });
        await rm(join(this.peerDir(peerId), `${date}.txt`), { force: true });
        removed++;
      }
    }
    return removed;
  }
}
