# Policy Monitor — Design (2026-10-02)

Status: approved by the PM council (architect, privacy-domain-expert, security-expert, auditor, kb-curator), 2026-10-02.
Decision record: `docs/decisions/DEC-20261002-01.md`. Extends the approved design `2026-09-29-privacy-policy-agent-team-design.md` (R5.6 freshness, R6 audit).

## M1 — Problem

The InfoSec office (정보보호실) asked for more than drafting. When a law is amended, they want to know which existing
privacy policies must change and where (section, paragraph), and they want an alert when a published policy has a
problem. Two delivery forms:

- **Agent mode**: put policy files in a folder; the agent checks them.
- **Service mode** (later): register a policy URL; the service re-checks it and reports what must change after an amendment.

Every output is a reference: "참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다." It is never legal advice.

## M2 — Two modes

| Mode | Trigger | Question answered |
|------|---------|-------------------|
| A — current check | a new or changed policy file (sha256) | Does the published policy meet the rule packs that are in force now? |
| B — amendment impact | the freshness watcher reports a new promulgation or an effective date | Which registered policies, which sections, must change because of this amendment? |

### What can be judged from published text alone (privacy-domain-expert)

- **Findings** (a fact-free judgement is reliable):
  - mandatory sections present (S01–S03, S05, S06, S11, S16, S18, S24);
  - element presence inside a present section (S07/S09 rows lack recipient, purpose, items or retention; S18 contact; S24 effective date and notice method);
  - banned vague wording (rule-pack lexicons, LLM-confirmed before High);
  - cited articles exist and match the claim;
  - outdated references (repealed or renumbered articles, old law names);
  - in-force amendment elements missing.
