import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { collectRenderWarnings, decodeRenderOutput, encodeRenderOutput, renderDocx, renderHtml, renderMarkdown, RenderOutputStoredSchema, runRender } from "../src/stages/render";
import { failAudit, policyAst, termsAst, vault } from "./fixtures/render/docs";

const dec = new TextDecoder();

/** Minimal unzip via the central directory; returns name -> text. */
function unzipText(zip: Uint8Array): Record<string, string> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let e = zip.length - 22;
  while (dv.getUint32(e, true) !== 0x06054b50) e--;
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true);
    const xl = dv.getUint16(p + 30, true);
    const cl = dv.getUint16(p + 32, true);
    const lo = dv.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nl));
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    out[name] = dec.decode(inflateRawSync(zip.subarray(start, start + csize)));
    p += 46 + nl + xl + cl;
  }
  return out;
}

describe("markdown", () => {
  const md = renderMarkdown(policyAst, { vault });
  test("headings, toc, table, citation, fixed blocks", () => {
    expect(md.startsWith("# 개인정보 처리방침")).toBe(true);
    // rendered: S01 S02 S05 S10 S12 (S08 omitted, S13 n.a.) plus the 목차 heading
    expect(md.match(/^## /gm)?.length).toBe(6);
    expect(md).toContain("[1. 개인정보의 처리 목적](#sec-S01)");
    expect(md).toContain("「개인정보 보호법」 제30조");
    expect(md).toContain("가나다 \\| 클라우드");
    expect(md).toContain("출처: 개인정보보호위원회 「개인정보 처리방침 작성지침」(2026.4.)");
    expect(md).toContain("법률 자문이 아닙니다");
    expect(md).toContain("실행 ID: 20260929-101500-a1b2c3");
  });
  test("omitted and not_applicable sections are absent", () => {
    expect(md).not.toContain("국외 이전");
    expect(md).not.toContain("권익침해");
  });
  test("terms numbering and unknown citation marker", () => {
    const t = renderMarkdown(termsAst);
    expect(t).toContain("## 제1조 (목적)");
    expect(t).toContain("[인용 확인 필요: XXX-1]");
    expect(t).toContain("「약관의 규제에 관한 법률」 제3조");
  });
});

describe("html", () => {
  const html = renderHtml(policyAst, { vault });
  test("lang, no scripts or external assets", () => {
    expect(html).toContain('<html lang="ko">');
    expect(html).not.toMatch(/<script|<link |src="http/i);
  });
  test("toc anchors resolve", () => {
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBe(5);
    for (const h of hrefs) expect(html).toContain(`id="${h}"`);
  });
  test("tables have th scope", () => {
    expect(html).toContain('<th scope="col">수탁자</th>');
    expect(html.match(/<th(?=[ >])(?![^>]*scope)/g)).toBeNull();
  });
  test("safe link", () => {
    expect(html).toContain('<a href="https://example.com/processors">');
  });
});

describe("docx", () => {
  test("zip with document.xml, titles, font, A4, table", async () => {
    const bytes = await renderDocx(policyAst, { vault });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const files = unzipText(bytes);
    const doc = files["word/document.xml"]!;
    expect(doc).toContain("개인정보의 처리 목적");
    expect(doc).toContain("개인정보 처리업무의 위탁");
    expect(doc).toContain("홍길동");
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain('w:w="11906"');
    expect(files["word/styles.xml"]).toContain("맑은 고딕");
  });
  test("terms docx", async () => {
    const files = unzipText(await renderDocx(termsAst));
    expect(files["word/document.xml"]).toContain("제1조 (목적)");
  });
});

describe("rehydration", () => {
  test("resolved values appear, unresolved marked with warnings", () => {
    const md = renderMarkdown(policyAst, { vault });
    expect(md).toContain("홍길동");
    expect(md).toContain("02-000-0000");
    expect(md).toContain("**[미확정: EMAIL_9]**");
    const w = collectRenderWarnings(policyAst, { vault });
    expect(w.some((x) => x.includes("EMAIL_9"))).toBe(true);
    expect(w.some((x) => x.includes("PERSON_1"))).toBe(false);
    expect(w.some((x) => x.includes("S10"))).toBe(true);
  });
  test("no vault leaves everything unresolved", () => {
    const html = renderHtml(policyAst);
    expect(html).toContain('<mark class="unresolved">[미확정: PERSON_1]</mark>');
    expect(html).not.toContain("홍길동");
  });
});

describe("determinism", () => {
  test("same input gives identical bytes (md, html, docx)", async () => {
    expect(renderMarkdown(policyAst, { vault })).toBe(renderMarkdown(policyAst, { vault }));
    expect(renderHtml(termsAst)).toBe(renderHtml(termsAst));
    const a = await renderDocx(policyAst, { vault });
    await new Promise((r) => setTimeout(r, 1100));
    const b = await renderDocx(policyAst, { vault });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
  test("timestamp appears only when injected", () => {
    expect(renderMarkdown(termsAst)).not.toContain("생성일");
    expect(renderMarkdown(termsAst, { generatedAt: "2026-09-30T00:00:00.000Z" })).toContain("생성일: 2026-09-30T00:00:00.000Z");
  });
});

describe("runRender", () => {
  test("files, banner on failed audit, reviewer sheet", async () => {
    const out = await runRender({
      policy: policyAst,
      terms: termsAst,
      options: { vault, changeHistory: [{ date: "2026-10-01", version: "1.0", summary: "최초 제정" }] },
      audits: [failAudit],
      slotEvidence: { "privacy.S02_purposes": ["T0001", "T0004"] },
      openQuestions: ["수탁자 보유 기간 확인"],
    });
    expect(out.files.map((f) => f.name)).toEqual(["privacy-policy.md", "privacy-policy.html", "privacy-policy.docx", "terms.md", "terms.html", "terms.docx", "reviewer-sheet.md", "reviewer-sheet.html"]);
    const get = (n: string) => dec.decode(out.files.find((f) => f.name === n)!.bytes);
    expect(get("privacy-policy.md")).toContain("DRAFT — unresolved findings");
    expect(get("terms.md")).not.toContain("DRAFT — unresolved");
    expect(get("privacy-policy.md")).toContain("변경 이력");
    const sheet = get("reviewer-sheet.md");
    expect(sheet).toContain("omitted_recommended");
    expect(sheet).toContain("T0001, T0004");
    expect(sheet).toContain("보유 기간 근거 부족");
    expect(sheet).toContain("수탁자 보유 기간 확인");
    expect(get("reviewer-sheet.html")).toContain('<html lang="ko">');
    expect(out.warnings.some((w) => w.includes("EMAIL_9"))).toBe(true);
  });
  test("terms not applicable is stated in the sheet", async () => {
    const out = await runRender({ policy: policyAst, termsNotApplicableReason: "내부 HR 시스템" });
    expect(out.files.some((f) => f.name.startsWith("terms"))).toBe(false);
    expect(dec.decode(out.files.find((f) => f.name === "reviewer-sheet.md")!.bytes)).toContain("내부 HR 시스템");
  });
  test("stored codec round-trips", async () => {
    const out = await runRender({ terms: termsAst });
    const stored = RenderOutputStoredSchema.parse(JSON.parse(JSON.stringify(encodeRenderOutput(out))));
    const back = decodeRenderOutput(stored);
    expect(Buffer.from(back.files[2]!.bytes).equals(Buffer.from(out.files[2]!.bytes))).toBe(true);
  });
});
