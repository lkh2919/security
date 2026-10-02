/** digest.md of the daily chain (Korean, reference only). Every dynamic string goes through `safeText`. */
import { MONITOR_DISCLAIMER, type MonitorReport } from "../../contracts/monitor-report";
import { formatCostLine, type UsageSummary } from "../../llm/usage-log";
import { FINANCE_MANUAL_LABEL } from "../monitor/common";
import { SEVERITY_LABEL, safeText } from "../monitor/report";
import { PEER_SIGNAL_LABEL } from "../../contracts/peers";
import type { DailyFreshness, DailyImpact, DailyPeers, DailyRecheck } from "./schemas";

const SEVERITIES = ["critical", "high", "medium", "low", "confirm"] as const;

export interface DigestInput {
  readonly runId: string;
  readonly tenantId: string;
  readonly date: string;
  readonly freshness: DailyFreshness;
  readonly impact: DailyImpact;
  readonly recheck: DailyRecheck;
  readonly peers?: DailyPeers;
  /** Per-policy reports (Mode A and/or Mode B findings). */
  readonly reports: readonly MonitorReport[];
  readonly usage: UsageSummary;
  readonly warnings?: readonly string[];
}

export function renderDailyDigest(d: DigestInput): string {
  const out: string[] = [`# 일일 점검 다이제스트 ${safeText(d.date)}`, "", `> ${MONITOR_DISCLAIMER}`, ""];
  out.push(`- 테넌트: ${safeText(d.tenantId)}`, `- 실행 번호: ${safeText(d.runId)}`, `- ${safeText(formatCostLine(d.usage))}`);
  for (const w of d.warnings ?? []) out.push(`- 참고: ${safeText(w)}`);
  out.push("");

  out.push("## 1. 법령 최신성", "");
  if (d.freshness.status === "skipped") out.push(`건너뜀: ${safeText(d.freshness.note ?? "")}`, "");
  else {
    out.push(`상태: ${safeText(d.freshness.report?.status ?? "n/a")}`, "");
    const changes = d.freshness.changes.filter((c) => c.kind !== "source_unreachable" || c.severity !== "info");
    if (changes.length === 0) out.push("변경 없음.", "");
    for (const c of changes) out.push(`- [${c.severity}] ${c.manualReview ? `${FINANCE_MANUAL_LABEL} · ` : ""}${safeText(c.message)}`);
    if (changes.length > 0) out.push("");
  }

  out.push("## 2. 개정 영향 (Mode B)", "");
  if (d.impact.status === "skipped") out.push(`건너뜀: ${safeText(d.impact.notes.join("; "))}`, "");
  else {
    if (d.impact.diffs.length === 0) out.push("비교한 개정이 없습니다.", "");
    for (const f of d.impact.diffs) {
      const counts = Object.values(f.perPolicy).reduce((n, list) => n + list.length, 0);
      out.push(`- ${safeText(f.lawCode)} (MST ${safeText(f.oldMst)} → ${safeText(f.newMst)}${f.effectiveOn ? `, 시행 ${safeText(f.effectiveOn)}` : ""}): 변경 조문 ${f.unitCount}건, 정책별 지적 ${counts}건${f.manualReview ? ` · ${FINANCE_MANUAL_LABEL}` : ""}`);
    }
    if (d.impact.diffs.length > 0) out.push("");
    for (const n of d.impact.notes) out.push(`- 참고: ${safeText(n)}`);
    if (d.impact.notes.length > 0) out.push("");
  }

  const manual = d.freshness.changes.filter((c) => c.manualReview);
  out.push(`## 3. ${FINANCE_MANUAL_LABEL}`, "");
  if (manual.length === 0 && !d.impact.diffs.some((x) => x.manualReview)) out.push("해당 없음.", "");
  else {
    out.push("금융 법령은 모니터링만 하며 자동으로 규칙 팩에 연결하지 않습니다. 사람이 검토해야 합니다.", "");
    for (const c of manual) out.push(`- ${safeText(c.message)}`);
    out.push("");
  }

  out.push("## 4. 현행 점검 (Mode A) 및 정책별 결과", "");
  if (d.recheck.status === "skipped") out.push(`건너뜀: ${safeText(d.recheck.notes.join("; "))}`, "");
  if (d.recheck.skippedUnchanged.length > 0) out.push(`변경 없음(건너뜀): ${d.recheck.skippedUnchanged.map(safeText).join(", ")}`, "");
  if (d.reports.length > 0) {
    out.push("| 정책 | " + SEVERITIES.map((s) => SEVERITY_LABEL[s]).join(" | ") + " |", "| --- | " + SEVERITIES.map(() => "---").join(" | ") + " |");
    for (const r of d.reports) out.push(`| ${safeText(r.policyId)} | ${SEVERITIES.map((s) => String(r.summary.bySeverity[s])).join(" | ")} |`);
    out.push("");
  } else out.push("새로 작성한 보고서가 없습니다.", "");

  if (d.peers) {
    out.push("## 5. 피어 워치 (업계 동향, 참고)", "", `${PEER_SIGNAL_LABEL}.`, "");
    if (d.peers.status === "skipped") out.push(`건너뜀: ${safeText(d.peers.notes.join("; "))}`, "");
    else {
      const peers = d.peers.outcomes.filter((o) => o.kind === "peer");
      const lotte = d.peers.outcomes.filter((o) => o.kind === "lotte");
      const n = (list: typeof peers, s: string): number => list.filter((o) => o.status === s).length;
      out.push(`- 피어: 변경 ${n(peers, "changed")}곳, 외형만 변경 ${n(peers, "cosmetic")}곳, 변경 없음 ${n(peers, "unchanged") + n(peers, "baseline")}곳, 건너뜀·실패 ${n(peers, "skipped") + n(peers, "failed")}곳`);
      out.push(`- 롯데 계열 공개 방침: 변경·신규 ${n(lotte, "changed") + n(lotte, "baseline")}건 (현행 점검 ${d.peers.lotteReports.length}건), 건너뜀·실패 ${n(lotte, "skipped") + n(lotte, "failed")}건`);
      if (d.peers.signals.groupAdoption.length === 0) out.push("- 그룹 동향 신호: 없음");
      for (const s of d.peers.signals.groupAdoption) out.push(`- 그룹 동향 신호: ${safeText(s.groupId)} · ${safeText(s.articleKey)} · ${safeText(s.sectionId)} — ${s.k}/${s.n} (${s.windowDays}일) · ${s.label}`);
      if (d.peers.reportFile) out.push(`- 상세 보고서: ${safeText(d.peers.reportFile)}`);
      for (const n2 of d.peers.notes) out.push(`- 참고: ${safeText(n2)}`);
      out.push("");
    }
  }

  out.push("---", "", MONITOR_DISCLAIMER, "");
  return out.join("\n");
}
