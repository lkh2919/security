import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { scanFiles, scanText } from "../../../scripts/pii-scan";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("PII guard", () => {
  test("flags mobile numbers, personal e-mails, RRN shapes and tokens, but not placeholders", () => {
    const kinds = (t: string) => scanText("docs/x.md", t).map((v) => v.kind);
    expect(kinds("전화 010-1234-5678")).toEqual(["mobile"]);
    expect(kinds("전화 01012345678")).toEqual(["mobile"]);
    expect(kinds("메일 kim.cs@corp.co.kr")).toEqual(["email"]);
    expect(kinds("주민 900101-1234567")).toEqual(["rrn"]);
    expect(kinds("key sk-ant-abcdefghijklmnop")).toEqual(["secret"]);
    expect(kinds("010-0000-0000 privacy@lotte.net help@example.com 02-750-0000 홍길동")).toEqual([]);
  });

  test("findings never echo the matched value", () => {
    const v = scanText("kb/a.json", "kim.cs@corp.co.kr 010-1234-5678");
    expect(JSON.stringify(v)).not.toContain("kim.cs");
    expect(JSON.stringify(v)).not.toContain("1234-5678");
  });

  test("unit-test fixtures and untracked run outputs are exempt; golden cases are scanned", () => {
    expect(scanText("packages/core/test/x.ts", "010-1234-5678")).toEqual([]);
    expect(scanText("golden/runs/x/G1.terms.json", "kim@corp.co.kr")).toEqual([]);
    expect(scanText("golden/cases/G1/x.txt", "kim@corp.co.kr").map((v) => v.kind)).toEqual(["email"]);
  });

  test("every tracked file in the repository is clean", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(scanFiles(ROOT, files)).toEqual([]);
  });
});
