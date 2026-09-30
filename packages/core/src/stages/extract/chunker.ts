/**
 * Splits a long masked transcript into chunks for R2 (design R3: chunk long input, <= 30K tokens/call).
 * Chunks are contiguous, deterministic, and repeat the last `overlap` segments of the previous chunk
 * so an answer that follows its question across a boundary is still seen together. Duplicate
 * extractions caused by the overlap merge cleanly downstream.
 */
import type { TranscriptSegment } from "../../contracts/masked-transcript";

export const DEFAULT_MAX_CHUNK_CHARS = 12_000;
export const DEFAULT_OVERLAP_SEGMENTS = 2;

const segmentCost = (s: TranscriptSegment): number => s.text.length + (s.speaker?.length ?? 0) + 12;

export function chunkSegments(
  segments: readonly TranscriptSegment[],
  maxChars = DEFAULT_MAX_CHUNK_CHARS,
  overlap = DEFAULT_OVERLAP_SEGMENTS,
): TranscriptSegment[][] {
  if (segments.length === 0) return [];
  const chunks: TranscriptSegment[][] = [];
  let start = 0;
  while (start < segments.length) {
    let end = start;
    let size = 0;
    while (end < segments.length && (end === start || size + segmentCost(segments[end]) <= maxChars)) {
      size += segmentCost(segments[end]);
      end++;
    }
    chunks.push(segments.slice(start, end));
    if (end >= segments.length) break;
    // Overlap, but always make forward progress.
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
