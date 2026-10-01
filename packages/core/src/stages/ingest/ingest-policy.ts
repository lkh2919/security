/**
 * Source bytes -> IngestedPolicy (Policy Monitor design M5): parse (Markdown / HTML), mask contacts, segment. Fails closed:
 * an unsupported, empty or oversized source becomes `status: "needs_manual_review"` with a warning, never an empty "clean" policy.
 */
import { IngestError, MAX_INGEST_BYTES, detectFormat, parsePolicySource, sha256OfBytes } from "../../adapters/ingest";
import { IngestedPolicySchema, PolicyIdSchema, type IngestedPolicy } from "../../contracts/ingested-policy";
import { segmentDocument, type HeadingPatterns } from "./segment-policy";

export interface IngestRequest {
  /** Registry key; derived from the file name when omitted. */
  readonly policyId?: string;
  /** File name (extension decides the format). */
  readonly name: string;
  readonly content: Uint8Array | string;
  readonly path?: string;
  readonly url?: string;
  readonly fetchedAt?: Date;
}

/** `acme-privacy.md` -> `acme-privacy`; a name without usable ASCII characters becomes `policy-<sha8>`. */
export function policyIdFor(name: string, sha256: string): string {
  const stem = name.replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]+$/, "");
  const id = stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);
  return PolicyIdSchema.safeParse(id).success ? id : `policy-${sha256.slice(0, 8)}`;
}

export function ingestPolicy(req: IngestRequest, patterns: HeadingPatterns): IngestedPolicy {
  const fetchedAt = (req.fetchedAt ?? new Date()).toISOString();
  const bytes = typeof req.content === "string" ? Buffer.from(req.content, "utf8") : req.content;
  const sha256 = sha256OfBytes(bytes);
  const policyId = req.policyId ?? policyIdFor(req.name, sha256);
  const base = { policyId, docType: "privacy" as const, source: { ...(req.path ? { path: req.path } : {}), ...(req.url ? { url: req.url } : {}), sha256, format: detectFormat(req.name), fetchedAt } };
  const manual = (warning: string): IngestedPolicy => IngestedPolicySchema.parse({ ...base, status: "needs_manual_review", sections: [], text: "", warnings: [warning] });

  let parsed;
  try {
    parsed = parsePolicySource(req.name, bytes);
  } catch (err) {
    if (err instanceof IngestError) return manual(err.code === "TOO_LARGE" ? `source exceeds the ${MAX_INGEST_BYTES}-byte cap; manual review required (수동 검토 필요)` : "source is empty; manual review required (수동 검토 필요)");
    throw err;
  }
  if (!parsed.supported) return manual(parsed.doc.warnings[0] ?? "unsupported format; manual review required");
  if (parsed.doc.paras.length === 0) return manual("no text could be extracted; manual review required (수동 검토 필요)");
  const seg = segmentDocument(parsed.doc, patterns);
  return IngestedPolicySchema.parse({ ...base, source: { ...base.source, format: parsed.format }, status: "ok", sections: seg.sections, text: seg.text, warnings: seg.warnings });
}
