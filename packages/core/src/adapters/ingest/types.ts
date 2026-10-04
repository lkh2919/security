/**
 * Shared shapes of the policy ingest adapters (Policy Monitor design M5): a source document becomes plain text plus
 * paragraph offsets. Adapters are pure and never touch the network or the file system.
 */

/** Byte cap of one policy source (design M6.1). Larger input is refused, not truncated. */
export const MAX_INGEST_BYTES = 2 * 1024 * 1024;

export interface ParsedPara {
  readonly text: string;
  /** Half-open offsets into `ParsedDocument.text`. */
  readonly span: { readonly start: number; readonly end: number };
  /** `heading`: h1-h6, a `#` line or a line that is only bold; `row`: one table row. */
  readonly kind: "heading" | "para" | "row";
  /** Heading level 1-6; 0 when unknown (bold-only line). */
  readonly level?: number;
  readonly cells?: readonly string[];
  /** Table header row. */
  readonly header?: boolean;
}

export interface ParsedDocument {
  /** Paragraph texts joined by "\n". */
  readonly text: string;
  readonly paras: readonly ParsedPara[];
  readonly warnings: readonly string[];
}

/** Paragraph draft before offsets are assigned. */
export interface ParaDraft {
  readonly text: string;
  readonly kind: ParsedPara["kind"];
  readonly level?: number;
  readonly cells?: readonly string[];
  readonly header?: boolean;
}

export type IngestErrorCode = "TOO_LARGE" | "EMPTY";

/** Thrown when a source cannot be ingested at all; callers turn it into a manual-review result. */
export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
  ) {
    super(`[INGEST_${code}] ${message}`);
    this.name = "IngestError";
  }
}

/** Assigns offsets: paragraphs are joined by a single "\n". Empty drafts are dropped. */
export function layoutParas(drafts: readonly ParaDraft[], warnings: readonly string[]): ParsedDocument {
  const paras: ParsedPara[] = [];
  let offset = 0;
  const parts: string[] = [];
  for (const d of drafts) {
    if (d.text.length === 0) continue;
    if (parts.length > 0) offset += 1;
    paras.push({ text: d.text, span: { start: offset, end: offset + d.text.length }, kind: d.kind, ...(d.level !== undefined ? { level: d.level } : {}), ...(d.cells ? { cells: d.cells } : {}), ...(d.header ? { header: true } : {}) });
    parts.push(d.text);
    offset += d.text.length;
  }
  return { text: parts.join("\n"), paras, warnings };
}
