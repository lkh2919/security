# Confirmed Design v2 — Privacy Agent: Draft, Check/Impact, Peer Watch (2026-10-02)

Status: confirmed by the PM council (architect `opus`, privacy-domain-expert `opus`, security-expert `sonnet`, auditor `sonnet`,
kb-curator `sonnet`, docs-writer `sonnet`) on 2026-10-02, at the user's request. Decision record: `docs/decisions/DEC-20261002-02.md`.

It builds on and does not replace:
- `2026-09-29-privacy-policy-agent-team-design.md` (drafting pipeline, approved);
- `2026-10-02-policy-monitor-design.md` (Check/Impact, Phase A1 built).

Where they disagree, this document wins.

## C1 — What the product is

The InfoSec office's first need is to know which existing policies fall out of step when a law changes, where they must change, and
how urgent the change is. Drafting new policies is the second capability.

| App | Question it answers | Status |
|-----|---------------------|--------|
| **Check/Impact** (Policy Monitor) | Does a published policy meet the rules in force? Which policies, which sections, must change after an amendment? | A1 built |
| **Peer Watch** (new) | Have peer companies in the same domain group already changed the same section? This is evidence for urgency. | design |
| **Draft** | Turns an interview and an intake form into a reviewed reference draft (policy and terms). | built, live-tuned |

Every output is a reference: "참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다."

## C2 — One core, three thin apps (architect)

```
packages/core (shared core)
  adapters/ingest, stages/ingest      MD/HTML (DOCX/PDF later) -> sections S01–S24 with provenance
  kb loader + rule packs + manifest   privacy-2026.04, terms-kftc-10023, legal-ref map, law targets
  stages/check (C2)                   profiles: draft | published
  stages/audit                        R7 fact envelope (draft) | published-policy judge (M1)
  stages/freshness + adapters/lawapi  law watch, article (항/호) diff
  stages/render, stages/monitor/report  reports (MD/HTML/DOCX, Reviewer Sheet, monitor report)
  pipeline (run store, stage cache)   atomic writes, resume, cache keyed by prompt/model/KB stamps
  llm (api | claude-code | mock)      pinned models per stage; usage log
apps (wiring only, no private copies of core logic)
  Draft         stages/orchestrate
  Check/Impact  stages/monitor
  Peer Watch    stages/peers + adapters/fetch/safe-fetch
```

## C3 — Workflow harness (AI 활용 적합성: workflow design)

| Concern | Exists | To add |
|---------|--------|--------|
| Division of labour | Code does exact work (C2, diff, mapping). Haiku extracts, Sonnet drafts, Opus audits and judges. Pinned model per stage. | — |
| Orchestration | `startRun` / `continueRun`; the monitor registry skips unchanged sha256 | `scripts/agent.ts <draft\|check\|impact\|peers\|daily> --config <org>` dispatcher |
| Daily chain | — | `daily` = freshness → Mode B for changed MSTs → sha re-check (Mode A) → peers → digest; each step is a RunStore stage, so a failure resumes, not restarts |
| Caching and resume | Stage cache, RunStore, `golden-batch.ts` waits out usage limits | Impact cache keyed by (tenant, policySha, diff hash, rulePackVersion) |
| Scheduling | Cloud Routines available | One Routine (fresh session) runs `agent.ts daily --llm claude-code` |
| Gates | tsc, unit tests, PII pre-commit hook, golden regression, D1–D8 calibration | `eval-gates.ts` runs the monitor and peer gates (C7); a confirmed alert is never published while a gate fails |
| Observability | In-memory usage per stage | `usage.jsonl` per run (stage, model, tokens, cache hits, list-price USD) and a cost line in every summary |
| Human gates | Clause vetting, house-style approval (user) | Domain-expert approval of the legal-ref map, heading patterns and alert wording; legal sign-off on the peer registry |
| Development harness | PM dispatches specialist agents with an explicit model tier; decisions recorded in `docs/decisions` | — |

## C4 — Company-wide extensibility (전사 적용 가능성)

Rule: a new department, affiliate or domain group brings data, not code.

- **Blocker to remove**: law watch targets are hard-coded in `stages/freshness/targets.ts`. They move to a KB file (`statutes/law-targets.watch.json`); the TS list remains only as a fallback.
- **Config pack**:
  ```
  config/orgs/<org>/org.json     name, domainGroup, policy folder, reviewers, enabled apps, LLM backend
  config/orgs/<org>/peers.json   peer registry for the group (or a shared one)
  ```
  Rule packs and the legal-ref map are chosen by `org.json`.
