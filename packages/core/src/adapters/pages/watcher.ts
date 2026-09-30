/**
 * PageWatcher: change detection for official pages without an API (PIPC guideline boards, KFTC standard terms).
 * Detection is by content, never by HTTP status: old ftc.go.kr URLs answer 200 with the homepage.
 */
import { createHash } from "node:crypto";
import { redactSecrets } from "../lawapi/redact";

export type PageKind = "pipc-board" | "privacy-board" | "ftc-list" | "ftc-view";

export interface PageTarget {
  readonly sourceId: string;
  readonly name: string;
  readonly kind: PageKind;
  readonly url: string;
}

export interface PageItem {
  readonly id: string;
  readonly title: string;
  readonly date: string | null;
  readonly attachment: string | null;
}

export type PageProblem = "unreachable" | "redirected_homepage" | "unexpected_content";

export interface PageSnapshot {
  readonly target: PageTarget;
  readonly ok: boolean;
  readonly problem?: PageProblem;
  readonly detail?: string;
  readonly pageTitle: string;
  /** Items relevant to the watch (guideline rows, tracked standard terms). */
  readonly items: PageItem[];
  /** SHA-256 over the relevant items; comparable with `Manifest.pages[].titleHash`. */
  readonly titleHash: string;
  /** Highest edition token found in relevant titles (e.g. "2026.4"), if any. */
  readonly latestEdition: string | null;
}

export const GUIDELINE_TITLE = /처리방침\s*작성지침/;
const ONLINE_TERMS = /전자상거래|온라인|인터넷|모바일|해외구매/;

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function clean(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? clean(m[1] ?? "") : "";
}

function rowsOf(html: string): string[] {
  return [...html.matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map((m) => m[0]);
}

const DATE = /\b(20\d{2}-\d{2}-\d{2})\b/;

export function parsePipcBoard(html: string): PageItem[] {
  const items: PageItem[] = [];
  for (const row of rowsOf(html)) {
    const a = /<a[^>]*nttId=(\d+)[^>]*>([\s\S]*?)<\/a>/.exec(row);
    if (!a) continue;
    const title = clean(a[2] ?? "").replace(/^\[[^\]]*\]\s*/, "");
    items.push({ id: a[1] ?? "", title, date: DATE.exec(clean(row))?.[1] ?? null, attachment: null });
  }
  return items;
}

