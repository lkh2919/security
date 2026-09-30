#!/usr/bin/env bun
/**
 * capture-lotte.ts - polite, re-runnable, idempotent capture of PUBLIC Lotte-group
 * privacy policies and terms pages (finance affiliates excluded by scope).
 *
 * Usage:
 *   bun scripts/capture-lotte.ts                 capture every entry in sites.json
 *   bun scripts/capture-lotte.ts --only <id,id>  capture only the listed ids
 *   bun scripts/capture-lotte.ts discover <url>  list policy/terms-looking links on ONE page (discovery aid)
 *
 * Inputs : kb/jurisdictions/kr/clauses/_captures/sites.json
 * Outputs: kb/_sources/lotte/<slug>/<stem>-<YYYYMMDD>.html|.txt   (gitignored raw material)
 *          kb/jurisdictions/kr/clauses/_captures/index.json       (committable provenance metadata)
 *
 * Rules: robots.txt respected per host, one request per page, delay between requests,
 * no login, no forms, no crawling. Unchanged content (same sha256) is skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CAP_DIR = join(ROOT, "kb/jurisdictions/kr/clauses/_captures");
const SITES_PATH = join(CAP_DIR, "sites.json");
const INDEX_PATH = join(CAP_DIR, "index.json");
const RAW_DIR = join(ROOT, "kb/_sources/lotte");
const UA = "privacy-agent-kb-curator/1.0 (public policy capture; low rate; respects robots.txt)";
const ROBOTS_TOKEN = "privacy-agent";
const DELAY_MS = 2500;
const MIN_TEXT_CHARS = 400;

type SiteEntry = {
  id: string;
  slug: string;
  site: string;
  affiliate: string;
  domainGroup: string;
  provenance: "user_supplied" | "agent_discovered";
  docType: "privacy" | "terms";
  subType?: string;
  url: string; // public page a person opens
  fetchUrl?: string; // underlying document URL when the page loads a fragment
  fileStem?: string;
  versionHint?: string; // hand-verified version/effective date when not machine-detectable
  notes?: string;
  excluded?: string; // user decision text; entry is never fetched (excluded_robots)
  browser?: boolean; // captured with the browser pane; script leaves the index entry untouched
};

type Capture = {
  id: string;
  site: string;
  slug: string;
  affiliate: string;
  domainGroup: string;
  provenance: string;
  url: string;
  fetchUrl: string | null;
  docType: string;
  subType: string | null;
  title: string | null;
  policyVersionOrEffectiveDate: string | null;
  captureDate: string;
  lastCheckedAt: string;
  httpStatus: number | null;
  capture: "ok" | "ok_browser" | "excluded_robots" | "failed_js" | "failed_http" | "failed_network" | "blocked_robots";
  charset: string | null;
  contentSha256: string | null; // sha256 of the cleaned UTF-8 text (stable against per-request tokens)
  rawSha256: string | null; // sha256 of the raw response bytes
  bytes: number | null;
  textChars: number | null;
  files: { html: string; txt: string } | null;
  headingList: string[];
  robots: string;
  notes: string;
  history: { captureDate: string; contentSha256: string }[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------- robots.txt ----------
type RobotsRules = { rules: { allow: boolean; pat: RegExp; len: number }[]; status: string };
const robotsCache = new Map<string, RobotsRules>();

function patToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

async function getRobots(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let res: RobotsRules = { rules: [], status: "no robots.txt (allowed)" };
  try {
    const r = await fetch(origin + "/robots.txt", {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    const ct = r.headers.get("content-type") ?? "";
    const text = await r.text();
    if (r.status === 200 && !/html/i.test(ct) && !/<html/i.test(text.slice(0, 500))) {
      const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
      let cur: (typeof groups)[number] | null = null;
      let lastWasAgent = false;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim();
        const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const k = m[1].toLowerCase();
        const v = m[2].trim();
        if (k === "user-agent") {
          if (!cur || !lastWasAgent) {
            cur = { agents: [], rules: [] };
            groups.push(cur);
          }
          cur.agents.push(v.toLowerCase());
          lastWasAgent = true;
        } else if ((k === "allow" || k === "disallow") && cur) {
          lastWasAgent = false;
          if (v) cur.rules.push({ allow: k === "allow", path: v });
        } else lastWasAgent = false;
      }
      const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ROBOTS_TOKEN.includes(a)));
      const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
      const rules = chosen.flatMap((g) => g.rules).map((r) => ({ allow: r.allow, pat: patToRegex(r.path), len: r.path.length }));
      const dis = chosen.flatMap((g) => g.rules).filter((r) => !r.allow).map((r) => r.path);
      res = { rules, status: `robots.txt ok (${dis.length} disallow rule(s)${dis.length ? ": " + dis.slice(0, 6).join(" ") : ""})` };
    } else if (r.status === 200) {
      res = { rules: [], status: "robots.txt returned HTML (treated as absent, allowed)" };
    } else {
      res = { rules: [], status: `robots.txt HTTP ${r.status} (treated as absent, allowed)` };
    }
  } catch (e) {
    res = { rules: [], status: `robots.txt unreachable (${(e as Error).message.slice(0, 60)}); host fetch decides` };
  }
  robotsCache.set(origin, res);
  return res;
}

function robotsAllows(r: RobotsRules, pathAndQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of r.rules) {
    if (rule.pat.test(pathAndQuery) && (!best || rule.len > best.len || (rule.len === best.len && rule.allow))) {
      best = { allow: rule.allow, len: rule.len };
    }
  }
  return best ? best.allow : true;
}

// ---------- fetching and decoding ----------
function detectCharset(headers: Headers, bytes: Uint8Array): string {
  const ct = headers.get("content-type") ?? "";
  const m1 = ct.match(/charset=([\w-]+)/i);
  if (m1) return m1[1].toLowerCase();
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const m2 = head.match(/<meta[^>]+charset=["']?([\w-]+)/i) ?? head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
  return m2 ? m2[1].toLowerCase() : "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
  const cs = /^(ks_c_5601-1987|euc_kr|ks_c_5601|cp949|ms949)$/i.test(charset) ? "euc-kr" : charset;
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ENT: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", middot: "·", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bull: "•", ndash: "–", mdash: "—" };
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): { text: string; headings: string[]; title: string | null } {
  const title = (() => {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? stripTags(m[1]) || null : null;
  })();
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, "");
  const headings: string[] = [];
  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => {
    const t = stripTags(inner);
    if (t) headings.push(t);
    return t ? `\n\n${"#".repeat(Number(n))} ${t}\n` : "\n";
  });
  h = h
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|dl|blockquote|form|header|footer)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<(p|div|tr|dt|dd)\b[^>]*>/gi, "\n");
  let text = decodeEntities(h.replace(/<[^>]*>/g, ""));
  text = text
    .split("\n")
    .map((l) => l.replace(/[ \t 　]+/g, " ").trim())
    .join("\n")
    .replace(/(\s*\|\s*)+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, headings, title };
}

// numbered heading-like lines (제N조, 1., 가., ①, 제N장, I.) that are short
const NUM_HEAD = /^(제\s*\d+\s*[조장절]|\d{1,2}\s*[.)]\s*\S|[가-하]\s*[.)]\s*\S|[IVX]{1,4}\s*[.)]\s*\S|[①-⑳]\s*\S|\d{1,2}\.\d{1,2}\.?\s+\S)/;
function headingList(text: string, tagHeads: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.replace(/^#+\s*/, "").trim().slice(0, 90);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (t.startsWith("#")) push(t);
    else if (t.length <= 60 && NUM_HEAD.test(t) && !/[다요]\.$/.test(t)) push(t);
    if (out.length >= 80) break;
  }
  if (!out.length) tagHeads.slice(0, 80).forEach(push);
  return out;
}

