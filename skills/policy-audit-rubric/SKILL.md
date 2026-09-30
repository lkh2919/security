---
name: policy-audit-rubric
description: >
  Builds and maintains the one-framework audit rubric with a privacy profile, a terms profile,
  cross-document checks, 0-5 score anchors and seeded defects for auditor calibration.
  Use when: creating or revising rubric content, adding seeded defects, defining score anchors,
  or explaining why an audit verdict changed.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: privacy-domain-expert
prerequisites: Rule packs from rulepack-authoring; house-style file (approved rules only)
relates_to:
  - skill: rulepack-authoring
    type: follows
  - skill: audit
    type: enables
  - skill: golden-set-regression
    type: enables
metadata:
  type: domain
  triggers:
    - audit rubric
    - rubric profile
    - seeded defect
    - score anchors
    - unfair clause check
---

## Overview

Produces the rubric text under `packages/core/prompts/audit/` (content only) and the seeded-defect specs under `golden/cases/D1..D8`. Design: R6.1 (one framework, two profiles), R6.3 (calibration), R6.4 (pass rule), R11.1 (golden set).

## When to Use

- Rubric v1 (design Row 4), profile changes, new defect classes, calibration failures reported by auditor.
- Not for running audits (`audit`) or metrics (`golden-set-regression`).

## Prerequisites

- Drafter prompts must never import the rubric; keep it in `prompts/audit/` only.

## Procedure

1. Shared layer: principles (legal compliance, accuracy against evidence, clarity), `houseStyle`, `consistency`, and 0-5 anchors with one concrete example per anchor level.
2. Privacy profile: section checks derived from the `must` and `should` rules per section (compressed must-rule digest for the auditor, not the full pack).
3. Terms profile: terms section checks plus ARTC unfair-clause checks from `unfair-clause-lexicon.json`.
4. Cross-document checks: same organization name, minimum age, withdrawal versus retention, T13 link to the policy.
5. Pass rule to encode: 0 blocker, 0 major, all C2 checks pass, every score at least 4 (`clarity` at least 3).
6. Seeded defects D1-D8 (privacy and terms): missing retention basis, wrong recipient, blanket liability exclusion, wrong citation, and others; each has a defect spec, expected `ruleId`, `severity`, and location. Target recall at least 90%.
7. Give each rule a stable `ruleId` (`R-S05-002`, `H-07`, `U-T14-01`) and version the rubric; note the version in every AuditReport.

## Output Format

Rubric files, defect specs, anchor tables, version and changelog line, calibration notes for auditor.

## Definition of Done

- Rubric covers both profiles and all four cross-document checks.
- Each seeded defect maps to exactly one rule and one expected finding.
- No law fact in the rubric lacks a verified source (URL plus `verifiedAt`).
- Findings-only design preserved: the auditor never edits text.
