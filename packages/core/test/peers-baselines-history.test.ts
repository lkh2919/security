import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFetchState, type PageFetcher, type PageRequest, type PageResult } from "../src/adapters/fetch";
import type { LawVersion } from "../src/adapters/lawapi";
import type { AmendmentDiff } from "../src/contracts/amendment-diff";
import { PEER_SIGNAL_LABEL, PeerBaselineSchema, PeerRegistrySchema, type PeerRegistry } from "../src/contracts/peers";
import {
  BaselineStore,
  SnapshotStore,
  baselineAsPrev,
  baselineFromPolicy,
  buildChangeEvent,
  comparePeerHistory,
  diffNormalized,
  exportBaselines,
  extractEffectiveDateText,
  isoDateOf,
  neutralizeDates,
  normalizePolicyHtml,
  previousVersionOf,
  renderHistoryReport,
  resolveAmendment,
  watchPeers,
  type NormalizedPolicy,
} from "../src/stages/peers";
import { NOW, patterns, readFixture, ruleSections } from "./monitor-fixtures";

const FILLER = "회사는 정보주체의 개인정보를 관련 법령에 따라 안전하게 처리하며 필요한 범위에서만 이용하고 목적이 달성되면 지체 없이 처리를 종료합니다.";
const SECTIONS: Record<string, { title: string; body: string[] }> = {
  S02: { title: "개인정보의 처리 목적", body: [`회원 가입 및 관리, 서비스 제공을 위하여 개인정보를 처리합니다. ${FILLER}`] },
  S03: { title: "처리하는 개인정보의 항목", body: [`이름, 이메일 주소, 배송지 주소를 처리합니다. ${FILLER}`] },
  S05: { title: "개인정보의 처리 및 보유 기간", body: [`회원 정보는 회원 탈퇴 시까지 보유합니다. ${FILLER}`] },
  S06: { title: "개인정보의 파기 절차 및 방법에 관한 사항", body: [`보유 기간이 경과한 개인정보는 지체 없이 파기합니다. ${FILLER}`] },
  S09: { title: "개인정보 처리업무의 위탁에 관한 사항", body: [`배송과 전산 운영을 위탁하며 위탁받은 자를 공개합니다. ${FILLER}`] },
  S11: { title: "개인정보의 안전성 확보조치에 관한 사항", body: [`내부관리계획 수립, 접근 권한 관리, 암호화를 시행합니다. ${FILLER}`] },
};

interface PageOpts {
  edit?: Record<string, string[]>;
  /** Date lines: appended to the preamble and S11 (시행일 line + an inline date). */
  date?: string;
}
function page(o: PageOpts = {}): string {
  const blocks = Object.entries(SECTIONS).map(([id, s], i) => {
    let body = o.edit?.[id] ?? s.body;
    if (o.date && id === "S11") body = [...body, `이 방침은 ${o.date}부터 시행합니다.`, `시행일자: ${o.date}`];
    return `<h2>${i + 1}. ${s.title}</h2>${body.map((p) => `<p>${p}</p>`).join("")}`;
  });
  return `<html><body><nav>홈 | 로그인</nav><h1>예시 개인정보 처리방침</h1><p>예시회사는 개인정보 보호법에 따라 처리방침을 공개합니다.</p>${blocks.join("")}<footer>고객센터 02-1234-5678</footer></body></html>`;
}
const norm = (html: string): NormalizedPolicy => {
  const r = normalizePolicyHtml(html, patterns);
  expect(r.unusable).toBeNull();
  return r.policy;
};

class FakeFetcher implements PageFetcher {
  readonly requests: PageRequest[] = [];
  readonly pages = new Map<string, string | PageResult>();
  async fetchPage(req: PageRequest): Promise<PageResult> {
    this.requests.push(req);
    const p = this.pages.get(req.url);
    if (p === undefined) return { status: "failed", reason: "http_404" };
    if (typeof p !== "string") return p;
    return { status: "ok", finalUrl: req.url, httpStatus: 200, body: p, contentType: "text/html", rendered: req.render === "browser" };
  }
}

// --- date neutralization (design C5 P0) -----------------------------------------------------------------------------------------

