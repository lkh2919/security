import { readFile } from "node:fs/promises";
import type { SttAdapter, SttResult, SttSegment, SttTranscribeOptions } from "./types";

/** Longest single segment before sentence-boundary splitting. */
export const DEFAULT_MAX_SEGMENT_CHARS = 400;

const TIMESTAMP_RE = /^\s*\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\]?\s*/;
/** `label: text` or `[label] text`. Labels contain no digits so `시간: 10:30` style prose is not eaten. */
const LABEL_RE = /^\s*(?:\[([^\[\]:：\d\n]{1,30})\]\s*[:：]?|([^\[\]:：\d\n]{1,30}?)\s*[:：])\s*(\S[\s\S]*)$/;

function timestampMs(m: RegExpMatchArray): number {
  const [, h, mi, s, frac] = m;
  const ms = frac ? Number(frac.padEnd(3, "0")) : 0;
  return ((Number(h ?? 0) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + ms;
}

/** Splits one long utterance at sentence ends, packing greedily up to `max` chars. Deterministic. */
export function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?。？！])\s+/);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  // A single sentence longer than max is hard-cut so segments stay bounded.
  return out.flatMap((s) => (s.length <= max ? [s] : (s.match(new RegExp(`[\s\S]{1,${max}}`, "g")) ?? [s])));
}

/**
 * Parses a plain-text transcript. Supported line forms:
 * `[00:01:23] label: text`, `label: text`, `[label] text`, or bare text (inherits the previous speaker).
 * Blank lines and Markdown headings / horizontal rules are skipped.
 */
export function parseTranscriptText(raw: string, maxSegmentChars = DEFAULT_MAX_SEGMENT_CHARS): SttSegment[] {
  const segs: { text: string; speaker?: string; startMs?: number; endMs?: number }[] = [];
  let lastSpeaker: string | undefined;
  for (const line0 of raw.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    let line = line0.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|={3,})$/.test(line)) continue;
    let startMs: number | undefined;
    const ts = line.match(TIMESTAMP_RE);
    if (ts && ts[0].trim().length >= 4 && line.slice(ts[0].length).length > 0) {
      startMs = timestampMs(ts);
      line = line.slice(ts[0].length);
    }
    let speaker = lastSpeaker;
    const lm = line.match(LABEL_RE);
    if (lm) {
      speaker = (lm[1] ?? lm[2]).trim();
      lastSpeaker = speaker;
      line = lm[3];
    }
    for (const piece of splitLong(line.trim(), maxSegmentChars)) {
      if (piece) segs.push({ text: piece, speaker, startMs });
    }
  }
  // endMs = next known startMs.
  return segs.map((s, i) => {
    const next = segs.slice(i + 1).find((n) => n.startMs !== undefined)?.startMs;
    return { text: s.text, ...(s.speaker ? { speaker: s.speaker } : {}), ...(s.startMs !== undefined ? { startMs: s.startMs } : {}), ...(s.startMs !== undefined && next !== undefined && next >= s.startMs ? { endMs: next } : {}) };
  });
}

/** Reads .txt / .md transcripts. */
export class TextFileSttAdapter implements SttAdapter {
  readonly id = "text-file";
  constructor(private readonly maxSegmentChars = DEFAULT_MAX_SEGMENT_CHARS) {}

  async transcribe(file: string, opts?: SttTranscribeOptions): Promise<SttResult> {
    if (!/\.(txt|md|markdown)$/i.test(file)) throw new Error(`TextFileSttAdapter only reads .txt/.md files: ${file.split(/[\/]/).pop()}`);
    const raw = await readFile(file, "utf8");
    return { source: "text_file", language: opts?.language ?? "ko", segments: parseTranscriptText(raw, this.maxSegmentChars) };
  }

  /** Same parsing for text already in memory (pasted answers). */
  fromText(raw: string, language = "ko"): SttResult {
    return { source: "text_file", language, segments: parseTranscriptText(raw, this.maxSegmentChars) };
  }
}
