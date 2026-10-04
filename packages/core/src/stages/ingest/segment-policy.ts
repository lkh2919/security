/**
 * Heading-rule segmenter (Policy Monitor design M5): maps the headings of a published policy to section ids S01-S24 / A1 / X1
 * with the keyword table `kb/jurisdictions/kr/segmentation/heading-patterns.json`. Code only, zero tokens.
 *
 *  - A block starts at a heading. An exact heading hit has confidence 1.0, a keyword hit 0.8; text before the first
 *    heading is the preamble (S01, 0.5). A heading that matches nothing starts an `UNMAPPED` block, unless it is
 *    clearly a sub-heading of the current section (deeper level), which stays inside that section.
 *  - Low confidence and UNMAPPED mean "not located", never "missing": the monitor searches the whole text before it reports an omission.
 *  - Contacts (phones, e-mails) are masked here, before anything else sees the text; only presence flags are kept.
 *  - Optional LLM pass for UNMAPPED blocks: not part of A1. `resolveUnmappedSections` is the hook (masked data only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ParsedDocument, ParsedPara } from "../../adapters/ingest/types";
import { ItemIdSchema, type ItemId } from "../../contracts/common";
import { IngestedPolicySchema, UNMAPPED_SECTION, type IngestedPolicy, type IngestedSection } from "../../contracts/ingested-policy";
import { sha256OfBytes } from "../../adapters/ingest";
import { buildRules, findHits } from "../intake/patterns";

// --- heading patterns ----------------------------------------------------------------------------

const PatternsFileSchema = z.looseObject({
  version: z.string().min(1),
  sections: z.record(ItemIdSchema, z.looseObject({ exact: z.array(z.string().min(1)), keywords: z.array(z.string().min(1)) })),
  /** Topics that belong to no standard section (e.g. 연계정보(CI)): a heading containing one is never mapped and never folded into the section before it. */
  unmappedKeywords: z.array(z.string().min(1)).optional(),
});

export interface SectionPatterns {
  readonly id: ItemId;
  /** Normalized headings that equal a section title. */
  readonly exact: readonly string[];
  /** Normalized keywords, contained in a heading. */
  readonly keywords: readonly string[];
}

export interface HeadingPatterns {
  readonly version: string;
  /** SHA-256 of the file (manifest `segmentation.sha256`). */
  readonly sha256: string;
  /** Normalized keywords of topics without a standard section: such a heading stays UNMAPPED (see `isUnmappedTopic`). */
  readonly unmapped: readonly string[];
  /** In file order: S01..S24, A1, X1 (ties go to the earlier entry). */
  readonly sections: readonly SectionPatterns[];
}

/** Only letters and digits survive, lowercase: spacing, punctuation, middle dots and brackets never decide a match. */
export function normHeading(s: string): string {
  return s.replace(/[ㆍᆞ·・•]/g, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

export function parseHeadingPatterns(raw: string): HeadingPatterns {
  const file = PatternsFileSchema.parse(JSON.parse(raw));
  return {
    version: file.version,
    sha256: sha256OfBytes(raw),
    unmapped: (file.unmappedKeywords ?? []).map(normHeading).filter((k) => k.length > 0),
    sections: Object.entries(file.sections).map(([id, p]) => ({ id: id as ItemId, exact: p.exact.map(normHeading), keywords: p.keywords.map(normHeading).filter((k) => k.length > 0) })),
  };
}

export function headingPatternsPath(repoRoot: string): string {
  return join(repoRoot, "kb", "jurisdictions", "kr", "segmentation", "heading-patterns.json");
}

export function loadHeadingPatterns(repoRoot: string): HeadingPatterns {
  return parseHeadingPatterns(readFileSync(headingPatternsPath(repoRoot), "utf8"));
}

/** Numbering that prefixes a heading: `제3조`, `3.`, `3)`, `(3)`, `가.`, `①`, `Ⅲ.`, `제2장`. Removed up to twice. */
const NUMBERING = /^\s*(?:제\s*\d+\s*(?:조|장|절)|\d{1,2}\s*[.)]|\(\s*\d{1,2}\s*\)|[가-하]\s*[.)]|[①-⑳]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.)]?|\[[^\]]{1,20}\])\s*/u;

export function stripNumbering(s: string): string {
  let t = s;
  for (let i = 0; i < 2; i++) t = t.replace(NUMBERING, "");
  return t;
}

type NumberingStyle = "chapter" | "article" | "arabic" | "hangul" | "paren" | "circled";

