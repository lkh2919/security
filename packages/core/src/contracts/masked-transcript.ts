/**
 * MaskedTranscript: STT or text transcript after the PII masking hard gate (design R3 row R1).
 * Contains placeholders such as `{{PERSON_1}}` only; real values live in the PiiVault (local).
 */
import { z } from "zod";
import { NonEmptyString, RunIdSchema, SegmentIdSchema } from "./common";

/** Placeholder key, e.g. `{{PERSON_1}}` -> key `PERSON_1`. */
export const PlaceholderKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*_\d+$/, "placeholder key must look like PERSON_1");
export type PlaceholderKey = z.infer<typeof PlaceholderKeySchema>;

export const TranscriptSegmentSchema = z.strictObject({
  id: SegmentIdSchema,
  /** Speaker label after masking (`interviewer`, `owner`, ...). Not a personal name. */
  speaker: z.string().optional(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const MaskedTranscriptSchema = z
  .strictObject({
    runId: RunIdSchema,
    source: z.enum(["stt", "text_file"]),
    language: z.string().default("ko"),
    /** Masker implementation version, for cache keys and audit. */
    maskerVersion: NonEmptyString,
    segments: z.array(TranscriptSegmentSchema),
    /** Placeholder keys used in the text. Counts only; the values are in the vault. */
    placeholders: z.array(z.strictObject({ key: PlaceholderKeySchema, kind: NonEmptyString, occurrences: z.number().int().positive() })),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.segments.forEach((seg, i) => {
      if (seen.has(seg.id)) ctx.addIssue({ code: "custom", path: ["segments", i, "id"], message: `duplicate segment id ${seg.id}` });
      seen.add(seg.id);
    });
  });
export type MaskedTranscript = z.infer<typeof MaskedTranscriptSchema>;

/** Looks up a segment by ID. Returns undefined when the ID does not exist. */
export function findSegment(transcript: MaskedTranscript, segmentId: string): TranscriptSegment | undefined {
  return transcript.segments.find((s) => s.id === segmentId);
}
