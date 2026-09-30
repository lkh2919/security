import { describe, expect, test } from "bun:test";
import { CanonicalJsonError, canonicalJson, canonicalJsonPretty, hashJson, sha256Hex } from "../src/pipeline";

describe("canonicalJson / hashJson", () => {
  test("is independent of object key order, at every depth", () => {
    const a = { b: 1, a: { d: [1, { y: 1, x: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [1, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashJson(a)).toBe(hashJson(b));
  });

  test("array order matters", () => {
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
  });

  test("hash is a known stable value (guards against accidental format changes)", () => {
    expect(canonicalJson({ b: [1, null, "x"], a: true })).toBe('{"a":true,"b":[1,null,"x"]}');
    expect(hashJson({ a: 1 })).toBe(sha256Hex('{"a":1}'));
    expect(hashJson({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });

  test("undefined members are omitted, undefined array items become null", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });

  test("Unicode NFC and NFD forms of the same Korean text hash equally", () => {
    const composed = "한글"; // precomposed Hangul syllables
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    expect(hashJson({ text: composed })).toBe(hashJson({ text: decomposed }));
  });

  test("Date values use toJSON; -0 equals 0", () => {
    expect(canonicalJson({ at: new Date("2026-09-29T00:00:00.000Z") })).toBe('{"at":"2026-09-29T00:00:00.000Z"}');
    expect(canonicalJson(-0)).toBe("0");
  });

  test("rejects non-JSON values and cycles", () => {
    expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  test("shared (non-cyclic) references are allowed", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  test("pretty form is valid JSON, sorted, and equal data gives byte-equal output", () => {
    const pretty = canonicalJsonPretty({ b: [1, { z: 1, y: 2 }], a: {} });
    expect(JSON.parse(pretty)).toEqual({ a: {}, b: [1, { y: 2, z: 1 }] });
    expect(pretty.indexOf('"a"')).toBeLessThan(pretty.indexOf('"b"'));
    expect(canonicalJsonPretty({ a: 1, b: 2 })).toBe(canonicalJsonPretty({ b: 2, a: 1 }));
  });
});
