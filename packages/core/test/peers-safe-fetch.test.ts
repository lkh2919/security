import { describe, expect, test } from "bun:test";
import { EMPTY_ROBOTS, MemoryFetchState, PEER_USER_AGENT, SafeFetcher, assertPublicHost, evaluateRobots, isPublicAddress, looksLikeHtml, parseRobots, validateUrl, type BrowserFetcher, type DnsResolver, type FetchLike } from "../src/adapters/fetch";

const PUBLIC_DNS: DnsResolver = async () => ["93.184.216.34"];
const HTML = `<html><body><h1>방침</h1><p>본문</p></body></html>`;
const res = (body: string, init: ResponseInit = {}): Response => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
const NOW = new Date("2026-10-02T09:00:00.000Z");

interface Call {
  url: string;
  headers: Record<string, string>;
  init: RequestInit;
}

/** Routes by URL; unknown URLs answer 404. Records every request. */
function fakeFetch(routes: Record<string, () => Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, init });
      const r = routes[url];
      return r ? r() : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}

const fetcherOf = (f: FetchLike, extra: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {}) => new SafeFetcher({ state: new MemoryFetchState(), fetch: f, resolveDns: PUBLIC_DNS, now: () => NOW, sleep: async () => undefined, ...extra });

describe("address and URL validation", () => {
  test("private, loopback, link-local, CGNAT, ULA and reserved addresses are refused; public ones pass", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "64:ff9b::a00:1", "2002:7f00:1::1", "ff02::1", "2001:db8::1"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip)).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  test("scheme, port and credentials", () => {
    expect(validateUrl("https://example.com/privacy").hostname).toBe("example.com");
    expect(validateUrl("http://example.com:80/x").port).toBe("");
    expect(validateUrl("https://example.com:443/x").hostname).toBe("example.com");
    for (const bad of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "https://example.com:8443/x", "http://example.com:8080/", "https://user:pw@example.com/", "not a url"]) expect(() => validateUrl(bad)).toThrow();
  });

  test("hosts are resolved: any private answer refuses the host; localhost and literal IPs need no DNS", async () => {
    const mixed: DnsResolver = async () => ["93.184.216.34", "10.0.0.5"];
    await expect(assertPublicHost(new URL("https://example.com/"), mixed)).rejects.toThrow("non-public");
    await expect(assertPublicHost(new URL("https://example.com/"), PUBLIC_DNS)).resolves.toBeUndefined();
    await expect(assertPublicHost(new URL("https://localhost/"), PUBLIC_DNS)).rejects.toThrow();
    await expect(assertPublicHost(new URL("https://127.0.0.1/"), PUBLIC_DNS)).rejects.toThrow();
    await expect(assertPublicHost(new URL("https://[::1]/"), PUBLIC_DNS)).rejects.toThrow();
    await expect(assertPublicHost(new URL("https://2130706433/"), PUBLIC_DNS)).rejects.toThrow(); // decimal form is normalized to 127.0.0.1
    await expect(assertPublicHost(new URL("https://gone.example/"), async () => [])).rejects.toThrow("did not resolve");
  });

  test("a URL that resolves to a private address is never requested", async () => {
    const f = fakeFetch({});
    const r = await fetcherOf(f.fetch, { resolveDns: async () => ["192.168.0.10"] }).fetchPage({ url: "https://intranet.example/privacy", render: "html" });
    expect(r.status).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });
});

