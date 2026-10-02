/**
 * Safe fetcher for Peer Watch (design C5 "Fetching"). It fetches exactly the URLs it is given and never follows crawled links.
 *
 *  - Only http/https on ports 80/443, no credentials in the URL. The host is resolved and refused when any address is private,
 *    loopback, link-local, CGNAT, ULA, multicast or reserved. Redirects are handled by hand (max 5): every hop is validated again,
 *    https -> http is refused, and a hop to another host passes robots and the daily limit like the first request.
 *    (A host resolved again by the HTTP stack could in theory answer differently; the fetcher cannot pin the address. The proxy
 *    of the deployment is the second line of defence.)
 *  - 5 MB size cap, 20 s timeout, honest user agent, no cookies (none are sent, `Set-Cookie` is ignored).
 *  - robots.txt is fetched once per origin and run: a disallow, a 401/403/429/5xx or an unreachable robots.txt skips the page;
 *    404/400 means no rules; an HTML answer counts as absent. Crawl-delay is honoured (waited, or skipped above the cap).
 *  - At most one page fetch per host per UTC day (persisted), conditional GET with stored ETag / Last-Modified, and back-off after a
 *    403 or 429 (1, 2, 4 ... max 7 days).
 *  - Pages that need JavaScript go through a `BrowserFetcher` (Playwright in production) under the same robots, user agent and rate
 *    rules; sub-requests of the page are validated and images, media and fonts are not loaded.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { evaluateRobots, looksLikeHtml, parseRobots, EMPTY_ROBOTS, type RobotsFile } from "./robots";
import type { FetchStateStore } from "./state";

export const PEER_USER_AGENT = "LottePolicyMonitor/0.1 (+internal research; contact via repository owner)";
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 5;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_CRAWL_DELAY_SEC = 30;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export type SkipReason = "robots_disallowed" | "robots_unreachable" | "rate_limit_daily" | "backoff" | "crawl_delay_too_long" | "blocked_http_403" | "blocked_http_429";

export interface PageRequest {
  readonly url: string;
  readonly render: "html" | "browser";
}

export type PageResult =
  | { readonly status: "ok"; readonly finalUrl: string; readonly httpStatus: number; readonly body: string; readonly contentType: string; readonly etag?: string; readonly lastModified?: string; readonly rendered: boolean }
  | { readonly status: "not_modified" }
  | { readonly status: "skipped"; readonly reason: SkipReason }
  | { readonly status: "failed"; readonly reason: string };

/** What the peer stage depends on; tests inject a fake. */
export interface PageFetcher {
  fetchPage(req: PageRequest): Promise<PageResult>;
}

export interface BrowserFetchOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Called for every request the page makes (document, redirects, scripts, XHR); false aborts it. */
  readonly allowRequest: (url: string) => Promise<boolean>;
}

export interface BrowserFetcher {
  fetch(url: string, opts: BrowserFetchOptions): Promise<{ readonly finalUrl: string; readonly httpStatus: number; readonly html: string }>;
  close(): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type DnsResolver = (host: string) => Promise<string[]>;

export type RefusedCode = "SCHEME" | "PORT" | "CREDENTIALS" | "PRIVATE_ADDRESS" | "DNS" | "DOWNGRADE" | "REDIRECTS" | "TOO_LARGE" | "BAD_URL";

/** A URL the fetcher will not request (message holds the code and the host, never the full URL). */
export class UrlRefused extends Error {
  constructor(
    readonly code: RefusedCode,
    detail: string,
  ) {
    super(`[FETCH_${code}] ${detail}`);
    this.name = "UrlRefused";
  }
}

// --- address classification ---------------------------------------------------------------------------------

function ipv4Parts(ip: string): number[] | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Eight 16-bit groups of an IPv6 address (handles `::` and a dotted IPv4 tail), or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = ipv4Parts(tail[1]!);
    if (!v4) return null;
    s = s.slice(0, -tail[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 1 && fill !== 0) || fill < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** True only for a globally routable unicast address. Unparseable input is not public. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const p = ipv4Parts(ip);
    return p !== null && !privateV4(p[0]!, p[1]!, p[2]!);
  }
  if (family === 6) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    const embedded = (hi: number, lo: number): boolean => !privateV4(hi >> 8, hi & 255, lo >> 8);
    if (g.every((x) => x === 0) || (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1)) return false; // :: and ::1
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embedded(g6, g7); // ::ffff:a.b.c.d (mapped)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false; // ::a.b.c.d (deprecated compatible)
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7); // NAT64
    if (g0 === 0x2002) return embedded(g1, g2); // 6to4 embeds an IPv4 address
    if ((g0 & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
    if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return false; // link-local, site-local
    if ((g0 & 0xff00) === 0xff00) return false; // multicast
    if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
    if (g0 === 0x2001 && g1 === 0) return false; // Teredo
    return (g0 & 0xe000) === 0x2000; // global unicast 2000::/3 only
  }
  return false;
}

