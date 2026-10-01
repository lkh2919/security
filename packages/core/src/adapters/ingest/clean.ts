/**
 * Text hygiene for ingested policy text (design M6.1). Unlike `sanitizeText` (transcripts) this does NOT apply NFKC:
 * policy wording such as the Hangul "araea" middle dot must reach the report as written. It removes what a reader cannot see:
 * zero-width and bidi characters, soft hyphens, tag characters and control characters, and folds every kind of space to " ".
 */

/** [from, to] code point ranges that are never visible text. Tab, line feed and carriage return stay. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x115f, 0x1160], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff9, 0xfffb], [0xe0000, 0xe007f],
];
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("")}]`, "gu");
const LINE_SEPARATORS = new RegExp(`[\\u{2028}\\u{2029}]`, "gu");

/** Removes invisible characters. Line separators U+2028/2029 become "\n". */
export function stripInvisible(s: string): string {
  return s.replace(LINE_SEPARATORS, "\n").replace(INVISIBLE, "");
}

/** One-line text: invisible characters removed, any whitespace run (also NBSP) collapsed to one space, trimmed. */
export function collapseSpace(s: string): string {
  return stripInvisible(s).replace(/\s+/g, " ").trim();
}
