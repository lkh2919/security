import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFetchState, type PageFetcher, type PageRequest, type PageResult } from "../src/adapters/fetch";
import type { Manifest } from "../src/contracts/manifest";
import { PeerRegistrySchema, PEER_SIGNAL_LABEL } from "../src/contracts/peers";
import { RunStore } from "../src/pipeline";
import { runDaily, type DailyDeps } from "../src/stages/daily";
import { NOW, ingestFixture, kb, patterns, ruleSections } from "./monitor-fixtures";

const KR = join(import.meta.dir, "fixtures", "config", "kr");
const manifest: Manifest = {
  manifestVersion: "1.0.0",
  rulePacks: [],
  lawSnapshot: { id: "snap", laws: [{ name: "개인정보 보호법", target: "law", id: "100", effective: "2026-01-01" }] },
  clauseLib: { version: "1.0.0", capturedAt: NOW.toISOString(), sites: [], vettedClauses: 0 },
  houseStyle: { version: "1.0.0" },
  pages: [],
};

const FILLER = "회사는 정보주체의 개인정보를 관련 법령에 따라 안전하게 처리하며 필요한 범위에서만 이용하고 목적이 달성되면 지체 없이 처리를 종료합니다.";
const policyPage = (retention: string): string =>
  `<html><body><nav>메뉴</nav><h1>예시 개인정보 처리방침</h1><p>예시회사는 개인정보 보호법에 따라 처리방침을 공개합니다.</p>` +
  `<h2>1. 개인정보의 처리 목적</h2><p>서비스 제공을 위하여 처리합니다. ${FILLER}</p>` +
  `<h2>2. 처리하는 개인정보의 항목</h2><p>이름과 이메일 주소를 처리합니다. ${FILLER}</p>` +
  `<h2>3. 개인정보의 처리 및 보유 기간</h2><p>${retention} ${FILLER}</p>` +
  `<h2>4. 개인정보의 파기 절차 및 방법에 관한 사항</h2><p>지체 없이 파기합니다. ${FILLER}</p></body></html>`;

class FakeFetcher implements PageFetcher {
  readonly requests: PageRequest[] = [];
  retention = "회원 탈퇴 시까지 보유합니다.";
  async fetchPage(req: PageRequest): Promise<PageResult> {
    this.requests.push(req);
    return { status: "ok", finalUrl: req.url, httpStatus: 200, body: policyPage(this.retention), contentType: "text/html", rendered: false };
  }
}

/** Fetch state whose first flush fails: the peers step stops after fetching. */
class FlakyState extends MemoryFetchState {
  failures = 1;
  override async flush(): Promise<void> {
    if (this.failures-- > 0) throw new Error("simulated disk failure");
  }
}

const REGISTRY = PeerRegistrySchema.parse({
  version: "t",
  groups: [
    {
      groupId: "retail",
      nameKo: "유통",
      lotte: ["lotte-a-privacy"],
      peers: [
        { peerId: "peer-1", name: "가나다", url: "https://peer1.example/privacy", render: "html", robots: "allowed", status: "active" },
        { peerId: "peer-2", name: "나다라", url: "https://peer2.example/privacy", render: "html", robots: "allowed", status: "active" },
      ],
    },
  ],
});
const CAPTURES = [{ id: "lotte-a-privacy", site: "롯데A", url: "https://lotte-a.example/privacy", capture: "ok", docType: "privacy" }];

function setup(opts: { state?: MemoryFetchState; now?: Date; peers?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "peers-daily-"));
  const fetcher = new FakeFetcher();
  const state = opts.state ?? new MemoryFetchState();
  const now = opts.now ?? NOW;
  const deps: DailyDeps = {
    krDir: KR,
    tenantId: "acme",
    runsRoot: join(tmp, "runs", "acme", "daily"),
    registryPath: join(tmp, "runs", "acme", "monitor", "registry.json"),
    apps: { check: true, impact: true, peers: opts.peers ?? true },
    loadPolicies: () => [ingestFixture("policy-clean.md", "pol-one")],
    ruleSections,
    rulePackItems: kb.rulePackItems,
    rulePackVersion: kb.rulePackVersion,
    patterns,
    manifest,
    now: () => now,
    peers: { registry: REGISTRY, captures: CAPTURES, fetcher, state, peersDir: join(tmp, "runs", "acme", "peers") },
  };
  return { tmp, deps, fetcher, state };
}