describe("date-only edits are cosmetic", () => {
  test("neutralizeDates handles the three date notations and drops 시행일/공고일 lines", () => {
    expect(neutralizeDates("2024.01.01부터 적용")).toBe("<DATE>부터 적용");
    expect(neutralizeDates("2024. 1. 1. 개정")).toBe("<DATE> 개정");
    expect(neutralizeDates("2024-01-01에 시행")).toBe("<DATE>에 시행");
    expect(neutralizeDates("2024년 1월 1일부터 시행합니다")).toBe("<DATE>부터 시행합니다");
    expect(neutralizeDates("시행일자: 2024.01.01")).toBe("");
    expect(neutralizeDates("공고일 : 2024년 1월 1일 / 시행일: 2024-01-08")).toBe("");
    expect(neutralizeDates("[시행일] 2024.01.01")).toBe("");
    expect(neutralizeDates("시행일자 안내는 별도 공지합니다")).toBe("시행일자 안내는 별도 공지합니다"); // no date: kept
    expect(neutralizeDates("보유 기간은 3년입니다")).toBe("보유 기간은 3년입니다");
  });

  test("a section that differs only by dates keeps its stored text and hash but compares equal", () => {
    const a = norm(page({ date: "2025년 3월 1일" }));
    const b = norm(page({ date: "2026-09-11" }));
    expect(a.contentSha256).not.toBe(b.contentSha256); // stored text differs
    expect(a.text).not.toBe(b.text);
    expect(a.text).toContain("2025년 3월 1일");
    expect(a.neutralContentSha256).toBe(b.neutralContentSha256);
    expect(diffNormalized(a, b)).toEqual([]);
    expect(buildChangeEvent({ peerId: "acme", groupId: "retail", detectedAt: NOW, prev: a, next: b })).toBeNull(); // not a change at all
    const ev = buildChangeEvent({ peerId: "acme", groupId: "retail", detectedAt: NOW, prev: a, next: b, rawChanged: true })!; // the raw page differs
    expect(ev.cosmeticOnly).toBe(true);
    expect(ev.changedSections).toEqual([]);
  });

  test("a real edit together with a date change is still a modified section", () => {
    const a = norm(page({ date: "2025.03.01" }));
    const b = norm(page({ date: "2026.09.11", edit: { S06: [`보유 기간이 경과한 개인정보는 7일 이내에 파기합니다. ${FILLER}`] } }));
    const changed = diffNormalized(a, b);
    expect(changed.map((c) => c.sectionId)).toEqual(["S06"]);
    expect(changed[0]!.quote).toContain("7일");
  });

  test("the effective date is read from a 시행일 line", () => {
    expect(extractEffectiveDateText("공고일자: 2025.02.01\n시행일자: 2025년 3월 1일\n")).toBe("2025년 3월 1일");
    expect(extractEffectiveDateText("본 방침은 2025. 3. 1.부터 시행합니다.")).toBe("2025. 3. 1.");
    expect(extractEffectiveDateText("날짜 없음")).toBeUndefined();
  });
});

// --- baselines --------------------------------------------------------------------------------------------------------------------

