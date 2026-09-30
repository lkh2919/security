import type { SttAdapter, SttResult, SttTranscribeOptions } from "./types";

/** Test double: returns a fixed result (or a per-file map) and records the requested files. */
export class MockSttAdapter implements SttAdapter {
  readonly id = "mock";
  readonly calls: string[] = [];
  constructor(private readonly result: SttResult | Readonly<Record<string, SttResult>>) {}

  async transcribe(file: string, _opts?: SttTranscribeOptions): Promise<SttResult> {
    this.calls.push(file);
    const r = "segments" in this.result ? (this.result as SttResult) : (this.result as Record<string, SttResult>)[file];
    if (!r) throw new Error(`MockSttAdapter: no canned result for ${file}`);
    return r;
  }
}
