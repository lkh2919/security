/**
 * Change detection between two normalized policies (design C5, P0 `peer_changed`) and the append-only change log
 * (`runs/<tenant>/peers/changelog.jsonl`: hashes and short masked quotes only).
 */
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PolicyChangeEventSchema, type ChangedSection, type PolicyChangeEvent } from "../../contracts/peers";
import { maskedQuote, type NormBlock, type NormSection, type NormalizedPolicy } from "./normalize";

/** What a comparison needs from the earlier policy: hashes always, blocks (text) only when a local snapshot exists. */
export interface PrevPolicy {
  readonly contentSha256: string;
  readonly neutralContentSha256?: string | undefined;
  readonly sections: readonly { readonly sectionId: string; readonly sha256: string; readonly neutralSha256?: string | undefined; readonly blocks?: readonly NormBlock[] }[];
}

/** Equal after date neutralization when both sides carry the neutral hash, else equal by the plain hash. */
const sameSection = (p: { sha256: string; neutralSha256?: string | undefined }, n: { sha256: string; neutralSha256?: string | undefined }): boolean =>
  p.neutralSha256 !== undefined && n.neutralSha256 !== undefined ? p.neutralSha256 === n.neutralSha256 : p.sha256 === n.sha256;

const paraSet = (s: { readonly blocks?: readonly NormBlock[] } | undefined): Set<string> => new Set((s?.blocks ?? []).flatMap((b) => b.paras));
const firstPara = (s: NormSection): string => s.blocks.flatMap((b) => (b.paras.length > 0 ? b.paras : [b.title])).find(Boolean) ?? "";

/** Paragraphs of `section` that `other` does not hold (in order). */
export function paragraphsNotIn(section: NormSection | undefined, other: { readonly blocks?: readonly NormBlock[] } | undefined): string[] {
  const known = paraSet(other);
  return (section?.blocks ?? []).flatMap((b) => b.paras).filter((p) => !known.has(p));
}

/** Section-level diff. Unequal section hashes only: whitespace, markup, navigation, block order and date-only edits never get here. */
export function diffNormalized(prev: PrevPolicy, next: NormalizedPolicy): ChangedSection[] {
  const before = new Map(prev.sections.map((s) => [s.sectionId, s]));
  const after = new Map(next.sections.map((s) => [s.sectionId, s]));
  const out: ChangedSection[] = [];
  for (const [id, n] of after) {
    const p = before.get(id);
    if (!p) out.push({ sectionId: id, kind: "added", quote: maskedQuote(firstPara(n)) });
    else if (!sameSection(p, n)) {
      const text = paragraphsNotIn(n, p)[0] ?? (p.blocks ? paragraphsNotIn(p as NormSection, n)[0] : undefined) ?? firstPara(n);
      out.push({ sectionId: id, kind: "modified", quote: maskedQuote(text) });
    }
  }
  for (const [id, p] of before) if (!after.has(id)) out.push({ sectionId: id, kind: "removed", quote: p.blocks ? maskedQuote(firstPara(p as NormSection)) : "" });
  return out;
}

export interface ChangeEventArgs {
  readonly peerId: string;
  readonly groupId: string;
  readonly detectedAt: Date;
  readonly prev: PrevPolicy;
  readonly next: NormalizedPolicy;
  /** The raw page differs from the last one although the normalized text may not (layout, markup, navigation). */
  readonly rawChanged?: boolean;
}

/** Null when nothing differs at all (not even the raw page). Equal normalized text with a changed raw page is a cosmetic-only event. */
export function buildChangeEvent(a: ChangeEventArgs): PolicyChangeEvent | null {
  const same = a.prev.contentSha256 === a.next.contentSha256 || (a.prev.neutralContentSha256 !== undefined && a.prev.neutralContentSha256 === a.next.neutralContentSha256);
  const changedSections = same ? [] : diffNormalized(a.prev, a.next);
  if (changedSections.length === 0 && !a.rawChanged) return null;
  return PolicyChangeEventSchema.parse({ peerId: a.peerId, groupId: a.groupId, detectedAt: a.detectedAt.toISOString(), fromSha: a.prev.contentSha256, toSha: a.next.contentSha256, changedSections, cosmeticOnly: changedSections.length === 0 });
}

export async function appendChangeLog(file: string, event: PolicyChangeEvent): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(PolicyChangeEventSchema.parse(event))}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

export function readChangeLog(file: string): PolicyChangeEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((line, i) => {
      try {
        return PolicyChangeEventSchema.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(`[PEER_CHANGELOG] ${file} line ${i + 1} is not a valid change event (${err instanceof Error ? err.message.slice(0, 120) : "error"})`);
      }
    });
}