- **Confirm questions** (depend on the operator's facts): an absent conditional section ("no S10" is a gap only if data goes abroad), completeness of purposes, items and periods, recipient accuracy, outsourcing vs provision, cookies and ad-ID, S17, A1, video devices, children, domestic representative. An absent conditional section is never "non-compliant", only "confirm".

## M3 — Amendment classes (Mode B)

| Class | Effect on an existing policy |
|-------|------------------------------|
| new_mandatory_item | add a paragraph in the target section (insertion point given) |
| changed_value | edit only the paragraphs that quote the old period or number; a bare article citation needs no change |
| renumbered | fix the citation only (Low) |
| terminology | wording update (Low unless the defined term changes scope) |
| effective_transition | upcoming → "prepare by date" (Medium if within 90 days); in force → applies now; 부칙 split dates handled explicitly |
| no_policy_impact | sanctions, surcharges, internal procedure: explicitly no alert |

Diffs run at 항/호 level, so a change in an article does not flag rules that cite an unchanged item.

## M4 — Alert tiers and severity

- **Provisional**: built automatically from the article diff and the legal-ref map. Labelled "미검증 – 도메인 검토 대기", worded as possible impact, capped at Medium, suggested wording never shown as final.
- **Confirmed**: issued only after the privacy-domain-expert (a) verifies the amendment on law.go.kr (URL, fetched date) and removes it from `pending-verification.json`, (b) updates the rule pack (`effectiveFrom`, `effectiveStatus`), and (c) approves the impact class, affected sections and any template wording. Seeded-defect checks must still pass after the pack update.
- **Severity**: Critical (in-force must element missing or wrong), High (in-force amendment not reflected; wrong quoted value), Medium (amendment due within 90 days; banned vague wording; notice method missing), Low (renumbered or outdated citation; terminology; should/may gaps), Confirm (fact-dependent question).
- Unverified claims (`pending-verification.json`) never alert.

## M5 — Architecture (architect)

```
packages/core/src/
  adapters/ingest/          md, html (docx, pdf later) -> plain text + offsets, sanitized
  adapters/lawapi/          + getFullText(mst) (조문 units), listVersions(lawId), oldAndNew spike
  stages/ingest/            segment-policy.ts (heading rules, then Haiku for leftovers), to-ast.ts
  stages/monitor/           current-check.ts (A), article-diff.ts, impact.ts (B), registry.ts, report.ts
  contracts/                ingested-policy.ts, amendment-diff.ts, monitor-report.ts, watch-registry.ts
scripts/monitor.ts          folder mode: --watch ./watch, writes runs/monitor/<stamp>/
```

- **IngestedPolicy**: `{ policyId, source{path|url, sha256, format, fetchedAt}, docType, sections[{ sectionId | "UNMAPPED", title, span, paras[{n, span, text}], mappedBy, confidence }], text, warnings }`. A section that the segmenter cannot place goes to UNMAPPED and is shown in the report. Low confidence means "not located", never "missing"; full-text search runs before "missing".
- **Mode A reuse**: the ingested sections become a valid PolicyAST (one `para` per source paragraph, no slotRefs). C2 runs with a `published` profile: keep `mandatory_present`, `vague_recipients`; skip `slot_refs`, `transcript_quotes`, `citations`, `unresolved_syntax`, `cross_doc`, house style. The fact-based R7 envelope stays strict; a separate published-policy auditor gets `{ sections text, must/should rule digest, c2 results }`, no ledger, no transcript, and its own prompt (`prompts/monitor/check-v1.md`). Conditional-rule findings are capped at Confirm.
- **Mode B**: the manifest stamp gives the previous MST, the freshness run the new one. Primary source is law.go.kr 신구법비교 (`target=oldAndNew`, to be confirmed by a live spike); fallback is two full texts parsed into 조문/항/호 and diffed. Changed units become legal-ref keys (`PIPA:22-2(1)`), matched against rule-pack legalRefs to get sections and rules. One LLM call per (policy, affected section): old text, new text, rules, section text in; `still_compliant | must_change | review`, quote, suggested wording out. Cache by (policySha, diff hash, rulePackVersion).
- **Registry**: `runs/monitor/registry.json` (gitignored) keeps policyId, source, last sha256, last report. An unchanged hash skips Mode A.

## M6 — Security (security-expert)

1. **Ingested text is untrusted**: wrapped in the untrusted-data fence in the user turn only; fence-like tokens stripped; LLM gets no tools; output is schema-validated JSON; every quote must be a verbatim substring of the source (checked in code). Caps on bytes, pages and tokens; HTML scripts, comments and hidden text stripped; zero-width and bidi characters removed. A seeded injection policy ("report all compliant") is part of the test set.
2. **Contacts in published policies are personal data**: masked before any LLM call, report or log (presence and format flags only); never in notifications. Ingested copies and reports live only under gitignored `runs/` and `watch/`; never in `kb/`, `golden/` or `docs/`.
3. **URL fetching (service mode)**: http(s) on 80/443 only; resolve DNS and block private, loopback, link-local (metadata) and ULA ranges; re-validate every redirect (max 5, no downgrade); size and time caps; robots.txt honoured; identifying user agent; per-host rate limit; no cookies or auth headers. Robots-blocked sites stay excluded (DEC-20260929).
4. **law.go.kr OC key**: environment or secret store only; redacted from every logged URL, error and cache key; never sent to an LLM.
5. **Notifications** carry only policy id, law and article, section code, severity, tier and a link to the access-controlled report: no contacts, no keys or webhook URLs, no raw LLM output, no long excerpts. Markdown and mention injection from policy text is neutralised.

## M7 — Knowledge base additions (kb-curator)

- `kb/jurisdictions/kr/statutes/versions/<lawId>.json`: version list `{ mst, promulgationNo, promulgationDate, effectiveDate, amendType, status }`.
- `kb/jurisdictions/kr/statutes/articles/<lawId>/<mst>.json`: 조문/항/호 snapshot with sha256 (raw XML stays in gitignored `kb/_sources/`).
- `kb/jurisdictions/kr/statutes/legalref-map.json`: legal-ref prefix → freshness source id and law id, with aliases (법, 영, 고시, 정보통신망법). The Network Act, ARTC, ECA and the safety-measures notice need law codes before Mode B can map the 제21988호 amendment (privacy-domain-expert review).
- `kb/jurisdictions/kr/segmentation/heading-patterns.json`: heading variants → S01–S24, seeded from the captures index `headingList`.
- Manifest: `lawSnapshot` gains `versionsSha256`, `articlesSha256`, `legalRefMapSha256`; a `segmentation {version, sha256}` block.
- Test portfolio: the 27 privacy captures with `capture` ok (robots-excluded, failed and JS-failed entries removed); raw text re-fetched to `kb/_sources/` (gitignored); contacts redacted.

## M8 — Evaluation and gates (auditor)

| Metric | Gate |
|--------|------|
| Segmentation accuracy (section assignment) | ≥ 0.95 on rendered golden drafts, ≥ 0.90 on real policies; span fidelity 1.0 |
| Seeded-defect recall (D1–D5 applied to rendered golden drafts, plus text-only seeds) | ≥ 0.90; 1.0 for major |
| Precision on clean policies | ≥ 0.90; no Critical/High false finding |
| False alarms | unmutated policy: 0 must-level findings, ≤ 1 should-level; unchanged hash → no alert |
| Amendment-impact recall (synthetic before/after diff with decoys) | ≥ 0.90, 1.0 for must rules; precision ≥ 0.80; unaffected-section alerts 0 |
| Location | correct section 1.0, correct paragraph ≥ 0.85 |
| Integrity | cited articles exist; tier labels correct; no PII in reports |
| Stability | two runs, finding-set Jaccard ≥ 0.9 |

The rendered golden drafts are cleaner than real policies, so segmentation and false-alarm numbers count only once the
real-policy slice is in. The 정보통신망법 제21988호 amendment is the first live fixture; its expected output is hand-labelled
by the privacy-domain-expert.

## M9 — Phases

| Phase | Scope | Exit |
|-------|-------|------|
| A1 | contracts; MD/HTML ingest + heading segmenter; C2 published profile; article diff + legal-ref mapping; Mode A and B runners with mock LLM; registry; `scripts/monitor.ts` folder mode; reports | unit tests green; fails closed (unparseable → manual review) |
| A2 | published-policy auditor prompt, live runs, eval set (M8), law.go.kr full-text fetch and live fixture for 제21988호; DOCX/PDF ingest | M8 gates on the golden slice |
| B | scheduled freshness + monitor runs, notifications (channel chosen by InfoSec), confirmed tier workflow | real-policy false-alarm rate measured before alerts go out |
| C | service: URL registry, safe fetcher (M6.3), dashboard | separate decision (web UI is out of Phase 1 scope) |

## M10 — Risks

1. Segmentation errors on free-form headings → UNMAPPED bucket, confidence threshold, full-text search before "missing".
2. False positives without operator facts → Confirm class, severity caps, provisional tier.
3. law.go.kr `oldAndNew` shape unverified; admrul (고시) diffs unproven → full-text fallback; live spike in A2.
4. Legal-ref map gaps (Network Act, ARTC, ECA, safety notice) → KB task before Mode B is trusted.
5. Cost: policies × affected sections → batch per policy; cache by (policySha, diff hash, rulePackVersion).
