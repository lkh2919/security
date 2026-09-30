---
name: audit
description: >
  Audits a privacy policy or terms draft in two layers: deterministic C2 checks, then the isolated
  Opus auditor with a code-enforced input allowlist; drives the capped fix loop.
  Use when: auditing a generated or existing draft, re-checking after redrafting flagged sections,
  or producing an AuditReport and Reviewer Sheet items.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: pm
prerequisites: Bun runtime; `scripts/run-pipeline.ts` (needs ANTHROPIC_API_KEY); rubric and must-rule digest from privacy-domain-expert
relates_to:
  - skill: draft
    type: follows
  - skill: policy-audit-rubric
    type: relates_to
metadata:
  type: process
  triggers:
    - audit privacy draft
    - audit terms
    - run auditor
    - audit report
---

## Overview

Sub-skill of `privacy-docs`. Entry point: see the CLI status line below.
Design: R6 (rubric, C2, R7, pass/fail, iteration cap), R3 (R7 row), R17 (acceptance).

## When to Use

- After C2-clean drafting, once per document per iteration.
- Not for building or tuning the rubric (`policy-audit-rubric`) or for harness regression (`golden-set-regression`).

## Prerequisites

- Entry point: the audit runs inside the pipeline (C2 then the isolated R7 auditor, redraft of flagged sections only, max 3 iterations, escalation with a DRAFT banner). Standalone audit of an external draft is not built; answer such a request with the rubric checklist applied manually and label it "manual, not the isolated auditor".
- Auditor prompts live in `packages/core/prompts/audit/`; drafter prompts must not import them.

## Procedure

1. Run C2 (layer 1). Stop and return findings if any C2 check fails.
2. Build the `AuditEnvelope` from the allowlist only: `docMarkdown`, `astSummary`, `factLedger`, `maskedTranscript`, `formSlots`, `applicability`, `mustRuleDigest`, `rubricProfile`, `houseStyle`, `c2Results`, `priorFindings`, `otherDocDigest`. No drafter prompts, thinking or clause-selection rationale.
3. Call R7 (`claude-opus-5-5`, effort `high`, fresh call, structured output). R7 emits findings only.
4. Verdict: pass needs 0 blocker, 0 major, all C2 checks passing, every score at least 4 (`clarity` at least 3).
5. On fail with iteration below 3: return flagged sections to the drafters, then repeat C2 and R7.
6. After iteration 3: render with the banner "DRAFT - unresolved findings" and return open findings to the user.

## Output Format

`AuditReport` (verdict, scores, findings with `ruleId`, `sectionId`, `severity`, evidence quote, `fixHint`), iteration number, envelope hash, minor findings for the Reviewer Sheet.

## Definition of Done

- Envelope key set matches the allowlist (unit test green).
- Report validates against the `AuditReport` schema and cites a rubric version.
- Loop ended by pass or by the iteration cap, never silently.
