/**
 * STT adapter boundary (design R3 row R1). Vendor implementations are deferred; only the text-file
 * and mock adapters exist. Adapters return RAW text: PII masking happens later in the intake stage,
 * so adapter output must never be sent to an LLM, logged or cached.
 */
export interface SttSegment {
  /** Raw (unmasked) utterance text. */
  readonly text: string;
  /** Raw speaker label if the source provides one (may be a personal name until masked). */
  readonly speaker?: string;
  readonly startMs?: number;
  readonly endMs?: number;
}

export interface SttResult {
  readonly source: "stt" | "text_file";
  readonly language: string;
  readonly segments: readonly SttSegment[];
}

export interface SttTranscribeOptions {
  readonly language?: string;
}

export interface SttAdapter {
  readonly id: string;
  transcribe(file: string, opts?: SttTranscribeOptions): Promise<SttResult>;
}
