/**
 * Row 6b validator for the clause library.
 * Run: bun scripts/validate-clauses.ts   (exit 1 on any error)
 * Checks: JSON parses; schema; sectionId/ruleId/slotId exist; {{var}} defined; {%if%} balanced;
 * no residual PII or company names; house-style candidates well-formed; manifest and index consistent.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const ROOT = resolve(import.meta.dir, "..");
const KR = join(ROOT, "kb/jurisdictions/kr");
const errors: string[] = [];
const warns: string[] = [];
const err = (m: string) => errors.push(m);

const readJson = (p: string) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { err(`JSON parse failed: ${p}: ${(e as Error).message}`); return null; }
};
const walk = (d: string): string[] => existsSync(d) ? readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : [p]; }) : [];

// ---- mini JSON Schema validator (subset used by clause-record.schema.json) ----
function check(schema: any, v: any, root: any, path: string, out: string[]) {
  if (schema.$ref) { const t = schema.$ref.replace("#/", "").split("/").reduce((o: any, k: string) => o[k], root); return check(t, v, root, path, out); }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s: any) => { const o: string[] = []; check(s, v, root, path, o); return o.length === 0; }).length;
    if (ok !== 1) out.push(`${path}: does not match exactly one alternative (${ok})`);
    return;
  }
  if ("const" in schema && v !== schema.const) out.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) out.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) { out.push(`${path}: type ${t} not in ${types}`); return; }
  }
  if (typeof v === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) out.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength && v.length < schema.minLength) out.push(`${path}: too short`);
  }
  if (typeof v === "number" && schema.minimum !== undefined && v < schema.minimum) out.push(`${path}: below minimum`);
  if (Array.isArray(v)) {
    if (schema.minItems && v.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, root, `${path}[${i}]`, out));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const r of schema.required ?? []) if (!(r in v)) out.push(`${path}: missing ${r}`);
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (schema.properties ?? {}))) out.push(`${path}: unexpected ${k}`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) check(s, v[k], root, `${path}.${k}`, out);
  }
}

// ---- references ----
const slots = readJson(join(KR, "interview/slots.json"));
const slotIds = new Set<string>((slots?.slots ?? []).map((s: any) => s.id));
const packs: Record<string, { dir: string; rules: Map<string, string> }> = {};
for (const dir of ["privacy-2026.04", "terms-kftc-10023"]) {
  for (const f of readdirSync(join(KR, "rulepacks", dir)).filter((x) => /^(S\d\d|A1|T\d\d)\.json$/.test(x))) {
    const p = readJson(join(KR, "rulepacks", dir, f));
    if (p) packs[p.id] = { dir, rules: new Map(p.rules.map((r: any) => [r.ruleId, r.level])) };
  }
}
const caps = readJson(join(KR, "clauses/_captures/index.json"));
const capIds = new Set<string>((caps?.captures ?? []).map((c: any) => c.id));
const schema = readJson(join(KR, "clauses/schema/clause-record.schema.json"));

const NAMES = ["김철수", "박영희", "이민수", "최지원", "정하늘", "강도윤", "조서연", "윤재현", "한지민"];
const PII: [string, RegExp][] = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["phone", /\b0\d{1,2}-\d{3,4}-\d{4}\b/],
  ["mobile", /\b01[016789]-?\d{3,4}-?\d{4}\b/],
  ["rrn", /\b\d{6}-[1-4]\d{6}\b/],
  ["date", /\d{4}\s*[.\-년]\s*\d{1,2}\s*[.\-월]/],
  ["version", /\b[vV]\.?\s?\d+\.\d+\b/],
  ["company", /롯데|LOTTE|Lotte|세븐일레븐|코리아세븐|하이마트|칠성|웰푸드|이노베이트|글로벌로지스|롯데캐슬/],
  ["staffname", new RegExp(NAMES.join("|"))],
  ["namefield", /(?:성명|이름|담당자)\s*[:：]\s*[가-힣]{2,4}(?:\s|$)/],
];
const PUBLIC_OK = ["1833-6972"]; // PIPC dispute mediation committee: public agency number

let clauseCount = 0;
const seen = new Set<string>();
const sectionUsed = new Map<string, number>();
for (const f of walk(join(KR, "clauses/privacy")).concat(walk(join(KR, "clauses/terms"))).filter((p) => p.endsWith(".json"))) {
  const c = readJson(f);
  if (!c) continue;
  clauseCount++;
  const where = c.id ?? f;
  if (seen.has(c.id)) err(`${where}: duplicate id`); seen.add(c.id);
  if (!f.replace(/\\/g, "/").endsWith(`/${c.domainGroup}/${c.id}.json`)) err(`${where}: file path does not match domainGroup/id`);
  const so: string[] = [];
  check(schema, c, schema, "$", so); so.forEach((m) => err(`${where}: schema ${m}`));

  // section and doc type
  const pack = packs[c.sectionId];
  if (!pack) { err(`${where}: sectionId ${c.sectionId} not in any rule pack`); continue; }
  sectionUsed.set(c.sectionId, (sectionUsed.get(c.sectionId) ?? 0) + 1);
  const expectDoc = c.sectionId.startsWith("T") ? "terms" : "privacy";
  if (c.docType !== expectDoc) err(`${where}: docType ${c.docType} does not fit section ${c.sectionId}`);
  if (!f.replace(/\\/g, "/").includes(`/clauses/${c.docType}/`)) err(`${where}: stored in wrong docType directory`);
  for (const r of c.coversElements ?? []) {
    if (!pack.rules.has(r)) err(`${where}: covers unknown rule ${r}`);
    if (!r.startsWith(`R-${c.sectionId}-`)) err(`${where}: covers ${r} outside its section`);
  }
  for (const g of c.gapsVsGuideline ?? []) if (g.ruleId && !pack.rules.has(g.ruleId)) err(`${where}: gap references unknown rule ${g.ruleId}`);
  for (const id of c.sourceCaptureIds ?? []) if (!capIds.has(id)) err(`${where}: unknown capture ${id}`);
  if ((c.provenance ?? []).length !== (c.sourceCaptureIds ?? []).length) err(`${where}: provenance/sourceCaptureIds length mismatch`);

  // template
  const text: string = c.text ?? "";
  const declared = new Map<string, any>((c.variables ?? []).map((v: any) => [v.name, v]));
  const used = new Set([...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!));
  for (const u of used) if (!declared.has(u)) err(`${where}: {{${u}}} used but not declared in variables[]`);
  for (const d of declared.keys()) if (!used.has(d)) err(`${where}: variable ${d} declared but not used`);
  if (/\{\{(?![\s]*[A-Za-z][A-Za-z0-9_]*\s*\}\})/.test(text) || /\{\{[^}]*$/m.test(text.replace(/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/g, ""))) err(`${where}: malformed {{ }}`);
  const ifs = [...text.matchAll(/\{%\s*if\s+(?:not\s+)?([A-Za-z][A-Za-z0-9_.]*)\s*%\}/g)];
  const ends = [...text.matchAll(/\{%\s*endif\s*%\}/g)];
  if (ifs.length !== ends.length) err(`${where}: {%if%}/{%endif%} not balanced (${ifs.length}/${ends.length})`);
  const stripped = text.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, "").replace(/\{%\s*(if\s+(not\s+)?[A-Za-z0-9_.]+|endif)\s*%\}/g, "");
  if (/\{%|%\}|\{\{|\}\}/.test(stripped)) err(`${where}: residual template syntax`);
  // depth check
  let depth = 0;
  for (const m of text.matchAll(/\{%\s*(if|endif)/g)) { depth += m[1] === "if" ? 1 : -1; if (depth < 0) err(`${where}: endif before if`); }
  const slotRefs = new Set<string>();
  for (const m of ifs) slotRefs.add(m[1]!);
  for (const v of declared.values()) if (v.slotId) slotRefs.add(v.slotId);
  const condSlots = (x: any): string[] => !x ? [] : x.all ? x.all.flatMap(condSlots) : x.any ? x.any.flatMap(condSlots) : x.not ? condSlots(x.not) : x.slot ? [x.slot] : [];
  for (const cd of c.conditions ?? []) condSlots(cd).forEach((s) => slotRefs.add(s));
  for (const s of slotRefs) if (!slotIds.has(s)) err(`${where}: slot ${s} not in interview/slots.json`);
  if (c.vetted !== false) err(`${where}: vetted must be false`);

  // PII / names
  let t = text;
  for (const ok of PUBLIC_OK) t = t.split(ok).join("");
  for (const [n, re] of PII) if (re.test(t)) err(`${where}: residual ${n} pattern in text (${re.exec(t)?.[0]})`);
  if (/등\s*(을|를|이|가)?\s*(수집|처리)/.test(t)) warns.push(`${where}: vague '등' near 수집/처리`);
  // verbatim guard: no single line copied longer than 200 chars unchanged is checked in build (paraphrase); just cap length
  if (text.length > 4500) warns.push(`${where}: text is long (${text.length})`);
}

// ---- index, manifest, house-style ----
const index = readJson(join(KR, "clauses/index.json"));
if (index) {
  if (index.counts?.total !== clauseCount) err(`index.json counts.total ${index.counts?.total} != files ${clauseCount}`);
  for (const [s, v] of Object.entries<any>(index.bySection ?? {})) {
    if (v.clauseCount !== (sectionUsed.get(s) ?? 0)) err(`index.json section ${s}: clauseCount ${v.clauseCount} != ${sectionUsed.get(s) ?? 0}`);
    for (const cl of v.clauses ?? []) if (!seen.has(cl.id)) err(`index.json lists missing clause ${cl.id}`);
  }
}
const mf = readJson(join(KR, "manifest.json"));
if (mf) {
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  for (const rp of mf.rulePacks ?? []) {
    const p = join(KR, "rulepacks", rp.id, "index.json");
    if (!existsSync(p)) err(`manifest: rulepack ${rp.id} index missing`);
    else if (sha(p) !== rp.sha256) err(`manifest: rulepack ${rp.id} sha256 stale (rulepack changed since build; rerun build-clauses)`);
  }
  if (mf.clauseLib?.count !== clauseCount) err(`manifest: clauseLib.count ${mf.clauseLib?.count} != ${clauseCount}`);
  const capSha = createHash("sha256").update(readFileSync(join(KR, "clauses/_captures/index.json"))).digest("hex");
  if (mf.clauseLib?.captureIndexSha256 !== capSha) err("manifest: captureIndexSha256 stale (capture index changed since build)");
  if (mf.houseStyle?.status !== "candidate") err("manifest: houseStyle.status must be candidate");
  if (mf.guideline !== "2026.4") err("manifest: guideline must be 2026.4");
}
if (existsSync(join(KR, "house-style/lotte-innovate.json"))) err("house-style/lotte-innovate.json must not exist (approval pending)");
const hs = readJson(join(KR, "house-style/lotte-innovate.candidates.json"));
if (hs) {
  const ids = new Set<string>();
  for (const r of hs.rules ?? []) {
    if (ids.has(r.id)) err(`house-style: duplicate ${r.id}`); ids.add(r.id);
    if (r.status !== "candidate") err(`house-style ${r.id}: status must be candidate`);
    for (const k of ["rule", "rationale", "evidence", "checkType", "scope"]) if (!r[k] || (Array.isArray(r[k]) && !r[k].length)) err(`house-style ${r.id}: missing ${k}`);
    for (const e of r.evidence ?? []) if (!capIds.has(e)) err(`house-style ${r.id}: unknown capture ${e}`);
    if (r.checkType === "regex") { try { new RegExp(r.pattern, "m"); } catch (e) { err(`house-style ${r.id}: bad regex ${(e as Error).message}`); } if (!r.patternMode) err(`house-style ${r.id}: patternMode missing`); }
    if (r.checkType === "structure" && !r.structure) err(`house-style ${r.id}: structure missing`);
  }
  // every H tag used in clauses exists
  for (const f of walk(join(KR, "clauses/privacy")).concat(walk(join(KR, "clauses/terms")))) {
    const c = JSON.parse(readFileSync(f, "utf8"));
    for (const h of c.houseStyleTags ?? []) if (!ids.has(h)) err(`${c.id}: unknown houseStyleTag ${h}`);
  }
}

console.log(`clauses validated: ${clauseCount}`);
if (warns.length) console.log(`warnings (${warns.length}):\n` + warns.slice(0, 20).join("\n"));
if (errors.length) { console.log(`ERRORS (${errors.length}):\n` + errors.join("\n")); process.exit(1); }
console.log("validation: OK");
