---
name: golden-set-regression
description: >
  Runs the golden-set regression gate: batch runs of G, W and D cases, metric computation against
  thresholds, stability runs and cost tracking.
  Use when: any prompt, KB, rule-pack, rubric or template change lands, before freeze or release,
  or when auditor calibration or stability needs to be measured.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: auditor
prerequisites: Bun runtime; golden/cases/ with expected.json and reference/; privacy-agent CLI (planned); API key held by operator
relates_to:
  - skill: policy-audit-rubric
    type: follows
  - skill: audit
    type: composes_with
metadata:
  type: process
  triggers:
    - golden set
    - regression gate
    - seeded defect recall
    - stability run
    - run regression
---

## Overview

Owned by auditor. Design: R11.1 (cases), R11.2 (thresholds), R11.3 (determinism levers), R10 (Batch API for 50% cost), R17 (acceptance).

## When to Use

- After any change to prompts, `kb/`, rule packs, rubric or template.
- Not for authoring cases or references (privacy-domain-expert) or fixing failures (route via PM).

## Prerequisites

- CLI status: PLANNED (design Row 13). Until built, run unit tests and report which gate metrics cannot yet be measured.
- Cases use synthetic inputs only; no real personal data.

## Procedure

1. Select cases: G1, G1b, G2, G2b, G3 (expect pass); W1-W4 (expect `warn`, no fabricated body); D1-D8 (seeded defects).
2. Run each case with 3 runs for stability (use the Batch API where possible); pin model, prompt, rule-pack, clause-library and style versions from `DocAST.meta`.
3. Compute metrics and compare with thresholds: applicability accuracy, M-item coverage, traceability, citation validity at 100%; unsupported-claim rate 0; slot recall at least 0.90 and precision at least 0.95; seeded-defect recall at least 0.90; blocker plus major findings on G-cases 0; stability: same sections and table rows, text similarity at least 0.85; clause-first ratio tracked (target at least 50%); cost or latency regression above 25% flagged.
4. Compare with the previous baseline and list regressions with the change that likely caused them.
5. On failure, allow at most 3 tuning loops per defect class, then escalate to PM.
6. Store the report in `runs/` (gitignored) and a summary in `docs/` when requested by PM.

## Output Format

Metric table (value, threshold, pass or fail), per-case verdicts, defect recall matrix, stability figures, cost and latency deltas, and a go or no-go recommendation.

## Definition of Done

- All R11.2 thresholds pass, or every failure is listed with an owner and next action.
- Inputs, versions and model IDs are recorded so an identical replay reproduces the result.
- Report is findings-only; auditor does not edit product code or KB content.
