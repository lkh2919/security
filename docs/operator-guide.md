# Operator guide

How to run the privacy-policy and terms pipeline, read its output, and keep the knowledge base healthy. Audience: the person operating the agent (PM, InfoSec analyst). Status of each piece: [`HANDOFF.md`](HANDOFF.md).

## 1. Prerequisites

- Bun (see `package.json`), then `bun install`.
- `.env` in the repository root:
  - `ANTHROPIC_API_KEY` for any live run.
  - `LAW_GO_KR_OC` for the freshness watcher. The key is bound to the registered IP, so freshness runs only on the original PC.
- Never print, log or commit keys. Scripts print token counts only.

## 2. Inputs

| Input | Format | Notes |
|-------|--------|-------|
| Service form | `key: value` Markdown or JSON | Gate answers such as `gate.outsourcing: 예`, data flows under `## 데이터 흐름: <name>`; see `kb/jurisdictions/kr/interview/intake-sheet-v1.json` |
| Interview | text file, lines like `[00:01:10] 이름 (역할): 발언` | STT audio adapters exist but are not wired to a vendor yet |
| Answers (resume) | JSON `AnswerSet`: `{ runId, round, answers: [{ questionId, value }] }` | `value: null` skips a question |

Use synthetic or already-public data when you can. Masking is off by default (user decision 2026-09-30): interviewees are assumed not to disclose sensitive internal information. If that is not true for an interview, add `--masking basic`. Raw values then stay in `runs/<id>/pii-vault.local.json` and never reach a model, the cache or the run snapshot.

## 3. Run it

```bash
# 1. start: intake, extract, coverage; stops if must-level facts are missing
bun scripts/run-pipeline.ts start --transcript interview.txt --form form.md [--masking basic]

# 2. answer the printed questions (max 2 rounds), then resume
bun scripts/run-pipeline.ts answer --run <runId> --answers answers.json
```

Outputs land in `runs/<runId>/output/`: `privacy-policy.{md,html,docx}`, `terms.{md,html,docx}` (only if terms apply), `reviewer-sheet.{md,html}`. Intermediate artifacts (`03-extract.json`, `04-coverage.r0.json`, ...) and `run-state.json` let you see where a run stopped. Runs are never overwritten; a repeated run id is refused.

## 4. Reading the result

- **Reviewer Sheet first.** It lists, per section, the status, the evidence (transcript segment ids), open questions and audit findings. Give it to the InfoSec office with the draft.
- **Section status**: `drafted`; `not_processed_statement` (e.g. no overseas transfer); `manual_review` (unknown gate, special type, or conflicting facts); `omitted_recommended`; `not_applicable`.
- **Always manual**: children under 14, CCTV, generative AI, location data, and any party that could be a processor (위탁) or a third-party recipient (제3자 제공). The draft shows both candidates and never decides.
- **Verdicts**: `pass`, `pass_with_warnings` (minor findings or manual-review sections), `fail`. A `fail` after 3 iterations renders with a "DRAFT, unresolved findings" banner and the open findings in the sheet.
- Every output carries the fixed disclaimer: reference draft, InfoSec and legal review required, violations can lead to administrative fines.

## 5. Keeping the knowledge base healthy

| Task | Command | Who |
|------|---------|-----|
| Validate clauses, manifest, house-style candidates | `bun scripts/validate-clauses.ts` | anyone |
| KB integrity tests | `cd packages/core && bun test test/kb-integrity.test.ts` | anyone |
| Law and guideline drift | `bun scripts/freshness-check.ts` (exit 0 fresh, 10 drift, 1 error) | original PC only |
| Re-capture Lotte policies, rebuild clauses | `scripts/capture-lotte.ts`, `scripts/build-clauses.ts` | original PC only (raw sources in `kb/_sources/` are gitignored) |
| Regression gate | `bun scripts/golden-regression.ts --cases G1 --runs 1 --no-defects`, then the full set with `--runs 3` | PM or auditor |

A freshness warning never blocks drafting; it adds a note. Drift in a law or guideline means the affected rule-pack sections need review by the privacy-domain-expert.

## Keeping personal data out of git

- Enable the guard once per clone: `git config core.hooksPath .githooks`. It runs `bun scripts/pii-scan.ts --staged` before every commit and blocks mobile numbers, personal e-mails, resident-registration-number shapes and tokens.
- `bun scripts/pii-scan.ts` scans every tracked file; the same check runs in the unit tests, so a leak fails `bun test`.
- Placeholders: name `홍길동`, phone `010-0000-0000`, e-mail `privacy@lotte.net`. Real names cannot be detected by pattern: never commit them. `packages/core/test/` and `golden/` are synthetic by construction and exempt.
- Raw sources and runs stay out of git (`kb/_sources/`, `runs/`).

## 6. Decisions only people can make

- **House style**: the candidates in `kb/jurisdictions/kr/house-style/lotte-innovate.candidates.json` are enforced only after the user approves them (approved file `lotte-innovate.json`).
- **Clause vetting**: a clause reaches the matcher only when `vetted: true` and `vettedAgainst` name the rule-pack version. Until then sections are written from the rule packs.
- **Delegation vs provision** and every `manual_review` item: decided by the privacy officer, not the agent.

## 7. Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `skipped: ANTHROPIC_API_KEY is not set` | add the key to `.env`; scripts exit 0 without it |
| `[CONTRACT_ERROR] ...` | an input or model output failed its schema; the message names the field, never the content |
| `run already exists` | pick a new `--run-id` or omit it |
| `not awaiting answers` | the run already finished or failed; check `run-state.json` |
| tsc or tests fail after a KB edit | run `bun scripts/validate-clauses.ts` and the KB integrity test first |