describe("robots.txt parser", () => {
  const UA = PEER_USER_AGENT;
  test("User-agent * rules: longest match wins, Allow wins a tie, empty Disallow allows all", () => {
    const robots = parseRobots(["User-agent: *", "Disallow: /private", "Allow: /private/open", "Disallow: /a/b$", ""].join("\n"));
    expect(evaluateRobots(robots, UA, "/privacy").allowed).toBe(true);
    expect(evaluateRobots(robots, UA, "/private/x").allowed).toBe(false);
    expect(evaluateRobots(robots, UA, "/private/open/page").allowed).toBe(true);
    expect(evaluateRobots(robots, UA, "/a/b").allowed).toBe(false);
    expect(evaluateRobots(robots, UA, "/a/b/c").allowed).toBe(true); // `$` anchors the end
    expect(evaluateRobots(parseRobots("User-agent: *\nDisallow:"), UA, "/anything").allowed).toBe(true);
    expect(evaluateRobots(parseRobots("User-agent: *\nDisallow: /x\nAllow: /x"), UA, "/x").allowed).toBe(true);
  });

  test("our group beats *, wildcards and query strings work, Crawl-delay is read", () => {
    const text = ["User-agent: *", "Disallow: /", "", "User-agent: LottePolicyMonitor", "Disallow: /admin", "Crawl-delay: 7", "", "User-agent: Googlebot", "Disallow: /g"].join("\n");
    const robots = parseRobots(text);
    expect(evaluateRobots(robots, UA, "/privacy")).toEqual({ allowed: true, crawlDelay: 7 });
    expect(evaluateRobots(robots, UA, "/admin/x").allowed).toBe(false);
    expect(evaluateRobots(robots, "OtherBot/1.0", "/privacy").allowed).toBe(false); // falls back to * (Disallow: /)
    const wild = parseRobots("User-agent: *\nDisallow: /*.pdf\nDisallow: /*?session=");
    expect(evaluateRobots(wild, UA, "/files/a.pdf").allowed).toBe(false);
    expect(evaluateRobots(wild, UA, "/p?session=1").allowed).toBe(false);
    expect(evaluateRobots(wild, UA, "/p?lang=ko").allowed).toBe(true);
  });

  test("comments, blank lines, stacked user-agent lines, BOM and no rules", () => {
    const robots = parseRobots("﻿# c\nUser-agent: a\nUser-agent: lottepolicymonitor # ours\nDisallow: /x # trailing\n\nDisallow: /y\n");
    expect(evaluateRobots(robots, UA, "/x").allowed).toBe(false);
    expect(evaluateRobots(robots, UA, "/y").allowed).toBe(false);
    expect(evaluateRobots(EMPTY_ROBOTS, UA, "/x").allowed).toBe(true);
    expect(looksLikeHtml("<!DOCTYPE html><html>", null)).toBe(true);
    expect(looksLikeHtml("User-agent: *", "text/html")).toBe(true);
    expect(looksLikeHtml("User-agent: *", "text/plain")).toBe(false);
  });
});

