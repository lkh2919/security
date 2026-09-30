import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TextFileSttAdapter } from "../src/adapters/stt";
import { createFactLedgerSchema, verifyTranscriptEvidence } from "../src/contracts/fact-ledger";
import { findVaultLeaks } from "../src/contracts/pii-vault";
import { MockLlmClient } from "../src/llm/client";
import { krPaths, loadKrKnowledge } from "../src/stages/coverage";
import {
  buildExtractSystem,
  buildSlotMap,
  chunkSegments,
  loadPromptFile,
  parsePromptFile,
  runExtract,
  verifyQuote,
  type ExtractOutput,
} from "../src/stages/extract";
import { assertNoPii, runIntake } from "../src/stages/intake";

const REPO = join(import.meta.dir, "..", "..", "..");
const kb = loadKrKnowledge(krPaths(REPO));
const INTAKE = join(import.meta.dir, "fixtures", "intake");
const r2Fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "extract", "r2-output.json"), "utf8")) as ExtractOutput;

async function intake() {
  const transcript = await new TextFileSttAdapter().transcribe(join(INTAKE, "interview.ko.txt"));
  return runIntake({ runId: "20260929-101500-a1b2c3", transcript, form: await readFile(join(INTAKE, "form.md"), "utf8") }, { masking: "basic" });
}

const knowledge = { template: kb.template, registry: kb.registry, slotHints: kb.slotHints };

describe("R2 on the Row 7 fixture (mock LLM)", () => {
  test("builds a valid, evidence-verified ledger; form wins; junk is dropped", async () => {
    const { maskedTranscript, formSlots, vault } = await intake();
    const llm = new MockLlmClient({ fixtures: { R2: r2Fixture }, vault });
    const res = await runExtract({ llm }, { maskedTranscript, formSlots, ...knowledge });
    const { ledger } = res;

    // Contract + evidence verification (the C2 check) pass.
    expect(createFactLedgerSchema(kb.registry).safeParse(ledger).success).toBe(true);
    expect(verifyTranscriptEvidence(ledger, maskedTranscript)).toEqual([]);

    // Model claims that are verified and typed.
    expect(ledger.slots["profile.serviceTypes"].value).toEqual(["b2c_commerce"]);
    expect(ledger.slots["gate.locationInfo"]).toMatchObject({ status: "filled", value: false, confidence: 0.9 });
    expect(ledger.slots["privacy.S09_processors"].value).toEqual([
      { processor: "택배사", task: "배송" },
      { processor: "알림톡 업체", task: "문자 발송" },
    ]);
    expect(ledger.slots["privacy.S05_retention"].confidence).toBe(0.4);

    // Form values win: membership only in the form; outsourcing "예" -> true, with form + transcript evidence.
    expect(ledger.slots["gate.membership"]).toMatchObject({ status: "filled", value: true, confidence: 1 });
    expect(ledger.slots["gate.membership"].evidence[0]).toMatchObject({ source: "form", ref: "form.slots.gate.membership" });
    const outsourcing = ledger.slots["gate.outsourcing"];
    expect(outsourcing).toMatchObject({ status: "filled", value: true, confidence: 1 });
    expect(outsourcing.evidence.map((e) => e.source)).toEqual(["form", "transcript"]);

    // Junk handling: unknown slot dropped (prompt-injection line), fabricated quote downgraded, unsure kept for review.
    expect(ledger.slots["gate.bogusSlot"]).toBeUndefined();
    expect(res.dropped.some((d) => d.slotId === "gate.bogusSlot" && d.reason === "unknown_slot")).toBe(true);
    expect(ledger.slots["privacy.S10_overseas"]).toMatchObject({ status: "needs_manual_review", value: null, evidence: [] });
    expect(res.dropped.some((d) => d.slotId === "privacy.S10_overseas" && d.reason === "no_valid_evidence")).toBe(true);
    expect(ledger.slots["gate.childrenU14"].status).toBe("needs_manual_review");

    // Slots nobody addressed stay absent (C1 reads absence as missing).
    expect(ledger.slots["privacy.S07_thirdParties"]).toBeUndefined();
  });

  test("one masked call: Haiku stage, versioned prompt, untrusted wrapper, slot map prefix, no PII", async () => {
    const { maskedTranscript, formSlots, vault } = await intake();
    const llm = new MockLlmClient({ fixtures: { R2: r2Fixture }, vault });
    const res = await runExtract({ llm }, { maskedTranscript, formSlots, ...knowledge });
    expect(res.chunks).toBe(1);
    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0];
    expect(call).toMatchObject({ stageId: "R2", modelId: "claude-haiku-4-5", effort: null, promptVersion: "1.0.0", schemaName: "ExtractOutput" });
    expect(call.user).toContain("<untrusted_transcript>");
    expect(call.system).toContain("- gate.outsourcing [yes_no");
    expect(call.system).toContain("listen for: Q-S09-01");
    // Masking hard gate: neither the payload nor the ledger carries a vault value.
    expect(findVaultLeaks(`${call.system}\n${call.user}`, vault)).toEqual([]);
    expect(findVaultLeaks(res.ledger, vault)).toEqual([]);
  });

  test("our own outgoing text passes the intake residual-PII gate that the real client applies", async () => {
    const { maskedTranscript, formSlots, vault } = await intake();
    const llm = new MockLlmClient({ fixtures: { R2: r2Fixture }, vault });
    await runExtract({ llm }, { maskedTranscript, formSlots, ...knowledge });
    for (const c of llm.calls) {
      assertNoPii(c.system, { vault });
      assertNoPii(c.user, { vault });
    }
    assertNoPii(loadPromptFile("interview/v1.md").body, { vault });
  });

  test("the static prefix is byte-identical across runs (cache-friendly)", async () => {
    const prompt = loadPromptFile("extract/v1.md");
    expect(buildExtractSystem(prompt, knowledge)).toBe(buildExtractSystem(prompt, knowledge));
    expect(buildSlotMap(knowledge)).toBe(buildSlotMap(knowledge));
  });

  test("a transcript answer that contradicts the form becomes status conflict", async () => {
    const { maskedTranscript, formSlots } = await intake();
    const contradiction: ExtractOutput = {
      slots: [{ slotId: "gate.membership", status: "filled", valueJson: "false", confidence: "high", evidence: [{ segmentId: "T0004", quote: "회원가입을 하면" }] }],
    };
    const llm = new MockLlmClient({ fixtures: { R2: contradiction } });
    const { ledger } = await runExtract({ llm }, { maskedTranscript, formSlots, ...knowledge });
    expect(ledger.slots["gate.membership"]).toMatchObject({ status: "conflict", value: null });
    expect(ledger.slots["gate.membership"].evidence.map((e) => e.source)).toEqual(["form", "transcript"]);
  });
});

