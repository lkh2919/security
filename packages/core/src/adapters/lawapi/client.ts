/**
 * LawApiClient: law.go.kr Open API (DRF) adapter for the R6 freshness watcher.
 *
 *  - The OC key is never logged, stored or embedded in errors (see `redact.ts`).
 *  - "HTTP 200 + error body" (e.g. failed user verification) raises a typed `LawApiError`.
 *  - Queries are UTF-8 percent-encoded; requests time out, retry twice with backoff and are
 *    spaced at least `minIntervalMs` apart (default 1 s).
 */
import { redactSecrets } from "./redact";
import { firstField, parseRows, rootTag } from "./xml";

export type LawTargetKind = "law" | "admrul";

export type LawApiErrorCode = "MISSING_KEY" | "AUTH" | "HTTP" | "TIMEOUT" | "NETWORK" | "PARSE" | "API";

export class LawApiError extends Error {
  constructor(
    readonly code: LawApiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(`[LAW_API_${code}] ${message}`);
    this.name = "LawApiError";
  }
}

export interface LawVersion {
  readonly target: LawTargetKind;
  readonly name: string;
  /** 법령ID / 행정규칙ID. */
  readonly lawId: string;
  /** 법령일련번호 (MST) / 행정규칙일련번호. */
  readonly mst: string;
  /** ISO date, or null. */
  readonly promulgatedOn: string | null;
  readonly promulgationNo: string;
  readonly effectiveOn: string | null;
  /** 제개정구분명, e.g. 일부개정. */
  readonly revisionType: string;
  /** 현행 / 시행예정 / 연혁. */
  readonly status: string;
}

export interface LawApiOptions {
  readonly oc: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly backoffMs?: number;
  readonly minIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Receives redacted URLs only. */
  readonly log?: (line: string) => void;
}

