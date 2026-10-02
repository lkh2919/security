# Contest deck outline (PPTX)

Audience: 1st Lotte Innovate AI Agent Build Challenge, Track A (process innovation).

Timeline:
- submission 2026-10-23;
- first review 10/26–27;
- demo day 10/29–30;
- winners are standardised company-wide and published to the internal AI library HUB.

Judging criteria and weights:

| Criterion | Weight |
|-----------|--------|
| 업무 효과성 | 30 |
| AI 활용 적합성 (AI use and workflow design) | 30 |
| 구현/아이디어 완성도 | 20 |
| 전사 적용 가능성 | 20 |

Design source: `docs/designs/2026-10-02-confirmed-design.md`.

Rules for numbers:
- `[measure]` cells come from real runs or the InfoSec pilot (design C8).
- Anything not measured by 10/23 is shown as a labelled target, never as a result.

## Storyline (needs first: existing policies vs law changes; drafting second)

| # | Title | Message | Evidence | Criterion |
|---|-------|---------|----------|-----------|
| 1 | The need | Laws change (Act 21445 in force 2026-09-11; Network Act amendment in force 2026-10-02) and InfoSec checks every affiliate's policy by hand | Manual hours per policy and per amendment `[measure: InfoSec pilot]` | 업무 효과성 |
| 2 | The idea | A daily agent: law change → which policies, which sections, how urgent; drafting follows | One-line flow | 업무 효과성 |
| 3 | Urgency with evidence | Peer Watch: "k of n peers in the same group already changed this section" | Aggregated counts only `[measure: peer change log]`; labelled "업계 동향(참고)" | 업무 효과성, AI 활용 적합성 |
| 4 | Workflow harness | Code does exact work; Haiku extracts, Sonnet drafts, Opus audits; staged, cached, resumable runs; daily chain; eval gates; usage log | Harness diagram (design C3) | AI 활용 적합성 |
| 5 | Facts you can trace | Every finding carries a verbatim quote and a location; the auditor cannot be talked into a pass | Quote check, isolated envelope, seeded-defect recall `[measure]` | AI 활용 적합성 |
| 6 | Honest limits | Fact-dependent items become "confirm" questions; finance law is flagged for manual review; provisional and confirmed tiers | Sample report | 완성도 |
| 7 | Drafting as capability 2 | Interview → draft → Reviewer Sheet | Synthetic G1 run | 완성도 |
| 8 | Cost and quality | Tokens and cost per run; gates for monitor, peers and drafting | `usage.jsonl` totals `[measure]`; gate table `[measure]` | 업무 효과성, 완성도 |
| 9 | Company-wide in 30 minutes | A new affiliate brings data, not code: `org.json`, policy folder, peer list, rule-pack choice; tenant-scoped paths | Config pack tree; HUB packaging (CLI, library, Claude Code skill) | 전사 적용 가능성 |
| 10 | Roll-out and asks | Domain groups, finance monitoring-only, approvals the company owns | Group table; approval list (design C10) | 전사 적용 가능성 |

## Demo-day script (5 minutes)

| Time | Segment | How it runs |
|------|---------|-------------|
| 0:00–0:40 | Need and urgency | Slide |
| 0:40–2:00 | `agent.ts daily` on a stored law change (제21988호 fixture), then the per-policy impact report, then the peer panel | Live, from stored fixtures; no live crawl |
| 2:00–3:30 | Drafting the synthetic G1 case | Recorded, 90 seconds |
| 3:30–4:15 | Harness diagram plus the auditor catching a seeded defect | Recorded clip |
| 4:15–5:00 | Extensibility and measured results | Slide |

Keep a fallback recording of the live segment.

## `[measure]` sources

| Number | Source | Status |
|--------|--------|--------|
| Manual baseline hours and expert key | InfoSec pilot (people supply it) | to collect |
| Monitor gates and 제21988호 impact result | `eval-gates.ts`, live run | to build |
| Peer change counts | Peer change log; collection must start early to have several days of data | to build |
| Seeded-defect recall | `scripts/calibrate-defects.ts` | 1.00, one live run (2026-10-01) |
| Tokens and cost | `usage.jsonl` | to build |
| Clause coverage | Only after privacy-domain-expert vetting | 0 of 153 vetted |