describe("evidence verification", () => {
  test("verifyQuote: exact substring only; wrong segment is repaired when unique; long quotes are cut to 300", async () => {
    const { maskedTranscript } = await intake();
    expect(verifyQuote(maskedTranscript, "T0004", "B2C 온라인 쇼핑 앱입니다.")?.repaired).toBe(false);
    const repaired = verifyQuote(maskedTranscript, "T0001", "B2C 온라인 쇼핑 앱입니다.");
    expect(repaired).toMatchObject({ repaired: true, evidence: { segmentId: "T0004" } });
    expect(verifyQuote(maskedTranscript, "T0004", "존재하지 않는 문장")).toBeNull();
    expect(verifyQuote(maskedTranscript, "T0004", "   ")).toBeNull();
    expect(verifyQuote(maskedTranscript, "T9999", "B2C")).toMatchObject({ evidence: { segmentId: "T0004" } });
    const long = { ...maskedTranscript, segments: [{ id: "T0001", text: "가".repeat(500) }] };
    expect(verifyQuote(long, "T0001", "가".repeat(500))?.evidence.quote.length).toBe(300);
  });

  test("a claim whose quote comes from a different sentence is downgraded, not trusted", async () => {
    const { maskedTranscript, formSlots } = await intake();
    const bad: ExtractOutput = {
      slots: [{ slotId: "gate.genAI", status: "filled", valueJson: "true", confidence: "high", evidence: [{ segmentId: "T0004", quote: "AI 챗봇을 제공합니다" }] }],
    };
    const { ledger } = await runExtract({ llm: new MockLlmClient({ fixtures: { R2: bad } }) }, { maskedTranscript, formSlots, ...knowledge });
    expect(ledger.slots["gate.genAI"]).toMatchObject({ status: "needs_manual_review", value: null });
  });

  test("bad JSON values and wrong types are dropped, yes/no strings are coerced", async () => {
    const { maskedTranscript, formSlots } = await intake();
    const q = [{ segmentId: "T0034", quote: "위치정보는 수집하지 않습니다." }];
    const out: ExtractOutput = {
      slots: [
        { slotId: "gate.cctvFixed", status: "filled", valueJson: "{not json", confidence: "high", evidence: q },
        { slotId: "gate.cctvMobile", status: "filled", valueJson: "\"maybe\"", confidence: "high", evidence: q },
        { slotId: "gate.locationInfo", status: "filled", valueJson: "\"아니오\"", confidence: "high", evidence: q },
      ],
    };
    const { ledger, dropped } = await runExtract({ llm: new MockLlmClient({ fixtures: { R2: out } }) }, { maskedTranscript, formSlots, ...knowledge });
    expect(ledger.slots["gate.cctvFixed"]).toBeUndefined();
    expect(ledger.slots["gate.cctvMobile"]).toBeUndefined();
    expect(dropped.filter((d) => d.reason === "bad_value").map((d) => d.slotId).sort()).toEqual(["gate.cctvFixed", "gate.cctvMobile"]);
    expect(ledger.slots["gate.locationInfo"].value).toBe(false);
  });
});