export function parsePrivacyBoard(html: string): PageItem[] {
  const items: PageItem[] = [];
  for (const row of rowsOf(html)) {
    const a = /\$bbs\.view\('(\d+)'[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/.exec(row);
    if (!a) continue;
    items.push({ id: a[1] ?? "", title: clean(a[2] ?? ""), date: DATE.exec(clean(row))?.[1] ?? null, attachment: null });
  }
  return items;
}

export function parseFtcList(html: string): PageItem[] {
  const items: PageItem[] = [];
  for (const row of rowsOf(html)) {
    const a = /selectBbsNttView\.do[^"']*nttSn=(\d+)[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/.exec(row);
    if (!a) continue;
    const title = clean(a[2] ?? "");
    const no = /\[(제\d+호)\]/.exec(title)?.[1] ?? (a[1] ?? "");
    items.push({ id: no, title, date: DATE.exec(clean(row))?.[1] ?? null, attachment: null });
  }
  return items;
}

export function parseFtcView(html: string): PageItem[] {
  const t = /p-table__subject_text">([\s\S]*?)<\/div>/.exec(html);
  if (!t) return [];
  const title = clean(t[1] ?? "");
  const att = /class="p-attach__link">([\s\S]*?)<span/.exec(html);
  const no = /\[(제\d+호)\]/.exec(title)?.[1] ?? title;
  return [{ id: no, title, date: DATE.exec(clean(html))?.[1] ?? null, attachment: att ? clean(att[1] ?? "") : null }];
}

/** Edition token such as "2026.4" or "2026" from a guideline title. */
export function editionOf(title: string): string | null {
  const m = /(20\d{2})\s*\.\s*(\d{1,2})/.exec(title) ?? /(20\d{2})/.exec(title);
  if (!m) return null;
  return m[2] ? `${m[1]}.${Number(m[2])}` : (m[1] ?? null);
}

function editionRank(e: string): number {
  const [y, mo] = e.split(".");
  return Number(y) * 100 + Number(mo ?? 0);
}

/** Pure classification of fetched content (exported for fixture tests). */
export function analyzePage(target: PageTarget, finalUrl: string, html: string): PageSnapshot {
  const pageTitle = htmlTitle(html);
  const base = { target, pageTitle, items: [] as PageItem[], titleHash: sha256(""), latestEdition: null as string | null };
  const fail = (problem: PageProblem, detail: string): PageSnapshot => ({ ...base, ok: false, problem, detail });

  const expectedPath = new URL(target.url).pathname.replace(/^\/www(?=\/)/, "");
  let finalPath = "";
  try {
    finalPath = new URL(finalUrl).pathname.replace(/^\/www(?=\/)/, "");
  } catch {
    /* keep empty */
  }
  const isFtc = target.kind === "ftc-list" || target.kind === "ftc-view";
  if (isFtc) {
    if (finalPath !== expectedPath || /index\.do$/.test(finalPath) || pageTitle === "공정거래위원회") {
      return fail("redirected_homepage", `expected ${expectedPath}, got ${finalPath || "?"} (title "${pageTitle}")`);
    }
  }

  let items: PageItem[];
  switch (target.kind) {
    case "pipc-board":
      items = parsePipcBoard(html);
      break;
    case "privacy-board":
      items = parsePrivacyBoard(html);
      break;
    case "ftc-list":
      items = parseFtcList(html);
      break;
    case "ftc-view":
      items = parseFtcView(html);
      break;
  }
  if (items.length === 0) return fail("unexpected_content", "no rows recognised");

  let relevant: PageItem[];
  if (target.kind === "pipc-board" || target.kind === "privacy-board") {
    relevant = items.filter((i) => GUIDELINE_TITLE.test(i.title));
    if (relevant.length === 0) return fail("unexpected_content", "no privacy policy drafting guideline row on the first list page");
  } else if (target.kind === "ftc-list") {
    relevant = items.filter((i) => ONLINE_TERMS.test(i.title));
  } else {
    relevant = items;
  }

  const editions = relevant.map((i) => editionOf(i.title)).filter((e): e is string => e !== null);
  const latestEdition = editions.length ? editions.reduce((a, b) => (editionRank(b) > editionRank(a) ? b : a)) : null;
  const canonical = relevant
    .map((i) => `${i.id}|${i.title}|${i.date ?? ""}|${i.attachment ?? ""}`)
    .sort()
    .join("\n");
  return { ...base, ok: true, items: relevant, titleHash: sha256(canonical), latestEdition };
}

export interface PageWatcherOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly backoffMs?: number;
  readonly minIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class PageWatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private last = 0;

  constructor(o: PageWatcherOptions = {}) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.retries = o.retries ?? 2;
    this.backoffMs = o.backoffMs ?? 750;
    this.minIntervalMs = o.minIntervalMs ?? 1000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  async snapshot(target: PageTarget): Promise<PageSnapshot> {
    let detail = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      const wait = this.last + this.minIntervalMs - this.now();
      if (this.last > 0 && wait > 0) await this.sleep(wait);
      this.last = this.now();
      try {
        const res = await this.fetchImpl(target.url, {
          headers: { "user-agent": "privacy-agent-freshness/0.1" },
          redirect: "follow",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status >= 500) {
          detail = `HTTP ${res.status}`;
          continue;
        }
        if (!res.ok) {
          detail = `HTTP ${res.status}`;
          break;
        }
        return analyzePage(target, res.url || target.url, await res.text());
      } catch (err) {
        detail = redactSecrets(err instanceof Error ? err.message : String(err));
      }
    }
    return { target, ok: false, problem: "unreachable", detail, pageTitle: "", items: [], titleHash: sha256(""), latestEdition: null };
  }
}
