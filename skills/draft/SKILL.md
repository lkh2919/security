---
name: draft
description: >
  Produces the privacy policy and terms of service drafts clause-first: match vetted Lotte clauses,
  adapt only sections that need it, run deterministic checks, and render MD, HTML and DOCX.
  Use when: generating a privacy policy or terms draft from a completed fact ledger, redrafting flagged sections,
  or rendering outputs with the Reviewer Sheet.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: pm
prerequisites: Bun runtime; privacy-agent CLI (planned); vetted clauses in kb/jurisdictions/kr/clauses/; rule packs in kb/jurisdictions/kr/rulepacks/
relates_to:
  - skill: interview
    type: follows
metadata:
  type: process
  triggers:
    - draft privacy policy
    - draft terms
    - generate policy
    - redraft section
    - render policy
---

## Overview

Sub-skill of `privacy-docs`. Maps to the planned CLI subcommand `privacy-agent run` (and `--resume`).
Design: R3 (R4, R5P, R5T, C2, R8), R5.3 clause library, R5.4 house style, R6.2 deterministic checks, R10 token plan.

## When to Use

- The fact ledger is complete or the remaining gaps are accepted as `manual_review`.
- Redrafting only sections flagged by the auditor (max 3 iterations per document).
- Not for changing prompts or rule packs (harness authoring skills do that).

## Prerequisites

- CLI status: PLANNED (design R15 rows 9-12). Before it exists, report which stage is missing and stop.
- Applicability map from C1. Terms are `not_applicable` for internal HR systems, with the reason stated.

## Procedure

1. Classify the business group (R4, code first, `haiku` fallback only).
2. Per section, render a vetted clause when its `vars` and `conditions` cover the ledger (zero tokens). Use the LLM (Sonnet, effort `medium`) only for sections needing adaptation, loading one rule-pack slice plus `principles.json`.
3. Emit SectionAST with `slotRef` per factual inline and `cite` inlines that resolve in `kb/jurisdictions/kr/statutes/citations.json`.
4. Run C2 (structure, evidence, style and safety, cross-document values). Fix code-level failures before any audit call.
5. Render (R8): MD, HTML with anchor TOC, DOCX; rehydrate placeholders locally; add disclaimer, change table and Reviewer Sheet.
6. Record version stamps in `DocAST.meta` (rule pack, clause library, house style, law snapshot, prompts, models).

## Output Format

`runs/<runId>/` artifacts, final MD, HTML and DOCX for each applicable document, Reviewer Sheet, clause-first ratio.

## Definition of Done

- C2 passes; no unresolved `{{...}}` or `{%...%}`; every `cite` resolves; disclaimer present.
- Only vetted clauses were used; each has provenance.
- Freshness drift, if any, appears as a note and Reviewer Sheet entry (drift never blocks drafting).
