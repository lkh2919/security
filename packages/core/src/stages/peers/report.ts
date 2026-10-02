/**
 * Peer Watch report (Korean, reference only): group counts, changed sections with short masked quotes, group-adoption signals with the
 * fixed label. Peers are never rated or ranked: rows follow the registry order and carry counts of events, not scores.
 */
import { MONITOR_DISCLAIMER } from "../../contracts/monitor-report";
import { PEER_SIGNAL_LABEL, PEER_UNKNOWN_CAUSE_LABEL, type PeerRegistry } from "../../contracts/peers";
import { safeText } from "../monitor/report";
import { collapseAlignments, refLabel } from "./collapse";
import type { PeerSignals } from "./signals";

export type OutcomeStatus = "unchanged" | "changed" | "baseline" | "cosmetic" | "skipped" | "failed";

export interface PeerOutcome {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly kind: "peer" | "lotte";
  readonly status: OutcomeStatus;
  readonly reason?: string;
  readonly changedSections?: readonly { readonly sectionId: string; readonly kind: "added" | "removed" | "modified"; readonly quote: string }[];
}

export const PEER_NOT_RATED_NOTE = "이 보고서는 공개된 방침의 변경 감지 결과이며, 개별 회사에 대한 판단 자료가 아닙니다.";
const KIND_KO = { added: "추가", removed: "삭제", modified: "수정" } as const;
const CONF_KO = { high: "높음", medium: "중간", low: "낮음" } as const;

/** One console line per target. */
export function formatOutcomeLine(o: PeerOutcome): string {
  const head = `${o.groupId}/${o.id}`;
  switch (o.status) {
    case "changed":
      return `${head}: changed (${(o.changedSections ?? []).map((c) => `${c.sectionId} ${c.kind}`).join(", ")})`;
    case "baseline":
      return `${head}: fetched, first snapshot stored`;
    case "unchanged":
      return `${head}: fetched, unchanged`;
    case "cosmetic":
      return `${head}: fetched, cosmetic-only change (no section differs)`;
    case "skipped":
      return `${head}: skipped (${o.reason ?? "unknown"})`;
    case "failed":
      return `${head}: failed (${o.reason ?? "unknown"})`;
  }
}

const fetched = (o: PeerOutcome): boolean => o.status === "unchanged" || o.status === "changed" || o.status === "baseline" || o.status === "cosmetic";

export interface PeerReportInput {
  readonly date: string;
  readonly tenantId: string;
  readonly dryRun?: boolean;
  readonly registry: PeerRegistry;
  readonly outcomes: readonly PeerOutcome[];
  readonly signals: PeerSignals;
}

