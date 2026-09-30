# Privacy Policy and Terms Drafting Agent Team — Design

- **Date**: 2026-09-29 · **Status**: approved · **Spec id**: `2026-09-29-privacy-policy-agent-team-design`
- **Owner**: architect (dispatched by PM, Design Gate Row 0) · **Decision record**: `docs/decisions/DEC-20260929-01.md`
- **Related**: ADR-0074 (Design Gate), ADR-0078 (LLM work routing), ADR-0079 (Instruction Writing Standard), `docs/constitution/07-new-project.md` §7.5
- **Contest**: Lotte Innovate AX contest, Track A (process innovation). Judging: business effect 30, AI fit 30, completeness 20, company-wide applicability 20. Deadline 2026-10-23.

## R1 — Problem and Scope

A developer must pass an InfoSec-office review before a service launches. The review needs a
privacy policy and, for user-facing services, terms of service. Developers copy old drafts.
Reviewers are not privacy-law experts. Reviews are slow and inconsistent.

The product takes a service description form, an interview recording (mp3 → STT → transcript),
and answers to a branching **Interview Template**. It drafts a **privacy policy** and **terms of
service** as MD, HTML and DOCX, plus a **Reviewer Sheet** with evidence and audit results.

- **Jurisdiction:** Korea only. The folder layout (`kb/jurisdictions/kr/`) allows later extension. No multi-jurisdiction mechanics.
- **Privacy law base:** PIPC Privacy Policy Drafting Guideline (April 2026, 24 items plus gen-AI appendix), PIPA, its Enforcement Decree, and the Standard PI Protection Guideline.
- **Terms law base:** KFTC standard terms, the Act on the Regulation of Terms and Conditions (ARTC), the E-Commerce Consumer Protection Act, and the Network Act.
- **Core differentiator:** a curated, versioned **Lotte clause library**. It holds all public privacy policies and terms of Lotte Innovate and the wider Lotte group, with per-clause provenance. The library is retrieved per section. This is not model fine-tuning. A **Lotte house style** layer fixes wording and format.
- **Phase 1:** the harness team plus a server-independent TypeScript library and CLI. R14 lists the deferred items.

## R2 — Placement Decision