describe("chunking and cross-chunk merge", () => {
  test("chunkSegments: contiguous cover, overlap, forward progress, oversize segment alone", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({ id: `T${String(i + 1).padStart(4, "0")}`, text: "가".repeat(100) }));
    const chunks = chunkSegments(segs, 350, 1);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0][0].id).toBe("T0001");
    expect(chunks.at(-1)!.at(-1)!.id).toBe("T0010");
    for (let i = 1; i < chunks.length; i++) expect(chunks[i][0].id).toBe(chunks[i - 1].at(-1)!.id);
    expect(chunkSegments([{ id: "T0001", text: "x".repeat(5000) }], 100, 2)).toHaveLength(1);
    expect(chunkSegments([], 100, 2)).toEqual([]);
  });

  test("a long transcript is split into several calls; equal rows dedupe, arrays union, scalar disagreement conflicts", async () => {
    const { maskedTranscript, formSlots } = await intake();
    let n = 0;
    const fixture = (): ExtractOutput => {
      n++;
      if (n === 1) {
        return {
          slots: [
            { slotId: "privacy.S09_processors", status: "filled", valueJson: "[{\"processor\":\"택배사\",\"task\":\"배송\"}]", confidence: "high", evidence: [{ segmentId: "T0026", quote: "배송은 택배사에" }] },
            { slotId: "gate.marketing", status: "filled", valueJson: "true", confidence: "medium", evidence: [{ segmentId: "T0030", quote: "선택 동의로 받습니다." }] },
          ],
        };
      }
      if (n === 2) {
        return {
          slots: [
            { slotId: "privacy.S09_processors", status: "filled", valueJson: "[{\"processor\":\"택배사\",\"task\":\"배송\"},{\"processor\":\"알림톡 업체\",\"task\":\"문자 발송\"}]", confidence: "high", evidence: [{ segmentId: "T0026", quote: "문자 발송은 알림톡 업체에 맡깁니다." }] },
            { slotId: "gate.marketing", status: "filled", valueJson: "false", confidence: "medium", evidence: [{ segmentId: "T0030", quote: "쿠폰을 보냅니다." }] },
          ],
        };
      }
      return { slots: [] };
    };
    const llm = new MockLlmClient({ fixtures: { R2: fixture } });
    const { ledger, chunks } = await runExtract({ llm, maxChunkChars: 600, overlapSegments: 1 }, { maskedTranscript, formSlots, ...knowledge });
    expect(chunks).toBeGreaterThan(2);
    expect(llm.callCount("R2")).toBe(chunks);
    expect(ledger.slots["privacy.S09_processors"].value).toEqual([
      { processor: "택배사", task: "배송" },
      { processor: "알림톡 업체", task: "문자 발송" },
    ]);
    expect(ledger.slots["privacy.S09_processors"].evidence).toHaveLength(2);
    expect(ledger.slots["gate.marketing"]).toMatchObject({ status: "conflict", value: null });
    expect(verifyTranscriptEvidence(ledger, maskedTranscript)).toEqual([]);
  });
});

describe("prompt file", () => {
  test("extract/v1.md has a semver front matter and instructions in English", () => {
    const p = loadPromptFile("extract/v1.md");
    expect(p.version).toBe("1.0.0");
    expect(p.body).toContain("untrusted");
    expect(() => parsePromptFile("no front matter")).toThrow(/front matter/);
    expect(() => parsePromptFile("---\nversion: one\n---\nx")).toThrow(/version/);
  });
});
