import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LawApiClient, LawApiError, redactSecrets } from "../src/adapters/lawapi";
import { PageWatcher, analyzePage, type PageSnapshot, type PageTarget } from "../src/adapters/pages";
import type { Manifest } from "../src/contracts/manifest";
import { MockLlmClient } from "../src/llm/client";
import { runFreshness, runFreshnessDetailed, type FreshnessTargets, type LawApiPort, type PagePort, type RuleIndex } from "../src/stages/freshness";

const fx = (n: string): string => readFileSync(join(import.meta.dir, "fixtures", "freshness", n), "utf8");
const SECRET = "supersecretkey123";
const noSleep = async (): Promise<void> => {};
const resp = (body: string, status = 200): Response => new Response(body, { status });

describe("redaction", () => {
  test("redacts OC values in URLs and known secrets", () => {
    const s = redactSecrets(`https://law.go.kr/DRF/lawSearch.do?OC=${SECRET}&target=law and ${SECRET}`, [SECRET]);
    expect(s).not.toContain(SECRET);
    expect(s).toContain("OC=[REDACTED]");
  });
  test("errors and logs never contain the key", async () => {
    const logs: string[] = [];
    const client = new LawApiClient({
      oc: SECRET,
      fetchImpl: (async () => {
        throw new Error(`connect failed https://law.go.kr/DRF/lawSearch.do?OC=${SECRET}&x=1`);
      }) as unknown as typeof fetch,
      sleep: noSleep,
      log: (l) => logs.push(l),
    });
    const err = await client.getCurrentVersion("개인정보 보호법", "law").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LawApiError);
    expect((err as Error).message).not.toContain(SECRET);
    expect(logs.length).toBe(3);
    expect(logs.join("\n")).not.toContain(SECRET);
  });
  test("missing key raises MISSING_KEY", async () => {
    const err = await new LawApiClient({ oc: undefined }).search("x", "law").catch((e: unknown) => e);
    expect((err as LawApiError).code).toBe("MISSING_KEY");
  });
});

describe("LawApiClient", () => {
  test("parses law search and picks the exact current name", async () => {
    const urls: string[] = [];
    const client = new LawApiClient({
      oc: SECRET,
      fetchImpl: (async (u: string) => {
        urls.push(u);
        return resp(fx("law-search-pipa.xml"));
      }) as unknown as typeof fetch,
      sleep: noSleep,
    });
    const v = await client.getCurrentVersion("개인정보 보호법", "law");
    expect(v).toMatchObject({ lawId: "011357", mst: "283839", promulgatedOn: "2026-03-10", promulgationNo: "21445", effectiveOn: "2026-09-11", revisionType: "일부개정" });
    expect(urls[0]).toContain(encodeURIComponent("개인정보 보호법"));
  });
  test("parses admrul rows", () => {
    const [v] = LawApiClient.parseSearch(fx("admrul-search-stdg.xml"), "admrul");
    expect(v).toMatchObject({ mst: "2100000257592", lawId: "73464", promulgationNo: "2025-4", effectiveOn: "2025-04-11" });
  });
  test("lists scheduled versions", async () => {
    const client = new LawApiClient({ oc: SECRET, fetchImpl: (async () => resp(fx("eflaw-pipa-scheduled.xml"))) as unknown as typeof fetch, sleep: noSleep });
    const list = await client.listScheduledVersions("011357");
    expect(list.map((v) => v.effectiveOn)).toEqual(["2027-07-01", "2027-03-09"]);
  });
  test("HTTP 200 error body raises AUTH without retry", async () => {
    let calls = 0;
    const client = new LawApiClient({
      oc: SECRET,
      fetchImpl: (async () => {
        calls++;
        return resp(fx("error-body.xml"));
      }) as unknown as typeof fetch,
      sleep: noSleep,
    });
    const err = await client.search("x", "law").catch((e: unknown) => e);
    expect((err as LawApiError).code).toBe("AUTH");
    expect(calls).toBe(1);
  });
  test("retries 5xx twice then fails; recovers on success", async () => {
    let calls = 0;
    const bad = new LawApiClient({ oc: SECRET, fetchImpl: (async () => (calls++, resp("x", 503))) as unknown as typeof fetch, sleep: noSleep });
    await expect(bad.search("x", "law")).rejects.toThrow("HTTP 503");
    expect(calls).toBe(3);
    let n = 0;
    const ok = new LawApiClient({ oc: SECRET, fetchImpl: (async () => (n++ < 2 ? resp("x", 500) : resp(fx("law-search-pipa.xml")))) as unknown as typeof fetch, sleep: noSleep });
    expect((await ok.search("x", "law")).length).toBe(2);
  });
  test("spaces requests by the minimum interval", async () => {
    const sleeps: number[] = [];
    let t = 1000;
    const client = new LawApiClient({
      oc: SECRET,
      fetchImpl: (async () => resp(fx("law-search-pipa.xml"))) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      now: () => t,
    });
    await client.search("a", "law");
    t += 100;
    await client.search("b", "law");
    expect(sleeps).toEqual([900]);
  });
});