describe("daily chain with Peer Watch", () => {
  test("the peers step runs after the re-check and before the digest; a new Lotte capture goes through Mode A", async () => {
    const { deps, fetcher, tmp } = setup();
    const r = await runDaily(deps);
    expect(r.steps.map((s) => s.stage)).toEqual(["daily-freshness", "daily-impact", "daily-recheck", "daily-peers", "daily-digest"]);
    const store = await RunStore.open(deps.runsRoot, r.runId);
    const peers = JSON.parse(readFileSync(join(r.dir, (await store.readState()).stages["daily-peers"]!.artifact!), "utf8")) as { status: string; outcomes: { id: string; status: string }[]; lotteReports: { policyId: string }[]; reportFile: string };
    expect(peers.status).toBe("ran");
    expect(peers.outcomes.map((o) => [o.id, o.status])).toEqual([["peer-1", "baseline"], ["peer-2", "baseline"], ["lotte-a-privacy", "baseline"]]);
    expect(peers.lotteReports.map((x) => x.policyId)).toEqual(["lotte-a-privacy"]);
    expect(existsSync(join(r.dir, "reports", "lotte-a-privacy.json"))).toBe(true);
    expect(existsSync(peers.reportFile)).toBe(true);
    expect(existsSync(join(tmp, "runs", "acme", "peers", "snapshots", "peer-1"))).toBe(true);
    expect(fetcher.requests.map((q) => q.url)).toEqual(["https://peer1.example/privacy", "https://peer2.example/privacy", "https://lotte-a.example/privacy"]);
    const digest = readFileSync(r.digestFile, "utf8");
    expect(digest).toContain("피어 워치");
    expect(digest).toContain(PEER_SIGNAL_LABEL);
    expect(digest).toContain("lotte-a-privacy");
  });

  test("a failure in the peers step resumes there: earlier steps are reused, nothing before it runs again", async () => {
    const { deps, fetcher } = setup({ state: new FlakyState() });
    await expect(runDaily(deps)).rejects.toThrow("simulated disk failure");
    const store = await RunStore.open(deps.runsRoot, "daily-20261002");
    const st = (await store.readState()).stages;
    expect([st["daily-freshness"]?.status, st["daily-impact"]?.status, st["daily-recheck"]?.status, st["daily-peers"]?.status, st["daily-digest"]]).toEqual(["done", "done", "done", "failed", undefined]);

    const r = await runDaily(deps);
    expect(r.steps.map((s) => [s.stage, s.resumed])).toEqual([["daily-freshness", true], ["daily-impact", true], ["daily-recheck", true], ["daily-peers", false], ["daily-digest", false]]);
    expect(existsSync(r.digestFile)).toBe(true);

    const fetched = fetcher.requests.length;
    const again = await runDaily(deps);
    expect(again.steps.every((s) => s.resumed)).toBe(true);
    expect(fetcher.requests.length).toBe(fetched); // the finished peers step is not fetched again
  });

  test("the next day a changed Lotte page is re-checked (Mode A) again; an unchanged one is not", async () => {
    const day1 = setup();
    await runDaily(day1.deps);
    // same tenant folders, next day
    const next = new Date("2026-10-03T09:00:00.000Z");
    const same = await runDaily({ ...day1.deps, now: () => next });
    const storeSame = await RunStore.open(day1.deps.runsRoot, same.runId);
    const art = async () => JSON.parse(readFileSync(join(same.dir, (await storeSame.readState()).stages["daily-peers"]!.artifact!), "utf8")) as { outcomes: { id: string; status: string }[]; lotteReports: unknown[] };
    expect((await art()).outcomes.map((o) => o.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect((await art()).lotteReports).toHaveLength(0);

    day1.fetcher.retention = "회원 탈퇴 후 3년간 보유합니다.";
    const third = await runDaily({ ...day1.deps, now: () => new Date("2026-10-04T09:00:00.000Z") });
    const storeThird = await RunStore.open(day1.deps.runsRoot, third.runId);
    const art3 = JSON.parse(readFileSync(join(third.dir, (await storeThird.readState()).stages["daily-peers"]!.artifact!), "utf8")) as { outcomes: { id: string; status: string; changedSections?: { sectionId: string }[] }[]; lotteReports: { policyId: string }[] };
    expect(art3.outcomes.map((o) => [o.id, o.status])).toEqual([["peer-1", "changed"], ["peer-2", "changed"], ["lotte-a-privacy", "changed"]]);
    expect(art3.outcomes[0]!.changedSections?.map((c) => c.sectionId)).toEqual(["S05"]);
    expect(art3.lotteReports.map((x) => x.policyId)).toEqual(["lotte-a-privacy"]);
  });

  test("a disabled peers app or a missing registry skips the step with a note", async () => {
    const off = setup({ peers: false });
    const r1 = await runDaily(off.deps);
    expect(off.fetcher.requests).toHaveLength(0);
    expect(r1.steps.find((s) => s.stage === "daily-peers")).toBeDefined();
    const { peers: _p, ...noRegistry } = setup().deps;
    void _p;
    const r2 = await runDaily(noRegistry);
    const store = await RunStore.open(noRegistry.runsRoot, r2.runId);
    const art = JSON.parse(readFileSync(join(r2.dir, (await store.readState()).stages["daily-peers"]!.artifact!), "utf8")) as { status: string; notes: string[] };
    expect(art.status).toBe("skipped");
    expect(art.notes.join(" ")).toContain("registry");
  });
});
