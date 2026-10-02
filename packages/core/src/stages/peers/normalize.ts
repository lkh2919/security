/**
 * Peer page -> normalized policy (design C5): navigation and footer boilerplate removed, hidden text dropped (the existing HTML
 * cleaner), paragraphs whitespace-normalized, contacts masked and sections assigned S01..S24 by the existing segmenter.
 *
 * Hashing is built so that layout changes do not register: a section hash covers the section's blocks sorted by text (so identical or
 * reordered blocks are equal), with heading numbering stripped (inserting a section renumbers the others). Dates and wording stay in
 * the text: a date-only edit is a modified section here.
 */
import { stripInvisible, parseHtml, collapseSpace } from "../../adapters/ingest";
import { sha256Hex } from "../../pipeline/canonical";
import { MAX_PEER_QUOTE_WORDS } from "../../contracts/peers";
import { UNMAPPED_SECTION } from "../../contracts/ingested-policy";
import { maskContacts, segmentDocument, stripNumbering, type HeadingPatterns } from "../ingest/segment-policy";

export const PREAMBLE_SECTION = "PREAMBLE";
/** A page with less text than this, or fewer than two mapped sections, is a shell (JavaScript-only, login wall): manual review. */
export const MIN_POLICY_CHARS = 400;
export const MIN_MAPPED_SECTIONS = 2;

export interface NormBlock {
  readonly sectionId: string;
  readonly title: string;
  readonly paras: readonly string[];
}

export interface NormSection {
  readonly sectionId: string;
  readonly sha256: string;
  readonly charCount: number;
  /** Blocks sorted by their text (canonical order). */
  readonly blocks: readonly NormBlock[];
}

export interface NormalizedPolicy {
  readonly sections: readonly NormSection[];
  /** Hash over the section hashes. */
  readonly contentSha256: string;
  /** Re-parseable text (`## [S02] title` marker lines, then the paragraphs). */
  readonly text: string;
}

const NAV_TAGS = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Removes site chrome (`nav`, `header`, `footer`, `aside`) before the cleaner runs. Repeats for nesting. */
export function stripBoilerplate(html: string): string {
  let prev = html;
  for (let i = 0; i < 5; i++) {
    const next = prev.replace(NAV_TAGS, " ");
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

const normPara = (s: string): string => collapseSpace(s.normalize("NFC"));

const sectionOrder = (id: string): number => {
  if (id === PREAMBLE_SECTION) return -1;
  if (id === UNMAPPED_SECTION) return 1000;
  const m = /^S(\d+)$/.exec(id);
  return m ? Number(m[1]) : 500;
};

const blockKey = (b: NormBlock): string => `${stripNumbering(b.title).trim()}\n${b.paras.join("\n")}`;

/** Groups blocks by section id and computes the hashes. Input order does not matter. */
export function buildNormalized(blocks: readonly NormBlock[]): NormalizedPolicy {
  const byId = new Map<string, NormBlock[]>();
  for (const b of blocks) {
    if (b.paras.length === 0 && !b.title.trim()) continue;
    byId.set(b.sectionId, [...(byId.get(b.sectionId) ?? []), b]);
  }
  const sections: NormSection[] = [...byId.entries()]
    .sort(([a], [b]) => sectionOrder(a) - sectionOrder(b) || a.localeCompare(b))
    .map(([sectionId, list]) => {
      const sorted = [...list].sort((a, b) => blockKey(a).localeCompare(blockKey(b)));
      return { sectionId, sha256: sha256Hex(sorted.map(blockKey).join("\n\n")), charCount: sorted.reduce((n, b) => n + b.paras.reduce((m, p) => m + p.length, 0), 0), blocks: sorted };
    });
  const lines: string[] = [];
  for (const s of sections)
    for (const b of s.blocks) {
      lines.push(`## [${s.sectionId}]${b.title ? ` ${b.title}` : ""}`);
      for (const p of b.paras) lines.push(p.startsWith("## [") ? `\\${p}` : p);
    }
  return { sections, contentSha256: sha256Hex(sections.map((s) => `${s.sectionId}:${s.sha256}`).join("\n")), text: `${lines.join("\n")}\n` };
}

export interface NormalizeResult {
  readonly policy: NormalizedPolicy;
  /** Why the page cannot be used (shell, no sections); null when it is a usable policy. */
  readonly unusable: string | null;
  readonly warnings: readonly string[];
}

/** HTML (plain or browser-rendered) -> normalized policy. Fails closed: a thin or unsegmentable page is `unusable`. */
export function normalizePolicyHtml(html: string, patterns: HeadingPatterns): NormalizeResult {
  const doc = parseHtml(stripBoilerplate(stripInvisible(html)));
  const seg = segmentDocument(doc, patterns);
  const blocks: NormBlock[] = seg.sections.map((s) => ({
    sectionId: s.mappedBy === "preamble" ? PREAMBLE_SECTION : s.sectionId,
    title: s.mappedBy === "preamble" ? "" : normPara(s.title),
    paras: s.paras.map((p) => normPara(p.text)).filter(Boolean),
  }));
  const policy = buildNormalized(blocks);
  const chars = policy.sections.reduce((n, s) => n + s.charCount, 0);
  const mapped = policy.sections.filter((s) => /^S\d{2}$/.test(s.sectionId)).length;
  const unusable = chars < MIN_POLICY_CHARS ? `page text too short (${chars} chars): JavaScript-only or non-policy page` : mapped < MIN_MAPPED_SECTIONS ? `only ${mapped} policy section(s) recognized` : null;
  return { policy, unusable, warnings: seg.warnings };
}

/** Inverse of `NormalizedPolicy.text`. */
export function parseNormalizedText(text: string): NormalizedPolicy {
  const blocks: { sectionId: string; title: string; paras: string[] }[] = [];
  for (const line of text.split("\n")) {
    const m = /^## \[([A-Za-z0-9]+)\](?: (.*))?$/.exec(line);
    if (m) blocks.push({ sectionId: m[1]!, title: m[2] ?? "", paras: [] });
    else if (line && blocks.length > 0) blocks[blocks.length - 1]!.paras.push(line.startsWith("\\## [") ? line.slice(1) : line);
  }
  return buildNormalized(blocks);
}

/** At most 25 words, contacts masked, one line. An ellipsis marks a cut. */
export function maskedQuote(text: string, maxWords = MAX_PEER_QUOTE_WORDS): string {
  const words = maskContacts(text).text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}
