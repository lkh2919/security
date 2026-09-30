# Privacy Policy and Terms Drafting Agent

**Phase 1: harness and core library** · design approved 2026-09-29

A TypeScript agent system that drafts a Korean privacy policy (개인정보처리방침) and terms of service from a service-description form and an interview transcript, for review by the InfoSec office. It follows the PIPC Privacy Policy Drafting Guideline (April 2026), reuses public Lotte group policy clauses, checks law freshness through the law.go.kr Open API, and runs an independent audit before rendering.

The output is a reference draft. Humans (privacy officer, InfoSec, legal) review it before publication.

## What it does

1. **Intake**: form plus transcript (text, or STT from audio). Masking is **off by default**; text is still sanitized and fenced as untrusted data. `--masking basic` masks PII before any model call.
2. **Extract (R2, Haiku)**: turns the transcript into a fact ledger. Every claim needs a verbatim quote that code verifies.
3. **Coverage (C1, code)**: walks the Interview Template, decides which of 24 privacy sections and 15 terms articles apply, and lists gaps.
4. **Interview (R3)**: asks the missing must-level questions (max 2 rounds, 10 questions each). The run stops at `awaiting_answers` and resumes with an answers file.
5. **Match (R4, code)**: ranks vetted Lotte clauses per section.
6. **Draft (R5P/R5T, Sonnet)**: clause-first; code renders a vetted clause when the facts cover it, the LLM writes only the rest. Unknown gates, special types (children, CCTV, gen-AI, location) and the delegation-vs-provision ambiguity become manual-review notes, never guesses.
7. **Check and audit (C2 code, R7 Opus)**: deterministic checks, then an isolated auditor that sees only an allowlisted envelope. Flagged sections are redrafted, at most 3 iterations; after that the draft carries a "DRAFT, unresolved findings" banner.
8. **Render (R8)**: Markdown, HTML, DOCX and a Reviewer Sheet.

Design: [`docs/designs/2026-09-29-privacy-policy-agent-team-design.md`](docs/designs/2026-09-29-privacy-policy-agent-team-design.md). Decisions: `docs/decisions/`. Current status and open items: [`docs/HANDOFF.md`](docs/HANDOFF.md). How to run it: [`docs/operator-guide.md`](docs/operator-guide.md).

## Status

| Area | State |
|------|-------|
| Contracts, run store, stage cache | done |
| Intake, extraction, coverage, interview, match, draft, C2, audit, loop, render, orchestrator | done, tested with mock models |
| Live API runs | **not run yet** (needs `ANTHROPIC_API_KEY`) |
| Clause library | 153 clauses captured and validated; **none vetted** (vetting is the privacy-domain-expert's work), so drafting falls back to the rule packs |
| House style | 19 candidate rules; **not approved** (the user approves them), so no house-style check is enforced |
| Golden set and regression gate | cases, seeded defects, rubric and harness done; live calibration pending |
| Law freshness | watcher done; runs only on the original PC (law.go.kr key is IP-bound) |

Cost and latency figures in the design are estimates; Row 13 replaces them with measured token usage.

## Structure

```
CLAUDE.md, AGENTS.md, README.md, NOTICES
agents/, skills/, docs/                       harness zone
packages/core/src/
  contracts/  pipeline/  llm/  adapters/       schemas, run store, model registry, STT and law API
  stages/{intake,extract,coverage,gap,interview,match,draft,check,audit,loop,orchestrate,render,freshness}
  eval/                                        golden-set metrics, defect injection, regression runner
packages/core/prompts/                         versioned prompt files (extract, interview, draft-*, audit)
kb/jurisdictions/kr/                           rule packs, interview template, clauses, rubric, statutes, house-style candidates
golden/{cases,defects}/                        synthetic regression cases and seeded defects
scripts/                                       run-pipeline, golden-regression, freshness-check, validate-clauses, ...
runs/                                          per-run artifacts (gitignored)
```

## Quick start

```bash
bun install
bun x tsc --noEmit                    # typecheck
cd packages/core && bun test          # 700+ tests, no network, no API key
bun scripts/validate-clauses.ts       # clause library validator
```

Live runs need `ANTHROPIC_API_KEY` in `.env`; see the operator guide. Never print or commit secrets.

## Agents and skills

Project agents: **privacy-domain-expert** (rule packs, rubric, template, clause vetting, house-style proposals) and **kb-curator** (corpus, provenance, manifest). Six more are copied from the L0 roster; see [`AGENTS.md`](AGENTS.md). Skills: [`skills/README.md`](skills/README.md); the `privacy-docs` router maps requests to `interview`, `draft`, `audit`, `freshness`.

## Regulatory basis

Personal Information Protection Act and its Decree (amended by Act 21445, in force 2026-09-11), the PIPC guideline 2026.4, the Act on the Regulation of Terms and Conditions, the E-Commerce Act, and KFTC standard terms No. 10023. Every legal fact in the knowledge base carries a verified source and date; unverified items stay in `kb/jurisdictions/kr/statutes/pending-verification.json` and never reach a prompt.

## Benchmark

github.com/kimlawtech/korean-privacy-terms (concepts only; see `NOTICES`).
