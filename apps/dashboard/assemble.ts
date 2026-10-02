/**
 * Static demo dashboard: data assembly (pure file reads, no network, no server). Lives outside packages/core on purpose
 * (CLAUDE.md: no server or UI dependency in packages/core). The builder (scripts/build-dashboard.ts) embeds the result as JSON
 * in one self-contained HTML file.
 *
 * Reads existing run outputs only: monitor reports (Mode A and Mode B), golden amendment fixtures, Peer Watch history,
 * eval-gate results, freshness reports and usage.jsonl. Every string is passed through the contact masker (defence in depth).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatCostLine, summarizeUsage } from "../../packages/core/src/llm/usage-log";
import { maskContacts } from "../../packages/core/src/stages/ingest/segment-policy";

export const DISCLAIMER = "참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다.";
export const PEER_LABEL = "업계 동향(참고) — 법적 요구사항 아님";
export const TIER_PROVISIONAL = "미검증(도메인 검토 대기)";
export const TIER_CONFIRMED = "확정";
export const NO_IMPACT_LABEL = "처리방침 영향 없음 (알림 0건)";

export interface AssembleOptions {
  readonly root: string;
  readonly configPath: string;
  /** A monitor stamp folder, or a folder holding stamp folders. Default: `<runs>/<tenant>/monitor`. */
  readonly monitorDir?: string;
  readonly now?: Date;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const readJson = (p: string): Json | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Json;
  } catch {
    return null;
  }
};

/** Recursively masks contacts in every string. */
export function maskDeep<T>(v: T): T {
  if (typeof v === "string") {
    const m = maskContacts(v);
    return (m.phone || m.email ? m.text : v) as unknown as T; // the masker also folds dashes: keep the original when nothing was masked
  }
  if (Array.isArray(v)) return v.map((x) => maskDeep(x)) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, maskDeep(x)])) as unknown as T;
  return v;
}

function walk(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || depth > 4) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, depth + 1));
    else out.push(p);
  }
  return out;
}

const SEVERITIES = ["critical", "high", "medium", "low", "confirm"] as const;

/** Latest report per policy id (by checkedAt) under `dir`. */
export function loadMonitorReports(dir: string): { reports: Json[]; files: string[] } {
  const latest = new Map<string, { r: Json; file: string }>();
  for (const f of walk(dir)) {
    if (!f.endsWith(".json")) continue;
    const r = readJson(f);
    if (!r || typeof r.policyId !== "string" || !Array.isArray(r.findings) || typeof r.checkedAt !== "string") continue;
    const prev = latest.get(r.policyId);
    if (!prev || String(r.checkedAt) > String(prev.r.checkedAt)) latest.set(r.policyId, { r, file: f });
  }
  const list = [...latest.values()];
  return { reports: list.map((x) => x.r), files: list.map((x) => x.file) };
}

function loadUsage(files: readonly string[]): ReturnType<typeof summarizeUsage> & { line: string } {
  const dirs = [...new Set(files.map((f) => resolve(f, "..")))];
  const records: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const d of dirs) {
    const p = join(d, "usage.jsonl");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Json;
        records.push({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: null, ...row });
      } catch {
        /* skip a damaged line */
      }
    }
  }
  const s = summarizeUsage(records);
  return { ...s, line: formatCostLine(s) };
}

function sectionTitles(root: string, pack: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = join(root, "kb", "jurisdictions", "kr", "rulepacks", pack);
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!/^[SAX]\d+\.json$/.test(f)) continue;
    const j = readJson(join(dir, f));
    if (j?.id && j.title?.ko) out[j.id as string] = j.title.ko as string;
  }
  return out;
}

/** `PIPA:31(4)1` -> `31`, `PIPA:31-2(1)1` -> `31-2`. */
export function articleOfUnit(key: string): { law: string; article: string } | null {
  const m = /^([A-Za-z-]+):(\d+(?:-\d+)?)/.exec(key);
  return m ? { law: m[1]!, article: m[2]! } : null;
}

