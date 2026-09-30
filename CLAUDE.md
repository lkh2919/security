# Privacy Agent — Claude Code Configuration

## Role Declaration

This project scaffolds the Privacy Policy and Terms Drafting Agent (Phase 1).

**See**: `docs/designs/2026-09-29-privacy-policy-agent-team-design.md` (approved) and `docs/decisions/DEC-20260929-01.md`

## Project Agents

The project defines two specialized agents in `agents/`:

- **privacy-domain-expert** (High tier, `claude-opus-5-5`) — Rule packs, rubric, Interview Template, clause vetting, house-style approval
- **kb-curator** (Medium tier, `claude-sonnet-5-5`) — Corpus capture, provenance, clustering, manifest stamps, freshness checks

Six agents are copied from L0 with a "Project scope (privacy-agent)" section: pm, architect, automation-engineer, auditor, security-expert, docs-writer. Full roster, aliases and owned skills: [`AGENTS.md`](AGENTS.md). Skills: [`skills/README.md`](skills/README.md).

**Rule: PM dispatches; no direct specialist invocation.** Every dispatch sets an explicit `model` alias (`opus`, `sonnet`, `haiku`) per the roster. Runtime pipeline agents (R1-R8, C1, C2) are product code in `packages/core`, not `agents/*.md`. `/sync` is not used here: PM verifies with the project QA gate and the user decides on commits.

## Harness vs Product Zones

- **Harness zone** — `CLAUDE.md`, `AGENTS.md`, `README.md`, `agents/`, `skills/`, `docs/`
  - Apply workspace validators (agents, skills, language)
  - Use `agent-model-gate.ts` tier checking
  
- **Product zone** — `packages/`, `kb/`, `golden/`, `runs/` (gitignored)
  - Apply product gates: `tsc --noEmit`, unit tests, golden-set regression, `security-scan`
  - No server or UI dependency in `packages/core`

## UTF-8 on Windows

Ensure `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8` when running scripts on Windows PowerShell.

## Next Steps

Rows 1-3 are done: scaffold, agents and skills (Row 2), and the law source spike (Row 3). Remaining rows follow design R15:

1. Row 4a: Korean privacy rule packs and Interview Template v1 (privacy-domain-expert).
2. Row 4b: terms rule packs and rubric v1 (privacy-domain-expert).
3. Row 5: Zod contracts, model registry, run store, stage cache (automation-engineer, `sonnet`).
4. Row 6: corpus capture, provenance, clustering, house-style candidates (kb-curator). Waiting for the user's site list.
5. Rows 7-12: R1 intake and masking, golden cases and clause vetting, R2-R4, R8 renderer, R5P/R5T drafters, R6 freshness watcher.
6. Rows 13-15: golden-set regression, router skill and README, final QA gate and freeze.
