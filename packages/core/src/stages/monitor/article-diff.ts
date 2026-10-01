/**
 * Article diff (Policy Monitor design M3, M5): two versions of one law -> the changed 항/호 units, keyed with the rule-pack
 * legal-ref notation. Pure code, no network.
 *
 * Source shape: law.go.kr `lawService` XML. Each `<조문단위>` has 조문번호, optional 조문가지번호, 조문여부 (`조문` for an article,
 * `전문` for a chapter heading), 조문내용, and nested `<항>` (항번호, 항내용) with `<호>` (호번호, 호가지번호, 호내용, 목내용).
 *
 * Keys: `LAW:38(1)` 항, `LAW:30(1)3-2` 호 (branch with `-`), `LAW:28-8(2)` article branch, `LAW:2[2]` a 호 directly under an
 * article without 항, `LAW:17` a leaf article. A 항 that has 호 children yields a unit for its lead-in text and one per 호.
 * Headings of articles that have 항 are not tracked (a title change alone does not flag rules). Amendment tags
 * (`<개정 2023.3.14>`) and the circled or numbered markers are ignored when texts are compared.
 */
import { createHash } from "node:crypto";
import { firstField, decodeEntities } from "../../adapters/lawapi/xml";
import { AmendmentDiffSchema, type AmendmentDiff, type AmendmentUnit } from "../../contracts/amendment-diff";

export interface LawItem {
  /** `1`, `3` */
  readonly number: string;
  /** `2` for 제3호의2 */
  readonly branch?: string;
  readonly text: string;
}

export interface LawParagraph {
  /** Paragraph number (`①` -> `1`). */
  readonly number: string;
  readonly text: string;
  readonly items: readonly LawItem[];
}

export interface LawArticle {
  /** 조문번호 (`38`). */
  readonly number: string;
  /** 조문가지번호 (`2` for 제22조의2). */
  readonly branch?: string;
  readonly title?: string;
  /** 조문내용 (the heading when the article has 항). */
  readonly text: string;
  readonly paragraphs: readonly LawParagraph[];
  /** Items directly under the article (no 항). */
  readonly items: readonly LawItem[];
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿";

/** `①` -> `1`; `(2)` or `2` stay numeric. */
function paraNumber(raw: string): string {
  const t = raw.trim();
  const i = t.length > 0 ? CIRCLED.indexOf(t.charAt(0)) : -1;
  return i >= 0 ? String(i + 1) : t.replace(/\D/g, "");
}

const blocks = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1] ?? "");
const stripBlocks = (xml: string, tag: string): string => xml.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"), "");

function parseItems(xml: string): LawItem[] {
  return blocks(xml, "호").flatMap((h) => {
    const number = (firstField(h, "호번호") ?? "").replace(/\D/g, "");
    if (!number) return [];
    const branch = firstField(h, "호가지번호")?.replace(/\D/g, "");
    const parts = [firstField(h, "호내용") ?? "", ...blocks(h, "목").map((m) => firstField(m, "목내용") ?? "")];
    return [{ number, ...(branch ? { branch } : {}), text: parts.filter(Boolean).join(" ") }];
  });
}

/** Parses the `<조문단위>` articles of a law.go.kr `lawService` response. Chapter headings (조문여부 other than 조문) are skipped. */
export function parseLawXml(xml: string): LawArticle[] {
  const out: LawArticle[] = [];
  for (const unit of blocks(xml, "조문단위")) {
    const body = stripBlocks(stripBlocks(unit, "항"), "호");
    const kind = firstField(body, "조문여부");
    if (kind !== null && kind !== "조문") continue;
    const number = (firstField(body, "조문번호") ?? "").replace(/\D/g, "");
    if (!number) continue;
    const branch = firstField(body, "조문가지번호")?.replace(/\D/g, "");
    const text = firstField(body, "조문내용") ?? "";
    const title = firstField(body, "조문제목") ?? /\(([^)]*)\)/.exec(text)?.[1];
    const paragraphs: LawParagraph[] = blocks(unit, "항").flatMap((p) => {
      const lead = stripBlocks(p, "호");
      const n = paraNumber(firstField(lead, "항번호") ?? "");
      return n ? [{ number: n, text: firstField(lead, "항내용") ?? "", items: parseItems(p) }] : [];
    });
    out.push({ number, ...(branch ? { branch } : {}), ...(title ? { title } : {}), text, paragraphs, items: parseItems(stripBlocks(unit, "항")) });
  }
  return out;
}