function buildAmendments(root: string, titles: Record<string, string>, reports: Json[]): Json[] {
  const lawsDir = join(root, "golden", "monitor", "laws");
  const expDir = join(root, "golden", "monitor", "expected");
  if (!existsSync(lawsDir)) return [];
  const out: Json[] = [];
  const modeB: Json[] = reports.flatMap((r) => (r.findings as Json[]).filter((f) => f.mode === "B").map((f): Json => ({ ...f, policyId: r.policyId })));
  for (const f of readdirSync(lawsDir).filter((x) => x.endsWith(".json")).sort()) {
    const fx = readJson(join(lawsDir, f));
    if (!fx) continue;
    const exp = readJson(join(expDir, f.replace(/-\d+-to-(\d+)\.json$/, "-$1.json"))) ?? {};
    const titleOf = new Map<string, string>();
    for (const a of (fx.new?.articles as Json[]) ?? []) titleOf.set(a.branch ? `${a.number}-${a.branch}` : String(a.number), String(a.title ?? ""));
    for (const a of (fx.old?.articles as Json[]) ?? []) {
      const k = a.branch ? `${a.number}-${a.branch}` : String(a.number);
      if (!titleOf.has(k)) titleOf.set(k, String(a.title ?? ""));
    }
    const sections: Json[] = (exp.expectedSections as Json[]) ?? [];
    const unitSection = new Map<string, string>();
    for (const s of sections) for (const u of s.units as string[]) unitSection.set(u, s.sectionId as string);
    const byArticle = new Map<string, { units: string[]; sectionIds: Set<string> }>();
    for (const k of (fx.diffUnitKeys as string[]) ?? []) {
      const a = articleOfUnit(k);
      if (!a) continue;
      const e = byArticle.get(a.article) ?? { units: [], sectionIds: new Set<string>() };
      e.units.push(k);
      const sid = unitSection.get(k);
      if (sid) e.sectionIds.add(sid);
      byArticle.set(a.article, e);
    }
    const lawCode = String(fx.law);
    const noImpact = exp.expectedClass === "no_policy_impact";
    const findings = modeB.filter((x) => x.trigger?.law === lawCode);
    const provisional = String(exp.labelStatus ?? "").toLowerCase().match(/pending|unverified/) !== null;
    const tier = findings.length > 0 ? (findings.every((x) => x.tier === "confirmed") ? TIER_CONFIRMED : TIER_PROVISIONAL) : provisional ? TIER_PROVISIONAL : TIER_CONFIRMED;
    const mapped = new Set(sections.map((s) => s.sectionId as string));
    // Mode A findings from the latest policy reports in the affected sections: context only, not an amendment finding.
    const overlap = reports.flatMap((r) =>
      (r.findings as Json[])
        .filter((x) => x.mode === "A" && x.severity !== "confirm" && mapped.has(x.sectionId))
        .map((x) => ({ policyId: r.policyId, sectionId: x.sectionId, para: x.location?.para ?? null, severity: x.severity, quote: x.location?.quote ?? "", fixHint: x.fixHint ?? "" })),
    );
    out.push({
      law: lawCode,
      lawNameKo: fx.lawNameKo,
      promulgationNo: fx.new?.promulgationNo,
      promulgated: fx.new?.promulgated,
      effectiveOn: fx.new?.effective,
      previous: { promulgationNo: fx.old?.promulgationNo, effectiveOn: fx.old?.effective },
      diffUnitCount: fx.diffUnitCount,
      noImpact,
      noImpactLabel: noImpact ? NO_IMPACT_LABEL : null,
      tier,
      articles: [...byArticle.entries()]
        .sort((a, b) => parseFloat(a[0].replace("-", ".")) - parseFloat(b[0].replace("-", ".")))
        .map(([article, e]) => ({ article, title: titleOf.get(article) ?? "", units: e.units, sectionIds: [...e.sectionIds].sort() })),
      sections: sections.map((s) => ({ sectionId: s.sectionId, title: titles[s.sectionId as string] ?? "", units: s.units, rules: s.rules })),
      policyFindings: findings.map((x) => ({
        policyId: x.policyId,
        sectionId: x.sectionId,
        para: x.location?.para ?? null,
        quote: x.location?.quote ?? "",
        fixHint: x.fixHint ?? "",
        message: x.message ?? "",
        severity: x.severity,
        tier: x.tier === "confirmed" ? TIER_CONFIRMED : TIER_PROVISIONAL,
        articleKey: x.trigger?.articleKey ?? "",
      })),
      modeAOverlap: noImpact ? [] : overlap,
    });
  }
  return out;
}

function buildPolicies(reports: Json[], titles: Record<string, string>, finance: boolean): Json[] {
  return reports
    .map((r) => {
      const findings = (r.findings as Json[]).filter((f) => f.mode !== "B");
      const bySeverity: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
      for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      const confirmBySection = new Map<string, { sectionId: string; title: string; questions: string[] }>();
      for (const f of findings.filter((x) => x.severity === "confirm")) {
        const e = confirmBySection.get(f.sectionId) ?? { sectionId: f.sectionId as string, title: titles[f.sectionId as string] ?? "", questions: [] as string[] };
        for (const q of (f.questions as string[]) ?? [f.message]) e.questions.push(q);
        confirmBySection.set(f.sectionId, e);
      }
      return {
        policyId: r.policyId,
        checkedAt: r.checkedAt,
        runId: r.runId,
        rulePackVersion: r.rulePackVersion,
        llmUsed: r.llmUsed ?? null,
        manualReview: finance || /(card|bank|finance|insur|금융|카드)/i.test(String(r.policyId)),
        bySeverity,
        warnings: r.warnings ?? [],
        findings: findings
          .filter((f) => f.severity !== "confirm")
          .map((f) => ({ id: f.id, severity: f.severity, tier: f.tier, ruleId: f.ruleId, sectionId: f.sectionId, sectionTitle: titles[f.sectionId] ?? "", para: f.location?.para ?? null, quote: f.location?.quote ?? "", message: f.message, fixHint: f.fixHint ?? "" })),
        confirmSections: [...confirmBySection.values()],
      };
    })
    .sort((a, b) => String(a.policyId).localeCompare(String(b.policyId)));
}