const T = (kind: PageTarget["kind"], url: string): PageTarget => ({ sourceId: "p", name: "p", kind, url });
const PIPC = T("pipc-board", "https://www.pipc.go.kr/np/cop/bbs/selectBoardList.do?bbsId=BS217");
const PRIV = T("privacy-board", "https://www.privacy.go.kr/front/bbs/bbsList.do?bbsNo=BBSMSTR_000000000049");
const FTCL = T("ftc-list", "https://www.ftc.go.kr/www/selectBbsNttList.do?bordCd=201&key=202");
const FTCV = T("ftc-view", "https://www.ftc.go.kr/www/selectBbsNttView.do?key=202&bordCd=201&nttSn=11139");

describe("page analysis", () => {
  test("PIPC board", () => {
    const s = analyzePage(PIPC, PIPC.url, fx("pipc-board.html"));
    expect(s.ok).toBe(true);
    expect(s.items[0]).toMatchObject({ id: "12018", date: "2026-04-23" });
    expect(s.latestEdition).toBe("2026.4");
  });
  test("privacy.go.kr board keeps only guideline rows", () => {
    const s = analyzePage(PRIV, PRIV.url, fx("privacy-board.html"));
    expect(s.items.map((i) => i.id)).toEqual(["20885"]);
    expect(s.latestEdition).toBe("2026");
  });
  test("KFTC list and view", () => {
    const l = analyzePage(FTCL, FTCL.url, fx("ftc-board.html"));
    expect(l.ok).toBe(true);
    const v = analyzePage(FTCV, FTCV.url, fx("ftc-view-10023.html"));
    expect(v.items[0]).toMatchObject({ id: "제10023호", date: "2014-09-23" });
    expect(v.items[0]?.attachment).toContain("2015_6._26._개정");
  });
  test("redirected homepage (200) is detected by content", () => {
    const viaRedirect = analyzePage(FTCV, "https://www.ftc.go.kr/www/index.do", fx("ftc-homepage.html"));
    expect(viaRedirect).toMatchObject({ ok: false, problem: "redirected_homepage" });
    const sameUrlHomepage = analyzePage(FTCV, FTCV.url, fx("ftc-homepage.html"));
    expect(sameUrlHomepage).toMatchObject({ ok: false, problem: "redirected_homepage" });
  });
  test("hash changes when a newer edition row appears", () => {
    const a = analyzePage(PIPC, PIPC.url, fx("pipc-board.html"));
    const newer = fx("pipc-board.html").replace("nttId=12018", "nttId=12500").replace("2026.4. 개정", "2027.4. 개정");
    const b = analyzePage(PIPC, PIPC.url, newer);
    expect(b.titleHash).not.toBe(a.titleHash);
    expect(b.latestEdition).toBe("2027.4");
  });
  test("PageWatcher follows final URL and reports unreachable", async () => {
    const w = new PageWatcher({ fetchImpl: (async () => Object.defineProperty(resp(fx("ftc-homepage.html")), "url", { value: "https://www.ftc.go.kr/www/index.do" })) as unknown as typeof fetch, sleep: noSleep });
    expect((await w.snapshot(FTCV)).problem).toBe("redirected_homepage");
    const w2 = new PageWatcher({ fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch, sleep: noSleep });
    expect((await w2.snapshot(FTCV)).problem).toBe("unreachable");
  });
});