export const defaultResolveDns: DnsResolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Scheme, port and credential checks (no network). Returns the parsed URL. */
export function validateUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlRefused("BAD_URL", "not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UrlRefused("SCHEME", `scheme ${u.protocol} is not allowed (${u.hostname})`);
  if (u.username || u.password) throw new UrlRefused("CREDENTIALS", `credentials in the URL are not allowed (${u.hostname})`);
  const port = u.port === "" ? (u.protocol === "https:" ? "443" : "80") : u.port;
  if (port !== "80" && port !== "443") throw new UrlRefused("PORT", `port ${port} is not allowed (${u.hostname})`);
  if (!u.hostname) throw new UrlRefused("BAD_URL", "no host");
  return u;
}

/** Resolves the host and refuses it when any address is not public. A literal IP is checked without DNS. */
export async function assertPublicHost(u: URL, resolve: DnsResolver = defaultResolveDns): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new UrlRefused("PRIVATE_ADDRESS", `host ${host} is local`);
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new UrlRefused("DNS", `host ${host} did not resolve`);
  if (!addresses.every(isPublicAddress)) throw new UrlRefused("PRIVATE_ADDRESS", `host ${host} resolves to a non-public address`);
}

// --- fetcher -----------------------------------------------------------------------------------------------------

export interface SafeFetcherOptions {
  readonly state: FetchStateStore;
  readonly fetch?: FetchLike;
  readonly resolveDns?: DnsResolver;
  readonly browser?: BrowserFetcher;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly userAgent?: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Dry runs keep the daily limit but do not store validators (a later real run must not get a 304 for content it never saved). Default true. */
  readonly persistValidators?: boolean;
}

type RobotsOutcome = { readonly kind: "rules"; readonly file: RobotsFile } | { readonly kind: "unreachable" };
type Internal = { readonly kind: "response"; readonly res: Response; readonly body: Uint8Array; readonly finalUrl: URL } | { readonly kind: "skip"; readonly reason: SkipReason } | { readonly kind: "fail"; readonly reason: string };

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

export class SafeFetcher implements PageFetcher {
  private readonly doFetch: FetchLike;
  private readonly dns: DnsResolver;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ua: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly robots = new Map<string, Promise<RobotsOutcome>>();

  constructor(private readonly opts: SafeFetcherOptions) {
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.dns = opts.resolveDns ?? defaultResolveDns;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ua = opts.userAgent ?? PEER_USER_AGENT;
    this.maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES;
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  }

  async fetchPage(req: PageRequest): Promise<PageResult> {
    const day = utcDay(this.now());
    const claimed = new Set<string>();
    let start: URL;
    let priorDay: string | undefined;
    try {
      start = validateUrl(req.url);
      await assertPublicHost(start, this.dns);
    } catch (err) {
      return { status: "failed", reason: err instanceof UrlRefused ? err.message : "invalid URL" };
    }
    try {
      priorDay = this.opts.state.host(start.host).lastPageDay;
      const skip = await this.preflight(start, day, claimed);
      if (skip) return { status: "skipped", reason: skip };
      const result = req.render === "browser" ? await this.viaBrowser(start, day, priorDay) : await this.viaHttp(req.url, start, day, claimed);
      return result;
    } finally {
      await this.opts.state.flush();
    }
  }

  // --- robots, daily limit, back-off ---------------------------------------------------------------------------

