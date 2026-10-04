/**
 * Git PII guard: fails when tracked (or staged) files hold personal data patterns.
 *   bun scripts/pii-scan.ts            scan all tracked files
 *   bun scripts/pii-scan.ts --staged   scan staged files (used by .githooks/pre-commit)
 *
 * Flags: Korean mobile numbers other than the placeholder 010-0000-0000, e-mail addresses outside the allowlist,
 * resident-registration-number shapes, and key/token shapes. `packages/core/test/` is synthetic by construction and
 * skipped; golden cases and defects are scanned (their inputs must use the placeholders too), run outputs are not tracked. Landline numbers of public institutions are not flagged. Real names cannot be detected
 * by pattern: replace them with the placeholder name 홍길동 before committing.
 * Enable the hook once per clone: `git config core.hooksPath .githooks`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly kind: "mobile" | "email" | "rrn" | "secret";
  /** Never the matched value, only its shape. */
  readonly hint: string;
}

const SKIP = [/^packages\/core\/test\//, /^golden\/runs\//, /^bun\.lock$/, /\.(png|jpg|docx|zip)$/i];
const EMAIL_OK = /^(privacy|help|git|noreply|security|example|user|name|abc)@(example\.(com|org|net)|lotte\.net|github\.com|abc\.abc|users\.noreply\.github\.com|anthropic\.com)$/i;
const MOBILE = /\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RRN = /\b\d{6}-[1-4]\d{6}\b/g;
const SECRET = /sk-ant-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/g;

export function scanText(file: string, text: string): Violation[] {
  if (SKIP.some((re) => re.test(file))) return [];
  const out: Violation[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(MOBILE)) if (m[0].replace(/\D/g, "") !== "01000000000") out.push({ file, line: i + 1, kind: "mobile", hint: "mobile number other than 010-0000-0000" });
    for (const m of line.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) out.push({ file, line: i + 1, kind: "email", hint: `e-mail at @${m[0].split("@")[1]}` });
    if (RRN.test(line)) out.push({ file, line: i + 1, kind: "rrn", hint: "resident registration number shape" });
    RRN.lastIndex = 0;
    if (SECRET.test(line)) out.push({ file, line: i + 1, kind: "secret", hint: "key or token shape" });
    SECRET.lastIndex = 0;
  });
  return out;
}

export function scanFiles(root: string, files: readonly string[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue; // deleted or unreadable
    }
    if (text.includes("\u0000")) continue; // binary
    out.push(...scanText(f, text));
  }
  return out;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const staged = process.argv.includes("--staged");
  const args = staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"] : ["ls-files"];
  const files = execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const violations = scanFiles(root, files);
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.kind}: ${v.hint}`);
  if (violations.length) {
    console.error(`pii-scan: ${violations.length} finding(s). Replace real values with placeholders (홍길동, 010-0000-0000, privacy@lotte.net).`);
    process.exit(1);
  }
  console.log(`pii-scan: clean (${files.length} files)`);
}