// ---- runFreshness ----
const TODAY = new Date("2026-09-30T00:00:00.000Z");
const ver = (o: Partial<{ mst: string; lawId: string; prom: string; eff: string; status: string; no: string }> = {}) => ({
  target: "law" as const,
  name: "개인정보 보호법",
  lawId: o.lawId ?? "011357",
  mst: o.mst ?? "283839",
  promulgatedOn: o.prom ?? "2026-03-10",
  promulgationNo: o.no ?? "21445",
  effectiveOn: o.eff ?? "2026-09-11",
  revisionType: "일부개정",
  status: o.status ?? "현행",
});
const targets: FreshnessTargets = {
  laws: [{ sourceId: "law:pipa", name: "개인정보 보호법", target: "law", lawCode: "PIPA" }],
  pages: [{ sourceId: "page:pipc", name: "PIPC", kind: "pipc-board", url: PIPC.url, affectsAllSections: true }],
};
const ruleIndex: RuleIndex = { lawCodes: { PIPA: "개인정보 보호법" }, lawIndex: { "PIPA:15(1)": ["S03"], "PIPA:17": ["S07"], "DEC:14-2": ["A1"] }, sectionIds: ["S01", "S03", "S07"] };
const pipcHash = analyzePage(PIPC, PIPC.url, fx("pipc-board.html")).titleHash;
const manifest = (over: Partial<Manifest["lawSnapshot"]["laws"][number]> = {}, hash = pipcHash): Manifest => ({
  manifestVersion: "1",
  rulePacks: [],
  lawSnapshot: { id: "s", laws: [{ name: "개인정보 보호법", target: "law", id: "283839", effective: "2026-09-11", ...over }] },
  clauseLib: { version: "1", capturedAt: TODAY.toISOString(), sites: [], vettedClauses: 0 },
  houseStyle: { version: "1" },
  pages: [{ url: PIPC.url, titleHash: hash, checkedAt: TODAY.toISOString() }],
});
const okPage = (): PagePort => ({ snapshot: async (t) => analyzePage(t, t.url, fx("pipc-board.html")) });
const api = (cur: ReturnType<typeof ver> | null, sched: ReturnType<typeof ver>[] = []): LawApiPort => ({
  getCurrentVersion: async () => cur,
  listScheduledVersions: async () => sched,
});
const deps = (lawApi: LawApiPort, pages: PagePort = okPage()) => ({ lawApi, pages, ruleIndex, now: () => TODAY, runId: "fresh-test" });

