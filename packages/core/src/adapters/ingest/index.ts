/**
 * Policy ingest adapters (Policy Monitor design M5): Markdown and HTML -> plain text with paragraph offsets.
 * DOCX and PDF are not read in A1: `parsePolicySource` reports them as unsupported so the caller fails closed.
 */
import { createHash } from "node:crypto";
import type { IngestFormat } from "../../contracts/ingested-policy";
import { stripInvisible } from "./clean";
import { parseHtml } from "./html";
import { parseMarkdown } from "./markdown";
import { IngestError, MAX_INGEST_BYTES, type ParsedDocument } from "./types";

export * from "./types";
export * from "./clean";
export { parseHtml, isHiddenElement } from "./html";
export { parseMarkdown, stripInlineMarkdown } from "./markdown";

export function detectFormat(name: string): IngestFormat {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  return "unknown";
}

export const sha256OfBytes = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export interface ParsedSource {
  readonly format: IngestFormat;
  readonly sha256: string;
  /** False for formats A1 does not read; `doc` is then empty and carries the warning. */
  readonly supported: boolean;
  readonly doc: ParsedDocument;
}

export const UNSUPPORTED_WARNING = (format: IngestFormat): string =>
  `${format.toUpperCase()} files are not supported in A1; manual review required (수동 검토 필요)`;

/** Parses raw bytes. Throws `IngestError` over the byte cap or for an empty file; DOCX/PDF/unknown return `supported: false`. */
export function parsePolicySource(name: string, content: Uint8Array | string): ParsedSource {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (bytes.byteLength > MAX_INGEST_BYTES) throw new IngestError("TOO_LARGE", `source is ${bytes.byteLength} bytes; the cap is ${MAX_INGEST_BYTES}`);
  if (bytes.byteLength === 0) throw new IngestError("EMPTY", "source is empty");
  const format = detectFormat(name);
  const sha256 = sha256OfBytes(bytes);
  if (format !== "md" && format !== "html") {
    return { format, sha256, supported: false, doc: { text: "", paras: [], warnings: [UNSUPPORTED_WARNING(format)] } };
  }
  const text = stripInvisible(new TextDecoder("utf-8").decode(bytes)).replace(/^﻿/, "");
  return { format, sha256, supported: true, doc: format === "md" ? parseMarkdown(text) : parseHtml(text) };
}
