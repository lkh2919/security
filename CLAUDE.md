# Privacy Agent — Claude Code Configuration

## Role Declaration

This project scaffolds the Privacy Policy and Terms Drafting Agent (Phase 1).

**See**: `docs/designs/2026-10-02-confirmed-design.md` (confirmed v2: Check/Impact, Peer Watch, Draft), `docs/designs/2026-09-29-privacy-policy-agent-team-design.md` (drafting, approved), `docs/decisions/DEC-20261002-02.md`

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

Rows 1-15 are implemented and tested with mock models (see `docs/HANDOFF.md` for the row table and `docs/reports/2026-10-01-final-qa.md`). What remains needs the API key, the original PC, or a person:

1. Live runs: `scripts/smoke-extract.ts`, `scripts/run-pipeline.ts`, then `scripts/golden-regression.ts --runs 3` (design R11.2 gate; max 3 tuning loops per defect class).
2. Clause vetting (privacy-domain-expert, `opus`): set `vetted` and `vettedAgainst` in clause files; bind the 11 unbound variables to slots or renderer metadata.
3. House-style approval (the user): candidates in `kb/jurisdictions/kr/house-style/`.
4. Original PC only: `scripts/freshness-check.ts`; raw-source rebuilds (redact the capture-index officer contacts again if the index is regenerated, QA finding 1).
5. Freeze (Row 15) only after the live and human gates pass.
