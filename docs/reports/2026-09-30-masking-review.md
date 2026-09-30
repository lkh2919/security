# R1 Intake & Mask: independent masking review (Row 7)

Reviewer: security-expert (dispatched by PM). Date: 2026-09-30. Scope: `packages/core/src/stages/intake/`, `src/adapters/stt/`, `contracts/pii-vault.ts`, `llm/client.ts` (`findVaultLeaks`). Skill: `pii-masking-review`. Synthetic data only. Source code was not modified.

Tests: `packages/core/test/intake-adversarial.test.ts` (164 tests: 79 hold today, 85 documented gaps marked `test.failing`), fixtures in `test/fixtures/intake-adversarial/`. Full `bun test`: 351 pass, 0 fail. When a gap is fixed, Bun reports "marked as failing but it passed"; remove `.failing` then.

Leak criterion: intake either fails closed (`PiiResidualError`) or the secret must not appear in the masked output. Fail-closed is acceptable.

## Verdict

Not releasable to an overseas LLM for real STT interviews yet. Digit-format PII written in ASCII is masked well (phone, RRN, card, IP, email, URL, account, address; full-width digits, NFKC, zero-width chars, NFD Hangul all pass). The gaps are in what real STT output and real Korean speech contain.

## Findings

| # | Class | Severity | Evidence (test ids) |
|---|-------|----------|---------------------|
| B1 | Spoken/segmented numbers: `공일공 일이삼사 오육칠팔`, spoken RRN/account/card/bizno/IP/사번, `010 12 34 56 78`, `010 - 1234 - 5678`, `010에 1234에 5678`, `010/1234/5678`, `192 168 0 1`, `영일영 1234 5678`. Gate is blind too. | Blocker | A1-A16, A23 |
| B2 | Names only masked when context proves them. Bare names (`박민준이에요`, `고객 김민수의`, `김도윤이 담당`), `박 과장`, `김 과장님`, all English names (`John`, `Daniel Kim`, `Mr. Smith`), given names (`서준이가`), spaced names. The gate has no name detection, so they pass silently. Latin speaker label registers only the full string; `John` alone leaks. | Blocker | C5-C13, C19, C22 |
| B3 | Name known to masker but not replaced (glued title `박민준책임이`, prefix `저희팀박민준`, speaker `한서준 과장` never in body). Gate only checks vault entries, and a name never replaced has none. | Major | C14b, C16, C17, H (gate) |
| B4 | Spoken/obfuscated email: `골뱅이/닷`, `at/dot`, `[at]`, `(at)`, IDN domain. `user:pw@10.1.1.1` leaves credentials. | Major | B1-B4, B6, B10 |
| B5 | Invisible/odd characters not stripped by `sanitizeText`: U+00AD, U+3164, U+FE0F, U+034F, tag chars, Unicode dashes (U+2010/2011/2013/2212), Arabic-Indic digits, letter O for zero. Soft hyphen inside an email domain leaves `hong@na` (local part) in output. | Major | E3-E9, E11, E12, E15 |
| B6 | Internal identifiers/infrastructure: Jira keys, Slack IDs/handles, vehicle plates, passport, Amex 4-6-5, MAC, `-prd`/single-label hosts (`ci-paylab-prd01`, `erpdb01`), internal TLDs outside the list (`.group`, `.lotte`), 번길 addresses partly masked, `판교로 256`. | Major | D1-D5, D11, D13-D15, D21, D28, D29 |
| B7 | Secrets: API keys/tokens (`sk-ant-...`, `AKIA...`, `ghp_...`), passwords in speech. Only caught by accident when a 10-digit run trips `LONG_NUMBER`. | Major | D22 (accident), D23-D26 |
| B8 | Numeric JSON form values (`"정산계좌": 110123456789012`) bypass `maskForm` and the gate (only strings are walked). | Major | J numeric form |
| B9 | Side channels: `PiiResidualError` message embeds the raw form key (`form.fields.<key>`); `TextFileSttAdapter` error echoes the full Windows path (filename may hold a name); `JSON.stringify(IntakeResult)`, `JSON.stringify(masker)` and `masker.patternOptions` (has `knownNames`) serialise raw values. | Minor (footguns) | J, G |
| B10 | Injection fence: `<`/`>` are neutralised, so the fence cannot be closed and fake system tags stay inert (holds, tested with 8 attacks incl. full-width, ZWSP, `<|im_start|>`). Gap: a newline in a segment or speaker label forges a `[T0099] 인터뷰어:` header line inside the fence. Literal `{{PERSON_1}}` in raw input is kept and collides with real keys. | Minor | I, G |
| B11 | `findVaultLeaks` (LLM backstop) is exact-string: a re-spelled value (`01073456712` vs `010-7345-6712`) is not caught. | Minor | J |
| B12 | Quadratic regex cost: 40k-char single segment takes about 1 s, 60k about 2.5 s (EMAIL/URL scans). | Minor | K |