- **What a department supplies**: `org.json`, a folder of its policies, an optional peer list, and a choice of existing rule packs.
- **A new law domain** brings a rule pack plus legal-ref map entries.
- **Tenancy**: every registry, run, watch, cache and report path is prefixed by a tenant id, with a per-tenant secret and config namespace. The contest build runs single-tenant with that prefix in place.
- **Packaging for the AI library HUB**:
  1. CLI (`bun scripts/agent.ts …`);
  2. library API (`checkPolicy`, `impactOf`, `watchPeers`, `draft`);
  3. a Claude Code skill and agent definition that call the CLI with `--llm claude-code`, so no API key is needed;
  4. a README page, "adopt in 30 minutes".

## C5 — Peer Watch

### Grouping

There are five Lotte domain groups plus one IT/platform reference group. Each group holds the Lotte affiliates, which are checked with Mode A and B, and about five peers, which are reference only and get change detection only. The Lotte side is seeded from the captures index (kb-curator):

| Group | Lotte captures |
|-------|----------------|
| 유통 | retail_ecommerce 14 |
| 식품 | food_manufacturing |
| 화학·건설·제조 | construction_realestate 4, plus Lotte Chemical |
| 관광·서비스 | services_leisure 9 |
| 금융 | none; L.POINT (loyalty_membership 4) is the nearest |

Logistics 4, IT services 3, HR 2 and holding 1 have no group yet; the user decides.

### Peer candidates

All candidates are to be verified: a published policy URL and robots rules. URLs are not supplied yet. Legal sign-off is not required: privacy policies must be publicly disclosed (PIPA Art. 30(2)), so fetching them is legitimate (user decision 2026-10-02).

| Group | Candidates |
|-------|------------|
| 식품 | CJ제일제당, 농심, 오리온, 오뚜기, 하이트진로 |
| 유통 | 신세계(이마트/SSG), 현대백화점, GS리테일, BGF리테일, 쿠팡 |
| 화학·건설·제조 | LG화학, 한화솔루션, 현대자동차, 현대건설, GS건설 |
| 관광·서비스 | 호텔신라, 신세계조선호텔, 하나투어, 모두투어, CJ CGV |
| 금융 (loyalty/card) | CJ ONE, OK캐쉬백, 신한카드, 삼성카드, 현대카드 |
| IT/platform reference | 네이버, 카카오, 토스, 우아한형제들, 당근 |

### Signals (privacy-domain-expert)

| Signal | Meaning |
|--------|---------|
| P0 `peer_changed` | Section-level change after normalisation. Cosmetic, date-only and contact-only edits do not count. |
| P1 `peer_aligned` | The changed paragraph cites the amended article or uses the amendment's new terms or values. |
| P2 `group_adoption` | k of n peers reach P1 for the same legal-ref key within a window: 30 days after the effective date, or up to it for an upcoming amendment. Shown when k ≥ 3 and k/n ≥ 0.6. |

- **Attribution confidence**: High when the peer cites the amended article or quotes its new wording; Medium when the change is in the same section and uses the amendment's keywords; Low when only timing and section overlap. Only High and Medium count toward P2. Low shows as "변경 감지 (원인 미상)". A peer change "co-occurred" with an amendment; it was never "caused by" it.
- **What a signal may change**: P2 can raise the priority of a Mode B item but never its severity. A peer signal alone never creates a finding.
- **Wording**: always "업계 동향(참고) — 법적 요구사항 아님". Never "의무", "위반" or "해야 함". Peers are never rated or ranked for compliance. Demo slides show aggregated counts only.

### Contracts and module

- `PeerRegistry`: groups with Lotte orgs and peers; `{peerId, name, url, robots, termsCheckedAt, approvedBy}`.
- `PolicySnapshot`: `{peerId, url, fetchedAt, sha256, sections[{sectionId, sha256, charCount}]}`.
- `PolicyChangeEvent`: changed sections with a masked quote of at most 25 words.
- `UrgencySignal`: `{articleKey, sectionId, groupId, k, n, windowDays, confidence, label}`. It is attached to Mode B findings as evidence.
- Code lives in `stages/peers/` and `adapters/fetch/safe-fetch.ts` and reuses ingest, the segmenter and the section map.

### Fetching (security-expert, must-have before any live crawl)

- Fetch only the exact URLs in the registry; never follow crawled links.
- Use the M6.3 safe fetcher: https on ports 80/443, DNS checked against private ranges, every redirect re-validated, size and time caps, no cookies.
- Check robots.txt on every fetch. A disallow, or robots.txt being unreachable, means the peer is skipped.
- Use an honest user agent, fetch at most one page per host per day, honour Crawl-delay, and use conditional GET.
- A 403 or 429 means back off; a block notice disables the peer for good.
- Record each site's terms-of-use status once when the peer is added (informational; not a blocker).

### Storage

- Committed: `kb/jurisdictions/kr/monitor/peers/peer-registry.json`, stamped in the manifest.
- Committed: an append-only change log holding hashes and short quotes only.
- Snapshots are written only on change, with contacts masked, outside git and kept for 90 days.

### Contest demo

The demo runs from stored fixtures, not a live crawl.

## C6 — Finance: monitoring only (option ①, user decision)

