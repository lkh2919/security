/**
 * Row 6b clause library builder (kb-curator).
 * Reads specs in scripts/clause-specs/, checks each against the raw captures (kb/_sources/lotte, gitignored),
 * derives provenance from clauses/_captures/index.json, and writes:
 *   kb/jurisdictions/kr/clauses/{privacy,terms}/<domainGroup>/<clause-id>.json
 *   kb/jurisdictions/kr/clauses/index.json
 *   kb/jurisdictions/kr/house-style/lotte-innovate.candidates.json
 *   kb/jurisdictions/kr/manifest.json
 * Run: bun scripts/build-clauses.ts   (then bun scripts/validate-clauses.ts)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Spec } from "./clause-specs/types";
import { privacySpecs } from "./clause-specs/privacy";
import { termsSpecs } from "./clause-specs/terms";
import { houseStyleCandidates } from "./clause-specs/house-style";
import { extraPrivacy, extraTerms } from "./clause-specs/extra";

const ROOT = resolve(import.meta.dir, "..");
const KR = join(ROOT, "kb/jurisdictions/kr");
const CAP = join(KR, "clauses/_captures/index.json");

export const VARS: Record<string, { slotId?: string; description: string }> = {
  operatorName: { slotId: "profile.orgNameRef", description: "Operator legal name (defined once as 회사)" },
  serviceName: { slotId: "profile.serviceNames", description: "Service or site name(s) covered by the document" },
  documentTitle: { description: "Document title, e.g. 개인정보 처리방침" },
  tableOfContents: { description: "Generated list of numbered headings" },
  summaryPurposes: { slotId: "privacy.S02_purposes", description: "Short list of processing purposes for the key-points block" },
  summaryItems: { slotId: "privacy.S03_items", description: "Short list of item groups for the key-points block" },
  summaryRetention: { slotId: "privacy.S05_retention", description: "Short retention summary for the key-points block" },
  summaryDestruction: { slotId: "privacy.S06_destruction", description: "Short destruction summary for the key-points block" },
  summarySecurity: { slotId: "privacy.S11_measures", description: "Short security summary for the key-points block" },
  purposeTable: { slotId: "privacy.S02_purposes", description: "Purposes per service or task, rendered as a list or table" },
  itemsTable: { slotId: "privacy.S03_items", description: "Items per purpose with legal basis and retention, rendered as tables" },
  generatedItems: { slotId: "privacy.S03_generatedItems", description: "Items generated during service use (logs, cookies, IP)" },
  receivedItems: { slotId: "privacy.S03_receivedItems", description: "Items received from other parties (partners, social login, affiliates)" },
  onDeviceFeatures: { slotId: "privacy.S03_onDeviceFeatures", description: "On-device features and what stays on the device" },
  collectionMethods: { description: "How data is collected (web form, phone, e-mail, offline form, tools)" },
  guardianItems: { slotId: "privacy.S04_guardianItems", description: "Guardian data items collected for under-14 users" },
  guardianVerifyMethod: { slotId: "privacy.S04_guardianVerifyMethod", description: "Method to verify guardian consent" },
  retentionTable: { slotId: "privacy.S05_retention", description: "Retention period and basis per service or item group" },
  retentionExceptions: { slotId: "privacy.S05_retentionExceptions", description: "Statutory retention exceptions (law, item, period)" },
  destructionText: { slotId: "privacy.S06_destruction", description: "Destruction procedure and method" },
  preservedSeparately: { slotId: "privacy.S06_preservedSeparately", description: "Items preserved separately under statute, with basis and period" },
  thirdPartyTable: { slotId: "privacy.S07_thirdParties", description: "Recipients with purpose, items, and recipient retention period" },
  additionalUseTable: { slotId: "privacy.S08_additionalUse", description: "Ongoing additional uses or provisions without consent" },
  additionalUseCriteria: { slotId: "privacy.S08_criteria", description: "Judgment criteria for additional use or provision" },
  processorTable: { slotId: "privacy.S09_processors", description: "Processors and outsourced tasks" },
  subProcessorTable: { slotId: "privacy.S09_subProcessors", description: "Sub-processors and their tasks" },
  overseasTable: { slotId: "privacy.S10_overseas", description: "Overseas transfers: items, country, timing and method, recipient, purpose and period, legal basis" },
  overseasRefusal: { slotId: "privacy.S10_refusal", description: "How to refuse overseas transfer and the effect of refusing" },
  securityMeasures: { slotId: "privacy.S11_measures", description: "Managerial, technical and physical safeguards actually implemented" },
  deviceTable: { slotId: "privacy.S14_devices", description: "Automatic collection devices, purpose, refusal path" },
  behavioralTable: { slotId: "privacy.S14_behavioral", description: "Behavioral information items, purposes, collection methods, retention" },
  trackerTable: { slotId: "privacy.S15_trackers", description: "Third-party trackers permitted on the service" },
  rightsChannels: { slotId: "privacy.S16_rightsChannels", description: "Channels to exercise rights (written, phone, e-mail, fax, online)" },
  selfServicePaths: { slotId: "privacy.S16_selfServicePaths", description: "Self-service menu path for viewing, correcting, deleting, withdrawing" },
  requestDept: { slotId: "privacy.S16_requestDept", description: "Department receiving access requests (role and functional e-mail only)" },
  officerContact: { slotId: "privacy.S18_officer", description: "Privacy officer: role/title and functional e-mail (no personal name in reusable text)" },
  deptContact: { slotId: "privacy.S18_dept", description: "Responsible department: name and functional e-mail" },
  cctvTable: { slotId: "privacy.S21_cctvFixed", description: "Fixed video devices: facility, count, location and coverage" },
  cctvManager: { slotId: "privacy.S21_cctvFixed", description: "Video management officer and authorized access holders (role and department only)" },
  cctvRetention: { slotId: "privacy.S21_cctvFixed", description: "Recording hours, retention days, storage place and method" },
  cctvMobileTable: { slotId: "privacy.S22_cctvMobile", description: "Mobile video devices (body cam, drone, robot): type, purpose, retention" },
  voluntaryMeasures: { slotId: "privacy.S23_voluntary", description: "Voluntary protection measures the operator actually applies" },
  locationInfo: { slotId: "privacy.X1_location", description: "Location-information processing details" },
  effectiveDate: { slotId: "privacy.S24_effectiveDate", description: "Effective date of this version" },
  announceDate: { description: "Announcement date of this version" },
  versionNumber: { description: "Version number printed on the policy" },
  priorVersions: { slotId: "privacy.S24_priorVersions", description: "Prior versions with application periods" },
  noticeMethod: { slotId: "privacy.S24_noticeMethod", description: "Where and how change notices are given" },
  noticeDaysBefore: { slotId: "terms.noticePeriodDays", description: "Days of advance notice before a change takes effect" },
  changeSummaryTable: { slotId: "privacy.S24_priorVersions", description: "Old/new comparison table of changed clauses" },
  // terms
  siteUrl: { description: "Public URL of the service or site" },
  termsDefinitions: { slotId: "terms.definitions", description: "Defined terms of the terms document" },
  serviceScope: { slotId: "terms.serviceScope", description: "Services provided under the terms" },
  suspensionCases: { slotId: "terms.suspensionCases", description: "Concrete grounds for suspending or restricting the service" },
  minAge: { slotId: "terms.minAge", description: "Minimum age for joining without a guardian" },
  membershipRules: { slotId: "terms.membershipRules", description: "Membership application rules and grounds for refusal" },
  memberNoticeChannels: { slotId: "terms.memberNoticeChannels", description: "Channels for individual notices to members" },
  paymentMethods: { slotId: "terms.paymentMethods", description: "Accepted payment methods" },
  contractFormation: { slotId: "terms.contractFormation", description: "When the purchase contract is formed" },
  refundPolicy: { slotId: "terms.refundPolicy", description: "Refund and return terms per item type" },
  userObligations: { slotId: "terms.userObligations", description: "Prohibited acts and duties of users" },
  ipPolicy: { slotId: "terms.ipPolicy", description: "Copyright and posting rules" },
  privacyPolicyUrl: { slotId: "terms.privacyPolicyUrl", description: "URL of the privacy policy" },
  liabilityPosture: { slotId: "terms.liabilityPosture", description: "Liability limitation posture (fault-based, no blanket exclusion)" },
  disputeVenue: { slotId: "terms.disputeVenue", description: "Competent court for disputes" },
  termsEffectiveDate: { description: "Effective date of the terms" },
  pointPolicy: { description: "Point/mileage rules (no matching interview slot yet)" },
  deliveryTerms: { description: "Delivery timing, area and fee (no matching interview slot yet)" },
  customerCenter: { description: "Customer center name and functional contact channel (no personal contact)" },
};

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const cap = readJson(CAP);
const captures: any[] = cap.captures;
const capById = new Map(captures.map((c) => [c.id, c]));
const strip = (s: string) => s.replace(/[\s​ ]+/g, "");
const rawCache = new Map<string, string>();
function rawOf(id: string): string {
  if (rawCache.has(id)) return rawCache.get(id)!;
  const c = capById.get(id);
  const f = c?.files?.txt ? join(ROOT, c.files.txt) : "";
  const t = f && existsSync(f) ? strip(readFileSync(f, "utf8")) : "";
  rawCache.set(id, t);
  return t;
}
const NOISY = new Set(["lotte-cinema-privacy", "lotte-cinema-terms", "lotte-enc-privacy"]);
function eligible(spec: Spec): any[] {
  return captures.filter((c) => {
    if (c.capture !== "ok") return false;
    if (c.docType !== spec.t) return false;
    const isCctv = c.subType === "cctv";
    if (spec.t === "privacy" && isCctv !== !!spec.cctv) return false;
    if (spec.g !== "cross_group" && c.domainGroup !== spec.g) return false;
    return true;
  });
}

const packDir = { privacy: join(KR, "rulepacks/privacy-2026.04"), terms: join(KR, "rulepacks/terms-kftc-10023") };
const ruleIds = new Map<string, Map<string, string>>(); // sectionId -> ruleId -> level
for (const [t, d] of Object.entries(packDir)) {
  for (const f of readdirSync(d).filter((x) => /^(S\d\d|A1|T\d\d)\.json$/.test(x))) {
    const p = readJson(join(d, f));
    ruleIds.set(p.id, new Map(p.rules.map((r: any) => [r.ruleId, r.level])));
  }
}
const sectionTitle = new Map<string, string>();
for (const d of Object.values(packDir)) {
  for (const f of readdirSync(d).filter((x) => /^(S\d\d|A1|T\d\d)\.json$/.test(x))) {
    const p = readJson(join(d, f));
    sectionTitle.set(p.id, p.title.ko);
  }
}

const warnings: string[] = [];
const out: any[] = [];
const ordinal = new Map<string, number>();

function usedVars(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!))];
}
function ifSlots(text: string): string[] {
  return [...new Set([...text.matchAll(/\{%\s*if\s+(?:not\s+)?([A-Za-z][A-Za-z0-9_.]*)\s*%\}/g)].map((m) => m[1]!))];
}

for (const spec of [...privacySpecs, ...termsSpecs, ...extraPrivacy, ...extraTerms]) {
  const pool = eligible(spec).filter((c) => spec.sites === "auto" ? !NOISY.has(c.id) : true);
  const re = new RegExp(spec.m);
  let ids: string[];
  if (spec.sites === "auto") {
    ids = pool.map((c) => c.id).filter((id) => re.test(rawOf(id)));
  } else {
    ids = [];
    for (const id of spec.sites) {
      if (!capById.has(id)) { warnings.push(`${spec.s}/${spec.k}: unknown capture ${id}`); continue; }
      if (re.test(rawOf(id))) ids.push(id);
      else warnings.push(`${spec.s}/${spec.k}: evidence regex does not match ${id}; dropped from provenance`);
    }
  }
  if (ids.length === 0 && !spec.allowNoEvidence) {
    warnings.push(`${spec.s}/${spec.k}: no evidence in any capture; clause skipped`);
    continue;
  }
  const grp = spec.g;
  const key = `${spec.t}.${spec.s}.${grp}`;
  const n = (ordinal.get(key) ?? 0) + 1;
  ordinal.set(key, n);
  const id = `lotte.${spec.t}.${spec.s}.${grp}.${String(n).padStart(2, "0")}`;

  const vn = usedVars(spec.x);
  const variables = vn.map((name) => {
    const v = VARS[name];
    if (!v) { warnings.push(`${id}: variable ${name} not in dictionary`); return { name, description: "UNDEFINED" }; }
    return { name, ...(v.slotId ? { slotId: v.slotId } : {}), description: v.description };
  });
  const rules = ruleIds.get(spec.s);
  const covers = spec.c.map((x) => `R-${spec.s}-${x}`);
  const gaps = (spec.gp ?? []).map((g) => {
    const [num, ...rest] = g.split("|");
    const ruleId = num ? `R-${spec.s}-${num}` : null;
    return { ruleId, level: ruleId ? rules?.get(ruleId) ?? null : null, note: rest.join("|") };
  });
  const primary = ids.map((i) => capById.get(i)).filter(Boolean);
  const sites = [...new Set(primary.map((c) => new URL(c.url).hostname))];
  const dates = [...new Set(primary.map((c) => (c.policyVersionOrEffectiveDate ?? "").split(" ; ")[0]).filter(Boolean))];
  const layout = spec.layout ?? (spec.t === "privacy" ? "guideline_numbered" : "legacy_article");
  const base = eligible(spec).filter((c) => !NOISY.has(c.id)).length;
  out.push({
    id,
    docType: spec.t,
    sectionId: spec.s,
    domainGroup: grp,
    sourceCaptureIds: ids,
    sourceSites: sites,
    policyVersionOrDate: dates.slice(0, 4).join(" / ") || null,
    layout,
    text: spec.x.trim(),
    variables,
    conditions: spec.cond ? [spec.cond] : [],
    coversElements: covers,
    gapsVsGuideline: gaps,
    vetted: false,
    vettingNotes: spec.n ?? "Not vetted. Awaiting privacy-domain-expert review against the current rule pack.",
    frequency: ids.length,
    frequencyBase: base,
    houseStyleTags: spec.tg ?? [],
    provenance: primary.map((c) => ({
      captureId: c.id,
      sourceUrl: c.url,
      affiliate: c.affiliate,
      businessGroup: c.domainGroup,
      captureDate: c.captureDate,
      policyVersionOrEffectiveDate: c.policyVersionOrEffectiveDate ?? null,
      contentHash: c.contentSha256,
    })),
    _sectionTitle: sectionTitle.get(spec.s) ?? null,
  });
}

// ---- write clause files ----
for (const t of ["privacy", "terms"]) {
  const d = join(KR, "clauses", t);
  if (existsSync(d)) for (const e of readdirSync(d)) rmSync(join(d, e), { recursive: true, force: true });
}
for (const r of out) {
  const { _sectionTitle, ...rec } = r;
  const dir = join(KR, "clauses", r.docType, r.domainGroup);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
}

// ---- index.json ----
const privOk = captures.filter((c) => c.capture === "ok" && c.docType === "privacy" && c.subType !== "cctv" && !NOISY.has(c.id));
const cctvOk = captures.filter((c) => c.capture === "ok" && c.docType === "privacy" && c.subType === "cctv");
const termsOk = captures.filter((c) => c.capture === "ok" && c.docType === "terms" && !NOISY.has(c.id));
const allSections = [
  ...["A1", ...Array.from({ length: 24 }, (_, i) => "S" + String(i + 1).padStart(2, "0"))].map((s) => ({ s, t: "privacy" })),
  ...Array.from({ length: 15 }, (_, i) => ({ s: "T" + String(i + 1).padStart(2, "0"), t: "terms" })),
];
const bySection: Record<string, any> = {};
const zero: string[] = [];
for (const { s, t } of allSections) {
  const cl = out.filter((c) => c.sectionId === s);
  const baseSet = s === "S21" || s === "S22" ? cctvOk : t === "privacy" ? privOk : termsOk;
  const covered = new Set(cl.flatMap((c) => c.sourceCaptureIds));
  const groups: Record<string, any> = {};
  for (const g of new Set(cl.map((c) => c.domainGroup))) {
    const gc = cl.filter((c) => c.domainGroup === g);
    groups[g] = { clauses: gc.length, maxFrequency: Math.max(...gc.map((c) => c.frequency)) };
  }
  const mand = ruleIds.get(s) ? [...ruleIds.get(s)!.entries()].filter(([, l]) => l === "must").map(([r]) => r) : [];
  const coveredMust = new Set(cl.flatMap((c) => c.coversElements));
  bySection[s] = {
    title: sectionTitle.get(s),
    docType: t,
    clauseCount: cl.length,
    clauses: cl.map((c) => ({ id: c.id, domainGroup: c.domainGroup, frequency: c.frequency, frequencyBase: c.frequencyBase, coverageRatio: +(c.frequency / Math.max(1, c.frequencyBase)).toFixed(2) })),
    byGroup: groups,
    captureCoverage: { covered: covered.size, of: baseSet.length, ratio: +(covered.size / Math.max(1, baseSet.length)).toFixed(2) },
    mustRules: mand.length,
    mustRulesCovered: mand.filter((r) => coveredMust.has(r)).length,
    mustRulesUncovered: mand.filter((r) => !coveredMust.has(r)),
  };
  if (cl.length === 0) zero.push(s);
}
const counts = { total: out.length, byDocType: {} as Record<string, number>, byDomainGroup: {} as Record<string, number> };
for (const c of out) {
  counts.byDocType[c.docType] = (counts.byDocType[c.docType] ?? 0) + 1;
  const k = `${c.docType}/${c.domainGroup}`;
  counts.byDomainGroup[k] = (counts.byDomainGroup[k] ?? 0) + 1;
}
const capIndexSha = sha(readFileSync(CAP));
const builtAt = new Date().toISOString();
writeFileSync(
  join(KR, "clauses/index.json"),
  JSON.stringify(
    {
      note: "Generated by scripts/build-clauses.ts. Sections with clauseCount 0 have no corpus clause and will be LLM-drafted from the rule pack.",
      clauseLibVersion: "0.1.0",
      builtAt,
      captureIndexSha256: capIndexSha,
      counts,
      eligibleCaptures: { privacy: privOk.length, privacyCctv: cctvOk.length, terms: termsOk.length },
      zeroClauseSections: zero,
      bySection,
    },
    null,
    2,
  ) + "\n",
);

// ---- house style ----
mkdirSync(join(KR, "house-style"), { recursive: true });
const hsPath = join(KR, "house-style/lotte-innovate.candidates.json");
for (const h of houseStyleCandidates) {
  h.evidence = h.evidence.filter((id) => capById.has(id));
}
writeFileSync(
  hsPath,
  JSON.stringify(
    {
      status: "candidate",
      note: "Candidate rules extracted from Lotte Innovate public policies. NOT approved. The user approves (DEC-20260929-02); only then does an approved lotte-innovate.json get created.",
      builtAt,
      rules: houseStyleCandidates,
    },
    null,
    2,
  ) + "\n",
);

// ---- manifest ----
const rp = (dir: string, id: string) => ({ id, version: id, sha256: sha(readFileSync(join(KR, "rulepacks", dir, "index.json"))) });
const sitesList = [...new Set(out.flatMap((c) => c.provenance.map((p: any) => p.sourceUrl)))].sort();
const capturedAt = new Date(Math.max(...captures.map((c) => Date.parse(c.captureDate)))).toISOString();
const manifest = {
  manifestVersion: "0.1.0",
  kbVersion: "0.1.0",
  guideline: "2026.4",
  rulePacks: [rp("privacy-2026.04", "privacy-2026.04"), rp("terms-kftc-10023", "terms-kftc-10023")],
  lawSnapshot: {
    id: "law-2026-09-29",
    note: "Ids copied from statutes/law-targets.json (Row 3 spike, verified 2026-09-29). Only laws with a verified MST are listed; guideline pages are tracked under pages[].",
    laws: [
      { name: "개인정보 보호법", target: "law", id: "011357/MST283839", effective: "2026-09-11" },
      { name: "개인정보 보호법 시행령", target: "law", id: "011468/MST289537", effective: "2026-09-11" },
      { name: "약관의 규제에 관한 법률", target: "law", id: "000667/MST260021", effective: "2024-08-07" },
      { name: "전자상거래 등에서의 소비자보호에 관한 법률", target: "law", id: "009318/MST282793", effective: "2026-07-21" },
      { name: "정보통신망 이용촉진 및 정보보호 등에 관한 법률", target: "law", id: "000030/MST283843", effective: "2026-09-11" },
      { name: "표준 개인정보 보호지침", target: "admrul", id: "2100000257592", effective: "2025-04-11" },
      { name: "개인정보의 안전성 확보조치 기준", target: "admrul", id: "2100000281400", effective: "2026-07-01" },
    ],
  },
  clauseLib: {
    version: "0.1.0",
    capturedAt,
    builtAt,
    sites: sitesList,
    vettedClauses: 0,
    count: out.length,
    captureIndexSha256: capIndexSha,
  },
  houseStyle: { version: "0.0.0-candidate", status: "candidate", candidates: houseStyleCandidates.length, file: "house-style/lotte-innovate.candidates.json" },
  pages: [],
};
writeFileSync(join(KR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`clauses written: ${out.length}`);
console.log(JSON.stringify(counts, null, 1));
console.log("zero-clause sections:", zero.join(", "));
if (warnings.length) console.log("WARNINGS:\n" + warnings.join("\n"));