function latestFile(dir: string, re: RegExp): string | null {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => re.test(x)).sort();
  return f.length ? join(dir, f[f.length - 1]!) : null;
}

function buildPeers(root: string, peersDir: string, registryPath: string): Json | null {
  const file = latestFile(peersDir, /^history-[A-Za-z-]+-\d{4}-\d{2}-\d{2}\.json$/) ?? latestFile(peersDir, /^report-.*\.json$/);
  const h = file ? readJson(file) : null;
  if (!h || !Array.isArray(h.groups)) return null;
  const reg = readJson(registryPath) ?? {};
  const regOrder: string[] = ((reg.groups as Json[]) ?? []).map((g) => g.groupId as string);
  const nameOf = new Map<string, string>(((reg.groups as Json[]) ?? []).map((g) => [g.groupId as string, g.nameKo as string]));
  const groupIds: string[] = (h.groups as Json[]).map((g) => g.groupId as string).sort((a, b) => regOrder.indexOf(a) - regOrder.indexOf(b));
  const groups = groupIds.map((id) => {
    const g = (h.groups as Json[]).find((x) => x.groupId === id)!;
    const peers = (h.peers as Json[]).filter((p) => p.groupId === id);
    const signals = ((g.signals as Json[]) ?? [])
      .map((s) => ({ articleKey: s.articleKey, sectionId: s.sectionId, k: s.k, n: s.n, windowDays: s.windowDays, confidence: s.confidence, meetsThreshold: !!s.meetsThreshold }))
      .sort((a, b) => String(a.articleKey).localeCompare(String(b.articleKey), "en", { numeric: true }));
    return {
      groupId: id,
      nameKo: nameOf.get(id) ?? g.nameKo ?? id,
      active: g.active,
      compared: g.compared,
      changed: g.changed,
      noUpdate: g.noUpdate,
      noHistory: g.noHistory,
      skipped: g.skipped,
      failed: g.failed,
      signals,
      // Detail list only: registry order, no ordering by change count, no scores.
      peers: peers.map((p) => ({ name: p.name, status: p.status, changedSectionIds: [...new Set(((p.changedSections as Json[]) ?? []).map((c) => c.sectionId as string))].sort() })),
    };
  });
  const sum = (k: string) => groups.reduce((a, g) => a + (Number((g as Json)[k]) || 0), 0);
  return {
    label: PEER_LABEL,
    law: h.law,
    asOf: h.asOf,
    windowStart: h.windowStart,
    amendment: { promulgationNo: h.amendment?.promulgationNo, promulgatedOn: h.amendment?.promulgatedOn, effectiveOn: h.diff?.effectiveOn, unitCount: h.diff?.unitCount },
    totals: { active: sum("active"), compared: sum("compared"), changed: sum("changed"), noUpdate: sum("noUpdate"), noHistory: sum("noHistory"), skipped: sum("skipped"), failed: sum("failed") },
    groups,
    source: file ? file.slice(root.length + 1) : null,
  };
}

function buildGates(evalDir: string): Json | null {
  const f = latestFile(evalDir, /^eval-gates-.*\.json$/);
  const g = f && !/unit-test/.test(f) ? readJson(f) : null;
  if (!g || !Array.isArray(g.gates)) return null;
  const gates = (g.gates as Json[]).map((x) => ({ id: x.id, label: x.label, threshold: x.threshold, value: x.value, status: x.status, note: x.note ?? "" }));
  const count = (s: string) => gates.filter((x) => x.status === s).length;
  return { stamp: g.stamp, mode: g.mode, rulePack: g.rulePack, labelStatus: g.labelStatus ?? "", pass: count("pass"), fail: count("fail"), skip: count("skip"), total: gates.length, gates };
}

const DATE_RE = /공포 (\d{4}-\d{2}-\d{2}) 제(\d+)호, 시행 (\d{4}-\d{2}-\d{2})/;

