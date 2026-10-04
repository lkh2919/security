/**
 * Markdown -> plain text with paragraph offsets (design M5). Handles what published policies use: `#` headings, bold-only
 * lines as headings, list items, pipe tables (one paragraph per row), fenced code (kept as text) and inline markup.
 * HTML comments, `<script>` and `<style>` blocks inside the Markdown are dropped; other raw tags are removed.
 */
import { collapseSpace, stripInvisible } from "./clean";
import { layoutParas, type ParaDraft, type ParsedDocument } from "./types";

const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const MAX_BOLD_HEADING = 80;

/** Inline markup -> text: links keep their label only (the URL is dropped), emphasis markers and code ticks are removed. */
export function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>\n]*>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1");
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (body[i] === "|") {
      cells.push(cur);
      cur = "";
    } else cur += body[i];
  }
  cells.push(cur);
  return cells.map((c) => collapseSpace(stripInlineMarkdown(c)));
}

export function parseMarkdown(source: string): ParsedDocument {
  const warnings: string[] = [];
  let src = stripInvisible(source).replace(/\r\n?/g, "\n");
  const before = src.length;
  src = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  if (src.length !== before) warnings.push("HTML comments, script or style blocks inside the Markdown were removed");

  const drafts: ParaDraft[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const text = collapseSpace(stripInlineMarkdown(buf.join(" ")));
    buf = [];
    if (text) drafts.push({ text, kind: "para" });
  };

  const lines = src.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const t = collapseSpace(raw);
      if (t) drafts.push({ text: t, kind: "para" });
      continue;
    }
    if (line === "") {
      flush();
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const text = collapseSpace(stripInlineMarkdown(h[2]!));
      if (text) drafts.push({ text, kind: "heading", level: h[1]!.length });
      continue;
    }
    if (line.startsWith("|") || (line.includes("|") && TABLE_SEPARATOR.test(lines[i + 1]?.trim() ?? ""))) {
      flush();
      if (TABLE_SEPARATOR.test(line)) continue;
      const cells = splitRow(line);
      const header = TABLE_SEPARATOR.test(lines[i + 1]?.trim() ?? "");
      if (cells.some((c) => c)) drafts.push({ text: cells.join(" | "), kind: "row", cells, ...(header ? { header: true } : {}) });
      continue;
    }
    const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)$/.exec(line);
    if (bold && !/(\*\*|__)/.test(bold[1]!)) {
      const text = collapseSpace(stripInlineMarkdown(bold[1]!));
      if (text.length <= MAX_BOLD_HEADING) {
        flush();
        if (text) drafts.push({ text, kind: "heading", level: 0 });
        continue;
      }
    }
    const item = /^(?:[-*+]\s+|(?=\d+[.)]\s))(.*)$/.exec(line);
    if (item) {
      flush();
      buf.push(item[1]!);
      flush();
      continue;
    }
    buf.push(line.replace(/^>\s?/, ""));
  }
  flush();
  return layoutParas(drafts, warnings);
}
