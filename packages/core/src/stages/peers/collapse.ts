/**
 * Report helpers: amendment unit keys come at the level of 항/호 (`PIPA:31(4)2`), which floods a report. These collapse them to one row per
 * article (`PIPA:31`) with the changed 항/호 in a short parenthesis, keeping the best confidence.
 */
import type { Confidence } from "./signals";

const RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

/** `PIPA:31(4)2` -> `{ article: "PIPA:31", detail: "(4)2" }`; a key that is not of this shape is its own article. */
export function splitArticleKey(key: string): { readonly article: string; readonly detail: string } {
  const m = /^([A-Z][A-Z0-9-]*:\d+(?:-\d+)?)(.*)$/.exec(key.trim());
  return m ? { article: m[1]!, detail: m[2]! } : { article: key.trim(), detail: "" };
}

/** `(4)2` -> `4항 2호`, `(3)` -> `3항`, `(4)[2]` -> `4항 2호`; empty when the key names the article only. */
export function detailKo(detail: string): string {
  const parts: string[] = [];
  for (const m of detail.matchAll(/\((\d+(?:-\d+)?)\)|\[(\d+(?:-\d+)?)\]|(\d+(?:-\d+)?)/g)) parts.push(m[1] ? `${m[1]}항` : `${m[2] ?? m[3]}호`);
  return parts.join(" ");
}

const natural = (a: string, b: string): number => a.localeCompare(b, "ko", { numeric: true });

/** "3항, 4항 1호, 10항" (empty when no key has a 항/호). */
export function detailList(keys: readonly string[]): string {
  return [...new Set(keys.map((k) => detailKo(splitArticleKey(k).detail)).filter(Boolean))].sort(natural).join(", ");
}

export const bestConfidence = (list: readonly Confidence[]): Confidence => list.reduce<Confidence>((best, c) => (RANK[c] > RANK[best] ? c : best), "low");

export interface CollapsedRef {
  readonly article: string;
  readonly sectionId: string;
  /** Best confidence of the unit keys of this article in this section. */
  readonly confidence: Confidence;
  /** `3항, 4항 1호`: the 항/호 reached with that best confidence. */
  readonly details: string;
  readonly keys: readonly string[];
}

/** One entry per (article, section), in order of first appearance. */
export function collapseAlignments(items: readonly { readonly articleKey: string; readonly sectionId: string; readonly confidence: Confidence }[]): CollapsedRef[] {
  const by = new Map<string, { article: string; sectionId: string; items: typeof items[number][] }>();
  for (const it of items) {
    const article = splitArticleKey(it.articleKey).article;
    const k = `${article}|${it.sectionId}`;
    const cur = by.get(k) ?? { article, sectionId: it.sectionId, items: [] };
    cur.items.push(it);
    by.set(k, cur);
  }
  return [...by.values()].map((g) => {
    const confidence = bestConfidence(g.items.map((i) => i.confidence));
    const keys = g.items.filter((i) => i.confidence === confidence).map((i) => i.articleKey);
    return { article: g.article, sectionId: g.sectionId, confidence, details: detailList(keys), keys };
  });
}

/** `PIPA:31 (3항, 4항 1호)`. */
export const refLabel = (article: string, details: string): string => (details ? `${article} (${details})` : article);
