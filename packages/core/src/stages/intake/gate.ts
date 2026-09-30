/**
 * Final PII gate. Deliberately a BROADER net than the maskers rules: it also flags long digit runs,
 * loose email / URL shapes and (when a vault is supplied) every vault value. It throws instead of
 * repairing, and never puts matched values into the error message (only kinds and offsets).
 */
import type { PiiVault } from "../../contracts/pii-vault";
import { findVaultLeaks } from "../../contracts/pii-vault";
import { DEFAULT_PUBLIC_DOMAINS, buildRules, findHits, hostOf, isPublicHost, type PatternOptions } from "./patterns";

export class PiiResidualError extends Error {
  constructor(readonly findings: readonly { kind: string; where: string; offset: number }[]) {
    super(`PII gate failed: ${findings.length} residual finding(s): ${findings.slice(0, 10).map((f) => `${f.kind}@${f.where}:${f.offset}`).join(", ")}`);
    this.name = "PiiResidualError";
  }
}

const PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*_\d+\}\}/g;

const BROAD: { kind: string; re: RegExp }[] = [
  { kind: "LONG_NUMBER", re: /(?<![\d])\d(?:[-.]?\d){9,}(?!\d)/g },
  { kind: "EMAIL_LIKE", re: /[^\s@{}]+@[^\s@{}]+\.[A-Za-z]{2,}/g },
  { kind: "URL_LIKE", re: /\b(?:https?:\/\/|www\.)[^\s]+/gi },
];

export interface GateOptions extends PatternOptions {
  /** When given, any vault value found in the text also fails the gate. */
  vault?: PiiVault;
}

export function findResidualPii(text: string, opts: GateOptions = {}, where = "text"): { kind: string; where: string; offset: number }[] {
  // Blank out placeholders (same length) so offsets stay meaningful and digits inside keys are ignored.
  const t = text.replace(PLACEHOLDER, (m) => " ".repeat(m.length));
  const out: { kind: string; where: string; offset: number }[] = [];
  for (const rule of buildRules(opts)) for (const h of findHits(t, rule)) out.push({ kind: rule.kind, where, offset: h.start });
  for (const b of BROAD) {
    for (const m of t.matchAll(b.re)) {
      // Public URLs stay legal: skip when the host is on the allowlist.
      if (b.kind === "URL_LIKE" && isPublicHost(hostOf(m[0].replace(/^www\./i, "http://www.")), opts.publicDomains ?? DEFAULT_PUBLIC_DOMAINS)) continue;
      out.push({ kind: b.kind, where, offset: m.index ?? 0 });
    }
  }
  if (opts.vault) for (const key of findVaultLeaks(text, opts.vault)) out.push({ kind: `VAULT:${key}`, where, offset: -1 });
  return out;
}

/** Throws `PiiResidualError` if any residual pattern (or vault value) remains in `text`. */
export function assertNoPii(text: string, opts: GateOptions = {}): void {
  const f = findResidualPii(text, opts);
  if (f.length) throw new PiiResidualError(f);
}

/** Gate over many labelled strings (segments, speakers, form values). */
export function assertAllNoPii(items: readonly { where: string; text: string }[], opts: GateOptions = {}): void {
  const f = items.flatMap((i) => findResidualPii(i.text, opts, i.where));
  if (f.length) throw new PiiResidualError(f);
}
