/**
 * Monitor reports (Policy Monitor design M4, M6): MonitorReport -> Korean Markdown plus JSON. Every string is passed through the
 * contact masker again (defence in depth: a report never carries a phone number or an e-mail address) and Markdown or mention
 * syntax inside quoted policy text is neutralised.
 */
import { MONITOR_DISCLAIMER, type MonitorFinding, type MonitorReport, type MonitorSeverity } from "../../contracts/monitor-report";
import { maskContacts } from "../ingest/segment-policy";

export const SEVERITY_LABEL: Readonly<Record<MonitorSeverity, string>> = { critical: "치명 (Critical)", high: "높음 (High)", medium: "중간 (Medium)", low: "낮음 (Low)", confirm: "확인 필요 (Confirm)" };
export const PROVISIONAL_LABEL = "미검증 – 도메인 검토 대기";
export const CONFIRMED_LABEL = "검증됨 (규칙 팩 기준)";

const ORDER: readonly MonitorSeverity[] = ["critical", "high", "medium", "low", "confirm"];

/** Masks contacts and defuses Markdown, HTML, mention and link syntax; single line. */
export function safeText(s: string): string {
  return maskContacts(s)
    .text.replace(/\s+/g, " ")
    .replace(/[\\`*_{}[\]<>#|~]/g, (c) => `\\${c}`)
    .replace(/@/g, "＠")
    .trim();
}

function findingMd(f: MonitorFinding, titles: Readonly<Record<string, string>>): string[] {
  const title = titles[f.sectionId];
  const lines = [`### ${f.id} · ${SEVERITY_LABEL[f.severity]} · ${f.sectionId}${title ? ` ${safeText(title)}` : ""}`, ""];
  lines.push(`- 구분: ${f.tier === "provisional" ? PROVISIONAL_LABEL : CONFIRMED_LABEL} (모드 ${f.mode}, 규칙 ${safeText(f.ruleId)})`);
  lines.push(`- 위치: ${f.sectionId}${f.location.para !== null ? ` 제${f.location.para}문단` : " (문단 미확인)"}`);
  if (f.trigger) lines.push(`- 개정 조문: ${safeText(f.trigger.law)} ${safeText(f.trigger.articleKey)}${f.trigger.effectiveOn ? ` (시행 ${f.trigger.effectiveOn})` : ""}`);
  lines.push(`- 내용: ${safeText(f.message)}`);
  if (f.location.quote) lines.push(`- 해당 문구: ${"> "}${safeText(f.location.quote)}`);
  lines.push(`- 수정 방향: ${safeText(f.fixHint)}`, "");
  return lines;
}

export interface MarkdownOptions {
  /** Section id -> Korean title, for headings. */
  readonly titles?: Readonly<Record<string, string>>;
}

export function renderMonitorMarkdown(report: MonitorReport, opts: MarkdownOptions = {}): string {
  const titles = opts.titles ?? {};
  const out: string[] = [`# 개인정보 처리방침 점검 보고서: ${safeText(report.policyId)}`, "", `> ${MONITOR_DISCLAIMER}`, ""];
  out.push(`- 점검 시각: ${report.checkedAt}`, `- 문서 해시(SHA-256 앞 12자): ${report.policySha.slice(0, 12)}`, `- 규칙 팩: ${safeText(report.rulePackVersion)}`, `- 실행 번호: ${safeText(report.runId)}`, `- 모델 판단: ${report.llmUsed ? "실행함" : "실행하지 않음 (결정적 검사만)"}`, "");
  out.push("## 요약", "", "| 심각도 | 건수 |", "| --- | --- |");
  for (const s of ORDER) out.push(`| ${SEVERITY_LABEL[s]} | ${report.summary.bySeverity[s]} |`);
  out.push(`| 합계 | ${report.summary.total} |`, "");
  if (report.warnings.length > 0) {
    out.push("## 참고 사항", "");
    for (const w of report.warnings) out.push(`- ${safeText(w)}`);
    out.push("");
  }
  out.push("## 지적 사항", "");
  if (report.findings.length === 0) out.push("자동 검사에서 지적 사항이 없습니다. 이는 적합하다는 뜻이 아니며, 사람의 검토가 필요합니다.", "");
  for (const f of report.findings) out.push(...findingMd(f, titles));
  out.push("---", "", MONITOR_DISCLAIMER, "");
  return out.join("\n");
}

/** JSON form of the report (already free of contacts: only masked text enters a report). */
export function renderMonitorJson(report: MonitorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export interface SummaryEntry {
  readonly policyId: string;
  readonly status: "checked" | "skipped_unchanged" | "manual_review";
  readonly report?: MonitorReport;
}

export function renderSummaryMarkdown(args: { stamp: string; entries: readonly SummaryEntry[]; unmapped?: readonly MonitorFinding[]; notes?: readonly string[] }): string {
  const out: string[] = [`# 점검 요약 ${safeText(args.stamp)}`, "", `> ${MONITOR_DISCLAIMER}`, ""];
  for (const n of args.notes ?? []) out.push(`- ${safeText(n)}`);
  if ((args.notes ?? []).length > 0) out.push("");
  out.push("| 정책 | 상태 | " + ORDER.map((s) => SEVERITY_LABEL[s]).join(" | ") + " |", "| --- | --- | " + ORDER.map(() => "---").join(" | ") + " |");
  for (const e of args.entries) {
    const state = e.status === "checked" ? "점검함" : e.status === "skipped_unchanged" ? "변경 없음 (건너뜀)" : "수동 검토 필요";
    out.push(`| ${safeText(e.policyId)} | ${state} | ${ORDER.map((s) => (e.report ? String(e.report.summary.bySeverity[s]) : "-")).join(" | ")} |`);
  }
  out.push("");
  if (args.unmapped && args.unmapped.length > 0) {
    out.push("## 규칙과 연결되지 않은 개정 조문", "");
    for (const f of args.unmapped) out.push(`- ${f.trigger ? `${safeText(f.trigger.law)} ${safeText(f.trigger.articleKey)}: ` : ""}${safeText(f.message)}`);
    out.push("");
  }
  out.push("---", "", MONITOR_DISCLAIMER, "");
  return out.join("\n");
}
