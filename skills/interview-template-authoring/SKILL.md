---
name: interview-template-authoring
description: >
  Designs and revises the branching Interview Template: modules, question nodes, conditions,
  evidenceHints and the coverage test that ties nodes to catalog items.
  Use when: creating or changing interview modules or nodes, importing the PM seed template,
  or checking that every mandatory privacy and terms item has a must question.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: privacy-domain-expert
prerequisites: PM-supplied privacy interview template (seed, design Q5); rule packs from rulepack-authoring
relates_to:
  - skill: rulepack-authoring
    type: follows
  - skill: interview
    type: enables
metadata:
  type: domain
  triggers:
    - interview template
    - template authoring
    - question node
    - evidenceHint
    - coverage test
---

## Overview

Produces `kb/jurisdictions/kr/interview/`. Design: R4.4 (schema and three uses), R4.3 (slot paths), R3 (C1 and R3 consumers), R6.1 cross-document checks.

## When to Use

- Building template v1 from the PM seed (design Row 4) or revising after a rule-pack change.
- Not for running interviews (`interview` skill).

## Prerequisites

- Slot paths exist in the fact ledger contract (Zod, design Row 5). Until then, use the R4.3 sketch names and flag them provisional.

## Procedure

1. Read the seed template and the M, C, R classes in R4.1 and R4.2.
2. Define modules: `core`, `b2c_commerce`, `member_community`, `internal_hr`, `ai_feature`, `marketing`, `overseas_transfer`, `children`, `cctv_location`, each with an `enterIf` condition built from `all`, `any`, `not` and `slot` operators.
3. For each node set: `id` (`Q-S09-02` form), `text`, `answerType`, `targets` (slot paths), `itemRefs` (`S09` or `T10`), `showIf`, `priority`, and an `evidenceHint` describing what the extractor should listen for. Keep wording plain; questions must be askable aloud.
4. Map every M item to at least one `must` node; C items get nodes that decide applicability; R items are `should`.
5. Add a coverage test: every M item has a `must` node, every `targets` path exists, every `showIf` slot resolves, no unreachable node. Include one branch fixture per module.
6. Version the template and record the `rulePackVersions` it was built against.

## Output Format

Template JSON files, coverage-test results, list of nodes with provisional slot paths, and questions that need a user decision.

## Definition of Done

- Coverage test passes (all M items covered by `must` nodes).
- Every node has an `evidenceHint`, `itemRefs` and `targets`.
- No personal data or real client details in examples; all wording paraphrased with sources noted.