function numberingStyle(s: string): NumberingStyle | null {
  if (/^\s*(?:제\s*\d+\s*장|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])/u.test(s)) return "chapter";
  if (/^\s*\[?\s*제\s*\d+\s*(?:조|절)/u.test(s)) return "article";
  if (/^\s*\d{1,2}\s*\./u.test(s)) return "arabic";
  if (/^\s*[가-하]\s*[.)]/u.test(s)) return "hangul";
  if (/^\s*(?:\d{1,2}\s*\)|\(\s*\d{1,2}\s*\))/u.test(s)) return "paren";
  if (/^\s*[①-⑳]/u.test(s)) return "circled";
  return null;
}

const DEFAULT_DEPTH: Readonly<Record<NumberingStyle, number>> = { chapter: 1, article: 2, arabic: 2, hangul: 3, paren: 3, circled: 4 };

/**
 * Nesting depth of a numbering style (1 = top), 0 when the line has no numbering. `top` is the style the document uses for
 * its articles: real pages differ ("가." articles with "1." items on one site, "1." articles with "가." items on another).
 */
function numberingDepth(s: string, top: NumberingStyle | null = null): number {
  const st = numberingStyle(s);
  if (!st) return 0;
  if (st === "chapter" || st === top) return 1;
  return Math.max(2, DEFAULT_DEPTH[st]);
}

export interface HeadingMatch {
  readonly sectionId: ItemId;
  readonly mappedBy: "heading_exact" | "heading_keyword";
  readonly confidence: number;
}

/** True when the heading is about a topic that has no standard section (e.g. 연계정보(CI) 생성·처리). */
export function isUnmappedTopic(patterns: HeadingPatterns, heading: string): boolean {
  const n = normHeading(stripNumbering(heading));
  return n.length > 0 && patterns.unmapped.some((k) => n.includes(k));
}

/** Exact heading first, then the longest contained keyword. `null` when nothing matches (or the heading is an unmapped topic). */
export function matchHeading(patterns: HeadingPatterns, heading: string): HeadingMatch | null {
  const n = normHeading(stripNumbering(heading));
  if (!n) return null;
  for (const s of patterns.sections) if (s.exact.includes(n)) return { sectionId: s.id, mappedBy: "heading_exact", confidence: 1 };
  if (patterns.unmapped.some((k) => n.includes(k))) return null;
  let best: { id: ItemId; len: number } | null = null;
  for (const s of patterns.sections) {
    for (const k of s.keywords) if (n.includes(k) && (!best || k.length > best.len)) best = { id: s.id, len: k.length };
  }
  return best ? { sectionId: best.id, mappedBy: "heading_keyword", confidence: 0.8 } : null;
}

/**
 * Does `sectionId` have a heading-like line anywhere in `lines` (another section's title, or a short non-sentence line that maps to it)?
 * Narrower than `fullTextMentions`: used where a word in running text proves nothing, only a heading the segmenter missed counts.
 */
export function headingLineMentions(patterns: HeadingPatterns, sectionId: string, lines: readonly string[]): boolean {
  return lines.some((l) => l.length <= MAX_HEADING_LINE && !SENTENCE_END.test(l) && matchHeading(patterns, l)?.sectionId === sectionId);
}

/** Full-text search used before a section is reported missing: does any exact title or keyword of `sectionId` occur anywhere? */
export function fullTextMentions(patterns: HeadingPatterns, sectionId: string, text: string): boolean {
  const n = normHeading(text);
  const s = patterns.sections.find((p) => p.id === sectionId);
  return s !== undefined && [...s.exact, ...s.keywords].some((k) => k.length >= 2 && n.includes(k));
}

// --- contact masking -----------------------------------------------------------------------------

export const PHONE_MASK = "[전화번호]";
export const EMAIL_MASK = "[이메일]";

const CONTACT_RULES = buildRules().filter((r) => r.kind === "EMAIL" || r.kind === "PHONE");

/** Full-width digits and sign characters to ASCII, length-preserving, so the phone and e-mail rules see them. */
const foldWidth = (s: string): string => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/＠/g, "@").replace(/[－‐‑–—]/g, "-").replace(/．/g, ".");

export interface MaskedText {
  readonly text: string;
  readonly phone: boolean;
  readonly email: boolean;
}

