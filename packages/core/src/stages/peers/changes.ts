/**
 * Change detection between two normalized policies (design C5, P0 `peer_changed`) and the append-only change log
 * (`runs/<tenant>/peers/changelog.jsonl`: hashes and short masked quotes only).
 */
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PolicyChangeEventSchema, type ChangedSection, type PolicyChangeEvent } from "../../contracts/peers";
import { maskedQuote, type NormSection, type NormalizedPolicy } from "./normalize";

const paraSet = (s: NormSection | undefined): Set<string> => new Set((s?.blocks ?? []).flatMap((b) => b.paras));
const firstPara = (s: NormSection): string => s.blocks.flatMap((b) => (b.paras.length > 0 ? b.paras : [b.title])).find(Boolean) ?? "";

/** Paragraphs of `section` that `other` does not hold (in order). */
export function paragraphsNotIn(section: NormSection | undefined, other: NormSection | undefined): string[] {
  const known = paraSet(other);
  return (section?.blocks ?? []).flatMap((b) => b.paras).filter((p) => !known.has(p));
}

/** Section-level diff. Unequal section hashes only: whitespace, markup, navigation and block order never get here. */
export function diffNormalized(prev: NormalizedPolicy, next: NormalizedPolicy): ChangedSection[] {
  const before = new Map(prev.sections.map((s) => [s.sectionId, s]));
  const after = new Map(next.sections.map((s) => [s.sectionId, s]));
  const out: ChangedSection[] = [];
  for (const [id, n] of after) {
    const p = before.get(id);
    if (!p) out.push({ sectionId: id, kind: "added", quote: maskedQuote(firstPara(n)) });
    else if (p.sha256 !== n.sha256) {
      const text = paragraphsNotIn(n, p)[0] ?? paragraphsNotIn(p, n)[0] ?? firstPara(n);
      out.push({ sectionId: id, kind: "modified", quote: maskedQuote(text) });
    }
  }
  for (const [id, p] of before) if (!after.has(id)) out.push({ sectionId: id, kind: "removed", quote: maskedQuote(firstPara(p)) });
  return out;
}

export interface ChangeEventArgs {
  readonly peerId: string;
  readonly groupId: string;
  readonly detectedAt: Date;
  readonly prev: NormalizedPolicy;
  readonly next: NormalizedPolicy;
  /** The raw page differs from the last one although the normalized text may not (layout, markup, navigation). */
  readonly rawChanged?: boolean;
}

/** Null when nothing differs at all (not even the raw page). Equal normalized text with a changed raw page is a cosmetic-only event. */
export function buildChangeEvent(a: ChangeEventArgs): PolicyChangeEvent | null {
  const changedSections = a.prev.contentSha256 === a.next.contentSha256 ? [] : diffNormalized(a.prev, a.next);
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