describe("hash-only baselines", () => {
  const p = norm(page({ date: "2025년 3월 1일" }));
  const tmp = (): string => join(mkdtempSync(join(tmpdir(), "baselines-")), "baselines");

  test("save and load round-trip; the file holds hashes only (no policy text, no quotes)", async () => {
    const store = new BaselineStore(tmp());
    expect(store.load("acme-retail")).toBeNull();
    expect(await store.save(baselineFromPolicy("acme-retail", "https://a.example/p", "2026-10-02T00:00:00.000Z", p))).toBe(true);
    const loaded = store.load("acme-retail")!;
    expect(PeerBaselineSchema.safeParse(loaded).success).toBe(true);
    expect(loaded.contentSha256).toBe(p.contentSha256);
    expect(loaded.neutralContentSha256).toBe(p.neutralContentSha256);
    expect(loaded.sections.map((s) => s.sectionId)).toEqual(p.sections.map((s) => s.sectionId));
    expect(loaded.effectiveDateText).toBe("2025년 3월 1일");
    const raw = readFileSync(join(store.dir, "acme-retail.json"), "utf8");
    expect(raw).not.toContain("개인정보를 처리합니다");
    expect(raw).not.toContain("파기");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["contentSha256", "effectiveDateText", "fetchedAt", "neutralContentSha256", "peerId", "sections", "url"]);
  });

  test("the same content is not rewritten (no churn on fetchedAt); changed content is", async () => {
    const store = new BaselineStore(tmp());
    await store.save(baselineFromPolicy("acme-retail", "https://a.example/p", "2026-10-02T00:00:00.000Z", p));
    expect(await store.save(baselineFromPolicy("acme-retail", "https://a.example/p", "2026-10-09T00:00:00.000Z", p))).toBe(false);
    expect(store.load("acme-retail")!.fetchedAt).toBe("2026-10-02T00:00:00.000Z");
    const q = norm(page({ edit: { S06: [`보유 기간이 경과한 개인정보는 7일 이내에 파기합니다. ${FILLER}`] } }));
    expect(await store.save(baselineFromPolicy("acme-retail", "https://a.example/p", "2026-10-09T00:00:00.000Z", q))).toBe(true);
    expect(await store.list()).toEqual(["acme-retail"]);
  });

  test("an invalid baseline file fails loudly instead of acting as a first snapshot", () => {
    const dir = tmp();
    const store = new BaselineStore(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad-peer.json"), "{}");
    expect(() => store.load("bad-peer")).toThrow("PEER_BASELINE");
  });

  test("a baseline is a usable previous side: a real edit is found with the quote from the new text, a date-only edit is no change", () => {
    const prev = baselineAsPrev(baselineFromPolicy("acme-retail", "https://a.example/p", "2026-10-02T00:00:00.000Z", p));
    const edited = norm(page({ date: "2025년 3월 1일", edit: { S06: [`보유 기간이 경과한 개인정보는 7일 이내에 파기합니다. ${FILLER}`] } }));
    const ev = buildChangeEvent({ peerId: "acme-retail", groupId: "retail", detectedAt: NOW, prev, next: edited })!;
    expect(ev.cosmeticOnly).toBe(false);
    expect(ev.changedSections).toEqual([{ sectionId: "S06", kind: "modified", quote: expect.stringContaining("7일") }]);
    const dated = norm(page({ date: "2026-09-11" }));
    expect(buildChangeEvent({ peerId: "acme-retail", groupId: "retail", detectedAt: NOW, prev, next: dated })).toBeNull();
    // removed section without previous text: empty quote, still reported
    const without = norm(page().replace(/<h2>4\..*?<\/p>/, ""));
    const plain = baselineAsPrev(baselineFromPolicy("acme-retail", "https://a.example/p", "2026-10-02T00:00:00.000Z", norm(page())));
    expect(diffNormalized(plain, without)).toEqual([{ sectionId: "S06", kind: "removed", quote: "" }]);
  });

  test("exportBaselines writes one baseline per local snapshot and skips peers without one", async () => {
    const snaps = new SnapshotStore(join(mkdtempSync(join(tmpdir(), "snaps-")), "snapshots"));
    await snaps.write({ peerId: "acme-retail", url: "https://a.example/p", fetchedAt: "2026-10-02T01:00:00.000Z", contentSha256: p.contentSha256, sections: [], render: "html", status: "ok" }, p.text);
    const store = new BaselineStore(tmp());
    const r = await exportBaselines(snaps, store, await snaps.peerIds());
    expect(r).toEqual({ written: ["acme-retail"], unchanged: [], missing: [] });
    expect(store.load("acme-retail")!.contentSha256).toBe(p.contentSha256);
    expect(await exportBaselines(snaps, store, ["acme-retail", "nobody"])).toEqual({ written: [], unchanged: ["acme-retail"], missing: ["nobody"] });
  });
});

