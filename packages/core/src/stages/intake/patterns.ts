/**
 * Structured PII rules for the R1 hard gate. Rules run in order on sanitized (NFKC) text; the most
 * specific patterns come first. Every rule only matches actual values, never data-category words
 * such as "휴대폰번호" or "주민등록번호".
 */
import { isIPv6 } from "node:net";

export interface PiiRule {
  readonly kind: string;
  readonly re: RegExp;
  /** When true the value is the LAST capture group, which must end the match (leading context stays). */
  readonly group?: boolean;
  /** Return false to skip a match (validation / allowlist). `before` is the text preceding the value. */
  readonly accept?: (value: string, before: string) => boolean;
  /** Maps a value to its identity key so equivalent spellings share one placeholder. */
  readonly identity?: (value: string) => string;
}

export interface PatternOptions {
  /** Domains whose URLs / hostnames are public and stay visible (subdomains included). */
  publicDomains?: readonly string[];
  /** Whole-match patterns for employee IDs (in addition to the built-in context rule). */
  employeeIdPatterns?: readonly (RegExp | string)[];
  /** Additional internal hostname patterns (single-label names such as `db-prod-01`). */
  internalHostPatterns?: readonly (RegExp | string)[];
  /** Caller-defined kinds, e.g. `{ kind: "PROJECTCODE", pattern: /PRJ-\d{4}/ }`. */
  extraRules?: readonly { kind: string; pattern: RegExp | string }[];
}

export const DEFAULT_PUBLIC_DOMAINS: readonly string[] = [
  "law.go.kr", "pipc.go.kr", "privacy.go.kr", "kisa.or.kr", "go.kr", "github.com", "google.com", "naver.com",
  "kakao.com", "apple.com", "microsoft.com", "anthropic.com", "claude.ai", "wikipedia.org",
];

const digits = (s: string): string => s.replace(/\D/g, "");
const global = (r: RegExp | string): RegExp => (typeof r === "string" ? new RegExp(r, "g") : new RegExp(r.source, r.flags.includes("g") ? r.flags : r.flags + "g"));

export function hostOf(url: string): string {
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^/:?#]+)/i);
  return (m ? m[1] : url).toLowerCase();
}

