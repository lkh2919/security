---
name: pii-masking-review
description: >
  Reviews the PII masking hard gate: pattern coverage for Korean personal data, placeholder and vault design,
  and leak tests proving no PiiVault value reaches an LLM payload, log or artifact.
  Use when: R1 intake or masking code changes, new PII patterns are needed, LLM payload builders change,
  or before any release that sends masked text to the Claude API.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: security-expert
prerequisites: R1 masking implementation (design Row 7); synthetic PII fixtures; security-scan skill
relates_to:
  - skill: security-scan
    type: composes_with
  - skill: zod-contract-gate
    type: composes_with
metadata:
  type: process
  triggers:
    - pii masking
    - masking review
    - leak test
    - piivault
    - data flow review
---

## Overview

Owned by security-expert. Design: R3 (R1 row, runtime API rules: send only masked text), R4.3 (placeholders), R7 (mask error is a hard stop), R12 (PII risk, Q3 data transfer).

## When to Use

- Any change under `packages/core/src/` touching intake, masking, `llm/` payload builders, run store or logging.
- Not for general dependency scanning (`security-scan`) or contract typing (`zod-contract-gate`).

## Prerequisites

- Use synthetic PII fixtures only. Never paste real personal data, real keys or tokens into reports.

## Procedure

1. Pattern coverage: names, phone numbers, email, resident registration and business registration numbers, addresses, account and card numbers, IP addresses, employee IDs, company-internal codes. Check both spaced and unspaced forms and Korean or full-width digits.
2. Placeholder design: stable `{{PERSON_1}}` style keys, one-way to the local PiiVault, rehydration only in R8.
3. Data-flow trace: map each place a string can reach (STT output, R2, R3, R5P/R5T, R7, cache keys, `runs/` artifacts, logs, error messages). Assert no PiiVault value is present.
4. Leak tests: unit test with fixtures asserting no LLM payload contains a vault value; an `AuditEnvelope` test asserting only allowlisted keys; log and artifact scan over a full synthetic run.
5. Injection check: the transcript is untrusted data; only R2 and R7 read it and both emit schema-bound output with no tools.
6. Key handling: API and law.go.kr OC keys come from the environment only, are never logged or stored, and `.gitignore` covers `runs/` and `kb/_sources/`.
7. Classify findings Critical, High, Medium; a Critical finding blocks release and is escalated to PM.

## Output Format

Coverage table (pattern, detected or missed), data-flow map, leak-test results, findings with severity and fix owner, Q3 (data transfer) status.

## Definition of Done

- All leak tests pass on the synthetic run; no Critical or High finding is open.
- A mask error stops the run; there is no fallback that sends unmasked text.
- Findings-only report; code changes are done by automation-engineer via PM.
