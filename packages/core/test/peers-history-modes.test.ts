import { describe, expect, test } from "bun:test";
import { MemoryFetchState, type PageFetcher, type PageRequest, type PageResult } from "../src/adapters/fetch";
import type { AmendmentDiff } from "../src/contracts/amendment-diff";
import { PeerHistorySchema, PeerRegistrySchema } from "../src/contracts/peers";
import { collapseAlignments, comparePeerHistory, detailKo, detailList, extractElementHtml, fragmentSelector, renderHistoryReport, renderPeerReport, splitArticleKey, withoutFragment } from "../src/stages/peers";
import { patterns, ruleSections } from "./monitor-fixtures";

const FILLER = "회사는 정보주체의 개인정보를 관련 법령에 따라 안전하게 처리하며 필요한 범위에서만 이용하고 목적이 달성되면 지체 없이 처리를 종료합니다." + " 회사는 처리방침을 변경하는 경우 시행 전에 홈페이지를 통하여 공지하며 정보주체의 권리 행사 절차를 안내합니다.";
const policy = (s06: string): string =>
  `<h2>1. 개인정보의 처리 목적</h2><p>회원 가입 및 관리, 서비스 제공을 위하여 개인정보를 처리합니다. ${FILLER}</p><h2>2. 처리하는 개인정보의 항목</h2><p>이름, 이메일 주소를 처리합니다. ${FILLER}</p><h2>3. 개인정보의 파기 절차 및 방법에 관한 사항</h2><p>${s06} ${FILLER}</p>`;
const OLD = policy("보유 기간이 경과한 개인정보는 지체 없이 파기합니다.");
const NEW = policy("개인정보 보호법 제21조에 따라 보유 기간이 경과한 개인정보는 5일 이내에 파기합니다.");

describe("extractElementHtml", () => {
  const html = `<html><body><nav>메뉴</nav><div class="a b" id="x"><p>하나<p>둘<div><span>셋</span></div></div><article id="old" class="pop"><div class="in"><b>넷</b></div></article><script>var s="<div id='old'>";</script><div class="terms">첫째</div><div class="terms">둘째</div></body></html>`;
  test("by id, class, tag.class and descendant chain; nested and unclosed p/li elements are balanced", () => {
    expect(extractElementHtml(html, "#old")).toBe(`<article id="old" class="pop"><div class="in"><b>넷</b></div></article>`);
    expect(extractElementHtml(html, ".terms")).toBe(`<div class="terms">첫째</div>`);
    expect(extractElementHtml(html, "article.pop .in")).toBe(`<div class="in"><b>넷</b></div>`);
    expect(extractElementHtml(html, "div.a.b")).toContain("<span>셋</span></div></div>");
    expect(extractElementHtml(html, "#missing")).toBeNull();
    expect(() => extractElementHtml(html, "div > p")).toThrow();
  });
  test("fragment helpers", () => {
    expect(fragmentSelector("https://e.com/p.do#popupPolicyOld20260728")).toBe("#popupPolicyOld20260728");
    expect(fragmentSelector("https://e.com/p.do")).toBeNull();
    expect(withoutFragment("https://e.com/p.do#x")).toBe("https://e.com/p.do");
  });
});

class Fake implements PageFetcher {
  readonly requests: PageRequest[] = [];
  readonly pages = new Map<string, string>();
  async fetchPage(req: PageRequest): Promise<PageResult> {
    this.requests.push(req);
    const body = this.pages.get(req.select ? `${req.url}|select:${req.select.value}` : req.url);
    return body === undefined ? { status: "failed", reason: "http_404" } : { status: "ok", finalUrl: req.url, httpStatus: 200, body, contentType: "text/html", rendered: req.render === "browser" };
  }
}

const DIFF: AmendmentDiff = {
  law: "PIPA",
  oldVersion: "100",
  newVersion: "101",
  effectiveOn: "2026-09-11",
  hash: "a".repeat(64),
  units: [{ key: "PIPA:21(1)", change: "amended", oldText: "개인정보처리자는 개인정보가 불필요하게 되었을 때에는 지체 없이 그 개인정보를 파기하여야 한다.", newText: "개인정보처리자는 개인정보가 불필요하게 되었을 때에는 5일 이내에 그 개인정보를 파기하고 파기 결과를 기록 보관하여야 한다." }],
};
const entry = (id: string, versions: unknown[]) => ({ peerId: id, name: id, url: `https://${id}.example/privacy`, render: "html", robots: "allowed", status: "active", history: { versions, beforeAmendment: 1, afterAmendment: 0 } });
const run = (f: Fake, peers: unknown[]) =>
  comparePeerHistory({ registry: PeerRegistrySchema.parse({ version: "t", groups: [{ groupId: "retail", nameKo: "유통", lotte: [], peers }] }), fetcher: f, state: new MemoryFetchState(), patterns, diff: DIFF, windowStart: "2026-03-10", asOf: new Date("2026-10-02T00:00:00Z"), ruleSections, lawNames: (p) => (p === "PIPA" ? ["개인정보 보호법"] : []) });