function buildLaws(root: string, amendments: Json[]): Json[] {
  const statutes = join(root, "kb", "jurisdictions", "kr", "statutes");
  const targets = readJson(join(statutes, "law-targets.watch.json"));
  const adds = readJson(join(statutes, "law-targets.watch-additions.json"));
  const fresh = (() => {
    const f = latestFile(join(root, "runs", "_freshness"), /^freshness-.*\.json$/);
    return f ? readJson(f) : null;
  })();
  const laws: Json[] = [];
  for (const t of (targets?.laws as Json[]) ?? []) laws.push({ sourceId: t.sourceId, name: t.name, code: t.lawCode ?? "", manualReview: false });
  for (const t of (adds?.targets as Json[]) ?? []) laws.push({ sourceId: t.sourceId, name: t.name, code: t.lawCode ?? "", manualReview: !!t.manualReview, promulgated: t.promulgationDate, effectiveOn: t.effectiveDate, version: t.version });
  const changes = ((fresh?.changes as Json[]) ?? []).filter((c) => typeof c.sourceId === "string");
  const sources = ((fresh?.report?.sources as Json[]) ?? []) as Json[];
  return laws.map((l) => {
    const msg = changes.map((c) => ({ c, m: DATE_RE.exec(String(c.message ?? "")) })).find((x) => x.c.sourceId === l.sourceId && x.m);
    const am = amendments.find((a) => a.law === l.code);
    const src = sources.find((s) => s.sourceId === l.sourceId);
    return {
      ...l,
      promulgated: l.promulgated ?? msg?.m?.[1] ?? am?.promulgated ?? null,
      promulgationNo: msg?.m?.[2] ?? (am?.promulgationNo ? String(am.promulgationNo).replace(/\D/g, "") : null),
      effectiveOn: l.effectiveOn ?? msg?.m?.[3] ?? am?.effectiveOn ?? null,
      freshness: src?.outcome ?? null,
    };
  });
}

export function assembleDashboard(opts: AssembleOptions): Json {
  const root = resolve(opts.root);
  const cfgPath = resolve(opts.configPath);
  const org = readJson(cfgPath) ?? {};
  const tenantId = String(org.tenantId ?? "default");
  const tenantRoot = join(root, "runs", tenantId);
  const monitorDir = opts.monitorDir ? resolve(opts.monitorDir) : join(tenantRoot, "monitor");
  const pack = String(org.rulePacks?.[0] ?? "privacy-2026.04");
  const titles = sectionTitles(root, pack);
  const { reports, files } = loadMonitorReports(monitorDir);
  const finance = /finance/i.test(String(org.domainGroup ?? ""));
  const amendments = buildAmendments(root, titles, reports);
  const policies = buildPolicies(reports, titles, finance);
  const registryPath = org.peersFile ? resolve(cfgPath, "..", String(org.peersFile)) : join(root, "kb", "jurisdictions", "kr", "monitor", "peers", "peer-registry.json");
  const peers = buildPeers(root, join(tenantRoot, "peers"), registryPath);
  const gates = buildGates(join(root, "runs", "eval"));
  const usage = loadUsage(files);
  const bySeverity: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const p of policies) for (const s of SEVERITIES) bySeverity[s]! += (p.bySeverity as Record<string, number>)[s] ?? 0;
  const data = {
    meta: { org: org.name ?? tenantId, tenantId, domainGroup: org.domainGroup ?? "", generatedAt: (opts.now ?? new Date()).toISOString(), rulePack: pack, disclaimer: DISCLAIMER, peerLabel: PEER_LABEL, monitorSource: files.length ? monitorDir.replace(root + "/", "") : null },
    overview: {
      laws: buildLaws(root, amendments),
      policies: policies.map((p) => ({ policyId: p.policyId, checkedAt: p.checkedAt, bySeverity: p.bySeverity, manualReview: p.manualReview })),
      bySeverity,
      gates: gates ? { pass: gates.pass, fail: gates.fail, skip: gates.skip, total: gates.total, stamp: gates.stamp } : null,
      cost: { calls: usage.calls, costUsd: usage.costUsd, line: usage.line },
    },
    amendments,
    policies,
    peers,
    gates,
  };
  return maskDeep(data);
}

/** JSON safe inside a `<script type="application/json">` tag. */
export function jsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Inlines style.css, app.js and the data into template.html. */
export function renderDashboardHtml(dir: string, data: unknown): string {
  const tpl = readFileSync(join(dir, "template.html"), "utf8");
  const css = readFileSync(join(dir, "style.css"), "utf8");
  const js = readFileSync(join(dir, "app.js"), "utf8");
  return tpl.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => js.replace(/<\/script/gi, "<\\/script")).replace("__DATA__", () => jsonForScript(data));
}