/** Replaces phone numbers and e-mail addresses with fixed tokens. Pure; no vault (the originals are not kept anywhere). */
export function maskContacts(input: string): MaskedText {
  const text = foldWidth(input);
  const hits = CONTACT_RULES.flatMap((rule) => findHits(text, rule)).sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let last = 0;
  let phone = false;
  let email = false;
  for (const h of hits) {
    if (h.start < last) continue;
    out += text.slice(last, h.start) + (h.rule.kind === "EMAIL" ? EMAIL_MASK : PHONE_MASK);
    if (h.rule.kind === "EMAIL") email = true;
    else phone = true;
    last = h.end;
  }
  return { text: out + text.slice(last), phone, email };
}

// --- segmentation --------------------------------------------------------------------------------

interface MaskedPara {
  readonly text: string;
  readonly kind: ParsedPara["kind"];
  readonly level?: number;
  readonly cells?: readonly string[];
  readonly header?: boolean;
  readonly phone: boolean;
  readonly email: boolean;
  start: number;
  end: number;
}

interface Block {
  sectionId: string;
  title: string;
  mappedBy: IngestedSection["mappedBy"];
  confidence: number;
  depth: number;
  /** Index of the heading paragraph (-1 for the preamble). */
  headingIndex: number;
  paraIndexes: number[];
  /** Preamble only: an unmatched heading (the document title) was already absorbed. */
  sawTitle?: boolean;
  /** Started by a heading element (<h1>-<h6>, Markdown #), not by a numbered or exact plain line. */
  element?: boolean;
}

const SENTENCE_END = /(?:다|요|니다)\s*[.!?]?\s*$|[.!?]\s*$/u;
const MAX_HEADING_LINE = 80;
/** A bold-only line that is not a heading deeper than any section heading. */
const BOLD_DEPTH = 7;

export interface SegmentResult {
  readonly text: string;
  readonly sections: IngestedSection[];
  readonly warnings: string[];
}