describe("in-page versions", () => {
  test("anchor: one request serves the current block (selector) and the popup block (fragment)", async () => {
    const f = new Fake();
    const page = `<html><body><nav>홈</nav><div class="policy_content_view v2">${NEW}</div><article id="popupPolicyOld20260728" class="lay_pop">${OLD}</article></body></html>`;
    f.pages.set("https://hd.example/p.do", page);
    const r = await run(f, [entry("hd", [{ effectiveDate: "2026-08-18", url: "https://hd.example/p.do", fetch: "anchor", selector: ".policy_content_view.v2" }, { effectiveDate: "2026-07-28", url: "https://hd.example/p.do#popupPolicyOld20260728", fetch: "anchor" }])]);
    expect(f.requests.length).toBe(1);
    expect(f.requests[0]!.url).toBe("https://hd.example/p.do");
    expect(r.peers[0]).toMatchObject({ status: "compared" });
    expect(r.peers[0]!.changedSections?.map((c) => c.sectionId)).toEqual(["S06"]);
    expect(r.peers[0]!.alignments?.[0]).toMatchObject({ articleKey: "PIPA:21(1)", sectionId: "S06" });
  });

  test("anchor: a missing element is a failure; a version without fragment and selector is a failure", async () => {
    const f = new Fake();
    f.pages.set("https://hd.example/p.do", `<div class="cur">${NEW}</div>`);
    const v = (extra: Record<string, unknown>) => ({ effectiveDate: "2026-07-28", url: "https://hd.example/p.do", fetch: "anchor", ...extra });
    const cur = { effectiveDate: "2026-08-18", url: "https://hd.example/p.do", fetch: "anchor", selector: ".cur" };
    const a = await run(f, [entry("hd", [cur, v({ selector: "#gone" })])]);
    expect(a.peers[0]).toMatchObject({ status: "failed" });
    expect(a.peers[0]!.reason).toContain("not found");
    const b = await run(f, [entry("hd", [cur, v({})])]);
    expect(b.peers[0]!.reason).toContain("no #fragment");
  });

  test("same_text: an old version that is really the current text is failed, never 'compared, 0 changes'", async () => {
    const f = new Fake();
    f.pages.set("https://hd.example/p.do", `<div class="cur">${NEW}</div><div id="old">${NEW}</div>`);
    const r = await run(f, [entry("hd", [{ effectiveDate: "2026-08-18", url: "https://hd.example/p.do", fetch: "anchor", selector: ".cur" }, { effectiveDate: "2026-07-28", url: "https://hd.example/p.do#old", fetch: "anchor" }])]);
    expect(r.peers[0]).toMatchObject({ status: "failed" });
    expect(r.peers[0]!.reason).toContain("same_text");
    expect(r.groups[0]).toMatchObject({ compared: 0, failed: 1 });
    expect(r.peers[0]!.changedSections).toBeUndefined();
  });

  test("select: the browser is asked to choose the option and returns the container; the current version comes from the same page by selector", async () => {
    const f = new Fake();
    f.pages.set("https://js.example/privacy.do", `<select><option>a</option></select><div class="terms">${NEW}</div><div class="terms">${OLD}</div>`);
    f.pages.set("https://js.example/privacy.do|select:2026년 6월 23일 개정안", `<div class="terms">${OLD}</div>`);
    const versions = [
      { effectiveDate: "2026-08-11", url: "https://js.example/privacy.do", fetch: "anchor", selector: ".terms" },
      { effectiveDate: "2026-06-23", url: "https://js.example/privacy.do", fetch: "select", select: { selector: ".termsTop>.selectWrap>select", value: "2026년 6월 23일 개정안" }, contentSelector: ".terms" },
    ];
    const r = await run(f, [entry("js", versions)]);
    expect(r.peers[0]).toMatchObject({ status: "compared" });
    expect(r.peers[0]!.changedSections?.map((c) => c.sectionId)).toEqual(["S06"]);
    const sel = f.requests.find((q) => q.select);
    expect(sel).toMatchObject({ render: "browser", select: { selector: ".termsTop>.selectWrap>select", value: "2026년 6월 23일 개정안", contentSelector: ".terms" } });
    expect(f.requests.length).toBe(2);
    // an incomplete select entry fails instead of fetching
    const bad = await run(new Fake(), [entry("js", [versions[0], { ...versions[1], contentSelector: undefined }])]);
    expect(bad.peers[0]).toMatchObject({ status: "failed" });
  });

  test("the schema accepts the new modes", () => {
    expect(PeerHistorySchema.safeParse({ versions: [{ effectiveDate: "2026-01-01", url: "https://pa.example/x", fetch: "select", select: { selector: "select", value: "v" }, contentSelector: ".c" }, { effectiveDate: "2025-01-01", url: "https://pa.example/x#y", fetch: "anchor" }] }).success).toBe(true);
  });
});

