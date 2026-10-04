/**
 * Per-run usage log (design C3): converts the usage records of the LLM clients (API: `CallUsageRecord`, Claude Code:
 * `ClaudeCodeUsageRecord` with `costUsd`) into `UsageRecord`s, appends them to `usage.jsonl` and summarises them for the cost line.
 * A Claude Code `costUsd` of 0 means "not reported" (the client defaults a missing value to 0), so list price is used then.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UsageRecordSchema, type UsageRecord } from "../contracts/usage";
import { listPriceUsd } from "./models";

/** The common subset of both clients' usage log rows. */
export interface RawUsageRow {
  readonly stageId: string;
  readonly modelId: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number };
  /** Present on Claude Code rows only. */
  readonly costUsd?: number;
}

export function toUsageRecord(row: RawUsageRow): UsageRecord {
  const list = listPriceUsd(row.modelId, row.usage);
  const reported = typeof row.costUsd === "number" && row.costUsd > 0 ? row.costUsd : null;
  const costUsd = reported ?? list;
  return UsageRecordSchema.parse({
    stage: row.stageId,
    model: row.modelId,
    inputTokens: row.usage.inputTokens,
    outputTokens: row.usage.outputTokens,
    cacheReadInputTokens: row.usage.cacheReadInputTokens,
    cacheCreationInputTokens: row.usage.cacheCreationInputTokens,
    listPriceUsd: list,
    reportedCostUsd: reported,
    costUsd,
    costSource: reported !== null ? "reported" : list !== null ? "list-price" : "unknown",
  });
}

export const toUsageRecords = (rows: readonly RawUsageRow[]): UsageRecord[] => rows.map(toUsageRecord);

/** Anything that can report the calls made so far (the backend clients of llm/factory). */
export interface UsageSource {
  usageRecords(): UsageRecord[];
}

export const USAGE_FILE = "usage.jsonl";

/** Appends records as JSON lines (creates the directory). A resumed run appends; nothing is rewritten. */
export async function appendUsageJsonl(file: string, records: readonly UsageRecord[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, records.map((r) => `${JSON.stringify(UsageRecordSchema.parse(r))}\n`).join(""), "utf8");
}

export async function readUsageJsonl(file: string): Promise<UsageRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => UsageRecordSchema.parse(JSON.parse(l)));
}

export interface UsageSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** Sum over calls with a known cost. */
  readonly costUsd: number;
  /** Calls whose cost is unknown (model not in the price table, no reported cost). */
  readonly unpricedCalls: number;
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  const s = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0, unpricedCalls: 0 };
  for (const r of records) {
    s.calls += 1;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.cacheReadInputTokens += r.cacheReadInputTokens;
    s.cacheCreationInputTokens += r.cacheCreationInputTokens;
    if (r.costUsd === null) s.unpricedCalls += 1;
    else s.costUsd += r.costUsd;
  }
  return s;
}

/** One Korean line for summary.md / digest.md. Cost is an estimate at list price unless the backend reported it. */
export function formatCostLine(summary: UsageSummary): string {
  if (summary.calls === 0) return "모델 호출 없음 (비용 $0.00)";
  const cache = summary.cacheReadInputTokens + summary.cacheCreationInputTokens;
  const unpriced = summary.unpricedCalls > 0 ? `, 가격 미확인 ${summary.unpricedCalls}회 제외` : "";
  return `모델 사용량: ${summary.calls}회 호출, 입력 ${summary.inputTokens} / 출력 ${summary.outputTokens} / 캐시 ${cache} 토큰, 추정 비용 $${summary.costUsd.toFixed(4)} (정가 기준 추정${unpriced})`;
}
