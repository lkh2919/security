/** AST -> RDoc: placeholder rehydration, citation formatting, numbering, fixed blocks. */
import type { Block, DocAST, Inline, SectionAST } from "../../contracts/ast";
import { rehydrate } from "../../contracts/pii-vault";
import type { RBlock, RDoc, RRun, RSection, RenderOptions } from "./types";

const LAW_NAMES: Readonly<Record<string, string>> = {
  PIPA: "개인정보 보호법",
  DEC: "개인정보 보호법 시행령",
  "ECA-DEC": "전자상거래 등에서의 소비자보호에 관한 법률 시행령",
  STD10023: "공정거래위원회 전자상거래(인터넷사이버몰) 표준약관 제10023호",
  STDG: "표준 개인정보 보호지침",
  CPPA: "통신비밀보호법",
  NTBA: "국세기본법",
  SAFE: "개인정보의 안전성 확보조치 기준",
  LSA: "근로기준법",
  PIPAD: "개인정보 보호법 시행령",
  "PIPA-DECREE": "개인정보 보호법 시행령",
  ECA: "전자상거래 등에서의 소비자보호에 관한 법률",
  ARTC: "약관의 규제에 관한 법률",
  ICNA: "정보통신망 이용촉진 및 정보보호 등에 관한 법률",
};

export const DEFAULT_DISCLAIMER =
  "이 문서는 AI의 도움으로 작성된 참고용 초안이며 법률 자문이 아닙니다. 게시 및 시행 전에 개인정보 보호책임자와 사내 정보보호 검토 부서의 검토를 받아야 하며, 최종 책임은 개인정보 보호책임자와 검토 부서에 있습니다.";
export const DEFAULT_DRAFT_BANNER = "DRAFT — unresolved findings (미해결 감사 지적사항이 남아 있는 초안입니다)";

const NOTE_LABELS = { info: "안내", manual_review: "확인 필요", freshness: "최신성 안내", disclaimer: "유의사항" } as const;

export class Collector {
  readonly warnings: string[] = [];
  private readonly seen = new Set<string>();
  add(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.warnings.push(message);
  }
}

/** Legal-ref key (`PIPA:30(1)1`, `ARTC:7[1]`, `ECA:21-2(1)4`, `NTBA:85-3(2)`) -> `「법령명」 제30조제1항제1호`. */
export function formatLegalRefKey(id: string): string | undefined {
  const m = /^([A-Z][A-Z0-9-]*):(\d+)(?:-(\d+))?((?:\(\d+(?:-\d+)?\)|\[\d+(?:-\d+)?\])*)(\d+)?(?:-(\d+))?$/.exec(id);
  const law = m ? LAW_NAMES[m[1]!] : undefined;
  if (!m || !law) return undefined;
  const branch = (b?: string): string => (b ? `의${b}` : "");
  let out = `제${m[2]}조${branch(m[3])}`;
  for (const part of m[4]!.match(/\(\d+(?:-\d+)?\)|\[\d+(?:-\d+)?\]/g) ?? []) {
    const [n, b] = part.slice(1, -1).split("-");
    out += part.startsWith("(") ? `제${n}항${branch(b)}` : `제${n}호${branch(b)}`;
  }
  if (m[5]) out += `제${m[5]}호${branch(m[6])}`;
  return `「${law}」 ${out}`;
}

export function formatCitation(id: string, opts: RenderOptions): string | undefined {
  const entry = opts.citations?.[id];
  if (entry) return `「${entry.law}」 ${entry.article}`;
  const key = formatLegalRefKey(id);
  if (key) return key;
  const m = /^([A-Z]+(?:-DECREE)?)-(\d+)(?:-(\d+))?$/.exec(id);
  const law = m ? LAW_NAMES[m[1]!] : undefined;
  if (!m || !law) return undefined;
  return `「${law}」 제${m[2]}조${m[3] ? `의${m[3]}` : ""}`;
}

export interface Ctx {
  readonly opts: RenderOptions;
  readonly col: Collector;
  section: string;
}

function unresolved(key: string, ctx: Ctx): RRun {
  ctx.col.add(`미해결 자리표시자 ${key} (섹션 ${ctx.section})`);
  return { kind: "unresolved", text: `[미확정: ${key}]` };
}