function findVersion(text: string): string | null {
  const found: string[] = [];
  const pats = [
    /(시행\s*일자?|공고\s*일자?|적용\s*일자?|개정\s*일자?|최종\s*(?:개정|수정)\s*일|시행일)\s*[:：]?\s*(\d{4}\s*[.\-년/]\s*\d{1,2}\s*[.\-월/]\s*\d{1,2}\s*일?)/g,
    /(\d{4}\s*[.\-년/]\s*\d{1,2}\s*[.\-월/]\s*\d{1,2}\s*일?)\s*(?:부터\s*)?(시행|적용|개정|공고)/g,
    /(v(?:er(?:sion)?)?\.?\s*\d+(?:\.\d+){1,3})/gi,
    /(버전|Version)\s*[:：]?\s*(\d+(?:\.\d+)*)/g,
  ];
  for (const p of pats) {
    for (const m of text.matchAll(p)) {
      found.push(m[0].replace(/\s+/g, " ").trim());
      if (found.length >= 4) break;
    }
  }
  return found.length ? [...new Set(found)].slice(0, 4).join(" ; ") : null;
}

// ---------- capture ----------
function stem(e: SiteEntry) {
  return e.fileStem ?? (e.subType ? `${e.docType}-${e.subType}` : e.docType);
}