export function segmentDocument(doc: ParsedDocument, patterns: HeadingPatterns): SegmentResult {
  // 1. mask contacts per paragraph (cells too), then lay the masked text out again so spans stay exact.
  const paras: MaskedPara[] = [];
  let offset = 0;
  for (const p of doc.paras) {
    const cells = p.cells?.map((c) => maskContacts(c));
    const m = cells ? { text: cells.map((c) => c.text).join(" | "), phone: cells.some((c) => c.phone), email: cells.some((c) => c.email) } : maskContacts(p.text);
    if (paras.length > 0) offset += 1;
    paras.push({
      text: m.text,
      kind: p.kind,
      ...(p.level !== undefined ? { level: p.level } : {}),
      ...(cells ? { cells: cells.map((c) => c.text) } : {}),
      ...(p.header ? { header: true } : {}),
      phone: m.phone,
      email: m.email,
      start: offset,
      end: offset + m.text.length,
    });
    offset += m.text.length;
  }
  const text = paras.map((p) => p.text).join("\n");

  // 2. the document's article numbering style: that of the first short numbered line that maps to a section.
  const top = (() => {
    for (const p of paras) {
      if (p.kind === "row" || p.text.length > MAX_HEADING_LINE || SENTENCE_END.test(p.text)) continue;
      const st = numberingStyle(p.text);
      if (st && st !== "chapter" && matchHeading(patterns, p.text)) return st;
    }
    return null;
  })();
  const depthOf = (t: string): number => numberingDepth(t, top);

  // 3. classify each paragraph: heading (with its match and depth) or body.
  const headingOf = (p: MaskedPara): { match: HeadingMatch | null; depth: number; element?: boolean } | null => {
    if (p.kind === "row") return null;
    // A bold line (level 0) that carries numbering takes its numbering depth: "7. 개인정보 자동 수집 장치" in bold is an article.
    if (p.kind === "heading") return { match: matchHeading(patterns, p.text), depth: p.level && p.level > 0 ? p.level : depthOf(p.text) || BOLD_DEPTH, element: p.level !== undefined && p.level > 0 };
    if (p.text.length > MAX_HEADING_LINE || SENTENCE_END.test(p.text)) return null;
    const match = matchHeading(patterns, p.text);
    // A plain line is a heading only when numbered or an exact title: a keyword inside a short sentence proves nothing.
    if (match && (depthOf(p.text) > 0 || match.mappedBy === "heading_exact")) return { match, depth: depthOf(p.text) || 2 };
    // An article-level line (`제10조 ...`, `10. ...`) about an unmapped topic starts its own UNMAPPED block.
    if (!match && depthOf(p.text) > 0 && depthOf(p.text) <= 2 && isUnmappedTopic(patterns, p.text)) return { match: null, depth: depthOf(p.text) };
    return null;
  };

  // 4. blocks
  const blocks: Block[] = [{ sectionId: "S01", title: "", mappedBy: "preamble", confidence: 0.5, depth: 0, headingIndex: -1, paraIndexes: [] }];
  let cur = blocks[0]!;
  paras.forEach((p, i) => {
    const h = headingOf(p);
    if (!h) {
      cur.paraIndexes.push(i);
      return;
    }
    const inMapped = cur.mappedBy !== "preamble" && cur.sectionId !== UNMAPPED_SECTION;
    // Element levels (h3 = 3) and plain-line numbering depths (1. = 1) are different scales: a heading element is never a
    // sub-heading of a plain line (real page, 2026-10-02: "[제 9 조]" h3 folded under "2. 모바일 브라우저에서 쿠키 허용/차단").
    const deeper = (h.element === true && cur.element !== true) ? false : h.depth > cur.depth;
    if (h.match) {
      // A keyword-only hit deeper than the current section heading is a sub-heading of it, not a new section.
      if (h.match.mappedBy === "heading_keyword" && inMapped && deeper) {
        cur.paraIndexes.push(i);
        return;
      }
      cur = { sectionId: h.match.sectionId, title: p.text, mappedBy: h.match.mappedBy, confidence: h.match.confidence, depth: h.depth, headingIndex: i, paraIndexes: [], ...(h.element ? { element: true } : {}) };
      blocks.push(cur);
      return;
    }
    // An unmapped topic (연계정보 ...) is never folded into the section before it: it must not inherit S21 and the like.
    const unmappedTopic = isUnmappedTopic(patterns, p.text);
    if (!unmappedTopic && ((cur.mappedBy === "preamble" && !cur.sawTitle) || (inMapped && deeper))) {
      if (cur.mappedBy === "preamble") cur.sawTitle = true;
      cur.paraIndexes.push(i);
      return;
    }
    cur = { sectionId: UNMAPPED_SECTION, title: p.text, mappedBy: "none", confidence: 0, depth: h.depth, headingIndex: i, paraIndexes: [], ...(h.element ? { element: true } : {}) };
    blocks.push(cur);
  });

  // 5. sections
  const sections: IngestedSection[] = [];
  for (const b of blocks) {
    if (b.headingIndex < 0 && b.paraIndexes.length === 0) continue; // empty preamble
    const own = b.paraIndexes.map((i) => paras[i]!);
    const all = b.headingIndex >= 0 ? [paras[b.headingIndex]!, ...own] : own;
    const title = (b.headingIndex >= 0 ? b.title : (own[0]?.text ?? "서문")).slice(0, 120);
    sections.push({
      sectionId: b.sectionId as IngestedSection["sectionId"],
      title,
      span: { start: all[0]!.start, end: all[all.length - 1]!.end },
      paras: own.map((p, k) => ({ n: k + 1, span: { start: p.start, end: p.end }, text: p.text, kind: p.kind, ...(p.cells ? { cells: [...p.cells] } : {}), ...(p.header ? { header: true } : {}) })),
      mappedBy: b.mappedBy,
      confidence: b.confidence,
      contacts: { phone: all.some((p) => p.phone), email: all.some((p) => p.email) },
    });
  }

  const warnings = [...doc.warnings];
  const unmapped = sections.filter((s) => s.sectionId === UNMAPPED_SECTION).length;
  if (unmapped > 0) warnings.push(`${unmapped} block(s) could not be mapped to a section (UNMAPPED); they are not judged as missing`);
  return { text, sections, warnings };
}

// --- optional LLM pass (A2) ------------------------------------------------------------------------

export type UnmappedResolver = (section: IngestedSection) => Promise<{ sectionId: ItemId; confidence: number } | null>;

/**
 * Hook for the optional model pass over UNMAPPED blocks (A2, Haiku stage `M0`). The resolver receives masked section data only and
 * must return a section id or null. A1 does not call it.
 */
export async function resolveUnmappedSections(policy: IngestedPolicy, resolve: UnmappedResolver): Promise<IngestedPolicy> {
  const sections: IngestedSection[] = [];
  for (const s of policy.sections) {
    if (s.sectionId !== UNMAPPED_SECTION) {
      sections.push(s);
      continue;
    }
    const r = await resolve(s);
    sections.push(r ? { ...s, sectionId: r.sectionId, mappedBy: "llm", confidence: Math.min(0.7, Math.max(0, r.confidence)) } : s);
  }
  return IngestedPolicySchema.parse({ ...policy, sections });
}
