import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST_PRICES_USD_PER_MTOK, MockLlmClient, listPriceUsd, type StructuredCallRequest } from "../src/llm";
import { USAGE_FILE, appendUsageJsonl, formatCostLine, readUsageJsonl, summarizeUsage, toUsageRecord, type UsageSource } from "../src/llm";
import { UsageRecordSchema } from "../src/contracts/usage";
import { checkCurrentPolicy, runMonitorFolder, renderSummaryMarkdown, type CheckJudgeOutput } from "../src/stages/monitor";
import { financeFlaggedSections, hitsFinanceLexicon, ingestPolicy, loadFinanceLexicon, parseFinanceLexicon } from "../src/stages/ingest";
import { MON_RUN_ID, NOW, ROOT, kb, patterns, ruleSections } from "./monitor-fixtures";

const lexicon = loadFinanceLexicon(ROOT);
const financeMd = readFileSync(join(import.meta.dir, "fixtures", "finance", "policy-finance.md"), "utf8");
const ingest = (lex?: typeof lexicon) => ingestPolicy({ name: "policy-finance.md", content: financeMd, fetchedAt: NOW }, patterns, lex);
const base = { runId: MON_RUN_ID, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now: NOW };
const sectionOf = (r: StructuredCallRequest): string => /^SECTION (\S+):/m.exec(r.user)![1]!;

describe("finance flag (Mode A)", () => {
  test("the lexicon file holds the design terms", () => {
    for (const t of ["신용정보", "개인신용정보", "신용조회", "충전포인트", "선불전자지급", "전자금융거래", "신용정보법", "전자금융거래법", "금융소비자보호법"]) expect(lexicon.terms).toContain(t);
    expect(hitsFinanceLexicon(parseFinanceLexicon('{"version":"1","terms":["신용 정보"]}'), "신용정보를 처리")).toBe(true);
  });

  test("only paragraphs that hit the lexicon are tagged; no lexicon means no tags", () => {
    const tagged = ingest(lexicon);
    const flagged = tagged.sections.flatMap((s) => s.paras.filter((p) => p.financeFlag).map((p) => p.text));
    expect(flagged).toEqual(["충전포인트 이용 내역은 전자금융거래법에 따라 5년간 보관합니다."]);
    expect(financeFlaggedSections(tagged)).toEqual(["S05"]);
    expect(ingest().sections.some((s) => s.paras.some((p) => p.financeFlag))).toBe(false);
  });

  test("one Confirm finding per flagged section, no suggested wording", async () => {
    const { report } = await checkCurrentPolicy({}, { ...base, policy: ingest(lexicon) });
    const f = report.findings.filter((x) => x.ruleId === "MON-FINANCE");
    expect(f).toHaveLength(1);
    expect([f[0]!.sectionId, f[0]!.severity, f[0]!.fixHint]).toEqual(["S05", "confirm", ""]);
    expect(f[0]!.message).toContain("금융 법령 해당 – 수동 검토");
    expect(f[0]!.location.para).toBe(2);
  });

  test("PIPA missing/wrong findings that quote a flagged paragraph are dropped; others stay", async () => {
    const flaggedQuote = "충전포인트 이용 내역은 전자금융거래법에 따라 5년간 보관합니다.";
    const plainQuote = "회원 정보는 회원 탈퇴 시까지 보유합니다.";
    const llm = new MockLlmClient({
      fixtures: {
        M1: (r: StructuredCallRequest): { findings: CheckJudgeOutput["findings"] } => ({
          findings: sectionOf(r) === "S05"
            ? [
                { ruleId: "R-S05-005", verdict: "wrong", quote: flaggedQuote, fixHint: "x" },
                { ruleId: "R-S05-004", verdict: "wrong", quote: plainQuote, fixHint: "y" },
              ]
            : [],
        }),
      },
    });
    const { report, adjustments } = await checkCurrentPolicy({ llm }, { ...base, policy: ingest(lexicon) });
    const s05 = report.findings.filter((x) => x.sectionId === "S05" && x.mode === "A" && x.layer === "llm");
    expect(s05.map((x) => x.ruleId)).toEqual(["R-S05-004"]);
    expect(adjustments.join(" ")).toContain("finance-flagged");
  });
});

