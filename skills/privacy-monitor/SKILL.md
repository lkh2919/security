---
name: privacy-monitor
description: >
  Runs the Privacy Monitor CLI for an org config using the operator's Claude Code login (no API key).
  Use when: checking published privacy policies against rule packs, assessing a law amendment's impact,
  running the daily watch, or reading peer-policy changes for an affiliate.
version: 1.0.0
last_reviewed: 2026-10-02
status: active
scope: project
owner: pm
prerequisites: Bun; Claude Code login; config/orgs/<org>/org.json; policy files in its policyDir; optional LAW_GO_KR_OC
relates_to:
  - skill: privacy-docs
    type: composes_with
  - skill: freshness
    type: composes_with
metadata:
  type: process
  triggers:
    - privacy-monitor
    - /privacy-monitor
    - check privacy policy
    - amendment impact
    - peer watch
---

## When to Use

An affiliate asks whether its published policy meets current rules, what a law amendment changes, what peers changed, or wants the daily digest. Drafting a new policy goes to `privacy-docs`. Setup: `docs/adopt-in-30-minutes.md`.

## Commands

Always pass `--llm claude-code` where a model is needed.

```bash
bun scripts/agent.ts check  --config config/orgs/<org>/org.json --llm claude-code [--force]
bun scripts/agent.ts impact --config config/orgs/<org>/org.json --diff old.xml,new.xml --law PIPA [--effective YYYY-MM-DD] --llm claude-code
bun scripts/agent.ts daily  --config config/orgs/<org>/org.json --llm claude-code [--run-id ID] [--skip-peers]
bun scripts/agent.ts peers  --config config/orgs/<org>/org.json [--group <id>] [--dry-run] [--limit N]
bun scripts/peer-history.ts --config config/orgs/<org>/org.json [--law PIPA --new-mst <mst>]
```

`daily` skips freshness when `LAW_GO_KR_OC` is unset; `peer-history` needs it. Do not print it.

## Inputs and Outputs

- Inputs: org config, policies in `policyDir` (`.md`, `.html`, `.htm`), law XML pair for `impact`.
- Outputs: `runs/<tenantId>/monitor|daily|peers/...` (gitignored). Report the paths, the summary (counts by severity) and the Confirm questions.

## Safety Rules

1. Reference only: repeat the disclaimer "참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다." Never present output as legal advice.
2. Do not rate, rank or score peers. Peer signals are industry reference, not legal requirements.
3. Finance items ("금융 법령 해당 – 수동 검토") are manual review by people; do not propose wording for them.
4. Provisional findings are unverified (max Medium); do not escalate them.
5. Never commit run outputs, policies under `watch/`, or keys. Never print `LAW_GO_KR_OC` or `ANTHROPIC_API_KEY`.
6. If a backend or key is missing, say what was skipped and stop; do not improvise findings.
7. Do not fetch peer pages outside the CLI (robots.txt and one page per host per day apply).

## Definition of Done

Command exit code and output paths reported, severity summary and Confirm questions listed, disclaimer included.
