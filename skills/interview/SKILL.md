---
name: interview
description: >
  Runs the branching Interview Template flow: intake and masking, fact extraction, coverage check,
  and gap questions (max 2 rounds), or exports the interviewer script.
  Use when: preparing an interview with a service owner, extracting facts from a transcript or form,
  listing unanswered template questions, or exporting the interviewer script to MD or DOCX.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: pm
prerequisites: Bun runtime; privacy-agent CLI (planned); interview template at kb/jurisdictions/kr/interview/
relates_to:
  - skill: privacy-docs
    type: follows
metadata:
  type: process
  triggers:
    - interview
    - privacy interview
    - interview script
    - gap questions
    - extract facts
---

## Overview

Sub-skill of `privacy-docs`. Maps to the planned CLI subcommand `privacy-agent interview`.
Design: R3 (R1, R2, C1, R3), R4.3 (fact ledger), R4.4 (Interview Template), R7 (human turn).

## When to Use

- Before a service-owner meeting: export the module-based interviewer script.
- After a meeting: turn the recording (mp3, via STT adapter) or `--transcript` text plus the service form into a masked fact ledger and a gap list.
- Never for authoring template content (that is `interview-template-authoring`).

## Prerequisites

- CLI status: PLANNED (design R15 rows 7, 9, 10). Until built, produce the script and gap list by hand from `kb/jurisdictions/kr/interview/` and say so.
- Interview Template exists with `version` and `rulePackVersions`.

## Procedure

1. Intake and mask (R1): parse the form, split the transcript into segment IDs (`T0001`), replace PII with placeholders (`{{PERSON_1}}`); the PiiVault stays local. A mask error is a hard stop.
2. Extract (R2, Haiku): fill slot candidates with segment evidence and confidence, using node `evidenceHint`s as the map. Only masked text is sent.
3. Coverage (C1, code): walk modules from `kb/jurisdictions/kr/interview/` against the ledger; compute applicability for S01-S24 and T01-T15 and the gap list.
4. Ask (R3): emit unanswered template questions verbatim; the LLM only merges and rephrases follow-ups (at most 10 questions, at most 2 rounds).
5. Save RunState and wait for `privacy-agent run --resume <id> --answers a.json`. A skipped `must` question leaves the item `manual_review`.
6. Export mode: render the applicable modules as an interviewer script (MD or DOCX via R8).

## Output Format

`runs/<runId>/NN-<stage>.json` artifacts, a `QuestionSet`, and optionally the interviewer script file. Report unanswered `must` nodes separately.

## Definition of Done

- Every M item has at least one asked or answered `must` node, or is flagged `manual_review`.
- No PiiVault value appears in any LLM payload or artifact under `runs/`.
- Gap questions are within the caps (10 per round, 2 rounds).