export function renderPeerReport(r: PeerReportInput): string {
  const out: string[] = [`# 피어 워치 보고서 ${safeText(r.date)}${r.dryRun ? " (시험 실행)" : ""}`, "", `> ${PEER_SIGNAL_LABEL}`, `> ${MONITOR_DISCLAIMER}`, "", PEER_NOT_RATED_NOTE, ""];
  out.push(`- 테넌트: ${safeText(r.tenantId)}`, `- 기준: 레지스트리 ${safeText(r.registry.version)}; 공개된 처리방침의 변경 감지만 수행합니다.`, "");

  const peers = r.outcomes.filter((o) => o.kind === "peer");
  const lotte = r.outcomes.filter((o) => o.kind === "lotte");
  const groupName = (id: string): string => r.registry.groups.find((g) => g.groupId === id)?.nameKo ?? id;
  const groupIds = r.registry.groups.map((g) => g.groupId).filter((id) => r.outcomes.some((o) => o.groupId === id));

  out.push("## 1. 그룹별 현황", "", "| 그룹 | 확인한 피어 | 변경 | 외형만 변경 | 건너뜀 |", "| --- | --- | --- | --- | --- |");
  for (const id of groupIds) {
    const own = peers.filter((o) => o.groupId === id);
    out.push(`| ${safeText(groupName(id))} | ${own.filter(fetched).length} | ${own.filter((o) => o.status === "changed").length} | ${own.filter((o) => o.status === "cosmetic").length} | ${own.filter((o) => !fetched(o)).length} |`);
  }
  out.push("");
  const notFetched = peers.filter((o) => !fetched(o));
  if (notFetched.length > 0) {
    out.push("건너뜀·실패 사유 (집계에서 제외):", "");
    for (const o of notFetched) out.push(`- ${safeText(groupName(o.groupId))} · ${safeText(o.name)}: ${safeText(o.reason ?? o.status)}`);
    out.push("");
  }

  out.push("## 2. 변경된 항목", "");
  const changed = peers.filter((o) => o.status === "changed");
  if (changed.length === 0) out.push("변경이 감지된 피어가 없습니다.", "");
  for (const o of changed) {
    out.push(`- ${safeText(groupName(o.groupId))} · ${safeText(o.name)}`);
    for (const c of o.changedSections ?? []) out.push(`  - ${safeText(c.sectionId)} (${KIND_KO[c.kind]}): "${safeText(c.quote)}"`);
  }
  if (changed.length > 0) out.push("");

  out.push("## 3. 개정 조문과 함께 나타난 변경 (참고)", "", `${PEER_SIGNAL_LABEL}. 변경이 개정과 동시에 나타났다는 뜻이며, 개정이 원인이라는 뜻은 아닙니다.`, "");
  const nameOf = (id: string): string => r.outcomes.find((o) => o.id === id)?.name ?? id;
  const aligned = r.signals.peerAligned.filter((p) => p.alignments.some((a) => a.confidence !== "low"));
  const unknown = r.signals.peerAligned.filter((p) => p.alignments.every((a) => a.confidence === "low"));
  if (aligned.length === 0 && unknown.length === 0) out.push("해당 없음.", "");
  // One line per article and section (the 항/호 units of an article are listed in a parenthesis).
  for (const p of aligned) for (const a of collapseAlignments(p.alignments.filter((x) => x.confidence !== "low")).filter((x) => x.confidence !== "low")) out.push(`- ${safeText(nameOf(p.peerId))}: ${safeText(refLabel(a.article, a.details))} / ${safeText(a.sectionId)} (신뢰도 ${CONF_KO[a.confidence]})`);
  for (const p of unknown) out.push(`- ${safeText(nameOf(p.peerId))}: ${PEER_UNKNOWN_CAUSE_LABEL}`);
  if (aligned.length + unknown.length > 0) out.push("");

  out.push("## 4. 그룹 동향 신호", "");
  if (r.signals.groupAdoption.length === 0) out.push("표시 조건(3곳 이상, 60% 이상)을 충족한 신호가 없습니다.", "");
  else {
    out.push("| 그룹 | 조문 | 항목 | 같은 방향으로 바꾼 곳 / 확인한 곳 | 기간(일) | 신뢰도 | 표시 |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const s of r.signals.groupAdoption) out.push(`| ${safeText(groupName(s.groupId))} | ${safeText(s.articleKey)} | ${safeText(s.sectionId)} | ${s.k} / ${s.n} | ${s.windowDays} | ${CONF_KO[s.confidence]} | ${s.label} |`);
    out.push("");
  }

  out.push("## 5. 롯데 계열 공개 방침 재점검", "");
  if (lotte.length === 0) out.push("대상 없음.", "");
  else {
    out.push("| 그룹 | 확인 | 변경·신규 | 건너뜀 |", "| --- | --- | --- | --- |");
    for (const id of groupIds) {
      const own = lotte.filter((o) => o.groupId === id);
      if (own.length === 0) continue;
      out.push(`| ${safeText(groupName(id))} | ${own.filter(fetched).length} | ${own.filter((o) => o.status === "changed" || o.status === "baseline").length} | ${own.filter((o) => !fetched(o)).length} |`);
    }
    out.push("", "변경·신규로 확인된 방침은 현행 점검(Mode A)에 넘깁니다.", "");
  }
  out.push("---", "", PEER_SIGNAL_LABEL, "", MONITOR_DISCLAIMER, "");
  return out.join("\n");
}