describe("report: one row per article", () => {
  test("keys collapse to the article with the 항/호 in a parenthesis", () => {
    expect(splitArticleKey("PIPA:31(4)2")).toEqual({ article: "PIPA:31", detail: "(4)2" });
    expect(splitArticleKey("PIPA:28-8(1)")).toEqual({ article: "PIPA:28-8", detail: "(1)" });
    expect(detailKo("(4)2")).toBe("4항 2호");
    expect(detailKo("")).toBe("");
    expect(detailList(["PIPA:31(10)", "PIPA:31(3)", "PIPA:31(4)2", "PIPA:31(3)"])).toBe("3항, 4항 2호, 10항");
    const c = collapseAlignments([
      { articleKey: "PIPA:31(1)", sectionId: "S18", confidence: "low" as const },
      { articleKey: "PIPA:31(3)", sectionId: "S18", confidence: "medium" as const },
      { articleKey: "PIPA:31(4)2", sectionId: "S18", confidence: "medium" as const },
      { articleKey: "PIPA:21(1)", sectionId: "S06", confidence: "high" as const },
    ]);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ article: "PIPA:31", sectionId: "S18", confidence: "medium", details: "3항, 4항 2호" });
  });

  test("history report: one k/n row per article and section, each changed section once per peer, labels and disclaimer kept", async () => {
    const f = new Fake();
    const many = Array.from({ length: 6 }, (_, i) => ({ key: `PIPA:31(${i + 1})`, change: "amended" as const, oldText: "이전 문장입니다 하나", newText: "개인정보 보호책임자의 성명 또는 개인정보 업무 담당부서 및 고충사항을 처리하는 부서에 관한 사항을 공개한다 보호책임자 지정 업무" }));
    const diff = { ...DIFF, units: [...DIFF.units, ...many] };
    const cite = policy("개인정보 보호법 제31조제3항 및 제31조제4항에 따라 개인정보 보호책임자의 성명, 개인정보 업무 담당부서 및 고충사항을 처리하는 부서를 공개합니다.");
    f.pages.set("https://pa.example/new", NEW);
    f.pages.set("https://pa.example/old", OLD);
    f.pages.set("https://pb.example/new", cite);
    f.pages.set("https://pb.example/old", OLD);
    const mk = (n: string) => entry(n, [{ effectiveDate: "2026-08-18", url: `https://${n}.example/new`, fetch: "http" }, { effectiveDate: "2026-07-28", url: `https://${n}.example/old`, fetch: "http" }]);
    const reg = PeerRegistrySchema.parse({ version: "t", groups: [{ groupId: "retail", nameKo: "유통", lotte: [], peers: [mk("pa"), mk("pb")] }] });
    const result = await comparePeerHistory({ registry: reg, fetcher: f, state: new MemoryFetchState(), patterns, diff, windowStart: "2026-03-10", asOf: new Date("2026-10-02T00:00:00Z"), ruleSections, lawNames: (p) => (p === "PIPA" ? ["개인정보 보호법"] : []) });
    const md = renderHistoryReport({ result, tenantId: "t", date: "2026-10-02", amendment: { oldMst: "100", newMst: "101", promulgatedOn: "2026-03-10", promulgationNo: "1", howFound: "x" } });
    expect(md).toContain("업계 동향(참고) — 법적 요구사항 아님");
    expect(md).toContain("참고용 검토 결과입니다");
    expect(md).toContain("co-occurred, not caused by");
    // no per-항 rows: every PIPA key is shown as an article, units only inside a parenthesis
    expect(md).not.toMatch(/PIPA:\d+\(\d+\)/);
    const rows = md.split("\n").filter((l) => l.startsWith("| ") && l.includes("PIPA:31"));
    const bySection = new Set(rows.map((l) => l.split("|")[3]));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(bySection.size);
    expect(rows.every((l) => /PIPA:31 \(\d+항/.test(l))).toBe(true);
    // each changed section is listed once per peer
    for (const block of md.split(/\n(?=- 유통 · )/).slice(1)) {
      const lines = block.split("\n").filter((l) => l.startsWith("  - S"));
      const ids = lines.map((l) => /^ {2}- (S\d+|\w+)/.exec(l)![1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("daily report lists one line per article and section", () => {
    const md = renderPeerReport({
      date: "2026-10-02",
      tenantId: "t",
      registry: PeerRegistrySchema.parse({ version: "t", groups: [{ groupId: "retail", nameKo: "유통", lotte: [], peers: [] }] }),
      outcomes: [{ id: "pa", groupId: "retail", name: "에이", kind: "peer", status: "changed", changedSections: [{ sectionId: "S18", kind: "modified", quote: "x" }] }],
      signals: { peerAligned: [{ peerId: "pa", alignments: [{ articleKey: "PIPA:31(3)", sectionId: "S18", confidence: "medium", basis: "new_terms" }, { articleKey: "PIPA:31(4)2", sectionId: "S18", confidence: "medium", basis: "new_terms" }] }], groupAdoption: [] } as never,
    });
    const lines = md.split("\n").filter((l) => l.includes("PIPA:31"));
    expect(lines).toEqual(["- 에이: PIPA:31 (3항, 4항 2호) / S18 (신뢰도 중간)"]);
  });
});