- **Watch list additions**:
  - 신용정보법 (law ID 001540) and its decree;
  - 전자금융거래법;
  - 금융소비자보호법;
  - the supervisory regulations where law.go.kr carries them.

  IDs that are not yet verified stay in `pending-verification.json`.
- **Articles of interest** (privacy-domain-expert, to verify):

  | Law | Articles |
  |-----|----------|
  | 신용정보법 | 31 (신용정보활용체제 공시), 32–34, 17, 20-2, 33-2, 37, 38, 39-3 |
  | 전자금융거래법 | 21, 22, 24, 26, 19 |
  | 금융소비자보호법 | 19, 23, 28, 46 |

- **Legal-ref map**: the prefixes `CIA`, `EFTA` and `FCPA` map to `manualReview: true` and to no sections. A finance amendment always produces a provisional "금융 법령 해당 – 수동 검토" item and is never auto-mapped.
- **Lotte Members (L.POINT)**:
  - The privacy policy is checked with the PIPA packs.
  - Paragraphs that cite these laws, or hit the finance lexicon, are tagged `financeFlag`: Confirm severity, no suggested wording and no PIPA "missing" finding for them. The lexicon covers 신용정보, 개인신용정보, 신용조회, 충전포인트, 선불전자지급 and 전자금융거래.
  - Credit-information content stays out of LLM prompts beyond the required masking.
- **Finance peer group**: reference only, under the same Peer Watch controls.
- **Out of Phase 1**: no finance rule pack and no finance drafting.

## C7 — Gates

The monitor gates in `2026-10-02-policy-monitor-design.md` M8 still apply. Added gates:

| Gate | Threshold |
|------|-----------|
| Cosmetic/layout invariance (whitespace, markup, nav, dates, identical reorders, real consecutive-day replays) | 0 alerts, 0 section-change records |
| Substantive change detection (seeded edits) | recall ≥ 0.90, precision ≥ 0.90 |
| Section attribution of changes | ≥ 0.90; unmappable → UNMAPPED; span fidelity 1.0 |
| Amendment attribution | precision ≥ 0.80; 0 on decoys (unrelated sections, pre-amendment changes) |
| Integrity | every "k of n" recomputable from stored events; quotes ≤ 25 words; no PII; robots and rate logs clean |
| Fail closed | unparseable or JS-only page → manual review, excluded from counts |

## C8 — Measuring business effect (업무 효과성, no invented numbers)

- **Pilot design**: two or three InfoSec reviewers review the same items, first by their normal method, then on the agent-assisted path. The agent path includes human verification of its output. Each reviewer logs wall-clock minutes.
- **Items**: the captured Lotte policies and the 제21988호 amendment.
- **What to report**: medians and ranges, missed or wrong findings against an expert key, and rework time. State n and call it a pilot.
- **Scaling claims**: these use the team's own policy count and amendment frequency, labelled as assumptions. Cost comes from `usage.jsonl`.
- **What the people involved supply**: the baseline hours and the expert key.

## C9 — Build order to the 2026-10-23 submission

| Days | Work |
|------|------|
| 1–3 | Config extraction: law targets to JSON, `org.json` loader, finance targets, legal-ref map (Network Act, ARTC, ECA, safety notice; finance monitor-only) |
| 3–6 | `usage.jsonl` and cost summary; `agent.ts` dispatcher and the `daily` chain with resume; tenant path prefix |
| 5–10 | `safe-fetch`, Peer Watch contracts, snapshot diff, signals into Mode B reports, tests (fixtures first) |
| 8–13 | Monitor A2 essentials: severity and confirm tuning (the live A1 run found 23 Confirm items and fact-dependent items marked Critical), live 제21988호 fixture, `eval-gates.ts` |
| 12–15 | Cloud Routine for `daily` and one real digest; HUB packaging (skill, README, library exports) |
| 15–21 | Pilot measurement with InfoSec, demo script and recording, deck |

**Cut line** (everything below it is cut first if time runs short):
- DOCX/PDF ingest;
- a notification channel;
- the confirmed-tier workflow UI;
- the URL service and dashboard;
- peer groups beyond 유통 plus one other.

If live peer fetching slips, peers are captured by hand as saved HTML and go through the same diff pipeline.

## C10 — Human approvals before the demo

1. Legal-ref map entries, including the finance prefixes (privacy-domain-expert).
2. Heading patterns, including the old `제N조` layout used by L.POINT, and the finance lexicon (privacy-domain-expert).
3. Alert, P2 and finance-flag wording (privacy-domain-expert).
4. Hand label of the 제21988호 fixture (privacy-domain-expert).
5. Peer registry: company list (user). No legal sign-off is needed for fetching public policies (user decision 2026-10-02).
6. Group assignment of logistics, IT services, HR and holding captures (user).
7. Baseline hours and an expert key for the pilot (InfoSec).
