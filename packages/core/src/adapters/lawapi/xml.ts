/**
 * Minimal dependency-free reader for the flat XML returned by the law.go.kr Open API.
 * Only what the freshness watcher needs: root tag, repeated row elements with simple children.
 */

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function unwrapText(raw: string): string {
  const t = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  return cdata ? (cdata[1] ?? "").trim() : decodeEntities(t);
}

/** Name of the document element, or null when the input is not XML. */
export function rootTag(xml: string): string | null {
  const body = xml.replace(/^﻿/, "").replace(/<\?xml[\s\S]*?\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const m = /<([^\s>/!?]+)/.exec(body);
  return m ? (m[1] ?? null) : null;
}

/** Text of the first `<name>` element anywhere in the document. */
export function firstField(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unwrapText(m[1] ?? "") : null;
}

/** Each `<rowTag>` element as a map of its direct simple children. */
export function parseRows(xml: string, rowTag: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const rowRe = new RegExp(`<${rowTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${rowTag}>`, "g");
  for (const rm of xml.matchAll(rowRe)) {
    const inner = rm[1] ?? "";
    const row: Record<string, string> = {};
    for (const cm of inner.matchAll(/<([^\s>/!?]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const key = cm[1] ?? "";
      if (!(key in row)) row[key] = unwrapText(cm[2] ?? "");
    }
    rows.push(row);
  }
  return rows;
}
