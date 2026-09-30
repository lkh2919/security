import type { SttResult } from "../../adapters/stt/types";
import { sanitizeText } from "./sanitize";

export interface RawSegment {
  readonly id: string;
  readonly speaker?: string;
  readonly startMs?: number;
  readonly endMs?: number;
  /** Sanitized but NOT yet masked. */
  readonly text: string;
}

export function segmentId(n: number): string {
  return `T${String(n).padStart(4, "0")}`;
}

/** Assigns stable IDs T0001.. in input order; drops empty segments. Deterministic. */
export function segmentTranscript(stt: SttResult): RawSegment[] {
  const out: RawSegment[] = [];
  for (const s of stt.segments) {
    const text = sanitizeText(s.text).trim();
    if (!text) continue;
    const speaker = s.speaker ? sanitizeText(s.speaker).trim() : undefined;
    out.push({
      id: segmentId(out.length + 1),
      text,
      ...(speaker ? { speaker } : {}),
      ...(s.startMs !== undefined ? { startMs: s.startMs } : {}),
      ...(s.endMs !== undefined ? { endMs: s.endMs } : {}),
    });
  }
  return out;
}