| Option | Pro | Con | Decision |
|--------|-----|-----|----------|
| (a) Standalone L3 project `Projects/privacy-agent/` | Standard L3 location. Promotable (`l3-to-variant-pipeline.ts`) or adoptable (`adopt-project.ts`). Own roster, registry and git repo. L0 governance stays out of the runtime. | Needs its own light product gates | **Chosen** |
| (a') Root folder `C:\aiagent\privacy-agent\` | Short path | Not a recognized layer. L0 validators scan it. | Rejected |
| (b) Variant `templates/co-privacy/` | Official, reusable | Full Phase B/C governance now (PROMOTION_CHECKLIST, ADR-0026, WS-08, parity). The product is unproven. | Deferred to Phase C |

1. Run `bun scripts/create-l3-scaffold.ts privacy-agent --dry-run` first. Review the kit size. If the kit is too heavy, hand-build the skeleton below and keep `adopt-project.ts` as the later path.
2. Split the project into two zones. The **harness zone** holds `agents/`, `skills/`, `docs/`, and platform files. The **product zone** holds `packages/`, `kb/`, and `golden/`.
3. Apply workspace agent and skill validators to the harness zone only. Apply product gates to the product zone: `tsc --noEmit`, unit tests, golden-set regression, `security-scan`.
4. Initialize the project as its own git repository. The workspace root is not a git repo.

```text
Projects/privacy-agent/
├── CLAUDE.md, AGENTS.md, README.md, NOTICES   # harness zone; NOTICES records the benchmark (R8)
├── agents/  skills/  docs/{designs,decisions,specs}/
├── package.json                               # Bun workspace ["packages/*"]
├── packages/core/                             # pure TS library, no server or UI dependency
│   ├── src/{contracts,pipeline,stages,llm,adapters/{stt,lawapi,pages}}/
│   └── prompts/{extract,interview,draft-privacy,draft-terms,audit,freshness}/   # semver prompt files
├── packages/cli/                              # `privacy-agent interview|run|audit|freshness`
├── kb/jurisdictions/kr/
│   ├── rulepacks/{privacy-2026.04,terms-kftc-<ver>}/   # one JSON file per section (R5.2)
│   ├── clauses/{privacy,terms}/<group>/<clause-id>.json  # Lotte clause library (R5.3)
│   ├── house-style/lotte-innovate.json        # R5.4
│   ├── statutes/{citations,retention-periods,remedy-agencies}.json, pending-verification.json
│   ├── interview/template-<ver>.json          # branching Interview Template (R4.4)
│   └── manifest.json                          # version stamps (R5.6)
├── golden/cases/<case-id>/                    # form, transcript, answers, expected, reference
└── runs/                                      # gitignored per-run artifacts
```

## R3 — Runtime Agent Roster

Runtime agents are product code: a typed stage plus a prompt file in `packages/core`. They are not
`agents/*.md` files. Harness agents (R9) are dev-time Claude Code agents that build and audit the product.

| ID | Name | Kind · tier · model | Responsibility | Inputs → outputs | Must NOT see | Budget (in/out per call) |
|----|------|---------------------|----------------|------------------|--------------|--------------------------|
| O0 | Orchestrator | code | State machine (R7), input allowlists, stage cache | config → RunState | — | 0 |
| R1 | Intake & Mask | code | STT adapter, segment IDs (`T0001`), form parse, PII → placeholders (`{{PERSON_1}}`) | form, mp3/txt, answers → MaskedTranscript, FormSlots, PiiVault (local) | — | 0 |
| R2 | Fact Extractor | LLM · Low · `claude-haiku-4-5` | Slot candidates with segment evidence and confidence. Uses template `evidenceHint`s as the extraction map. | MaskedTranscript, FormSlots, slot schema → FactLedger | PiiVault, clauses, drafts | ≤ 30K / 6K; chunk long input |
| C1 | Coverage Engine | code | Walks the Interview Template against the ledger. Computes applicability (privacy S01–S24, terms T01–T15) and gaps. Detects special types. | FactLedger, template, rule packs → ApplicabilityMap, GapList, Warnings | — | 0 |
| R3 | Gap Interviewer | code + LLM · Medium · `claude-sonnet-5-5`, effort `low` | Code emits unanswered template questions verbatim. The LLM only merges and rephrases context-specific follow-ups. | GapList, ledger excerpt → QuestionSet (≤ 10) | Transcript, clauses, drafts | ≤ 8K / 2K; max 2 rounds |
| R4 | Clause Matcher | code (+ `haiku` fallback) | Classifies the business group. Ranks vetted Lotte clauses per section. Attaches house-style rules. | FormSlots, ledger, clause index → ClauseSelection | Transcript | ≤ 3K / 0.5K (fallback only) |
| R5P / R5T | Drafters (privacy / terms) | code + LLM · Medium · `claude-sonnet-5-5`, effort `medium` | **Clause-first:** code renders a vetted clause when its variables and conditions cover the facts. The LLM runs only for sections that need adaptation. Output is SectionAST with `slotRef` and statute citations. | Section rule slice, clauses, house style, ledger slots (masked), fix findings → SectionAST | Transcript, auditor prompt and rubric, auditor reasoning, PiiVault | ≤ 6K / 2K per LLM section |
| R6 | Law Freshness Watcher | code + LLM · Low · `haiku` | Checks law.go.kr and official pages against the KB stamps. Runs the verification list (R5.5). | manifest, API responses → FreshnessReport | All run data | ≤ 4K / 0.5K per change |
| C2 | Deterministic Checker | code | Pre-output validation (R6.2) | AST, ledger, rule packs, statutes → CheckResults | — | 0 |
| R7 | Independent Auditor | LLM · High · `claude-opus-5-5`, effort `high` | One rubric, profile per document (R6.1). Emits findings only. | AuditEnvelope (R6.3) → AuditReport | Drafter prompts and thinking, ClauseSelection rationale, PiiVault | ≤ 60K / 6K per document per iteration |
| R8 | Renderer | code | AST → MD, HTML (anchor TOC), DOCX. Rehydrates placeholders locally. Adds disclaimer, change table, Reviewer Sheet. | AST, PiiVault, reports → files | — | 0 |

**Decision: one drafter engine with two prompt families (R5P, R5T), not two agent classes.** Clause-first
rendering, AST and `slotRef` mechanics are identical. Separate prompt files and rule packs keep each context small.

**Runtime API rules:**

- Pin model IDs in `src/llm/models.ts`. Use structured outputs (`output_config.format`) for every LLM output. Do not use forced `tool_choice`.
- Set effort explicitly (the Opus 5.5 default is `medium`). Enable the server-side refusal fallback (`fallbacks: "default"`).
- Do not send sampling parameters. Opus 5.5 and Sonnet 5.5 reject them. R11.3 lists the determinism levers.
- Send only masked text. Masking is a hard gate. Treat the transcript as untrusted data. Only R2 and R7 read it, and both emit schema-bound output only.

## R4 — Data Contracts (sketches; Zod files are Row 5 work)

### R4.1 Privacy section catalog (PIPC guideline 2026.4)

Class: **M** always · **C** when the processing applies, else a "not processed" statement · **R** recommended.
Handling: `clause` = code-rendered clause plus slot fill · `llm` = clause-first, LLM when adaptation is needed · `warn` = "may apply, manual review" placeholder.

| ID | Item | Class | Cited basis | Handling | Guide lines* |
|----|------|-------|-------------|----------|--------------|
| S01 | Title and preamble | M | Std. Guideline §18 | clause | 546–576 |
| S02 | Processing purposes | M | PIPA 30(1)1 | llm | 577–654 |
| S03 | Items processed | M | Decree 31(1)1 | llm | 655–886 |
| S04 | Children under 14 | C | PIPA 22-2 | warn | 887–932 |
| S05 | Processing and retention period | M | PIPA 30(1)2 | llm + statute table | 933–1091 |
| S06 | Destruction procedure and method | M | PIPA 30(1)3-2 | clause | 1092–1139 |
| S07 | Provision to third parties (conditional grouping allowed) | C | PIPA 30(1)3 | llm | 1140–1252 |
| S08 | Criteria for continued additional use | C | Decree 14-2 | llm | 1253–1324 |
| S09 | Outsourcing (conditional grouping allowed) | C | PIPA 30(1)4 | llm | 1325–1405 |
| S10 | Overseas collection and transfer | C | PIPA 28-8; Decree 31(1)2,4 | llm | 1406–1577 |
| S11 | Safety measures | M | Decree 31(1)3 | clause (checklist) | 1578–1608 |
| S12 | Sensitive-data disclosure risk | C | PIPA 30(1)3-3 | llm | 1609–1667 |
| S13 | Pseudonymized information | C | PIPA 30(1)4-2 | llm | 1668–1759 |
| S14 | Automatic collection devices | C | PIPA 30(1)7 | clause | 1760–2129 |
| S15 | Third-party behavioral data | R+C | — | clause | 2130–2246 |
| S16 | Rights of data subjects | M | PIPA 30(1)5 | clause | 2247–2333 |
| S17 | Automated decisions | C | PIPA 37-2 | llm + manual flag | 2334–2543 |
| S18 | Privacy officer and complaint dept. | M | PIPA 30(1)6 | clause | 2544–2585 |
| S19 | Domestic representative | C | PIPA 31-2 | clause | 2586–2633 |
| S20 | Remedies | R | — | clause | 2634–2668 |
| S21 / S22 | Fixed / mobile video devices | C | PIPA 25 / 25-2 | warn | 2669–2845 |
| S23 | Voluntary items | R | — | llm (optional) | 2846–2913 |
| S24 | Policy changes (versioned change notice) | M | PIPA 30(2) | clause | 2914–end of Part III |
| A1 / X1 | Gen-AI appendix / location information | C | Appendix 1 / Location Info. Act | warn | 3701–4259 / — |

\* Line ranges in the UTF-8 extraction of the guideline. The kb-curator copies the file to `kb/sources/` and records the ranges in `provenance.json`.

### R4.2 Terms section catalog (KFTC standard-terms structure; content authored in Row 4)

| ID | Article | Module | Cited basis |
|----|---------|--------|-------------|
| T01–T03 | Purpose, definitions, posting and amendment of terms | core | ARTC 3; std. terms |
| T04–T05 | Service provision, change, suspension | core | std. terms |
| T06–T08 | Membership, withdrawal, notices to members | member | ARTC 12 |
| T09–T10 | Contract formation, payment, subscription withdrawal, refund | commerce | E-Commerce Act 13, 17, 18 |
| T11 | Obligations of company and users | core | std. terms |
| T12 | Posts, IP, copyright | community | std. terms |
| T13 | Privacy protection (link to the privacy policy) | core | PIPA 30 (cross-doc) |
| T14 | Limitation of liability | core | ARTC 7 (unfair-clause check) |
| T15 | Disputes, governing law, jurisdiction | core | ARTC 14 |

An internal HR or groupware system gets no terms. C1 marks terms `not_applicable`, and R8 states the reason.

### R4.3 Shared fact ledger (one ledger feeds both documents)

```ts
const Evidence = z.object({ source: z.enum(["form","transcript","interview","kb_default","user_confirmed"]),
  ref: z.string() /* "T0042" | "form.flows[2]" | "Q-S09-02" */, quote: z.string().max(300) /* masked */ });
const Slot = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v.nullable(),
  status: z.enum(["filled","not_applicable","missing","conflict","needs_manual_review"]),
  confidence: z.number().min(0).max(1), evidence: z.array(Evidence) });
const FactLedger = z.object({ runId: z.string(), jurisdiction: z.literal("kr"),
  profile: z.object({ serviceTypes: z.array(z.enum(SERVICE_TYPES)), businessGroup: z.string(), orgNameRef: z.string() }),
  applicability: z.record(z.enum([...PRIVACY_IDS, ...TERMS_IDS]), z.object({ state: z.enum(["yes","no","unknown"]), basisSlots: z.array(z.string()) })),
  privacy: z.object({ S02_purposes: Slot(z.array(Purpose)), S03_items: Slot(z.array(ItemGroup)),
    S05_retention: Slot(z.array(z.object({ target: z.string(), period: z.string(), basis: z.enum(["consent","statute","internal"]), citationId: z.string().optional() }))),
    S07_thirdParties: Slot(z.array(RecipientOrGroup)), S09_processors: Slot(z.array(RecipientOrGroup)),
    S10_overseas: Slot(z.array(OverseasTransfer)), S18_officer: Slot(ContactRefs) /* placeholders only */, /* … S24 */ }),
  terms: z.object({ minAge: Slot(z.number()), paid: Slot(z.boolean()), refundPolicy: Slot(RefundRule), ugc: Slot(z.boolean()),
    noticePeriodDays: Slot(z.number()), /* … T15 */ }),
});
```

Citations cannot combine with structured outputs, so evidence uses segment IDs. C2 verifies that each `ref` exists and each `quote` is a substring of that segment.

### R4.4 Branching Interview Template (content authored by privacy-domain-expert in Row 4)

```ts
const Cond = z.lazy(() => z.union([ z.object({ all: z.array(Cond) }), z.object({ any: z.array(Cond) }), z.object({ not: Cond }),
  z.object({ slot: z.string(), op: z.enum(["eq","in","exists","truthy"]), value: z.unknown().optional() }) ]));
const QuestionNode = z.object({ id: z.string() /* "Q-S09-02" */, text: z.string(), help: z.string().optional(),
  answerType: z.enum(["yes_no","single","multi","text","table","date","contact_ref"]), options: z.array(z.string()).optional(),
  targets: z.array(z.string()) /* slot paths */, itemRefs: z.array(z.string()) /* ["S09"] | ["T10"] */,
  showIf: Cond.optional(), priority: z.enum(["must","should"]), evidenceHint: z.string() /* what R2 listens for */ });
const Module = z.object({ id: z.enum(["core","b2c_commerce","member_community","internal_hr","ai_feature",
  "marketing","overseas_transfer","children","cctv_location"]), enterIf: Cond, nodes: z.array(QuestionNode) });
const InterviewTemplate = z.object({ version: z.string(), rulePackVersions: z.array(z.string()), modules: z.array(Module) });
```

The template has three uses: an interviewer script (R8 renders it to DOCX or MD), the extraction map for R2, and the gap engine for C1.
The PM-supplied privacy interview template is its seed. Every `must` node maps to at least one M item. C2 tests that every M item has a node.

### R4.5 Policy / terms AST and audit report

```ts
const Inline = z.discriminatedUnion("t", [ z.object({ t: z.literal("text"), text: z.string(), slotRef: z.string().optional() }),
  z.object({ t: z.literal("placeholder"), key: z.string() }), z.object({ t: z.literal("cite"), citationId: z.string() /* "PIPA-25" */ }),
  z.object({ t: z.literal("link"), text: z.string(), href: z.string() }) ]);
const Block = /* para{runs} | list{ordered, items} | table{caption, header, rows} | note{kind: info|manual_review|freshness|disclaimer} */;
const Section = z.object({ id: z.string(), title: z.string(),
  status: z.enum(["drafted","not_processed_statement","omitted_recommended","manual_review","not_applicable"]),
  blocks: z.array(Block), trace: z.object({ slotRefs: z.array(z.string()), clauseRefs: z.array(z.string()), ruleRefs: z.array(z.string()), styleRefs: z.array(z.string()) }) });
const DocAST = z.object({ docType: z.enum(["privacy","terms"]), meta: z.object({ runId: z.string(), effectiveDate: z.string(),
  rulePackVersion: z.string(), clauseLibVersion: z.string(), houseStyleVersion: z.string(), lawSnapshotId: z.string(),
  promptVersions: z.record(z.string(), z.string()), models: z.record(z.string(), z.string()) }), sections: z.array(Section), warnings: z.array(Warning) });
const Finding = z.object({ id: z.string(), layer: z.enum(["deterministic","llm"]), ruleId: z.string() /* R-S05-002 | H-07 | U-T14-01 */,
  docType: z.enum(["privacy","terms","cross"]), sectionId: z.string(), severity: z.enum(["blocker","major","minor","info"]),
  message: z.string(), evidence: z.object({ astPath: z.string(), quote: z.string().max(300) }), fixHint: z.string() });
const AuditReport = z.object({ runId: z.string(), docType: z.enum(["privacy","terms"]), iteration: z.number().int().min(1).max(3),
  envelopeHash: z.string(), rubricVersion: z.string(), profile: z.string(),
  scores: z.object({ legal: z.number(), accuracy: z.number(), clarity: z.number(), houseStyle: z.number(), consistency: z.number() }),
  verdict: z.enum(["pass","pass_with_warnings","fail"]), findings: z.array(Finding), resolvedFindingIds: z.array(z.string()) });
```

## R5 — Knowledge Base

### R5.1 Principles

- Every legal fact enters the KB only with a **verified source and date**: a law.go.kr record ID or an official PIPC or KFTC page, plus `verifiedAt`. Unverified claims go to `statutes/pending-verification.json`. Prompts never load that file.
- Every clause keeps its provenance. The KB stores paraphrases of the guideline with attribution ("PIPC, Privacy Policy Drafting Guideline, 2026.4"). It stores short quotes only with a source line.

### R5.2 Rule packs (sliced per section)

- Create one JSON file per section: `S01…S24`, `A1`, `T01…T15`, plus `principles.json`, `glossary.json`, and `unfair-clause-lexicon.json`.
- Rule shape: `{ ruleId, sectionId, level: must|should|may, statement, legalRefs[{law, article, paragraph, item}], check: {kind: deterministic|llm, expr?}, sourceSpan, verifiedAt }`.
- R5P and R5T load only their section file plus `principles.json`. R7 loads a compressed must-rule digest. No stage loads the full guideline text.
- A `legalRefs` reverse index (`law+article → sections`) lets R6 map amendments to sections in code.

### R5.3 Lotte clause library (the differentiator)

- **Corpus:** all public privacy policies and terms of Lotte Innovate and the wider Lotte group (site list: Q1).
- **Clause record:** `{ clauseId, docType, itemIds: ["S09"], body, vars: [{name, slotPath}], conditions: Cond[], provenance: { sourceUrl, affiliate, businessGroup, captureDate, policyEffectiveDate, contentHash }, vetted, vettedAgainst, styleRefs }`.
- `body` uses `{{var}}` substitution and `{%if cond%}…{%endif%}` blocks. Code renders them at zero token cost.
- **Pipeline:** capture (HTML snapshot plus hash) → split by item → cluster near-duplicates → pick a canonical clause per cluster → privacy-domain-expert vets it against the current rule pack. Only vetted clauses reach R4. Old policies may predate the 2026 guideline.
- **Business groups (proposed):** `retail-commerce`, `fnb-membership`, `hospitality-leisure`, `manufacturing-b2b`, `it-services` (Lotte Innovate), `recruiting-employee`. Finance stays out of Phase 1 because stricter sector laws apply.
- A coverage matrix (item × group → vetted clause count) shows gaps. It also serves as a contest slide.

### R5.4 Lotte house style layer

- `house-style/lotte-innovate.json` holds rules `H-01…`. Each rule has `{ id, scope: privacy|terms|both, kind: deterministic|llm, rule, example, sourceClauseIds }`.
- Rules cover title and preamble form, numbering (for example, "Article N" versus Roman numerals), table layouts for outsourcing and third-party lists, fixed terms (for example, "member" versus "user"), date and contact-block formats, and change-notice format.
- kb-curator extracts candidate rules from Lotte Innovate's own policies. privacy-domain-expert approves them. The drafters load them in the cached prefix. C2 checks the deterministic rules. R7 scores `houseStyle`.

### R5.5 Statutes and first-run verification list

- `statutes/citations.json` holds `{ citationId, law, article, title, effectiveFrom, sourceId, verifiedAt }`. C2 checks every `cite` inline against it (R6.2).
- R6 checks these items on the first run. They stay out of rules until verified:
  1. A reported PIPA amendment (2026-03, effective 2026-09-11) with a turnover-based fine of up to 10%.
  2. The KFTC e-commerce standard terms number (reported as No. 10023) and its latest revision date.

### R5.6 Version stamps and freshness flow

`manifest.json` holds `rulePacks[{id, version, sha256}]`, `lawSnapshot{id, laws[{name, target: law|admrul, id, effective}]}`,
`clauseLib{version, capturedAt, sites, vettedClauses}`, `houseStyle{version}`, and `pages[{url, titleHash, checkedAt}]`.

1. O0 starts R6 in parallel with R1. Results are cached for 24 hours.
2. R6 queries the law.go.kr Open API (OC key) for PIPA, the Decree, the Standard Guideline, ARTC, the E-Commerce Act, and the Network Act, and compares version IDs with the stamps. For a changed law, code maps changed articles to sections through the index. Haiku writes a short summary.
3. R6 checks the PIPC guideline page and the KFTC standard-terms page by title hash.
4. Drift never blocks drafting. Drift adds a `freshness` note to affected sections, a watermark, and a Reviewer Sheet entry. If all sources fail, the report says "freshness unverified".

## R6 — Independent Audit

### R6.1 Rubric: one framework, two profiles (decision)

- The **shared layer** covers principles (legal compliance, accuracy against evidence, clarity), house style, and 0–5 score anchors.
- The **privacy profile** adds privacy rule-pack section checks. The **terms profile** adds terms section checks and ARTC unfair-clause checks.
- The **cross-document checks** cover the same organization name, minimum age, withdrawal versus retention, and the T13 link to the policy.
- Rejected: two independent rubrics. They would duplicate the principles and house-style checks and drift apart.

### R6.2 Layer 1 — C2 deterministic pre-output validation (zero tokens)

- **Structure:** valid schema; no unresolved `{{…}}` or `{%…%}` syntax; no empty section; all M items present; each C item drafted (`yes`), stated as not processed (`no`), or `manual_review` (`unknown`).
- **Evidence:** every factual inline has a valid `slotRef`; evidence quotes exist in their segments; every `cite` resolves in `citations.json` with a matching article title; retention periods match the statute table.
- **Style and safety:** deterministic house-style rules pass; no unfair-clause or vague-expression lexicon hit; cross-document values are equal; the disclaimer block is present.

### R6.3 Layer 2 — R7 isolated auditor

- O0 builds an `AuditEnvelope` with an allowlist: `{ docMarkdown, astSummary, factLedger, maskedTranscript, formSlots, applicability, mustRuleDigest, rubricProfile, houseStyle, c2Results, priorFindings, otherDocDigest }`.
- The envelope type has no field for drafter prompts, thinking, or clause-selection rationale. A unit test asserts its keys. R7 is a fresh call on a different tier (Opus) from the drafters (Sonnet). The masked transcript lets R7 catch extractor misses.
- R7 emits findings only. Only the drafters edit text, and only in flagged sections. Auditor prompts live in `prompts/audit/`. Drafter prompts must not import them.
- **Seeded-defect calibration:** golden drafts carry known defects (missing retention basis, wrong recipient, blanket liability exclusion, wrong citation). R7 recall must be ≥ 90%.

### R6.4 Pass / fail and iteration cap

- **Pass:** 0 blocker, 0 major, all C2 checks pass, and every score ≥ 4 (`clarity` ≥ 3). Minor findings go to the Reviewer Sheet.
- **Fix loop:** the drafters redraft flagged sections only, then C2 and R7 run again. The cap is **3 iterations per document**. **Escalation:** after iteration 3, R8 renders the draft with a "DRAFT — unresolved findings" banner. O0 returns the open findings to the user.
- **Disclaimer:** every output carries "Reference draft. InfoSec and legal review required. Violations can lead to administrative fines."

## R7 — Orchestration

```text
INIT ─┬─> INTAKE(R1) ─> MASK(hard gate) ─> EXTRACT(R2) ─> COVERAGE(C1) ─ gaps ─> INTERVIEW(R3) ─> [human answers] ─> EXTRACT ─> COVERAGE (≤ 2 rounds)
      └─> FRESHNESS(R6) ──────────(join)────────────> MATCH(R4) ─> DRAFT(R5P ∥ R5T, per section, concurrency 4)
          ─> CHECK(C2) ─> AUDIT(R7 per doc) ─ fail & iter < 3 ─> DRAFT(flagged) │ pass or iter = 3 ─> RENDER(R8) ─> DONE
```

- **Handoffs:** each stage writes one typed artifact `runs/<runId>/NN-<stage>.json`. The cache key is the hash of stage inputs, prompt version, and model ID. A matching key reuses the artifact.
- **Parallel:** R6 runs beside intake. Drafting runs per section and per document. **Serial:** R7 runs once per document per iteration.
- **Human turn:** INTERVIEW saves RunState. `privacy-agent run --resume <id> --answers a.json` resumes it. A skipped `must` question leaves the item `manual_review`.
- **Failures:** API errors get SDK retries (2), then one stage retry, then a resumable failure. Schema-invalid output gets one retry with the validator error. A `refusal` uses the server fallback, then `manual_review`. A mask error is a hard stop. An STT failure falls back to `--transcript`. A failed law API falls back to official pages, then "freshness unverified".

## R8 — Benchmark: `kimlawtech/korean-privacy-terms` (Apache-2.0)

Our findings come from a third-party summary. Unverified numbers stay unverified (R5.5). We adopt ideas and re-implement them in our own words. We copy no template text. The project `NOTICES` records the repository as "inspired by, concepts only".

| Verdict | Item | Our form |
|---------|------|----------|
| Adopt | Thin router skill plus small, independently callable sub-skills | Harness: `privacy-docs` router skill with sub-skills that call CLI subcommands. Runtime: one prompt per slice. |
| Adopt | Answer-driven conditional section pruning | C1 applicability over the Interview Template |
| Adopt | Service-type branching interview | Interview Template modules (R4.4) |
| Adopt | Template variables plus conditional blocks | Clause library `vars` and `{%if%}`, code-rendered |
| Adopt | Statute citations in output | `cite` inlines, verified by C2 against `citations.json` |
| Adopt | Deterministic pre-output validation | C2 (R6.2) |
| Adopt | "Reference draft, legal review" disclaimer | Disclaimer block, checked by C2 |
| Adopt | Checklists next to templates; example input/output pairs | Rule packs beside clauses; `golden/cases/` |
| Reject | EU, US, and JP jurisdictions | Korea only (R1) |
| Reject | Next.js MDX output; consent modal, cookie banner, and label cards | MD, HTML, DOCX for InfoSec. Guideline labeling output deferred. |
| Reject | Manual law versioning by git tags | R6 Open API drift detection plus stamps |
| Beat | Validates 11 items against the 2025.4 guideline | 24 items plus appendix (2026.4), conditional grouping, versioned change notice |
| Beat | No independent audit, no evidence trace | Isolated Opus auditor, `slotRef` to transcript quote |
| Beat | Generic wording | Lotte clause library, house style, InfoSec review fit, Reviewer Sheet |

## R9 — Harness Team and Skills

| Agent | Source | Tier / alias | Role in this project |
|-------|--------|--------------|----------------------|
| pm | session + project copy | Medium floor | Triage, plans, gates, decision records |
| architect | L0 | High / `opus` | Design and contract reviews |
| automation-engineer | L0 | Low / `haiku` (`sonnet` for core LLM modules, Q8) | Code, tests, CLI, adapters, renderer |
| auditor | L0 | Medium / `sonnet` | Harness QA gate, golden-set regression owner |
| security-expert | L0 | Medium / `sonnet` | Masking review, data-flow threat model, key handling |
| docs-writer | L0 | Medium / `sonnet` | README, operator guide, PPTX outline |
| **privacy-domain-expert** (hire) | project `agents/` | High / `opus` | Rule packs (privacy and terms), rubric, Interview Template content, clause vetting, house-style approval, golden references |
| **kb-curator** (hire) | project `agents/` | Medium / `sonnet` | Corpus capture, provenance, clustering, house-style extraction, manifest stamps, verification list |

**Hiring rationale (pm.md signals):**

- *privacy-domain-expert:* a new legal domain keeps requiring ad-hoc handling, and the user requested it. security-expert covers application security, not Korean privacy and terms law. The scope includes terms law, so no separate terms expert is hired. The High tier fits the main product risk: legal error.
- *kb-curator:* KB refresh and drift triage recur, and no agent owns a versioned corpus. The Medium tier fits the grouping judgment. Bulk normalization may run at `haiku`.
- Both hires live in the project `agents/` folder, which keeps the L0 roster and `agent-model-gate.ts` unchanged. A proposed eval-engineer hire is rejected because auditor plus privacy-domain-expert cover that work.

| Skill (project `skills/`) | Owner | Purpose |
|---------------------------|-------|---------|
| `privacy-docs` (router) + `interview`, `draft`, `audit`, `freshness` sub-skills | pm | Thin entry routing to CLI subcommands, each callable alone |
| `rulepack-authoring` | privacy-domain-expert | Slice guideline and terms sources into rule files with verified legalRefs |
| `interview-template-authoring` | privacy-domain-expert | Module and node design, `evidenceHint`s, coverage test |
| `policy-audit-rubric` | privacy-domain-expert | Shared layer, profiles, seeded defects |
| `lotte-corpus-curation` | kb-curator | Capture, provenance, clustering, vetting handoff, house-style extraction |
| `law-freshness-check` | kb-curator | Open API and page checks, manifest update, verification list |
| `golden-set-regression` | auditor | Batch runs, metrics, thresholds |
| `pii-masking-review` | security-expert | Pattern coverage and leak tests |
| reuse: `zod-contract-gate`, `security-scan`, `research-analysis`, `documentation-writing` | as named | L0 skills |

## R10 — Token-Efficiency Plan

1. **Code first.** O0, R1, C1, C2, R8, and the `clause`-handled sections cost zero tokens. Clause-first rendering skips the LLM whenever a vetted clause covers the facts.
2. **Slice loading.** Each drafter call loads one section file (~1–3K tokens), not the full guideline (100K+).
3. **Prompt caching.** Each role has a frozen prefix (role, house style, glossary) and a breakpoint. Volatile data comes after it. JSON keys are sorted. Prompts contain no timestamps.
4. **Isolation.** Only R2 and R7 read the transcript. Code emits template questions. Structured outputs remove parse retries.
5. **Tier fit and reuse.** Haiku extracts, Sonnet drafts, Opus audits once per document per iteration. The Batch API (50%) runs the golden set. The stage cache re-drafts flagged sections only.
6. **Harness.** Dev agents read rule-pack slices and graft nodes, never the full guideline.

Estimated cost per run (30-minute interview, one iteration): R2 $0.05 + R3 $0.02 + R5P $0.30 + R5T $0.20 + R7 2 × $0.36 ≈ **$1.30**.
Row 13 replaces these estimates with measured `usage`.

## R11 — Quality-Consistency Plan

### R11.1 Golden set

| Case | Scenario | Expected result |
|------|----------|-----------------|
| G1 / G1b | B2C commerce app / plus overseas cloud and processors | Policy and terms drafted, pass. S09 and S10 drafted in G1b. |
| G2 / G2b | Internal HR groupware / plus payroll third party | Policy drafted, terms `not_applicable`, pass |
| G3 | Member community service (UGC) | Policy and terms with T12, pass |
| W1–W4 | Children, CCTV, gen-AI feature, location | Correct `warn`, no fabricated body |
| D1–D8 | Seeded-defect drafts (privacy and terms) | R7 detects each defect |

Inputs are synthetic and hold no real personal data. Each case has `expected.json` (slots, applicability, required and forbidden phrases) and a `reference/` folder reviewed by privacy-domain-expert.

### R11.2 Regression gate (any prompt, KB, rule-pack, or template change)

| Metric | Threshold |
|--------|-----------|
| Applicability accuracy; M-item coverage; traceability; citation validity | 100% each |
| Unsupported-claim rate | 0 |
| Slot recall / precision | ≥ 0.90 / ≥ 0.95 |
| Seeded-defect recall (R7) | ≥ 0.90 |
| Blocker + major findings on G-cases | 0 |
| Run-to-run stability (3 runs per case) | Same sections and table rows; text similarity ≥ 0.85 |
| Clause-first ratio (sections rendered without LLM) | Tracked; target ≥ 50% |
| Cost and latency per run | Regression > 25% flagged |

### R11.3 Determinism levers

Opus 5.5 and Sonnet 5.5 reject sampling parameters, so temperature cannot fix the output. The design uses these levers instead:

- Clause-first rendering, closed enums, structured outputs, canonical order, code-rendered tables, and house-style rules in the cached prefix.
- Pinned model, prompt, rule-pack, clause-library, and style versions in `DocAST.meta`. An input-hash stage cache makes an identical replay return identical output.

## R12 — Risks

| Risk | Mitigation |
|------|------------|
| Deadline (18 working days) plus added terms scope | Clause-first rendering, warn-only special types, freeze 2026-10-21. Terms depth is limited to the T01–T15 core. |
| Legal inaccuracy | Traceability, citation checks, statute tables, vetted clauses, Opus audit, domain-expert review |
| Unverified law facts | Verified-source rule (R5.1), pending-verification file, R6 first-run list |
| PII leaves the company | Mask hard gate, placeholders, local vault, leak test (Q3) |
| Prompt injection through the transcript | Two readers only, schema-bound outputs, no tools |
| Copyright (guideline, Lotte sites, benchmark) | Paraphrase with attribution, clause provenance, NOTICES "concepts only" |
| Stale or inconsistent Lotte clauses | Vetting against the current rule pack, house-style normalization |
| Korean STT and Haiku extraction quality | Manual transcript fallback. Move R2 to Sonnet if recall < 0.90. |
| Toolchain: bun not on the Git Bash PATH, no git repo | Fix in Row 1 (Q4) |

## R13 — Open Questions for the User

1. **Q1 Corpus scope:** Which Lotte Innovate services and sites go in? Which group affiliates? Are finance affiliates excluded in Phase 1?
2. **Q2 Non-public sources:** May internal non-public policies or past InfoSec-approved drafts enter the clause library? If yes, what access control applies?
3. **Q3 Data transfer:** May masked interview text reach the Claude API (overseas processing)? Or is a cloud-region endpoint required? The adapter supports both.
4. **Q4 Toolchain:** Where does the project git repository live? Can bun join the Git Bash PATH?
5. **Q5 Formats:** Does InfoSec have a fixed service-description form or DOCX layout? Please share the PM's privacy interview template.
6. **Q6 House style authority:** Who approves the Lotte house-style rules (InfoSec office, legal team, or PM)?
7. **Q7 Keys and samples:** Who registers the law.go.kr OC key? Can you provide one realistic interview recording?
8. **Q8 Tier:** Do you approve dispatching automation-engineer at `sonnet` for the core LLM modules?

## R14 — Deferred (out of Phase 1)

Vercel deployment, web UI, service-ization, zip packaging, STT vendor selection (interface, mock and file adapter only),
full drafting for S04/S21/S22/A1/X1 (warn-only), guideline labeling output, consent UI components, non-Korean jurisdictions,
promotion to `templates/co-privacy`, and the contest PPTX (derive it from R1, R3, R5.3, R8, R10, R11).

## R15 — Phased Task Breakdown (Row 1+)

| Row | Window | Task | Agent | Tier / alias |
|-----|--------|------|-------|--------------|
| 1 | 09-30 – 10-02 | Scaffold project (dry run first), Bun workspace, git init, NOTICES, registry | scaffolding-expert | Low / `haiku` |
| 2 | 09-30 – 10-02 | Hire two agents; create the R9 skills | lifecycle-manager | Medium / `sonnet` |
| 3 | 09-30 – 10-03 | Spike: law.go.kr targets, KFTC and PIPC page checks, verification list | automation-engineer | Low / `haiku` |
| 4 | 10-01 – 10-08 | Rule packs S/T, rubric v1, Interview Template v1 (from the PM seed) | privacy-domain-expert | High / `opus` |
| 5 | 10-01 – 10-06 | Zod contracts (R4), model registry, run store, stage cache | automation-engineer | `sonnet` (Q8) |
| 6 | Q1 – 10-09 | Corpus capture, provenance, clustering, house-style candidates | kb-curator | Medium / `sonnet` |
| 7 | 10-06 – 10-10 | R1 intake and masking; masking review | automation-engineer + security-expert | `haiku` + `sonnet` |
| 8 | 10-06 – 10-10 | Golden cases, seeded defects, clause vetting, house-style approval | privacy-domain-expert | High / `opus` |
| 9 | 10-08 – 10-13 | R2, C1 (template walker), R3, R4 | automation-engineer | `sonnet` (Q8) |
| 10 | 10-08 – 10-13 | R8 renderer (MD, HTML, DOCX), Reviewer Sheet, interview script export | automation-engineer | Low / `haiku` |
| 11 | 10-12 – 10-16 | R5P, R5T clause-first drafters, C2, R7, envelope test | automation-engineer + privacy-domain-expert | `sonnet` + `opus` |
| 12 | 10-13 – 10-16 | R6 freshness watcher, manifest flow | automation-engineer | Low / `haiku` |
| 13 | 10-16 – 10-20 | Golden-set regression, calibration, tuning (max 3 loops per defect class) | auditor + privacy-domain-expert | `sonnet` + `opus` |
| 14 | 10-19 – 10-21 | Router skill, README, operator guide, PPTX outline | docs-writer | Medium / `sonnet` |
| 15 | 10-21 – 10-22 | Final QA gate, security scan, freeze, `/sync` on the project repo | auditor + security-expert + pm | Medium / `sonnet` |

Critical path: Q1 → Row 6 → Row 8 (vetting) → Row 11 → Row 13. If Q1 is not answered by 2026-10-03, Row 6 starts with a provisional site list.

## R16 — Platform, Accessibility, Preview

| Platform | Impact | Files affected |
|----------|--------|----------------|
| Claude Code | Project-scoped roster, skills, router skill | project `agents/`, `skills/`, `.claude/` |
| Antigravity (GEMINI.md) | The scaffold `GEMINI.md` and `.gemini/` mirrors keep parity. The runtime has no platform dependency. | project `GEMINI.md`, `.gemini/` |
| templates/common | None. Phase 1 changes no L1 or L2 file. Promotion is deferred. | N/A |
| L0 root | This doc, the registry entry, and DEC-20260929-01 | `docs/` only |

- **Cross-platform:** use TypeScript on Bun only (ADR-0036) and `path.join` for paths. Do not redirect to `nul`.
- **Accessibility:** there is no UI in Phase 1. The HTML output uses semantic headings, `<th scope>`, an anchor TOC, and `lang="ko"`. Row 10 runs `accessibility-audit` on the HTML.
- **Preview:** exempt (no UI).

## R17 — Acceptance Criteria (Row 1+)

- [ ] `packages/core` has no server or UI dependency. `tsc --noEmit` passes.
- [ ] G1, G2, and G3 pass every R11.2 threshold on 3 consecutive runs. W1–W4 emit warnings only.
- [ ] Unit tests prove that the `AuditEnvelope` excludes drafter prompts and thinking, and that no LLM payload holds a PiiVault value.
- [ ] Every `cite` in the output resolves in `citations.json`. No unverified law fact appears in a rule or a prompt.
- [ ] Every M item has at least one `must` Interview Template node. Every clause used in output has provenance and a `vetted` flag.
- [ ] Each run writes both documents (or a `not_applicable` note), the Reviewer Sheet, and all version stamps.
- [ ] An older manifest stamp produces a drift warning. The audit loop stops at 3 iterations and returns open findings.

## Resolved Open Questions (2026-09-29)

| Q | Resolution |
|---|------------|
| Q1 | Finance affiliates are excluded from the corpus. The user supplies the representative sites. |
| Q2 | Public policies plus InfoSec-annotated approved policies are allowed (public documents). |
| Q3 | Masked transcripts may go to the Claude API. |
| Q4 | Project git is initialized. bun 1.4.2 is installed via winget. PATH needs a fresh shell, so agents use the explicit path. |
| Q5 | Pending. PM supplies the interview template. The InfoSec form is still requested. |
| Q6 | The user personally approves the Lotte house-style rules. |
| Q7 | OC key registration is pending (user action). Sample recording is pending. |
| Q8 | Approved. Implementation agents run at `sonnet` for core LLM modules. |
