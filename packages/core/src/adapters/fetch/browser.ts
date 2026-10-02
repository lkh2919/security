/**
 * Browser fetcher for pages whose policy text needs JavaScript (design C5). Playwright (`playwright-core`) drives the preinstalled
 * Chromium (`PLAYWRIGHT_BROWSERS_PATH`, default /opt/pw-browsers). Each fetch uses a fresh context (no cookies survive), blocks
 * images, media and fonts, aborts every request the injected `allowRequest` refuses, and waits for network idle. The result is the
 * rendered document HTML, which then goes through the same cleaner as a plain response.
 *
 * `playwright-core` is imported lazily: nothing here runs unless a peer needs `render: js_required`.
 */
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserFetchOptions, BrowserFetcher, SelectSpec } from "./safe-fetch";

interface PwResponse {
  status(): number;
}
interface PwRequest {
  url(): string;
  resourceType(): string;
}
interface PwRoute {
  request(): PwRequest;
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface PwPage {
  route(url: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<PwResponse | null>;
  waitForLoadState(state: string, o: { timeout: number }): Promise<void>;
  content(): Promise<string>;
  url(): string;
  selectOption(selector: string, values: { label: string } | { value: string }, o: { timeout: number; force?: boolean }): Promise<string[]>;
  evaluate<T>(expression: string): Promise<T>;
  waitForFunction(expression: string, arg: unknown, o: { timeout: number }): Promise<unknown>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(o: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(o: Record<string, unknown>): Promise<PwBrowser>;
}

/** An explicit executable (env `PEER_CHROMIUM_PATH`, else the first Chromium build under the browsers folder) when Playwright's own lookup fails. */
export function findChromium(browsersPath = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "/opt/pw-browsers"): string | undefined {
  const explicit = process.env["PEER_CHROMIUM_PATH"];
  if (explicit && existsSync(explicit)) return explicit;
  if (!existsSync(browsersPath)) return undefined;
  for (const dir of readdirSync(browsersPath).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const exe = join(browsersPath, dir, "chrome-linux", "chrome");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

/**
 * `--ignore-certificate-errors-spki-list` value for the CA certificates in a PEM file: base64 SHA-256 of each SubjectPublicKeyInfo.
 * Chromium then accepts chains through exactly these keys and still verifies everything else. Opt-in through `PEER_BROWSER_CA_FILE`
 * for sandboxes where a TLS-inspecting egress proxy signs with a CA that is not in the browser's NSS store (it is not a switch that
 * turns certificate checks off).
 */
export function spkiHashes(pemFile: string): string[] {
  const pem = readFileSync(pemFile, "utf8");
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => createHash("sha256").update(new X509Certificate(m[0]).publicKey.export({ type: "spki", format: "der" })).digest("base64"));
}

/** Page functions as source text; `call` turns one into an expression (Playwright invokes a string only as an expression, not as a function). */
const call = (fn: string, arg: unknown): string => `(${fn})(${JSON.stringify(arg)})`;

/** Browser-side: text and outer HTML of the first visible element that matches the selector (page functions, run by Playwright). */
const VISIBLE_TEXT = `(cs) => { for (const e of document.querySelectorAll(cs)) { const st = getComputedStyle(e); if (e.getClientRects().length > 0 && st.visibility !== "hidden" && st.display !== "none") return (e.textContent || "").replace(/\\s+/g, " ").trim(); } return null; }`;
const VISIBLE_HTML = `(cs) => { for (const e of document.querySelectorAll(cs)) { const st = getComputedStyle(e); if (e.getClientRects().length > 0 && st.visibility !== "hidden" && st.display !== "none") return e.outerHTML; } return null; }`;
const CHANGED_TEXT = `([cs, prev]) => { for (const e of document.querySelectorAll(cs)) { const st = getComputedStyle(e); if (e.getClientRects().length > 0 && st.visibility !== "hidden" && st.display !== "none") { const t = (e.textContent || "").replace(/\\s+/g, " ").trim(); return t.length > 0 && t !== prev; } } return false; }`;

/** Opens the select with the option chosen and returns the policy container (outer HTML). Throws when the content does not change. */
async function chooseVersion(page: PwPage, sel: SelectSpec, timeoutMs: number): Promise<string> {
  const before = await page.evaluate<string | null>(call(VISIBLE_TEXT, sel.contentSelector));
  if (before === null) throw new Error(`select: content container "${sel.contentSelector}" not visible`);
  const timeout = Math.min(10_000, timeoutMs);
  try {
    // `force`: widget libraries (jQuery UI selectmenu) hide the native select and draw their own button; the native select still drives the page.
    await page.selectOption(sel.selector, { label: sel.value }, { timeout, force: true });
  } catch {
    await page.selectOption(sel.selector, { value: sel.value }, { timeout, force: true });
  }
  await page.waitForFunction(call(CHANGED_TEXT, [sel.contentSelector, before]), undefined, { timeout }).catch(() => {
    throw new Error("select: content did not change after choosing the option");
  });
  const html = await page.evaluate<string | null>(call(VISIBLE_HTML, sel.contentSelector));
  if (html === null) throw new Error("select: content container disappeared");
  return html;
}

const BLOCKED_RESOURCES = new Set(["image", "media", "font"]);

export class PlaywrightBrowserFetcher implements BrowserFetcher {
  private browser: Promise<PwBrowser> | null = null;

  private launch(): Promise<PwBrowser> {
    this.browser ??= (async () => {
      const mod = (await import("playwright-core")) as unknown as { chromium: PwChromium };
      const proxy = process.env["HTTPS_PROXY"] ?? process.env["https_proxy"];
      const caFile = process.env["PEER_BROWSER_CA_FILE"];
      const args = [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...(caFile && existsSync(caFile) ? [`--ignore-certificate-errors-spki-list=${spkiHashes(caFile).join(",")}`] : [])];
      const common = { headless: true, ...(proxy ? { proxy: { server: proxy } } : {}), ...(args.length > 0 ? { args } : {}) };
      try {
        return await mod.chromium.launch(common);
      } catch (first) {
        const exe = findChromium();
        if (!exe) throw first;
        return mod.chromium.launch({ ...common, executablePath: exe });
      }
    })();
    return this.browser;
  }

  async fetch(url: string, opts: BrowserFetchOptions): Promise<{ finalUrl: string; httpStatus: number; html: string }> {
    const browser = await this.launch();
    const context = await browser.newContext({ userAgent: opts.userAgent, acceptDownloads: false, serviceWorkers: "block", locale: "ko-KR" });
    try {
      const page = await context.newPage();
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (BLOCKED_RESOURCES.has(req.resourceType()) || !(await opts.allowRequest(req.url()))) await route.abort();
        else await route.continue();
      });
      const response = await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });
      await page.waitForLoadState("networkidle", { timeout: Math.min(10_000, opts.timeoutMs) }).catch(() => undefined);
      const html = opts.select ? await chooseVersion(page, opts.select, opts.timeoutMs) : await page.content();
      if (Buffer.byteLength(html, "utf8") > opts.maxBytes) throw new Error("rendered page exceeds the size cap");
      return { finalUrl: page.url(), httpStatus: response?.status() ?? 0, html };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b).close().catch(() => undefined);
  }
}