## Fix recommendations (for the R1 author, routed by PM)

- B1: add a pre-pass that converts runs of >= 7 sino-Korean digit words (공/영/일/이/삼/사/오/육/칠/팔/구, with particles 에/은/는/이/가 between groups) to digits, then re-run the phone/RRN/account/card rules. Make the gate normalise: remove `[\s.\-/~–−]` and interleaved Hangul particles between digit groups and flag any run of >= 9 digits (or digit-words) instead of only contiguous ASCII digits.
- B2/B3: (a) require a participant/colleague roster in the form (names, English names) and mask every occurrence with substring rules that tolerate glued titles and suffixes; (b) make the gate test ALL registered names (knownNames, discovered, speaker-derived) as raw substrings, not only vault entries; (c) add an unknown-name tripwire for `surname + 1-2 syllables + (님|씨|과장|책임|...)` and capitalised Latin word pairs, failing closed or requiring a confirmation step; (d) register each token of a Latin name and every given-name form; (e) treat `X 과장` / `X님` speaker labels as names.
- B4: pre-pass mapping `골뱅이|앳|at|[at]|(at)` and `닷|dot|점` to `@` / `.` between email-like tokens; allow Korean/IDN local parts and domains; treat `user:pass@host` as one credential token.
- B5: extend `CONTROL_RE` with U+00AD, U+034F, U+115F/1160/3164, U+180E, U+FE00-FE0F, U+E0000-E007F, U+206A-206F; fold Unicode dashes (U+2010-2015, U+2212, U+FE58, U+FF0D) to `-`; map other Unicode decimal digits (`\p{Nd}`) to ASCII; make the gate run on the same normalised text.
- B6/B7: add configurable rule sets for Jira keys, Slack IDs, plates (`\d{2,3}[가-힣]\s?\d{4}`), passport, MAC, more internal TLDs/host suffixes, and a generic secret rule (`sk-`, `AKIA`, `ghp_`, `xox[bp]-`, high-entropy tokens, `비밀번호/password` + value).
- B8: mask number-typed form values (String() them) and walk numbers in `collectStrings`.
- B9: replace the raw key in `where` with an index/hash; strip paths to a basename hash in adapter errors; define `toJSON()` on `PiiMasker` and make `vault` a non-enumerable property (or class with `toJSON` returning a marker); drop `knownNames` from `patternOptions`.
- B10: replace `\n` and `\r` in segment text and speaker with a space before wrapping; escape `{{`/`}}` in raw input (e.g. `{ {`) and limit the gate's placeholder blanking to `_\d{1,4}`.
- B11: in `findVaultLeaks` also compare digit-only/whitespace-stripped forms for numeric kinds.
- B12: cap segment length (split before masking) or anchor the EMAIL/URL scans.

## False positives (vocabulary that should stay visible or not abort a run)

Fine today: `5년`, `제30조`, `제15조 제1항 제2호`, `1천만 명`, versions `2.1.3`/`v1.2.3.4`, `15,000원`, `1,234,567,890원`, dates, `ISO 27001`, `TLS 1.3`, `1588-1234`, `정보주체`, `고객님` (F1-F6, F12-F16).
Problems: `2024-2025-2026 학년도` masked as ACCOUNT (F7); a plain 10-digit amount `5000000000원` (F8), 11-digit count (F9) and epoch ms (F10) abort the whole run via `LONG_NUMBER` (fail-closed but noisy; allow unit suffix 원/명/건 or downgrade to manual review); over-masking of quality nouns that start with a surname syllable before a title, e.g. `정합성 담당자` (F11); `github.com/foo` over-masked because `hostOf()` keeps the path for scheme-less URLs (F18); a 2-syllable registered name that is also a place word (`성수` vs `성수동`) aborts the run through the raw-substring vault check (F17); `git@github.com:...` masked as an email (B9 row in tests).

## Data-flow trace (holds)

Cache key = hashes only (transcript, form, options; names hashed). Run store and stage cache contain no vault or original values for the clean fixture (disk scan). Mask errors stop the run; no unmasked fallback. `MockLlmClient` refuses a payload with an exact vault value (`PiiLeakError`). Placeholders are stable per identity across body, speaker and form, deterministic across runs, and round-trip through `rehydrate` (later spellings of one identity rehydrate to the first spelling, which is lossy but safe).

## Q3 (data transfer) status

Condition "send masked text only" is NOT yet satisfied for STT-style input: B1 and B2 are release blockers. Re-review after fixes; suggested acceptance: all `[KNOWN LEAK]` tests in classes A, B, C, E and D1-D5/D13-D14/D23-D26 flip to passing.
