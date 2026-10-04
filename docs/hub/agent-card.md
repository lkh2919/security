# Agent card: Privacy Monitor

**Name**: Privacy Monitor (privacy-agent)

**Purpose**: checks published Korean privacy policies against the rule packs in force, reports which sections a law amendment affects, watches peer policies as industry reference, and drafts a reference privacy policy and terms.

## Inputs

- `config/orgs/<org>/org.json` (data only; fields as in `config/orgs/example/org.json`)
- A folder of published policies (`.md`, `.html`, `.htm`)
- Optional: peer registry JSON, old and new law XML plus law code (`impact`), interview transcript plus service form (`draft`)

## Outputs

Reference reports (Markdown and JSON, Korean) under `runs/<tenantId>/` (gitignored): monitor reports with severity, provisional or confirmed tier and Confirm questions; daily digest; peer reports; draft documents with a Reviewer Sheet. Every output carries "참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다."

## Entry points

- CLI: `bun scripts/agent.ts <check|impact|daily|draft|peers> --config ... [--llm api|claude-code|none]`; also `bun scripts/peer-history.ts`
- Library: `packages/core` (`runMonitorFolder`, `runDaily`, `watchPeers`, `startRun`, `draftDocument`)
- Claude Code skill: `skills/privacy-monitor/SKILL.md`
- Setup: `docs/adopt-in-30-minutes.md` (Korean: `docs/ko/adopt-in-30-minutes.md`)

## Requirements

- Bun
- Claude Code login (`--llm claude-code`) or `ANTHROPIC_API_KEY` (`--llm api`); `--llm none` runs deterministic checks only
- Optional `LAW_GO_KR_OC` (law.go.kr key, bound to a registered IP) for law freshness and peer history

## Data handling

- Runs locally; text goes only to the chosen model backend. Policy text is treated as untrusted data and fenced.
- Draft intake masking is off by default; `--masking basic` masks PII before any model call.
- Org config holds no secrets or personal data; reviewers are role labels.
- Keys are never printed or logged. Policies (`watch/`) and outputs (`runs/`) are gitignored; never commit them.
- Peer fetching follows robots.txt, uses one page per host per UTC day, and applies no rating or ranking.

## Owners

PM (skills and routing), privacy-domain-expert (rule packs), kb-curator (corpus and freshness). See `AGENTS.md`.

## Limitations

- Reference only; not legal advice. InfoSec and legal review is required.
- DOCX and PDF policy input are not supported yet (reported as manual review).
- Finance policies: monitoring and manual review only; no suggested wording.
- Peer signals are industry reference, not legal requirements.
- Live model runs, clause vetting and house-style approval are still pending (see `docs/HANDOFF.md`).