describe("watchPeers with a committed baseline", () => {
  const REGISTRY: PeerRegistry = PeerRegistrySchema.parse({
    version: "t",
    groups: [{ groupId: "retail", nameKo: "유통", lotte: [], peers: [{ peerId: "peer-1", name: "가나다", url: "https://peer1.example/privacy", render: "html", robots: "allowed", status: "active" }] }],
  });
  const dirs = () => {
    const base = mkdtempSync(join(tmpdir(), "wp-"));
    return { baselinesDir: join(base, "baselines"), fresh: () => join(mkdtempSync(join(tmpdir(), "wp-run-")), "runs", "acme", "peers") };
  };
  const run = (peersDir: string, baselinesDir: string, html: string, day: string, dryRun = false) => {
    const f = new FakeFetcher();
    f.pages.set("https://peer1.example/privacy", html);
    return watchPeers({ registry: REGISTRY, captures: [], fetcher: f, state: new MemoryFetchState(), patterns, peersDir, baselinesDir, tenantId: "acme", includeLotte: false, dryRun, now: () => new Date(`${day}T09:00:00.000Z`) });
  };

  test("first snapshot writes the baseline; a fresh container with the baseline sees 'unchanged', not a first snapshot", async () => {
    const d = dirs();
    const r1 = await run(d.fresh(), d.baselinesDir, page(), "2026-10-02");
    expect(r1.outcomes.find((o) => o.id === "peer-1")?.status).toBe("baseline");
    expect(readdirSync(d.baselinesDir)).toEqual(["peer-1.json"]);
    const r2 = await run(d.fresh(), d.baselinesDir, page(), "2026-10-03"); // new runs/ folder: the local snapshot is gone
    expect(r2.outcomes.find((o) => o.id === "peer-1")?.status).toBe("unchanged");
  });

  test("a real change against the baseline-only previous side is reported with a quote and updates the baseline; a date-only edit does not", async () => {
    const d = dirs();
    await run(d.fresh(), d.baselinesDir, page({ date: "2025.03.01" }), "2026-10-02");
    const store = new BaselineStore(d.baselinesDir);
    const before = store.load("peer-1")!;

    const dated = await run(d.fresh(), d.baselinesDir, page({ date: "2026.09.11" }), "2026-10-03");
    expect(dated.outcomes.find((o) => o.id === "peer-1")?.status).toBe("unchanged"); // dates only: not a change
    expect(store.load("peer-1")!.contentSha256).toBe(before.contentSha256);

    const dry = await run(d.fresh(), d.baselinesDir, page({ edit: { S06: [`파기는 7일 이내에 합니다. ${FILLER}`] } }), "2026-10-04", true);
    expect(dry.outcomes.find((o) => o.id === "peer-1")?.status).toBe("changed");
    expect(store.load("peer-1")!.contentSha256).toBe(before.contentSha256); // dry run writes nothing

    const real = await run(d.fresh(), d.baselinesDir, page({ edit: { S06: [`파기는 7일 이내에 합니다. ${FILLER}`] } }), "2026-10-05");
    const o = real.outcomes.find((x) => x.id === "peer-1")!;
    expect(o.status).toBe("changed");
    expect(o.changedSections?.[0]).toMatchObject({ sectionId: "S06", kind: "modified" });
    expect(o.changedSections?.[0]?.quote).toContain("7일");
    expect(store.load("peer-1")!.contentSha256).not.toBe(before.contentSha256);
  });
});

// --- history ----------------------------------------------------------------------------------------------------------------------

const DIFF: AmendmentDiff = {
  law: "PIPA",
  oldVersion: "100",
  newVersion: "101",
  effectiveOn: "2026-10-30",
  hash: "a".repeat(64),
  units: [{ key: "PIPA:21(1)", change: "amended", oldText: "개인정보처리자는 개인정보가 불필요하게 되었을 때에는 지체 없이 그 개인정보를 파기하여야 한다.", newText: "개인정보처리자는 개인정보가 불필요하게 되었을 때에는 5일 이내에 그 개인정보를 파기하고 파기 결과를 기록 보관하여야 한다." }],
};
const lawNames = (p: string): string[] => (p === "PIPA" ? ["개인정보 보호법", "개인정보보호법"] : []);
const CITES = [`개인정보 보호법 제21조에 따라 보유 기간이 경과한 개인정보는 지체 없이 파기합니다. ${FILLER}`];
const QUOTES = [`개인정보가 불필요하게 되었을 때에는 5일 이내에 그 개인정보를 파기하고 파기 결과를 기록 보관합니다. ${FILLER}`];
const UNRELATED = [`내부관리계획 수립, 접근 권한 관리, 암호화를 시행하고 점검 주기를 늘렸습니다. ${FILLER}`];

