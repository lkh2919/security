# Privacy Policy and Terms Drafting Agent

**Phase 1 — Harness and Core Library** · Approved 2026-09-29

A TypeScript agent system for drafting InfoSec-reviewed privacy policies and terms of service under Korean law (PIPA, PIPC Guideline 2026.4, KFTC standards).

## Overview

This project implements an orchestrated, multi-stage pipeline (8 runtime agents, 2 harness agents, 6 skills) that:

1. **Intakes** service descriptions, interview recordings (mp3 → STT), and branching interview answers
2. **Extracts** facts using Haiku with the PIPC guideline as a retrieval map
3. **Covers** 24 privacy sections and 15 terms sections via a deterministic template walker
4. **Interviews** users on identified gaps (max 2 rounds)
5. **Drafts** clauses (code-rendered from vetted Lotte clause library) and LLM-adapted sections
6. **Audits** output independently using Opus against a legal rubric
7. **Renders** MD, HTML, and DOCX with a Reviewer Sheet and version stamps

**Cost**: ~$1.30 per run (30-min interview, 1 iteration). **Time**: ~2 minutes end-to-end.

## Structure

```
privacy-agent/
├── CLAUDE.md, AGENTS.md, README.md, NOTICES
├── agents/, skills/, docs/{designs,decisions,specs}/     # harness zone
├── package.json (Bun workspaces)
├── packages/core/src/{contracts,pipeline,stages,llm,...}  # no server/UI
├── packages/cli/                                          # subcommands
├── kb/jurisdictions/kr/{rulepacks,clauses,house-style}   # product zone
├── golden/cases/                                          # regression test cases
└── runs/                                                  # gitignored per-run artifacts
```

## Getting Started

```bash
# Install dependencies
cd privacy-agent
bun install

# Type check
bun run typecheck

# (Future) Run CLI
bun run packages/cli dev
```

## Design & Decisions

- **Design**: `docs/designs/2026-09-29-privacy-policy-agent-team-design.md`
- **Decision Record**: `docs/decisions/DEC-20260929-01.md`
- **Benchmark**: github.com/kimlawtech/korean-privacy-terms (concepts only; see NOTICES)

## Agents

- **privacy-domain-expert** (High tier) — Rule packs, Interview Template, auditor rubric, clause vetting
- **kb-curator** (Medium tier) — Corpus capture, freshness checks, house-style extraction

## Skills

See `skills/README.md` for the full roster of router and specialized skills.

## Regulatory Basis

- **Privacy**: Korean Personal Information Protection Act (PIPA), PIPC Privacy Policy Drafting Guideline (April 2026)
- **Terms**: KFTC Standard Terms and Conditions, Act on the Regulation of Terms and Conditions (ARTC)

## Next Steps (Row 1+)

1. Hire and onboard privacy-domain-expert and kb-curator agents
2. Spike law.go.kr API and PIPC/KFTC page freshness checks (Row 3)
3. Author rule packs and Interview Template (Row 4)
4. Define Zod data contracts (Row 5)
5. Implement intake, extraction, coverage, and rendering stages
6. Build auditor rubric and golden-set regression gate
