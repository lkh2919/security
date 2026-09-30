/**
 * Canonical JSON and hashing. Stable across key order, runtime, and Unicode normalization form.
 *
 * Rules:
 *  - object keys sorted by UTF-16 code unit order; `undefined` object members are omitted;
 *  - `undefined` array elements serialize as `null` (same as JSON.stringify);
 *  - strings and keys are normalized to Unicode NFC (Korean text from different sources may be NFD);
 *  - non-finite numbers, bigint, functions, symbols, and cycles throw;
 *  - values with a `toJSON` method (Date) are converted first.
 */
import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {}

type Ancestors = Set<object>;

function nfc(text: string): string {
  return text.normalize("NFC");
}

function write(value: unknown, indent: number, depth: number, ancestors: Ancestors): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number: ${value}`);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(nfc(value));
    case "undefined":
      throw new CanonicalJsonError("undefined is not a JSON value at the root");
    case "bigint":
    case "function":
    case "symbol":
      throw new CanonicalJsonError(`unsupported value type: ${typeof value}`);
  }

  const obj = value as object;
  if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
    const converted = (obj as { toJSON: () => unknown }).toJSON();
    if (converted === undefined) throw new CanonicalJsonError("toJSON returned undefined");
    return write(converted, indent, depth, ancestors);
  }
  if (ancestors.has(obj)) throw new CanonicalJsonError("cycle detected");
  ancestors.add(obj);

  const pad = indent > 0 ? "\n" + " ".repeat(indent * (depth + 1)) : "";
  const closePad = indent > 0 ? "\n" + " ".repeat(indent * depth) : "";
  const colon = indent > 0 ? ": " : ":";
  let out: string;

  if (Array.isArray(obj)) {
    const items = obj.map((item) => (item === undefined ? "null" : write(item, indent, depth + 1, ancestors)));
    out = items.length === 0 ? "[]" : `[${pad}${items.join("," + pad)}${closePad}]`;
  } else {
    const entries: Array<[string, string]> = [];
    for (const key of Object.keys(obj)) {
      const member = (obj as Record<string, unknown>)[key];
      if (member === undefined) continue;
      entries.push([nfc(key), write(member, indent, depth + 1, ancestors)]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][0] === entries[i - 1][0]) throw new CanonicalJsonError(`duplicate key after normalization: ${entries[i][0]}`);
    }
    out = entries.length === 0 ? "{}" : `{${pad}${entries.map(([k, v]) => JSON.stringify(k) + colon + v).join("," + pad)}${closePad}}`;
  }
  ancestors.delete(obj);
  return out;
}

/** Compact canonical JSON used for hashing. */
export function canonicalJson(value: unknown): string {
  return write(value, 0, 0, new Set());
}

/** Pretty (2-space) canonical JSON used for artifact files, so equal data gives byte-equal files. */
export function canonicalJsonPretty(value: unknown): string {
  return write(value, 2, 0, new Set()) + "\n";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of the canonical JSON form of `value`. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