  /** Null when the page may be requested (the host slot is then claimed), else the reason to skip. */
  private async preflight(url: URL, day: string, claimed: Set<string>): Promise<SkipReason | null> {
    const host = url.host;
    const hs = this.opts.state.host(host);
    if (hs.backoffUntilDay && day < hs.backoffUntilDay) return "backoff";
    if (hs.lastPageDay === day && !claimed.has(host)) return "rate_limit_daily";
    const robots = await this.robotsFor(url);
    if (robots.kind === "unreachable") return "robots_unreachable";
    const decision = evaluateRobots(robots.file, this.ua, `${url.pathname}${url.search}`);
    if (!decision.allowed) return "robots_disallowed";
    if (decision.crawlDelay !== undefined && decision.crawlDelay > MAX_CRAWL_DELAY_SEC) return "crawl_delay_too_long";
    if (!claimed.has(host)) {
      this.opts.state.setHost(host, { lastPageDay: day });
      claimed.add(host);
      await this.opts.state.flush();
      if (decision.crawlDelay && decision.crawlDelay > 0) await this.sleep(decision.crawlDelay * 1000);
    }
    return null;
  }

  private robotsFor(url: URL): Promise<RobotsOutcome> {
    let p = this.robots.get(url.origin);
    if (!p) {
      p = this.fetchRobots(url.origin);
      this.robots.set(url.origin, p);
    }
    return p;
  }

  private async fetchRobots(origin: string): Promise<RobotsOutcome> {
    const r = await this.get(new URL("/robots.txt", origin), "text/plain,*/*;q=0.1", null, MAX_ROBOTS_BYTES);
    if (r.kind !== "response") return { kind: "unreachable" };
    const s = r.res.status;
    if (s >= 200 && s < 300) {
      const body = new TextDecoder("utf-8").decode(r.body);
      return looksLikeHtml(body, r.res.headers.get("content-type")) ? { kind: "rules", file: EMPTY_ROBOTS } : { kind: "rules", file: parseRobots(body) };
    }
    if (s === 401 || s === 403 || s === 429 || s >= 500) return { kind: "unreachable" };
    return { kind: "rules", file: EMPTY_ROBOTS }; // 404, 410, 400 ...: no rules
  }

  // --- HTTP -----------------------------------------------------------------------------------------------------

  /** One request chain with manual redirects. `hop` runs before every redirect target is requested (robots and rate for pages). */
  private async get(start: URL, accept: string, hop: ((next: URL) => Promise<Internal | null>) | null, maxBytes: number, validators?: { etag?: string; lastModified?: string }): Promise<Internal> {
    let url = start;
    for (let i = 0; ; i++) {
      let res: Response;
      try {
        if (i > 0) await assertPublicHost(url, this.dns);
        const headers: Record<string, string> = { "user-agent": this.ua, accept, "accept-language": "ko,en;q=0.5" };
        if (validators?.etag) headers["if-none-match"] = validators.etag;
        if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;
        res = await this.doFetch(url.href, { method: "GET", redirect: "manual", headers, credentials: "omit", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (err instanceof UrlRefused) return { kind: "fail", reason: err.message };
        return { kind: "fail", reason: `network: ${err instanceof Error ? err.name : "error"}` };
      }
      const location = res.headers.get("location");
      if (REDIRECT_STATUS.has(res.status) && location) {
        await res.body?.cancel().catch(() => undefined);
        if (i >= this.maxRedirects) return { kind: "fail", reason: new UrlRefused("REDIRECTS", `more than ${this.maxRedirects} redirects (${start.hostname})`).message };
        let next: URL;
        try {
          next = validateUrl(new URL(location, url).href);
          if (url.protocol === "https:" && next.protocol === "http:") throw new UrlRefused("DOWNGRADE", `redirect from https to http refused (${url.hostname})`);
          await assertPublicHost(next, this.dns);
        } catch (err) {
          return { kind: "fail", reason: err instanceof UrlRefused ? err.message : "invalid redirect target" };
        }
        if (hop) {
          const stop = await hop(next);
          if (stop) return stop;
        }
        url = next;
        continue;
      }
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "response", res, body: new Uint8Array(0), finalUrl: url };
      }
      try {
        return { kind: "response", res, body: await readCapped(res, maxBytes), finalUrl: url };
      } catch (err) {
        return { kind: "fail", reason: err instanceof UrlRefused ? err.message : `network: ${err instanceof Error ? err.name : "error"}` };
      }
    }
  }