function textRuns(text: string, ctx: Ctx): RRun[] {
  const out: RRun[] = [];
  const re = /\{\{([A-Z][A-Z0-9_]*_\d+)\}\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    const value = ctx.opts.vault ? rehydrate(m[0], ctx.opts.vault) : m[0];
    out.push(value === m[0] ? unresolved(m[1]!, ctx) : { kind: "text", text: value });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function resolveInline(inline: Inline, ctx: Ctx): RRun[] {
  switch (inline.t) {
    case "text":
      return inline.strong ? textRuns(inline.text, ctx).map((r) => (r.kind === "text" ? { ...r, strong: true } : r)) : textRuns(inline.text, ctx);
    case "placeholder":
      return textRuns(`{{${inline.key}}}`, ctx);
    case "cite": {
      const label = formatCitation(inline.citationId, ctx.opts);
      if (label) return [{ kind: "cite", text: label }];
      ctx.col.add(`확인되지 않은 인용 ${inline.citationId} (섹션 ${ctx.section})`);
      return [{ kind: "unresolved", text: `[인용 확인 필요: ${inline.citationId}]` }];
    }
    case "link":
      return [{ kind: "link", text: inline.text, href: inline.href }];
  }
}

const runsOf = (inlines: readonly Inline[], ctx: Ctx): RRun[] => inlines.flatMap((i) => resolveInline(i, ctx));

function resolveBlock(block: Block, ctx: Ctx): RBlock {
  switch (block.t) {
    case "para":
      return { t: "para", runs: runsOf(block.runs, ctx) };
    case "list":
      return { t: "list", ordered: block.ordered, items: block.items.map((i) => runsOf(i, ctx)) };
    case "table":
      return { t: "table", caption: block.caption, header: [...block.header], rows: block.rows.map((row) => row.map((cell) => runsOf(cell, ctx))) };
    case "note":
      return { t: "note", kind: block.kind, label: NOTE_LABELS[block.kind], runs: runsOf(block.runs, ctx) };
  }
}

/** Sections that appear in the document body. `omitted_recommended` and `not_applicable` do not. */
export function isRendered(section: SectionAST): boolean {
  return section.status === "drafted" || section.status === "not_processed_statement" || section.status === "manual_review";
}

export function headingFor(docType: "privacy" | "terms", n: number, title: string): string {
  return docType === "terms" ? `제${n}조 (${title})` : `${n}. ${title}`;
}

export function buildDoc(ast: DocAST, opts: RenderOptions, col: Collector): RDoc {
  const ctx: Ctx = { opts, col, section: "-" };
  const baseTitle = ast.docType === "privacy" ? "개인정보 처리방침" : "이용약관";
  const org = opts.organizationName ? textRuns(opts.organizationName, ctx).map((r) => r.text).join("") : "";
  const title = org ? `${org} ${baseTitle}` : baseTitle;

  const sections: RSection[] = [];
  let n = 0;
  for (const s of ast.sections) {
    if (!isRendered(s)) continue;
    n += 1;
    ctx.section = s.id;
    const blocks = s.blocks.map((b) => resolveBlock(b, ctx));
    if (s.status === "manual_review") {
      col.add(`섹션 ${s.id}은(는) 담당자 확인이 필요합니다 (manual_review)`);
      // Only when the section carries no specific manual-review note of its own: a generic banner over drafted text misleads readers.
      if (!s.blocks.some((b) => b.t === "note" && b.kind === "manual_review")) {
        blocks.unshift({ t: "note", kind: "manual_review", label: NOTE_LABELS.manual_review, runs: [{ kind: "text", text: "이 항목에는 담당자가 사실관계를 확인해야 하는 내용이 있습니다." }] });
      }
    }
    sections.push({ id: s.id, anchor: `sec-${s.id}`, heading: headingFor(ast.docType, n, s.title), blocks });
  }
  for (const w of ast.warnings) col.add(`[${w.kind}] ${w.itemId ? `${w.itemId}: ` : ""}${w.message}`);

  const gv = opts.guidelineVersion ?? "2026.4";
  const m = ast.meta;
  const basis =
    ast.docType === "privacy"
      ? { stamp: `작성지침 기준: 개인정보보호위원회 개인정보 처리방침 작성지침 (${gv}.)`, attribution: `출처: 개인정보보호위원회 「개인정보 처리방침 작성지침」(${gv}.)` }
      : { stamp: "작성 기준: 공정거래위원회 전자상거래(인터넷사이버몰) 표준약관 제10023호, 약관의 규제에 관한 법률", attribution: "출처: 공정거래위원회 「전자상거래(인터넷사이버몰) 표준약관」 제10023호" };
  const stamps = [
    basis.stamp,
    `규칙팩 버전: ${m.rulePackVersion}`,
    `조항 라이브러리 버전: ${m.clauseLibVersion}`,
    `하우스 스타일 버전: ${m.houseStyleVersion}`,
    `법령 스냅샷: ${m.lawSnapshotId}`,
    ...Object.keys(m.promptVersions).sort().map((k) => `프롬프트 ${k}: ${m.promptVersions[k]}`),
    `실행 ID: ${m.runId}`,
    ...(opts.generatedAt ? [`생성일: ${opts.generatedAt}`] : []),
  ];

  const ch = opts.changeHistory;
  return {
    lang: "ko",
    title,
    subtitle: [`시행일: ${m.effectiveDate}`],
    banner: opts.draftBanner ? (typeof opts.draftBanner === "string" ? opts.draftBanner : DEFAULT_DRAFT_BANNER) : undefined,
    sections,
    changeHistory: ch && ch.length > 0 ? { caption: "변경 이력", header: ["시행일", "버전", "변경 내용"], rows: ch.map((e) => [e.date, e.version, e.summary]) } : undefined,
    disclaimer: DEFAULT_DISCLAIMER,
    attribution: basis.attribution,
    stamps,
  };
}