async function captureOne(e: SiteEntry, prev: Capture | undefined): Promise<Capture> {
  const target = e.fetchUrl ?? e.url;
  const u = new URL(target);
  const base: Capture = {
    id: e.id, site: e.site, slug: e.slug, affiliate: e.affiliate, domainGroup: e.domainGroup, provenance: e.provenance,
    url: e.url, fetchUrl: e.fetchUrl ?? null, docType: e.docType, subType: e.subType ?? null,
    title: prev?.title ?? null, policyVersionOrEffectiveDate: null, captureDate: prev?.captureDate ?? today(),
    lastCheckedAt: today(), httpStatus: null, capture: "failed_network", charset: null, contentSha256: prev?.contentSha256 ?? null, rawSha256: prev?.rawSha256 ?? null,
    bytes: prev?.bytes ?? null, textChars: prev?.textChars ?? null, files: prev?.files ?? null, headingList: prev?.headingList ?? [],
    robots: "", notes: e.notes ?? "", history: prev?.history ?? [],
  };
  const robots = await getRobots(u.origin);
  base.robots = robots.status;
  if (!robotsAllows(robots, u.pathname + u.search)) {
    base.capture = "blocked_robots";
    base.notes = (base.notes + " Disallowed by robots.txt; not fetched.").trim();
    return base;
  }
  let r: Response;
  let bytes: Uint8Array;
  try {
    r = await fetch(target, { headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5", "accept-language": "ko,en;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (err) {
    base.notes = (base.notes + ` Network error: ${(err as Error).message.slice(0, 120)}.`).trim();
    return base;
  }
  base.httpStatus = r.status;
  if (r.url && r.url !== target) base.notes = (base.notes + ` Redirected to ${r.url}.`).trim();
  if (r.status >= 400) {
    base.capture = "failed_http";
    return base;
  }
  const charset = detectCharset(r.headers, bytes);
  const html = decode(bytes, charset);
  const { text, headings, title } = htmlToText(html);
  const hash = sha256(new TextEncoder().encode(text));
  base.rawSha256 = sha256(bytes);
  base.charset = charset;
  base.title = title ?? base.title;
  base.bytes = bytes.length;
  base.textChars = text.length;
  base.headingList = headingList(text, headings);
  base.policyVersionOrEffectiveDate = e.versionHint ?? findVersion(text);
  if (text.length < MIN_TEXT_CHARS) {
    base.capture = "failed_js";
    base.contentSha256 = hash;
    base.notes = (base.notes + " Little or no policy text in the served HTML (JS-rendered or fragment loaded elsewhere); not stored.").trim();
    base.files = null;
    return base;
  }
  base.capture = "ok";
  if (prev && prev.contentSha256 === hash && prev.files && existsSync(join(ROOT, prev.files.html))) {
    // unchanged: keep original captureDate and files
    base.captureDate = prev.captureDate;
    base.files = prev.files;
    base.contentSha256 = hash;
    base.notes = (base.notes + " Unchanged since previous capture.").trim();
    return base;
  }
  base.captureDate = today();
  base.contentSha256 = hash;
  const day = base.captureDate.replaceAll("-", "");
  const rel = `kb/_sources/lotte/${e.slug}/${stem(e)}-${day}`;
  mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
  writeFileSync(join(ROOT, rel + ".html"), html, "utf8");
  writeFileSync(join(ROOT, rel + ".txt"), text + "\n", "utf8");
  base.files = { html: rel + ".html", txt: rel + ".txt" };
  if (prev?.contentSha256 && prev.contentSha256 !== hash) base.history = [...base.history, { captureDate: prev.captureDate, contentSha256: prev.contentSha256 }];
  return base;
}

async function runCapture(only: Set<string> | null) {
  const sites: { sites: SiteEntry[] } = JSON.parse(readFileSync(SITES_PATH, "utf8"));
  const index: { generated?: string; captures: Capture[] } = existsSync(INDEX_PATH) ? JSON.parse(readFileSync(INDEX_PATH, "utf8")) : { captures: [] };
  const byId = new Map(index.captures.map((c) => [c.id, c]));
  let lastHost = "";
  let n = 0;
  for (const e of sites.sites) {
    if (only && !only.has(e.id)) continue;
    if (e.browser) continue; // browser-pane captures are maintained by hand
    if (e.excluded) {
      const p = byId.get(e.id);
      byId.set(e.id, {
        ...(p ?? ({} as Capture)), id: e.id, site: e.site, slug: e.slug, affiliate: e.affiliate, domainGroup: e.domainGroup,
        provenance: e.provenance, url: e.url, fetchUrl: e.fetchUrl ?? null, docType: e.docType, subType: e.subType ?? null,
        capture: "excluded_robots", lastCheckedAt: today(), captureDate: p?.captureDate ?? today(), httpStatus: null,
        title: null, policyVersionOrEffectiveDate: null, charset: null, contentSha256: null, rawSha256: null, bytes: null,
        textChars: null, files: null, headingList: [], robots: "Disallowed by robots.txt", history: [],
        notes: e.excluded,
      } as Capture);
      console.log(`excluded_robots        ${e.id}`);
      continue;
    }
    const host = new URL(e.fetchUrl ?? e.url).host;
    if (n > 0) await sleep(host === lastHost ? DELAY_MS + 1000 : DELAY_MS);
    lastHost = host;
    n++;
    const cap = await captureOne(e, byId.get(e.id));
    byId.set(e.id, cap);
    console.log(`${cap.capture.padEnd(15)} ${String(cap.httpStatus ?? "-").padEnd(4)} ${String(cap.textChars ?? "-").padStart(7)}ch  ${e.id}`);
    // persist after each entry so an interrupted run loses nothing
    const order = new Map(sites.sites.map((s, i) => [s.id, i]));
    const captures = [...byId.values()].sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
    mkdirSync(CAP_DIR, { recursive: true });
    writeFileSync(INDEX_PATH, JSON.stringify({ generated: new Date().toISOString(), note: "Committable provenance metadata only. Raw snapshots live in kb/_sources/ (gitignored).", captures }, null, 2) + "\n", "utf8");
  }
}

// ---------- discovery aid ----------
async function discover(url: string) {
  const u = new URL(url);
  const robots = await getRobots(u.origin);
  console.log(`# ${url}  [${robots.status}]`);
  if (!robotsAllows(robots, u.pathname + u.search)) return console.log("BLOCKED by robots");
  let bytes: Uint8Array;
  let r: Response;
  try {
    r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30000) });
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    return console.log("ERR " + (e as Error).message);
  }
  const html = decode(bytes, detectCharset(r.headers, bytes));
  console.log(`# HTTP ${r.status} final=${r.url} bytes=${bytes.length}`);
  const kw = /개인정보|privacy|이용약관|약관|terms|policy|처리방침|cctv|영상정보|위치기반|agree|clause|stipulation/i;
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/href\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const onclick = m[1].match(/onclick\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const label = stripTags(m[2]);
    if (!(kw.test(label) || kw.test(href) || kw.test(onclick))) continue;
    let abs = href;
    try { abs = new URL(href, r.url).toString(); } catch { /* keep raw */ }
    const key = label + abs + onclick;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${label.slice(0, 40)} -> ${abs}${onclick ? "  [onclick " + onclick.slice(0, 80) + "]" : ""}`);
  }
  for (const m of html.matchAll(/<(?:iframe|frame)\b[^>]*src\s*=\s*["']([^"']*)["']/gi)) console.log("IFRAME -> " + m[1]);
}

const args = process.argv.slice(2);
if (args[0] === "discover" && args[1]) await discover(args[1]);
else {
  const oi = args.indexOf("--only");
  await runCapture(oi >= 0 ? new Set(args[oi + 1].split(",")) : null);
}