const hv = (n: string, date: string, fetch: "http" | "browser" | "form" = "http") => ({ effectiveDate: date, url: `https://${n}.example/privacy/${date}`, fetch });
const hist = (n: string, extra: Record<string, unknown> = {}) => ({ currentEffectiveDate: "2026-10-30", versions: [hv(n, "2025-01-01"), hv(n, "2026-10-30")], beforeAmendment: 0, afterAmendment: 1, note: "", ...extra });
const peer = (id: string, history?: unknown) => ({ peerId: id, name: `피어${id}`, url: `https://${id}.example/privacy`, render: "html", robots: "allowed", status: "active", ...(history === undefined ? {} : { history }) });

const HREG: PeerRegistry = PeerRegistrySchema.parse({
  version: "t",
  groups: [
    {
      groupId: "retail",
      nameKo: "유통",
      lotte: [],
      peers: [
        peer("p1", hist("p1")), // cites the article
        peer("p2", hist("p2")), // quotes the new wording
        peer("p3", hist("p3", { versions: [hv("p3", "2025-01-01"), hv("p3", "2026-10-30", "browser")] })), // unrelated change
        peer("p4", hist("p4")), // identical pages
        peer("p5", hist("p5", { afterAmendment: null, note: "개정 후 갱신 없음" })),
        peer("p6", hist("p6", { versions: [hv("p6", "2025-01-01"), hv("p6", "2026-10-30", "form")] })),
        peer("p7"), // no history field
        peer("p8", hist("p8", { versions: [] })),
        peer("p9", hist("p9", { beforeAmendment: 1, afterAmendment: 1 })),
        { ...peer("px"), status: "excluded" },
      ],
    },
    { groupId: "food", nameKo: "식품", lotte: [], peers: [peer("f1", hist("f1")), peer("f2", hist("f2"))] },
  ],
});

function historyFetcher(): FakeFetcher {
  const f = new FakeFetcher();
  const set = (n: string, before: string, after: string, afterBrowser = false) => {
    f.pages.set(`https://${n}.example/privacy/2025-01-01`, before);
    f.pages.set(`https://${n}.example/privacy/2026-10-30`, after);
    void afterBrowser;
  };
  set("p1", page(), page({ edit: { S06: CITES } }));
  set("p2", page(), page({ edit: { S06: QUOTES } }));
  set("p3", page(), page({ edit: { S11: UNRELATED } }));
  set("p4", page({ date: "2025-01-01" }), page({ date: "2026-10-30" })); // date-only: cosmetic
  set("f1", page(), page({ edit: { S06: CITES } }));
  set("f2", page(), page());
  return f;
}

const base = (f: PageFetcher, over: Record<string, unknown> = {}) => ({ registry: HREG, fetcher: f, state: new MemoryFetchState(), patterns, diff: DIFF, windowStart: "2026-03-10", asOf: new Date("2026-11-15T00:00:00.000Z"), ruleSections, lawNames, ...over });