  private async viaHttp(key: string, start: URL, day: string, claimed: Set<string>): Promise<PageResult> {
    const prior = this.opts.state.url(key);
    const hop = async (next: URL): Promise<Internal | null> => {
      const skip = await this.preflight(next, day, claimed);
      return skip ? { kind: "skip", reason: skip } : null;
    };
    const r = await this.get(start, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", hop, this.maxBytes, prior);
    if (r.kind === "skip") return { status: "skipped", reason: r.reason };
    if (r.kind === "fail") return { status: "failed", reason: r.reason };
    const s = r.res.status;
    if (s === 304) return { status: "not_modified" };
    const blocked = this.backoff(r.finalUrl.host, s, day);
    if (blocked) return blocked;
    if (s < 200 || s >= 300) return { status: "failed", reason: `http_${s}` };
    const contentType = r.res.headers.get("content-type") ?? "";
    if (contentType && !/^(text\/|application\/xhtml)/i.test(contentType)) return { status: "failed", reason: `unsupported_content_type: ${contentType.split(";")[0]}` };
    this.opts.state.setHost(r.finalUrl.host, { strikes: 0, backoffUntilDay: undefined });
    const etag = r.res.headers.get("etag") ?? undefined;
    const lastModified = r.res.headers.get("last-modified") ?? undefined;
    if (this.opts.persistValidators !== false) this.opts.state.setUrl(key, { etag, lastModified, lastCheckedAt: this.now().toISOString() });
    return { status: "ok", finalUrl: r.finalUrl.href, httpStatus: s, body: decodeBody(r.body, contentType), contentType, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}), rendered: false };
  }

  /** A 403 or 429 blocks the host for 1, 2, 4 ... (max 7) days. */
  private backoff(host: string, status: number, day: string): PageResult | null {
    if (status !== 403 && status !== 429) return null;
    const strikes = (this.opts.state.host(host).strikes ?? 0) + 1;
    this.opts.state.setHost(host, { strikes, backoffUntilDay: addDays(day, Math.min(2 ** (strikes - 1), 7)) });
    return { status: "skipped", reason: status === 403 ? "blocked_http_403" : "blocked_http_429" };
  }

  private async viaBrowser(url: URL, day: string, priorDay: string | undefined): Promise<PageResult> {
    const browser = this.opts.browser;
    if (!browser) return { status: "failed", reason: "browser_unavailable" };
    try {
      const r = await browser.fetch(url.href, {
        userAgent: this.ua,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
        allowRequest: async (u) => {
          try {
            await assertPublicHost(validateUrl(u), this.dns);
            return true;
          } catch {
            return false;
          }
        },
      });
      const blocked = this.backoff(url.host, r.httpStatus, day);
      if (blocked) return blocked;
      if (r.httpStatus < 200 || r.httpStatus >= 300) return { status: "failed", reason: `http_${r.httpStatus}` };
      if (Buffer.byteLength(r.html, "utf8") > this.maxBytes) return { status: "failed", reason: new UrlRefused("TOO_LARGE", `rendered page exceeds ${this.maxBytes} bytes`).message };
      this.opts.state.setHost(url.host, { strikes: 0, backoffUntilDay: undefined });
      return { status: "ok", finalUrl: r.finalUrl, httpStatus: r.httpStatus, body: r.html, contentType: "text/html", rendered: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "error";
      // The page was never requested (the browser could not start, or the TLS handshake was refused): the host's slot is not used up.
      if (/net::ERR_CERT|net::ERR_PROXY|Executable doesn't exist|Failed to launch/i.test(message)) this.opts.state.setHost(url.host, { lastPageDay: priorDay });
      return { status: "failed", reason: `browser: ${message.split("\n")[0]!.slice(0, 120)}` };
    }
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new UrlRefused("TOO_LARGE", `response is ${declared} bytes; the cap is ${max}`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new UrlRefused("TOO_LARGE", `response exceeds the cap of ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Charset from the header, else a `<meta charset>` in the first 2 KB, else UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label as "utf-8").decode(bytes);
    } catch {
      // unknown label: try the next
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
