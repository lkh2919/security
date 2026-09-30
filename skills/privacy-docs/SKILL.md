---
name: privacy-docs
description: >
  Thin router for the privacy-agent product. Routes a request to one of four sub-skills
  (interview, draft, audit, freshness), each mapped to a script.
  Use when: a user or PM asks to prepare an interview, draft a privacy policy or terms,
  audit a draft, or check law freshness, and the correct entry point is unclear.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: pm
prerequisites: Bun runtime; ANTHROPIC_API_KEY for live runs; scripts in `scripts/` (run-pipeline, freshness-check, golden-regression)
relates_to:
  - skill: interview
    type: composes_with
  - skill: draft
    type: composes_with
  - skill: audit
    type: composes_with
  - skill: freshness
    type: composes_with
metadata:
  type: process
  triggers:
    - privacy-docs
    - /privacy-docs
    - draft privacy policy
    - draft terms of service
    - privacy interview
    - audit privacy draft
---

## Overview

`privacy-docs` holds no logic of its own. It picks the right sub-skill and passes along the run context.
Each sub-skill can be called alone. Design: `docs/designs/2026-09-29-privacy-policy-agent-team-design.md` R7 (orchestration), R8 (thin router pattern), R9 (skills).

## When to Use

Use for any end-user or PM request about the Korea-only privacy policy and terms pipeline.
Do not use it for KB authoring (use `rulepack-authoring`, `interview-template-authoring`, `lotte-corpus-curation`) or harness QA (use `golden-set-regression`).

## Routing Table

| Intent | Sub-skill | Entry point | Stage(s) |
|--------|-----------|--------------------------|----------|
| Prepare or export interviewer script; find gaps | `interview` | `bun scripts/run-pipeline.ts start ...` (stops at `awaiting_answers` with the questions) | R1, R2, C1, R3 |
| Produce policy and terms from form, transcript, answers | `draft` | `bun scripts/run-pipeline.ts start ...` then `answer --run <id> --answers a.json` | R4, R5P, R5T, C2, R7, R8 |
| Audit an existing or generated draft | `audit` | runs inside the pipeline (draft -> C2 -> R7, max 3 iterations); standalone audit of an external draft is not built | C2, R7 |
| Check law and guideline drift | `freshness` | `bun scripts/freshness-check.ts` (original PC only: the law.go.kr key is IP-bound) | R6 |

## Procedure

1. Classify the request against the routing table. If two intents apply, run them in order: freshness (parallel), interview, draft, audit.
2. Confirm inputs exist: form JSON, transcript or `--transcript` text (STT fallback), answers file on resume.
3. Masking is OFF by default (user decision 2026-09-30): text is sanitized and fenced as untrusted data. Pass `--masking basic` when the interview holds sensitive internal information; then no unmasked value reaches a model.
4. Invoke the sub-skill. If a stage it needs is unavailable (no API key, no law.go.kr access), say which and stop instead of improvising.
5. Return the run ID, artifact paths under `runs/<runId>/`, and open findings.

## Output Format

Routing decision (one line), sub-skill invoked, run ID, paths, and next step. Every generated document carries the disclaimer: "Reference draft. InfoSec and legal review required. Violations can lead to administrative fines."

## Definition of Done

- The correct sub-skill was invoked (or a clear "stage unavailable" message returned).
- No unmasked text left the local process.
- The user received run ID, artifacts and unresolved items.