describe("usage log", () => {
  const u = (i: number, o: number, cr = 0, cc = 0) => ({ inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cc });

  test("list price comes from the table; an unknown model gives null, never a guess", () => {
    expect(listPriceUsd("claude-haiku-4-5", u(1_000_000, 1_000_000))).toBeCloseTo(6, 6);
    expect(listPriceUsd("claude-opus-5-5", u(1_000_000, 0, 1_000_000, 0))).toBeCloseTo(4.2, 6);
    expect(listPriceUsd("claude-mystery-9", u(10, 10))).toBeNull();
    expect(listPriceUsd("claude-opus-5-5", u(1, 1), { "claude-opus-5-5": { input: 1, output: null, cacheRead: null, cacheWrite: null } })).toBeNull();
    expect(Object.keys(LIST_PRICES_USD_PER_MTOK)).toContain("claude-sonnet-5-5");
  });

  test("a reported cost (Claude Code) is preferred; API rows use list price; unknown model is unpriced", () => {
    const api = toUsageRecord({ stageId: "M1", modelId: "claude-opus-5-5", usage: u(1000, 500) });
    expect([api.costSource, api.reportedCostUsd]).toEqual(["list-price", null]);
    expect(api.costUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 9);
    const cc = toUsageRecord({ stageId: "M1", modelId: "claude-opus-5-5", usage: u(1000, 500), costUsd: 0.0123 });
    expect([cc.costSource, cc.costUsd]).toEqual(["reported", 0.0123]);
    const zero = toUsageRecord({ stageId: "M1", modelId: "claude-opus-5-5", usage: u(1000, 500), costUsd: 0 });
    expect(zero.costSource).toBe("list-price");
    const unknown = toUsageRecord({ stageId: "R2", modelId: "claude-mystery-9", usage: u(1, 1) });
    expect([unknown.costUsd, unknown.costSource]).toEqual([null, "unknown"]);
    expect(UsageRecordSchema.safeParse(unknown).success).toBe(true);
  });

  test("usage.jsonl appends one record per line and summaries count unpriced calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const file = join(dir, "sub", USAGE_FILE);
    const a = toUsageRecord({ stageId: "M1", modelId: "claude-opus-5-5", usage: u(1000, 500) });
    const b = toUsageRecord({ stageId: "R2", modelId: "claude-mystery-9", usage: u(1, 1) });
    await appendUsageJsonl(file, [a]);
    await appendUsageJsonl(file, [b]);
    await appendUsageJsonl(file, []);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    const back = await readUsageJsonl(file);
    expect(back).toEqual([a, b]);
    const s = summarizeUsage(back);
    expect([s.calls, s.unpricedCalls, s.inputTokens]).toEqual([2, 1, 1001]);
    expect(formatCostLine(s)).toContain("가격 미확인 1회");
    expect(formatCostLine(summarizeUsage([]))).toContain("모델 호출 없음");
    expect(await readUsageJsonl(join(dir, "missing.jsonl"))).toEqual([]);
  });

  test("summary.md carries the cost line", () => {
    const md = renderSummaryMarkdown({ stamp: "s", entries: [], usage: summarizeUsage([toUsageRecord({ stageId: "M1", modelId: "claude-opus-5-5", usage: u(1000, 500) })]) });
    expect(md).toContain("모델 사용량: 1회 호출");
  });
});

describe("runMonitorFolder (tenant paths, usage.jsonl, cost line)", () => {
  test("writes under the given tenant root with usage.jsonl and a cost line", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mon-"));
    const watch = join(tmp, "watch");
    mkdirSync(watch);
    copyFileSync(join(import.meta.dir, "fixtures", "finance", "policy-finance.md"), join(watch, "policy-finance.md"));
    const usage: UsageSource = { usageRecords: () => [toUsageRecord({ stageId: "M1", modelId: "claude-opus-5-5", usage: u(10, 5) })] };
    const outRoot = join(tmp, "runs", "acme", "monitor");
    const r = await runMonitorFolder({ root: ROOT, watchDir: watch, outRoot, registryPath: join(outRoot, "registry.json"), backendNote: "test", usage, now: NOW });
    expect(r.outDir.startsWith(outRoot)).toBe(true);
    expect(existsSync(join(outRoot, "registry.json"))).toBe(true);
    expect(readFileSync(join(r.outDir, "summary.md"), "utf8")).toContain("모델 사용량: 1회 호출");
    expect(readFileSync(join(r.outDir, USAGE_FILE), "utf8").trim().split("\n")).toHaveLength(1);
    const report = readFileSync(join(r.outDir, "policy-finance.md"), "utf8");
    expect(report).toContain("금융 법령 해당");
    expect(report).toContain("수동 검토");
    expect(report).not.toContain("수정 방향: \n");
  });
});
function u(i: number, o: number, cr = 0, cc = 0) {
  return { inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cc };
}