// --- flattening and diffing ----------------------------------------------------------------------

const artKey = (a: Pick<LawArticle, "number" | "branch">): string => (a.branch ? `${a.number}-${a.branch}` : a.number);
const itemKey = (i: LawItem): string => (i.branch ? `${i.number}-${i.branch}` : i.number);

/** Text for comparison: amendment tags and list markers removed, whitespace collapsed. */
export function normalizeProvision(text: string): string {
  return decodeEntities(text)
    .replace(/[<＜](?:(?:개정|신설|삭제|전문개정|본조신설|종전)[^>＞]*|\d{4}\.[^>＞]*)[>＞]/g, "")
    .replace(/\[(?:전문개정|본조신설|제목개정)[^\]]*\]/g, "")
    .replace(/^\s*(?:[①-㊿]|\d+\.|\(\d+\))\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One entry per tracked unit: key (without the law code) -> provision text. */
export function flattenArticles(articles: readonly LawArticle[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of articles) {
    const base = artKey(a);
    if (a.paragraphs.length === 0 && a.items.length === 0) {
      out.set(base, a.text);
      continue;
    }
    for (const i of a.items) out.set(`${base}[${itemKey(i)}]`, i.text);
    for (const p of a.paragraphs) {
      out.set(`${base}(${p.number})`, p.text);
      for (const i of p.items) out.set(`${base}(${p.number})${itemKey(i)}`, i.text);
    }
  }
  return out;
}

export interface DiffOptions {
  readonly oldVersion?: string;
  readonly newVersion?: string;
  readonly effectiveOn?: string | null;
}

/** `삭제`, `제38조 삭제 <2020. 2. 4.>`: the unit was repealed. */
export const isRepealedText = (text: string): boolean => /^(?:제\d+조(?:의\d+)?\s*)?삭제$/.test(normalizeProvision(text));

export function unitsHash(units: readonly AmendmentUnit[]): string {
  return createHash("sha256").update(JSON.stringify(units.map((u) => [u.key, u.change, u.oldText ?? null, u.newText ?? null]))).digest("hex");
}

/** Diffs two article lists of the law `law` (the code used in the keys: `PIPA`, `DEC`). Output order follows the new text, then deletions. */
export function diffArticles(law: string, oldArticles: readonly LawArticle[], newArticles: readonly LawArticle[], opts: DiffOptions = {}): AmendmentDiff {
  const before = flattenArticles(oldArticles);
  const after = flattenArticles(newArticles);
  const units: AmendmentUnit[] = [];
  for (const [k, text] of after) {
    const old = before.get(k);
    const key = `${law}:${k}`;
    if (old === undefined) units.push({ key, change: "added", newText: text });
    else if (normalizeProvision(old) !== normalizeProvision(text)) {
      units.push(isRepealedText(text) ? { key, change: "deleted", oldText: old } : { key, change: "amended", oldText: old, newText: text });
    }
  }
  for (const [k, text] of before) if (!after.has(k)) units.push({ key: `${law}:${k}`, change: "deleted", oldText: text });
  return AmendmentDiffSchema.parse({ law, oldVersion: opts.oldVersion ?? "old", newVersion: opts.newVersion ?? "new", effectiveOn: opts.effectiveOn ?? null, units, hash: unitsHash(units) });
}
