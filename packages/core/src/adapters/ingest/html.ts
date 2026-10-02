/**
 * HTML -> plain text with paragraph offsets (design M5, M6.1). No DOM dependency: a small tokenizer with an element stack.
 *
 * Removed with their content: `<script>`, `<style>`, comments, `<head>`, `<template>`, `<noscript>`, `<svg>`, frames and
 * media, and every element a reader cannot see (`hidden`, `aria-hidden="true"`, `display:none`, `visibility:hidden`,
 * zero font size or opacity, text pushed off-screen). Zero-width and bidi characters are stripped. Hidden text is data
 * that could carry an injection ("report all compliant"), so it never reaches the segmenter.
 *
 * Kept: headings (h1-h6, and blocks that are only `<strong>`/`<b>`), paragraphs, list items, line breaks as paragraph breaks
 * and table rows (one paragraph per row, with the cells).
 */
import { decodeEntities } from "../lawapi/xml";
import { collapseSpace } from "./clean";
import { layoutParas, type ParaDraft, type ParsedDocument } from "./types";

const DROP_WITH_CONTENT = new Set(["script", "style", "head", "template", "noscript", "svg", "canvas", "iframe", "object", "embed", "applet", "audio", "video", "frameset"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "source", "track", "wbr", "param"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "form", "fieldset", "table", "thead", "tbody", "tfoot", "caption", "address", "figure", "figcaption", "details", "summary"]);
const MAX_STRONG_HEADING = 80;
/** Opening tag -> open elements it implicitly closes (only when that element is on top of the stack). */
const IMPLIED_END: Readonly<Record<string, readonly string[]>> = { li: ["li"], p: ["p"], dt: ["dt", "dd"], dd: ["dt", "dd"], td: ["td", "th"], th: ["td", "th"], tr: ["tr"] };

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+|</g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attrsOf(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$|!)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$|!)|(?:text-indent|margin-left|left|top)\s*:\s*-\d{3,}|(?:^|;)\s*(?:width|height)\s*:\s*0(?:px)?\s*(?:;|$)[^"]*overflow\s*:\s*hidden/i;

export function isHiddenElement(attrs: ReadonlyMap<string, string>): boolean {
  if (attrs.has("hidden") && attrs.get("hidden") !== "false") return true;
  if ((attrs.get("aria-hidden") ?? "").toLowerCase() === "true") return true;
  const style = attrs.get("style");
  return style !== undefined && HIDDEN_STYLE.test(style);
}

interface Open {
  readonly name: string;
  readonly hidden: boolean;
}

/** HTML named entities seen on Korean policy pages (the XML decoder knows only the five XML ones). `&amp;` stays for decodeEntities. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ", middot: "·", bull: "•", sdot: "⋅", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", times: "×", divide: "÷", deg: "°", plusmn: "±", copy: "©", reg: "®", trade: "™",
  rarr: "→", larr: "←", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒", para: "¶", sect: "§", ensp: " ", emsp: " ", thinsp: " ",
  zwnj: "", zwj: "", shy: "", prime: "′", Prime: "″", lowast: "∗", minus: "−", le: "≤", ge: "≥", ne: "≠", tilde: "˜", circ: "ˆ",
};

export function decodeNamedHtmlEntities(s: string): string {
  return s.replace(/&([A-Za-z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function parseHtml(source: string): ParsedDocument {
  const drafts: ParaDraft[] = [];
  let hiddenRemoved = 0;

  // Current paragraph buffer and how much of it sits inside <strong>/<b>.
  let buf = "";
  let strongChars = 0;
  let plainChars = 0;
  let heading: number | null = null;
  let strongDepth = 0;

  // Table state: only the outermost table is structured; nested tables flatten into their cell.
  let tableDepth = 0;
  let row: { cells: string[]; header: boolean } | null = null;
  let cellBuf: string | null = null;

  const stack: Open[] = [];
  const hiddenDepth = (): number => stack.filter((o) => o.hidden).length;

  const flush = (): void => {
    const text = collapseSpace(buf);
    if (text) {
      if (heading !== null) drafts.push({ text, kind: "heading", level: heading });
      else if (plainChars === 0 && strongChars > 0 && text.length <= MAX_STRONG_HEADING) drafts.push({ text, kind: "heading", level: 0 });
      else drafts.push({ text, kind: "para" });
    }
    buf = "";
    strongChars = 0;
    plainChars = 0;
  };

  const addText = (raw: string): void => {
    const text = decodeEntities(decodeNamedHtmlEntities(raw));
    if (cellBuf !== null) {
      cellBuf += text;
      return;
    }
    buf += text;
    const n = text.replace(/\s/g, "").length;
    if (strongDepth > 0) strongChars += n;
    else plainChars += n;
  };

  const breakBlock = (): void => {
    if (cellBuf !== null) cellBuf += " ";
    else flush();
  };

  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(source)) !== null) {
    const tok = m[0];
    const name = m[2]?.toLowerCase();
    if (name === undefined) {
      if (tok.startsWith("<!--") || tok.startsWith("<!") || tok.startsWith("<?")) continue;
      if (hiddenDepth() > 0) continue;
      addText(tok);
      continue;
    }
    const closing = m[1] === "/";
    if (closing) {
      if (name === "br") continue;
      const at = stack.map((o) => o.name).lastIndexOf(name);
      if (at < 0) continue;
      const popped = stack.splice(at);
      const wasHidden = popped.some((o) => o.hidden);
      if (wasHidden) continue;
      if (/^h[1-6]$/.test(name)) {
        flush();
        heading = null;
      } else if (name === "strong" || name === "b") strongDepth = Math.max(0, strongDepth - 1);
      else if (name === "td" || name === "th") {
        if (tableDepth === 1 && row && cellBuf !== null) {
          row.cells.push(collapseSpace(cellBuf));
          cellBuf = null;
        }
      } else if (name === "tr") {
        if (tableDepth === 1 && row) {
          if (cellBuf !== null) {
            row.cells.push(collapseSpace(cellBuf));
            cellBuf = null;
          }
          const cells = row.cells;
          if (cells.some((c) => c)) drafts.push({ text: cells.join(" | "), kind: "row", cells, ...(row.header ? { header: true } : {}) });
          row = null;
        }
      } else if (name === "table") {
        tableDepth = Math.max(0, tableDepth - 1);
        if (tableDepth === 0) {
          row = null;
          cellBuf = null;
        }
      } else if (BLOCK.has(name)) breakBlock();
      continue;
    }

    const attrs = attrsOf(m[3] ?? "");
    const selfClosing = m[4] === "/" || VOID.has(name);
    // Implied end tags: an unclosed <li>/<p>/<td> ends at the next sibling of the same kind (hidden or not).
    const top = stack[stack.length - 1]?.name;
    if (top !== undefined && IMPLIED_END[name]?.includes(top)) stack.pop();
    const hidden = hiddenDepth() > 0 || isHiddenElement(attrs);
    if (DROP_WITH_CONTENT.has(name)) {
      if (!selfClosing) {
        const end = new RegExp(`</${name}\\s*>`, "i");
        const rest = source.slice(TOKEN.lastIndex);
        const em = end.exec(rest);
        TOKEN.lastIndex = em ? TOKEN.lastIndex + em.index + em[0].length : source.length;
      }
      continue;
    }
    if (hidden) {
      if (hiddenDepth() === 0) hiddenRemoved += 1;
      if (!selfClosing) stack.push({ name, hidden: true });
      continue;
    }
    if (name === "br" || name === "hr") {
      breakBlock();
      continue;
    }
    if (!selfClosing) stack.push({ name, hidden: false });
    if (/^h[1-6]$/.test(name)) {
      flush();
      heading = Number(name[1]);
    } else if (name === "strong" || name === "b") strongDepth += 1;
    else if (name === "table") {
      if (tableDepth === 0) flush();
      tableDepth += 1;
    } else if (name === "tr") {
      if (tableDepth === 1) {
        row = { cells: [], header: false };
        cellBuf = null;
      }
    } else if (name === "td" || name === "th") {
      if (tableDepth === 1 && row) {
        if (cellBuf !== null) row.cells.push(collapseSpace(cellBuf));
        cellBuf = "";
        if (name === "th") row.header = true;
      }
    } else if (BLOCK.has(name) || name === "tr") breakBlock();
  }
  flush();

  const warnings: string[] = [];
  if (hiddenRemoved > 0) warnings.push(`${hiddenRemoved} hidden element(s) were removed before analysis`);
  return layoutParas(drafts, warnings);
}