export function isoFromCompact(v: string | undefined): string | null {
  if (!v || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/** JO code for `lawService.do`: 4-digit article + 2-digit branch (제37조의2 -> 003702). */
export function joCode(article: number, branch = 0): string {
  return `${String(article).padStart(4, "0")}${String(branch).padStart(2, "0")}`;
}

function rowToVersion(row: Record<string, string>, target: LawTargetKind): LawVersion {
  if (target === "admrul") {
    return {
      target,
      name: row["행정규칙명"] ?? "",
      lawId: row["행정규칙ID"] ?? "",
      mst: row["행정규칙일련번호"] ?? "",
      promulgatedOn: isoFromCompact(row["발령일자"]),
      promulgationNo: row["발령번호"] ?? "",
      effectiveOn: isoFromCompact(row["시행일자"]),
      revisionType: row["제개정구분명"] ?? "",
      status: row["현행연혁구분"] ?? "",
    };
  }
  return {
    target,
    name: row["법령명한글"] ?? "",
    lawId: row["법령ID"] ?? "",
    mst: row["법령일련번호"] ?? "",
    promulgatedOn: isoFromCompact(row["공포일자"]),
    promulgationNo: row["공포번호"] ?? "",
    effectiveOn: isoFromCompact(row["시행일자"]),
    revisionType: row["제개정구분명"] ?? "",
    status: row["현행연혁코드"] ?? "",
  };
}

export class LawApiClient {
  private readonly oc: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: ((line: string) => void) | undefined;
  private lastRequestAt = 0;

  constructor(options: LawApiOptions) {
    this.oc = options.oc?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://law.go.kr/DRF";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 2;
    this.backoffMs = options.backoffMs ?? 750;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  private redact(text: string): string {
    return redactSecrets(text, this.oc ? [this.oc] : []);
  }

  private buildUrl(endpoint: "lawSearch.do" | "lawService.do", params: Record<string, string>): string {
    if (!this.oc) throw new LawApiError("MISSING_KEY", "LAW_GO_KR_OC is not set");
    const qs = Object.entries({ OC: this.oc, type: "XML", ...params })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${this.baseUrl}/${endpoint}?${qs}`;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (this.lastRequestAt > 0 && wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /** GET with timeout, retry (network/5xx/timeout) and error-body detection. Returns the XML text. */
  private async getXml(endpoint: "lawSearch.do" | "lawService.do", params: Record<string, string>, expectedRoots: readonly string[]): Promise<string> {
    const url = this.buildUrl(endpoint, params);
    let lastError: LawApiError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      await this.throttle();
      this.log?.(`GET ${this.redact(url)} (attempt ${attempt + 1})`);
      try {
        const res = await this.fetchImpl(url, {
          headers: { "user-agent": "privacy-agent-freshness/0.1", accept: "application/xml" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status >= 500) throw new LawApiError("HTTP", `HTTP ${res.status}`, true);
        if (!res.ok) throw new LawApiError("HTTP", `HTTP ${res.status}`, false);
        const body = await res.text();
        return this.checkBody(body, expectedRoots);
      } catch (err) {
        lastError = this.normalizeError(err);
        if (!lastError.retryable) break;
      }
    }
    throw lastError ?? new LawApiError("NETWORK", "request failed");
  }

  private normalizeError(err: unknown): LawApiError {
    if (err instanceof LawApiError) {
      return new LawApiError(err.code, this.redact(err.message.replace(/^\[LAW_API_[A-Z_]+\]\s*/, "")), err.retryable);
    }
    const name = err instanceof Error ? err.name : "";
    const msg = this.redact(err instanceof Error ? err.message : String(err));
    if (name === "TimeoutError" || name === "AbortError") return new LawApiError("TIMEOUT", `timed out after ${this.timeoutMs} ms`, true);
    return new LawApiError("NETWORK", msg, true);
  }

  /** Detects HTTP-200 error bodies and unexpected documents. */
  private checkBody(body: string, expectedRoots: readonly string[]): string {
    const root = rootTag(body);
    if (root === null) throw new LawApiError("PARSE", "response is not XML");
    if (root === "Response") {
      const result = firstField(body, "result") ?? "unknown error";
      const msg = firstField(body, "msg") ?? "";
      throw new LawApiError("AUTH", this.redact(`${result} ${msg}`.trim()));
    }
    if (!expectedRoots.includes(root)) throw new LawApiError("PARSE", `unexpected root element <${root}>`);
    const code = firstField(body, "resultCode");
    if (code !== null && code !== "00") {
      throw new LawApiError("API", this.redact(`resultCode ${code}: ${firstField(body, "resultMsg") ?? ""}`));
    }
    return body;
  }

  /** Parses a lawSearch response (exported for fixture tests). */
  static parseSearch(xml: string, target: LawTargetKind): LawVersion[] {
    return parseRows(xml, target === "admrul" ? "admrul" : "law").map((r) => rowToVersion(r, target));
  }

  /** Searches by name (substring match on the server); results are unfiltered. */
  async search(name: string, target: LawTargetKind): Promise<LawVersion[]> {
    const params: Record<string, string> = { target, query: name, display: "100" };
    if (target === "admrul") params["nw"] = "1";
    const xml = await this.getXml("lawSearch.do", params, target === "admrul" ? ["AdmRulSearch"] : ["LawSearch"]);
    return LawApiClient.parseSearch(xml, target);
  }

  /** Current version whose name matches exactly (whitespace-insensitive), or null. */
  async getCurrentVersion(name: string, target: LawTargetKind): Promise<LawVersion | null> {
    const rows = await this.search(name, target);
    const exact = rows.filter((v) => squash(v.name) === squash(name));
    return exact.find((v) => v.status === "현행" || v.status === "") ?? exact[0] ?? null;
  }

  /** Scheduled (시행예정) versions of a law, by 법령ID. Laws only; admrul has no such list. */
  async listScheduledVersions(lawId: string): Promise<LawVersion[]> {
    const xml = await this.getXml("lawSearch.do", { target: "eflaw", LID: lawId, nw: "2", display: "100", sort: "efdes" }, ["LawSearch"]);
    const seen = new Set<string>();
    return LawApiClient.parseSearch(xml, "law").filter((v) => {
      const key = `${v.mst}|${v.effectiveOn}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Every version of a law by 법령ID (현행, 연혁 and 시행예정; lawSearch `target=eflaw`, `nw=1,2,3`), newest effective date first. A
   * version (MST) appears once per effective date it has (phased entry into force), so callers pick the row they need.
   */
  async listAllVersions(lawId: string): Promise<LawVersion[]> {
    const xml = await this.getXml("lawSearch.do", { target: "eflaw", LID: lawId, nw: "1,2,3", display: "100", sort: "efdes" }, ["LawSearch"]);
    const seen = new Set<string>();
    return LawApiClient.parseSearch(xml, "law").filter((v) => {
      const key = `${v.mst}|${v.effectiveOn}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Text of one article (JO code), tags stripped. */
  async getArticleText(mst: string, jo: string): Promise<string> {
    const xml = await this.getXml("lawService.do", { target: "law", MST: mst, JO: jo }, ["법령", "Law"]);
    const parts = [...xml.matchAll(/<(조문내용|항내용|호내용|목내용)>([\s\S]*?)<\/\1>/g)].map((m) =>
      (m[2] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
    );
    if (parts.length === 0) throw new LawApiError("PARSE", "article text not found");
    return parts.join("\n");
  }

  /** Full text XML of one law version by MST (법령일련번호), for the article diff (Mode B). Laws only. */
  async getFullTextXml(mst: string): Promise<string> {
    return this.getXml("lawService.do", { target: "law", MST: mst }, ["법령", "Law"]);
  }
}