describe("SafeFetcher", () => {
  test("fetches the page with the honest user agent, no cookies, checks robots first", async () => {
    const f = fakeFetch({ "https://a.example/robots.txt": () => res("User-agent: *\nDisallow: /admin", { headers: { "content-type": "text/plain" } }), "https://a.example/privacy": () => res(HTML, { headers: { "content-type": "text/html; charset=utf-8", etag: '"v1"', "set-cookie": "sid=1" } }) });
    const r = await fetcherOf(f.fetch).fetchPage({ url: "https://a.example/privacy", render: "html" });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.body).toContain("본문");
    expect(f.calls.map((c) => c.url)).toEqual(["https://a.example/robots.txt", "https://a.example/privacy"]);
    for (const c of f.calls) {
      expect(c.headers["user-agent"]).toBe(PEER_USER_AGENT);
      expect(c.headers["cookie"]).toBeUndefined();
      expect(c.init.redirect).toBe("manual");
      expect(c.init.credentials).toBe("omit");
    }
    expect(PEER_USER_AGENT).toBe("LottePolicyMonitor/0.1 (+internal research; contact via repository owner)");
  });

  test("robots: disallow, 5xx, 403, unreachable skip the page; 404 and an HTML answer mean no rules", async () => {
    const run = async (robots: () => Response | Promise<Response>) => {
      const f = fakeFetch({ "https://b.example/privacy": () => res(HTML) });
      const wrapped: FetchLike = async (url, init) => (url.endsWith("/robots.txt") ? robots() : f.fetch(url, init));
      return { r: await fetcherOf(wrapped).fetchPage({ url: "https://b.example/privacy", render: "html" }), pageCalls: f.calls.length };
    };
    const disallow = await run(() => res("User-agent: *\nDisallow: /", { headers: { "content-type": "text/plain" } }));
    expect(disallow.r).toEqual({ status: "skipped", reason: "robots_disallowed" });
    expect(disallow.pageCalls).toBe(0);
    for (const status of [500, 503, 403, 401, 429]) {
      const x = await run(() => new Response("x", { status }));
      expect(x.r).toEqual({ status: "skipped", reason: "robots_unreachable" });
      expect(x.pageCalls).toBe(0);
    }
    const down = await run(() => Promise.reject(new Error("ECONNRESET")));
    expect(down.r).toEqual({ status: "skipped", reason: "robots_unreachable" });
    expect((await run(() => new Response("nope", { status: 404 }))).r.status).toBe("ok");
    expect((await run(() => res("<html><body>404 page</body></html>"))).r.status).toBe("ok"); // HTML robots.txt = absent
  });

  test("robots.txt is fetched once per origin per run", async () => {
    const f = fakeFetch({ "https://c.example/robots.txt": () => res("User-agent: *\nDisallow:", { headers: { "content-type": "text/plain" } }), "https://c.example/p1": () => res(HTML), "https://c.example/p2": () => res(HTML) });
    const state = new MemoryFetchState();
    const fetcher = fetcherOf(f.fetch, { state });
    expect((await fetcher.fetchPage({ url: "https://c.example/p1", render: "html" })).status).toBe("ok");
    expect((await fetcher.fetchPage({ url: "https://c.example/p2", render: "html" })).status).toBe("skipped");
    expect(f.calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  test("at most one page fetch per host per UTC day, persisted in the state; the next day is open again", async () => {
    const f = fakeFetch({ "https://d.example/a": () => res(HTML), "https://d.example/b": () => res(HTML) });
    const state = new MemoryFetchState();
    let now = NOW;
    const mk = () => fetcherOf(f.fetch, { state, now: () => now });
    expect((await mk().fetchPage({ url: "https://d.example/a", render: "html" })).status).toBe("ok");
    // a new run (new fetcher, same persisted state), same day, other path on the same host
    expect(await mk().fetchPage({ url: "https://d.example/b", render: "html" })).toEqual({ status: "skipped", reason: "rate_limit_daily" });
    expect(f.calls.filter((c) => !c.url.endsWith("robots.txt"))).toHaveLength(1);
    now = new Date("2026-10-03T00:00:01.000Z");
    expect((await mk().fetchPage({ url: "https://d.example/b", render: "html" })).status).toBe("ok");
    // another host is independent
    const g = fakeFetch({ "https://e.example/a": () => res(HTML) });
    expect((await fetcherOf(g.fetch, { state, now: () => now }).fetchPage({ url: "https://e.example/a", render: "html" })).status).toBe("ok");
  });

  test("conditional GET: stored ETag and Last-Modified are sent; 304 is not_modified; validators are stored", async () => {
    let seen: Record<string, string> = {};
    const f: FetchLike = async (url, init) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      seen = (init.headers ?? {}) as Record<string, string>;
      if (seen["if-none-match"] === '"v1"') return new Response(null, { status: 304 });
      return res(HTML, { headers: { "content-type": "text/html", etag: '"v1"', "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT" } });
    };
    const state = new MemoryFetchState();
    let now = NOW;
    const mk = () => fetcherOf(f, { state, now: () => now });
    expect((await mk().fetchPage({ url: "https://f.example/p", render: "html" })).status).toBe("ok");
    expect(seen["if-none-match"]).toBeUndefined();
    expect(state.url("https://f.example/p")).toMatchObject({ etag: '"v1"', lastModified: "Wed, 01 Oct 2026 00:00:00 GMT" });
    now = new Date("2026-10-03T09:00:00.000Z");
    expect(await mk().fetchPage({ url: "https://f.example/p", render: "html" })).toEqual({ status: "not_modified" });
    expect(seen["if-none-match"]).toBe('"v1"');
    expect(seen["if-modified-since"]).toBe("Wed, 01 Oct 2026 00:00:00 GMT");
  });

  test("a dry run (persistValidators false) keeps the daily limit but stores no validators", async () => {
    const f = fakeFetch({ "https://g.example/p": () => res(HTML, { headers: { "content-type": "text/html", etag: '"x"' } }) });
    const state = new MemoryFetchState();
    await fetcherOf(f.fetch, { state, persistValidators: false }).fetchPage({ url: "https://g.example/p", render: "html" });
    expect(state.url("https://g.example/p").etag).toBeUndefined();
    expect(state.host("g.example").lastPageDay).toBe("2026-10-02");
  });

  describe("redirects", () => {
    const redirect = (to: string, status = 302): Response => new Response(null, { status, headers: { location: to } });

    test("each hop is re-validated: a hop to a private address is refused and never requested", async () => {
      const f = fakeFetch({ "https://h.example/p": () => redirect("https://internal.example/secret") });
      const dns: DnsResolver = async (h) => (h === "internal.example" ? ["10.1.1.1"] : ["93.184.216.34"]);
      const r = await fetcherOf(f.fetch, { resolveDns: dns }).fetchPage({ url: "https://h.example/p", render: "html" });
      expect(r.status).toBe("failed");
      expect(f.calls.some((c) => c.url.includes("internal.example"))).toBe(false);
      for (const target of ["http://127.0.0.1/", "https://169.254.169.254/latest/meta-data", "https://h.example:8443/x", "file:///etc/passwd"]) {
        const g = fakeFetch({ "https://h.example/p": () => redirect(target) });
        const x = await fetcherOf(g.fetch).fetchPage({ url: "https://h.example/p", render: "html" });
        expect(x.status).toBe("failed");
        expect(g.calls.some((c) => c.url === target)).toBe(false);
      }
    });

    test("https -> http downgrade is refused; http -> https is followed; max 5 redirects", async () => {
      const down = fakeFetch({ "https://i.example/p": () => redirect("http://i.example/p") });
      const r1 = await fetcherOf(down.fetch).fetchPage({ url: "https://i.example/p", render: "html" });
      expect(r1).toMatchObject({ status: "failed" });
      if (r1.status === "failed") expect(r1.reason).toContain("DOWNGRADE");

      const up = fakeFetch({ "http://j.example/p": () => redirect("https://j.example/p"), "https://j.example/p": () => res(HTML) });
      const r2 = await fetcherOf(up.fetch).fetchPage({ url: "http://j.example/p", render: "html" });
      expect(r2.status).toBe("ok");
      if (r2.status === "ok") expect(r2.finalUrl).toBe("https://j.example/p");

      const routes: Record<string, () => Response> = {};
      for (let i = 0; i < 8; i++) routes[`https://k.example/${i}`] = () => redirect(`/${i + 1}`);
      const loop = fakeFetch(routes);
      const r3 = await fetcherOf(loop.fetch).fetchPage({ url: "https://k.example/0", render: "html" });
      expect(r3.status).toBe("failed");
      expect(loop.calls.filter((c) => !c.url.endsWith("robots.txt"))).toHaveLength(6); // first request + 5 redirects
      // exactly 5 redirects are allowed
      const ok5: Record<string, () => Response> = {};
      for (let i = 0; i < 5; i++) ok5[`https://l.example/${i}`] = () => redirect(`/${i + 1}`);
      ok5["https://l.example/5"] = () => res(HTML);
      expect((await fetcherOf(fakeFetch(ok5).fetch).fetchPage({ url: "https://l.example/0", render: "html" })).status).toBe("ok");
    });

    test("a redirect to another host passes robots and the daily limit of that host", async () => {
      const f = fakeFetch({
        "https://m.example/p": () => redirect("https://n.example/policy"),
        "https://n.example/robots.txt": () => res("User-agent: *\nDisallow: /policy", { headers: { "content-type": "text/plain" } }),
        "https://n.example/policy": () => res(HTML),
      });
      const r = await fetcherOf(f.fetch).fetchPage({ url: "https://m.example/p", render: "html" });
      expect(r).toEqual({ status: "skipped", reason: "robots_disallowed" });
      expect(f.calls.some((c) => c.url === "https://n.example/policy")).toBe(false);
    });
  });

  test("size cap and content type", async () => {
    const big = "x".repeat(2000);
    const f = fakeFetch({ "https://o.example/big": () => res(big), "https://o.example/pdf": () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }) });
    const r = await fetcherOf(f.fetch, { maxBytes: 1000 }).fetchPage({ url: "https://o.example/big", render: "html" });
    expect(r).toMatchObject({ status: "failed" });
    const declared = fakeFetch({ "https://p.example/big": () => res("ok", { headers: { "content-type": "text/html", "content-length": "99999999" } }) });
    expect((await fetcherOf(declared.fetch).fetchPage({ url: "https://p.example/big", render: "html" })).status).toBe("failed");
    const pdf = await fetcherOf(f.fetch).fetchPage({ url: "https://o.example/pdf", render: "html" });
    expect(pdf).toMatchObject({ status: "failed" });
  });

  test("403 and 429 back the host off for the following days (1, 2, 4 ... days)", async () => {
    const f = fakeFetch({ "https://q.example/p": () => new Response("blocked", { status: 429 }) });
    const state = new MemoryFetchState();
    let now = NOW;
    const mk = () => fetcherOf(f.fetch, { state, now: () => now });
    expect(await mk().fetchPage({ url: "https://q.example/p", render: "html" })).toEqual({ status: "skipped", reason: "blocked_http_429" });
    expect(state.host("q.example")).toMatchObject({ strikes: 1, backoffUntilDay: "2026-10-03" });
    now = new Date("2026-10-03T09:00:00.000Z");
    expect(await mk().fetchPage({ url: "https://q.example/p", render: "html" })).toEqual({ status: "skipped", reason: "blocked_http_429" }); // tried again, blocked again
    expect(state.host("q.example")).toMatchObject({ strikes: 2, backoffUntilDay: "2026-10-05" });
    now = new Date("2026-10-04T09:00:00.000Z");
    expect(await mk().fetchPage({ url: "https://q.example/p", render: "html" })).toEqual({ status: "skipped", reason: "backoff" });
  });

  test("Crawl-delay is waited; one above the cap skips the page", async () => {
    const waits: number[] = [];
    const mkRoutes = (delay: number) => fakeFetch({ "https://r.example/robots.txt": () => res(`User-agent: *\nCrawl-delay: ${delay}`, { headers: { "content-type": "text/plain" } }), "https://r.example/p": () => res(HTML) });
    const ok = mkRoutes(5);
    expect((await fetcherOf(ok.fetch, { sleep: async (ms) => void waits.push(ms) }).fetchPage({ url: "https://r.example/p", render: "html" })).status).toBe("ok");
    expect(waits).toEqual([5000]);
    const slow = mkRoutes(300);
    expect(await fetcherOf(slow.fetch).fetchPage({ url: "https://r.example/p", render: "html" })).toEqual({ status: "skipped", reason: "crawl_delay_too_long" });
  });

  test("render browser: robots and the daily limit apply, the page's own requests are validated, no browser means failed", async () => {
    const seen: { url: string; ua: string; allowed: Record<string, boolean> }[] = [];
    const browser: BrowserFetcher = {
      fetch: async (url, o) => {
        seen.push({ url, ua: o.userAgent, allowed: { "https://cdn.example/app.js": await o.allowRequest("https://cdn.example/app.js"), "http://127.0.0.1/x": await o.allowRequest("http://127.0.0.1/x"), "https://x.example:8443/": await o.allowRequest("https://x.example:8443/") } });
        return { finalUrl: url, httpStatus: 200, html: HTML };
      },
      close: async () => undefined,
    };
    const f = fakeFetch({ "https://s.example/robots.txt": () => res("User-agent: *\nDisallow: /blocked", { headers: { "content-type": "text/plain" } }) });
    const fetcher = fetcherOf(f.fetch, { browser });
    const r = await fetcher.fetchPage({ url: "https://s.example/policy", render: "browser" });
    expect(r).toMatchObject({ status: "ok", rendered: true });
    expect(seen[0]).toMatchObject({ ua: PEER_USER_AGENT, allowed: { "https://cdn.example/app.js": true, "http://127.0.0.1/x": false, "https://x.example:8443/": false } });
    expect(await fetcher.fetchPage({ url: "https://s.example/policy2", render: "browser" })).toEqual({ status: "skipped", reason: "rate_limit_daily" });
    expect(await fetcherOf(f.fetch, { browser }).fetchPage({ url: "https://s.example/blocked/x", render: "browser" })).toEqual({ status: "skipped", reason: "robots_disallowed" });
    expect(seen).toHaveLength(1);
    expect(await fetcherOf(f.fetch).fetchPage({ url: "https://t.example/p", render: "browser" })).toEqual({ status: "failed", reason: "browser_unavailable" });
  });

  test("a browser that cannot start or complete TLS never requested the page: the host's daily slot is released; other failures keep it", async () => {
    const failing = (message: string): BrowserFetcher => ({ fetch: async () => Promise.reject(new Error(message)), close: async () => undefined });
    const state = new MemoryFetchState();
    const f = fakeFetch({});
    const cert = await fetcherOf(f.fetch, { state, browser: failing("page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://v.example/p\nCall log: ...") }).fetchPage({ url: "https://v.example/p", render: "browser" });
    expect(cert).toMatchObject({ status: "failed" });
    expect(state.host("v.example").lastPageDay).toBeUndefined();
    const other = await fetcherOf(f.fetch, { state, browser: failing("page.goto: Timeout 20000ms exceeded") }).fetchPage({ url: "https://v.example/p", render: "browser" });
    expect(other).toMatchObject({ status: "failed" });
    expect(state.host("v.example").lastPageDay).toBe("2026-10-02");
  });

  test("EUC-KR pages are decoded by the declared charset", async () => {
    const bytes = new Uint8Array([0xb0, 0xb3, 0xc0, 0xce]); // "개인" in EUC-KR
    const f = fakeFetch({ "https://u.example/p": () => new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=euc-kr" } }) });
    const r = await fetcherOf(f.fetch).fetchPage({ url: "https://u.example/p", render: "html" });
    expect(r.status === "ok" && r.body).toBe("개인");
  });
});