describe("historical comparison", () => {
  test("statuses, the date-only edit and the k/n of each group; peers without history or update are counted separately", async () => {
    const f = historyFetcher();
    const r = await comparePeerHistory(base(f));
    const by = Object.fromEntries(r.peers.map((p) => [p.peerId, p]));
    expect(by["p1"]!.status).toBe("compared");
    expect(by["p1"]!.alignments).toEqual([{ articleKey: "PIPA:21(1)", sectionId: "S06", confidence: "high", basis: "cites_article" }]);
    expect(by["p2"]!.alignments?.[0]).toMatchObject({ confidence: "high", basis: "quotes_new_wording" });
    expect(by["p3"]!.changedSections?.map((c) => c.sectionId)).toEqual(["S11"]);
    expect(by["p3"]!.alignments).toEqual([]);
    expect(by["p4"]).toMatchObject({ status: "compared", changedSections: [] }); // dates only: compared, no change
    expect(by["p5"]).toMatchObject({ status: "no_update" });
    expect(by["p6"]).toMatchObject({ status: "skipped" });
    expect(by["p6"]!.reason).toContain("fetch_form");
    expect(by["p7"]).toMatchObject({ status: "no_history" });
    expect(by["p8"]).toMatchObject({ status: "no_history" });
    expect(by["p9"]).toMatchObject({ status: "no_update" });
    expect(by["px"]).toBeUndefined(); // excluded peers are not part of it

    const retail = r.groups.find((g) => g.groupId === "retail")!;
    expect(retail).toMatchObject({ active: 9, compared: 4, changed: 3, noUpdate: 2, noHistory: 2, skipped: 1, failed: 0 });
    expect(retail.signals).toHaveLength(1);
    expect(retail.signals[0]).toMatchObject({ articleKey: "PIPA:21(1)", sectionId: "S06", k: 2, n: 4, confidence: "high", meetsThreshold: false, label: PEER_SIGNAL_LABEL });
    const food = r.groups.find((g) => g.groupId === "food")!;
    expect(food).toMatchObject({ compared: 2, changed: 1 });
    expect(food.signals[0]).toMatchObject({ k: 1, n: 2 });
    // the render choice follows the history entry
    expect(f.requests.find((q) => q.url === "https://p3.example/privacy/2026-10-30")?.render).toBe("browser");
    expect(f.requests.find((q) => q.url === "https://p1.example/privacy/2026-10-30")?.render).toBe("html");
    // form versions and peers without history are never requested
    expect(f.requests.some((q) => q.url.includes("p6.") || q.url.includes("p7.") || q.url.includes("p5."))).toBe(false);
  });

  test("k/n meets the display threshold with 3 of 4 (and a version effective before the window does not count)", async () => {
    const reg = PeerRegistrySchema.parse({
      version: "t",
      groups: [{ groupId: "retail", nameKo: "유통", lotte: [], peers: ["a1", "a2", "a3", "a4"].map((n) => peer(n, hist(n))) }],
    });
    const f = new FakeFetcher();
    const put = (n: string, after: string) => {
      f.pages.set(`https://${n}.example/privacy/2025-01-01`, page());
      f.pages.set(`https://${n}.example/privacy/2026-10-30`, after);
    };
    put("a1", page({ edit: { S06: CITES } }));
    put("a2", page({ edit: { S06: QUOTES } }));
    put("a3", page({ edit: { S06: CITES } }));
    put("a4", page());
    const r = await comparePeerHistory(base(f, { registry: reg }));
    expect(r.groups[0]!.signals[0]).toMatchObject({ k: 3, n: 4, meetsThreshold: true });
    // a window that starts after the peers' new versions took effect: nothing aligns
    const late = await comparePeerHistory(base(historyFetcher(), { registry: reg, windowStart: "2026-11-01", diff: { ...DIFF, effectiveOn: "2026-11-05" } }));
    expect(late.groups[0]!.signals).toEqual([]);
  });

  test("at most 3 history pages per host per run; failures and skips are reported, not thrown", async () => {
    const reg = PeerRegistrySchema.parse({
      version: "t",
      groups: [{ groupId: "retail", nameKo: "유통", lotte: [], peers: [peer("h1", hist("same")), peer("h2", hist("same")), peer("h3", hist("gone"))] }],
    });
    const f = new FakeFetcher();
    for (const d of ["2025-01-01", "2026-10-30"]) f.pages.set(`https://same.example/privacy/${d}`, page());
    const r = await comparePeerHistory(base(f, { registry: reg }));
    expect(f.requests.filter((q) => q.url.startsWith("https://same.example")).length).toBe(3);
    expect(r.peers.find((p) => p.peerId === "h1")!.status).toBe("compared");
    expect(r.peers.find((p) => p.peerId === "h2")).toMatchObject({ status: "skipped" });
    expect(r.peers.find((p) => p.peerId === "h2")!.reason).toContain("history_host_limit");
    expect(r.peers.find((p) => p.peerId === "h3")).toMatchObject({ status: "failed" });
  });

  test("history fetches release the host's daily slot but leave back-off alone", async () => {
    const state = new MemoryFetchState();
    state.setHost("p1.example", { lastPageDay: "2026-11-15", backoffUntilDay: "2026-11-20" });
    await comparePeerHistory(base(historyFetcher(), { state }));
    expect(state.host("p1.example").lastPageDay).toBeUndefined();
    expect(state.host("p1.example").backoffUntilDay).toBe("2026-11-20");
  });

  test("the report carries the fixed label, the co-occurred wording, masked quotes and no ranking words", async () => {
    const r = await comparePeerHistory(base(historyFetcher()));
    const md = renderHistoryReport({ result: r, tenantId: "acme", date: "2026-11-15", titles: { S06: "파기" }, amendment: { oldMst: "100", newMst: "101", promulgatedOn: "2026-03-10", promulgationNo: "21445", howFound: "lawSearch eflaw" } });
    expect(md).toContain(PEER_SIGNAL_LABEL);
    expect(md).toContain("co-occurred, not caused by");
    expect(md).toContain("개정 전후 갱신 없음");
    expect(md).toContain("이력 미공개");
    expect(md).toContain("2 / 4");
    expect(md).not.toMatch(/순위|등급|점수|1위/);
    expect(md).not.toMatch(/02-1234-5678|@example/);
    for (const p of r.peers) for (const c of p.changedSections ?? []) expect(c.quote.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(26); // 25 words and the ellipsis
  });

  test("isoDateOf", () => {
    expect(isoDateOf("2026-10-30")).toBe("2026-10-30");
    expect(isoDateOf("2026. 7. 1.")).toBe("2026-07-01");
    expect(isoDateOf("2026년 7월 1일")).toBe("2026-07-01");
    expect(isoDateOf("2026년 7월")).toBeNull();
  });
});

// --- law versions -----------------------------------------------------------------------------------------------------------------

const lv = (mst: string, prom: string, no: string, eff: string, status: string): LawVersion => ({ target: "law", name: "개인정보 보호법", lawId: "011357", mst, promulgatedOn: prom, promulgationNo: no, effectiveOn: eff, revisionType: "일부개정", status });
const ROWS = [
  lv("283839", "2026-03-10", "21445", "2027-07-01", "시행예정"),
  lv("289415", "2026-09-08", "21910", "2027-03-09", "시행예정"),
  lv("283839", "2026-03-10", "21445", "2026-09-11", "현행"),
  lv("270351", "2025-04-01", "20897", "2025-10-02", "연혁"),
  lv("248613", "2023-03-14", "19234", "2025-03-13", "연혁"),
  lv("248613", "2023-03-14", "19234", "2024-03-15", "연혁"),
];

describe("law version resolution", () => {
  test("the previous version is the one promulgated before the new MST (a version listed per effective date counts once)", () => {
    expect(previousVersionOf(ROWS, "283839")?.mst).toBe("270351");
    expect(previousVersionOf(ROWS, "270351")?.mst).toBe("248613");
    expect(previousVersionOf(ROWS, "248613")).toBeNull();
    expect(previousVersionOf(ROWS, "289415")?.mst).toBe("283839");
  });

  test("resolveAmendment diffs the two versions and takes the earliest effective date of the new one", async () => {
    const asked: string[] = [];
    const port = {
      listAllVersions: async () => ROWS,
      getFullTextXml: async (mst: string) => {
        asked.push(mst);
        return readFixture(mst === "270351" ? "law-old.xml" : "law-new.xml");
      },
    };
    const r = await resolveAmendment(port, { law: "PIPA", lawId: "011357", newMst: "283839" });
    expect(asked).toEqual(["270351", "283839"]);
    expect(r.oldMst).toBe("270351");
    expect(r.diff.effectiveOn).toBe("2026-09-11");
    expect(r.diff).toMatchObject({ law: "PIPA", oldVersion: "270351", newVersion: "283839" });
    expect(r.diff.units.length).toBeGreaterThan(0);
    expect(r.howFound).toContain("270351");
    const given = await resolveAmendment(port, { law: "PIPA", lawId: "011357", newMst: "283839", oldMst: "248613", effectiveOn: "2026-09-12" });
    expect(given.oldMst).toBe("248613");
    expect(given.diff.effectiveOn).toBe("2026-09-12");
  });
});