export function isPublicHost(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

function validBirth(v: string): boolean {
  const d = digits(v);
  const mm = Number(d.slice(2, 4));
  const dd = Number(d.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** 4-part dotted numbers written as versions ("v1.2.3.4", "버전 1.2.3.4") are not IPs. */
const VERSION_BEFORE = /(?:버전|version|ver\.?|build|빌드)\s*$/i;

const BANKS = "국민|신한|우리|하나|농협|기업|카카오뱅크|토스뱅크|케이뱅크|SC제일|씨티|부산|대구|광주|전북|제주|우체국|새마을|수협|신협";
const SIDO = "서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주";
const SIDO_FULL = `(?:${SIDO})(?:특별시|광역시|특별자치시|특별자치도|도)?`;
const TLD = "com|net|org|io|kr|dev|app|ai|cloud|biz|info|internal|local|corp|lan|intra|intranet|priv";

export function buildRules(opts: PatternOptions = {}): PiiRule[] {
  const pub = opts.publicDomains ?? DEFAULT_PUBLIC_DOMAINS;
  const rules: PiiRule[] = [
    { kind: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, identity: (v) => v.toLowerCase() },
    {
      kind: "URL",
      re: /\b[a-z][a-z0-9+.-]{1,10}:\/\/[^\s<>"'`)\]가-힣]+/gi,
      accept: (v) => !isPublicHost(hostOf(v), pub),
      identity: (v) => v.toLowerCase(),
    },
    {
      kind: "URL",
      re: new RegExp(`(?<![\\w@./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLD})(?![\\w-])(?:[/:][^\\s<>"'\`)\\]가-힣]*)?`, "gi"),
      accept: (v) => !isPublicHost(hostOf(v), pub),
      identity: (v) => v.toLowerCase(),
    },
    {
      kind: "HOST",
      re: /(?<![\w-])(?:[a-z][a-z0-9]*-){1,3}(?:prod|stg|stage|uat|qa|dev)\d{0,3}(?![\w-])/gi,
      identity: (v) => v.toLowerCase(),
    },
    { kind: "RRN", re: /(?<![\d-])(?:\d{6}[- ]?[1-8]\d{6}|\d{6}-[1-8]\*{6})(?![\d-])/g, accept: validBirth, identity: digits },
    { kind: "BIZNO", re: /(?<![\d-])\d{3}-\d{2}-\d{5}(?![\d-])/g, identity: digits },
    { kind: "CARD", re: /(?<![\d-])(?:\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}|\d{15,16})(?![\d-])/g, identity: digits },
    // Phones: mobile, landline (with or without parentheses), international.
    { kind: "PHONE", re: /(?<![\d.\-+])01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g, identity: digits },
    { kind: "PHONE", re: /(?<![\d.\-+])(?:\(0(?:2|[3-6][1-5]|70|80)\)|0(?:2|[3-6][1-5]|70|80|50\d))[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g, identity: digits },
    { kind: "PHONE", re: /(?<![\w+])\+\d{1,3}[-.\s]?\(?\d{1,4}\)?(?:[-.\s]?\d{2,4}){2,3}(?!\d)/g, identity: digits },
    {
      kind: "IP",
      re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w]|\.\d)(?:\/\d{1,2}|:\d{1,5})?/g,
      accept: (_v, before) => !VERSION_BEFORE.test(before),
      identity: (v) => v,
    },
    {
      kind: "IP",
      re: /(?<![\w:.])[0-9A-Fa-f:]{2,39}(?![\w:])/g,
      accept: (v) => (v.match(/:/g)?.length ?? 0) >= 2 && isIPv6(v),
      identity: (v) => v.toLowerCase(),
    },
    // Accounts: keyword or bank context, then generic hyphenated numbers with >= 10 digits.
    { kind: "ACCOUNT", re: /(?:계좌(?:번호)?|account(?:\s*(?:no\.?|number))?)\s*[:은는이가]?\s*(?:(?:[가-힣]{2,6}은행|[A-Za-z]{2,12})\s*)?(\d[\d-]{7,18}\d)/gi, group: true, identity: digits },
    { kind: "ACCOUNT", re: new RegExp(`(?:${BANKS})\\s*(?:은행)?\\s*(\\d[\\d-]{7,18}\\d)`, "g"), group: true, identity: digits },
    { kind: "ACCOUNT", re: /(?<![\d-])\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?(?![\d-])/g, accept: (v) => digits(v).length >= 10, identity: digits },
    // Employee IDs (context rule + configurable patterns).
    { kind: "EMPID", re: /(?:사번|직원\s*번호|사원\s*번호|employee\s*(?:id|no\.?)|emp[\s_-]?id)\s*(?:은|는|이|가|:|=)?\s*([A-Za-z]{0,4}-?\d{3,10})/gi, group: true, identity: (v) => v.toUpperCase() },
    { kind: "EMPID", re: /(?<![\w-])EMP-\d{3,10}(?![\w-])/g, identity: (v) => v.toUpperCase() },
    // Addresses (best effort): road-name, lot-number, postal code, building unit.
    { kind: "ADDR", re: new RegExp(`${SIDO_FULL}\\s*[가-힣]{1,6}(?:시|군|구)(?:\\s*[가-힣]{1,6}(?:구|읍|면))?\\s*[가-힣0-9]{1,12}(?:대로|로|길)(?:\\d+번길)?\\s*\\d+(?:-\\d+)?(?:\\s*\\([가-힣0-9,\\s]+\\))?(?:\\s*\\d+동)?(?:\\s*\\d+층)?(?:\\s*\\d+호)?`, "g"), identity: (v) => v.replace(/\s+/g, " ") },
    { kind: "ADDR", re: new RegExp(`${SIDO_FULL}\\s*[가-힣]{1,6}(?:시|군|구)(?:\\s*[가-힣]{1,6}(?:구|읍|면))?\\s*[가-힣0-9]{1,10}(?:동|읍|면|리)\\s*\\d+(?:-\\d+)?(?:번지)?(?:\\s*\\d+호)?`, "g"), identity: (v) => v.replace(/\s+/g, " ") },
    { kind: "ADDR", re: /[가-힣]{1,6}구\s*[가-힣0-9]{1,12}(?:대로|로|길)\s*\d+(?:-\d+)?/g, identity: (v) => v.replace(/\s+/g, " ") },
    { kind: "ADDR", re: /(?:우편\s*번호|zip(?:\s*code)?)\s*[:은는]?\s*\(?(\d{5})/gi, group: true, identity: digits },
  ];
  for (const p of opts.employeeIdPatterns ?? []) rules.push({ kind: "EMPID", re: global(p), identity: (v) => v.toUpperCase() });
  for (const p of opts.internalHostPatterns ?? []) rules.push({ kind: "HOST", re: global(p), identity: (v) => v.toLowerCase() });
  for (const r of opts.extraRules ?? []) {
    if (!/^[A-Z][A-Z0-9]*$/.test(r.kind)) throw new Error(`extraRules kind must be UPPERCASE alphanumeric: ${r.kind}`);
    rules.push({ kind: r.kind, re: global(r.pattern), identity: (v) => v });
  }
  return rules;
}

export interface RuleHit {
  readonly rule: PiiRule;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

/** Finds all hits of one rule in `text` (left to right, non-overlapping per rule). */
export function findHits(text: string, rule: PiiRule): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const m of text.matchAll(rule.re)) {
    const idx = m.index ?? 0;
    let value = m[0];
    let start = idx;
    if (rule.group) {
      value = m[m.length - 1];
      if (!value) continue;
      start = idx + m[0].length - value.length;
    }
    if (rule.accept && !rule.accept(value, text.slice(0, start))) continue;
    hits.push({ rule, start, end: start + value.length, value });
  }
  return hits;
}