describe("runFreshness", () => {
  test("current when stamps match and nothing is near", async () => {
    const r = await runFreshness(manifest(), targets, deps(api(ver(), [ver({ mst: "289415", eff: "2027-03-09" })])));
    expect(r.status).toBe("current");
    expect(r.sources.every((s) => s.outcome === "unchanged")).toBe(true);
    expect(r.affectedSections).toEqual([]);
  });
  test("new amendment promulgated maps to sections via lawIndex", async () => {
    const r = await runFreshnessDetailed(manifest(), targets, deps(api(ver({ mst: "290000", prom: "2026-09-29", eff: "2027-01-01" }))));
    expect(r.report.status).toBe("drift");
    expect(r.changes.map((c) => c.kind)).toContain("amendment_promulgated");
    expect(r.report.affectedSections.map((s) => s.itemId)).toEqual(["S03", "S07"]);
  });
  test("effective date reached: previously scheduled version is now current", async () => {
    const r = await runFreshnessDetailed(manifest(), targets, deps(api(ver({ mst: "289415", prom: "2026-09-08", eff: "2026-09-30" }))));
    expect(r.changes.map((c) => c.kind)).toContain("effective_date_reached");
  });
  test("upcoming effective date within N days", async () => {
    const soon = ver({ mst: "289415", prom: "2026-09-08", eff: "2026-11-15" });
    const r = await runFreshnessDetailed(manifest(), targets, deps(api(ver(), [soon])));
    expect(r.changes.map((c) => c.kind)).toEqual(["upcoming_effective"]);
    expect(r.report.status).toBe("drift");
    const far = await runFreshness(manifest(), targets, deps(api(ver(), [ver({ mst: "289415", eff: "2027-03-09" })])));
    expect(far.status).toBe("current");
  });
  test("guideline edition change maps to all sections", async () => {
    const r = await runFreshnessDetailed(manifest({}, "0".repeat(64)), targets, deps(api(ver())));
    expect(r.changes.map((c) => c.kind)).toContain("guideline_edition_change");
    expect(r.report.affectedSections.map((s) => s.itemId)).toEqual(["S01", "S03", "S07"]);
  });
  test("KFTC standard-terms revision", async () => {
    const t: FreshnessTargets = { laws: [], pages: [{ sourceId: "page:ftc", name: "ftc", kind: "ftc-view", url: FTCV.url }] };
    const m = { ...manifest(), pages: [{ url: FTCV.url, titleHash: "1".repeat(64), checkedAt: TODAY.toISOString() }] };
    const pages: PagePort = { snapshot: async (x) => analyzePage(x, x.url, fx("ftc-view-10023.html")) };
    const r = await runFreshnessDetailed(m, t, deps(api(null), pages));
    expect(r.changes[0]?.kind).toBe("standard_terms_revision");
  });
  test("redirected homepage counts as unreachable, all failed -> unverified", async () => {
    const t: FreshnessTargets = { laws: targets.laws, pages: [{ sourceId: "page:ftc", name: "ftc", kind: "ftc-view", url: FTCV.url }] };
    const failing: LawApiPort = { getCurrentVersion: async () => { throw new LawApiError("AUTH", "bad"); }, listScheduledVersions: async () => [] };
    const pages: PagePort = { snapshot: async (x) => analyzePage(x, "https://www.ftc.go.kr/www/index.do", fx("ftc-homepage.html")) };
    const r = await runFreshnessDetailed(manifest(), t, deps(failing, pages));
    expect(r.report.status).toBe("unverified");
    expect(r.changes.every((c) => c.kind === "source_unreachable")).toBe(true);
  });
  test("tolerates missing rule index", async () => {
    const r = await runFreshness(manifest({ id: "1" }), targets, { lawApi: api(ver()), pages: okPage(), now: () => TODAY });
    expect(r.status).toBe("drift");
    expect(r.affectedSections).toEqual([]);
  });
  test("optional LLM summary uses R6 (haiku) via MockLlmClient; default off", async () => {
    const llm = new MockLlmClient({ fixtures: { R6: { summary: "PIPA amended." } } });
    const changed = api(ver({ mst: "290000", prom: "2026-09-29", eff: "2027-01-01" }));
    const off = await runFreshness(manifest(), targets, { ...deps(changed), llm });
    expect(llm.callCount()).toBe(0);
    expect(off.affectedSections[0]?.summary).toBe("");
    const on = await runFreshness(manifest(), targets, { ...deps(changed), llm, summarize: true });
    expect(llm.calls[0]?.modelId).toBe("claude-haiku-4-5");
    expect(on.affectedSections[0]?.summary).toBe("PIPA amended.");
  });
});

export type { PageSnapshot };
