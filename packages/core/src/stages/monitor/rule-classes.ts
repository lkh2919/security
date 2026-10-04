/**
 * Mode A rule classes (Policy Monitor design M2, confirmed design C9): what a published text alone can prove.
 *
 *  - `textOnly`      the rule can be judged from the published text. Once its section is present, the element must be there
 *                    (a mandatory heading, an officer contact, a recipient's fields, a concrete retention period, a
 *                    forbidden vague phrase). A missing or wrong must element is Critical or High.
 *  - `factDependent` whether the rule applies, or whether the text is complete or true, depends on the operator's facts that
 *                    the text cannot show (data that may not exist, a consent split that only matters with no-consent items,
 *                    a statute that may not apply, prior versions that may not exist, accuracy against real processing,
 *                    consistency with notices the judge never sees). Never a violation: the finding is Confirm, merged per section.
 *
 * Criteria, in order: (1) rule applies only "if/where/when" something is true of the operator -> factDependent; (2) judging
 * needs a document or fact outside the section text (consent notice, actual processing, a registry) -> factDependent;
 * (3) "accurate", "actual", "working", "true" wording -> factDependent; (4) the element is structural or textual and
 * its section is already present -> textOnly. When unsure -> factDependent. A rule id missing from this table is factDependent.
 *
 * `should` rules: textOnly gives Low at most; factDependent should rules are dropped (a Confirm restating a recommendation
 * only adds reading load).
 *
 * Keyed by ruleId of privacy-2026.04; the test in monitor-current-check.test.ts keeps it in step with the rule packs.
 */
export type RuleClass = "textOnly" | "factDependent";

export const RULE_CLASSES: Readonly<Record<string, RuleClass>> = {
  // S01 Title and preamble (mandatory)
  "R-S01-001": "textOnly", // must: standard title
  "R-S01-002": "textOnly", // should: processor name in title
  "R-S01-003": "textOnly", // should: preamble purpose
  "R-S01-004": "factDependent", // should: service scope
  "R-S01-005": "textOnly", // should: table of contents
  "R-S01-006": "textOnly", // must: plain, item-separated wording
  // S02 Processing purposes (mandatory)
  "R-S02-001": "textOnly", // must: purposes stated
  "R-S02-002": "textOnly", // must: specific, no vague terms
  "R-S02-003": "factDependent", // must: consistent with consent notice
  "R-S02-004": "factDependent", // must: no-consent purposes predictable
  // S03 Items processed (mandatory)
  "R-S03-001": "factDependent", // must: items listed, minimum, accurate
  "R-S03-002": "textOnly", // must: no abbreviation
  "R-S03-003": "factDependent", // must: consent vs no-consent split
  "R-S03-004": "factDependent", // must: legal basis per no-consent item
  "R-S03-005": "factDependent", // must: generated data
  "R-S03-006": "factDependent", // must: data received from others
  "R-S03-007": "factDependent", // should: unique ID / sensitive sub-groups
  "R-S03-008": "factDependent", // must: on-device with server storage
  "R-S03-009": "factDependent", // should: on-device-only disclosure
  // S04 Children under 14 (conditional)
  "R-S04-001": "textOnly", // must: guardian data items
  "R-S04-002": "factDependent", // should: consent fact and verification method
  "R-S04-003": "textOnly", // must: child-readable wording
  "R-S04-004": "factDependent", // should: separate children's policy
  // S05 Processing and retention period (mandatory)
  "R-S05-001": "textOnly", // must: retention per basis
  "R-S05-002": "factDependent", // must: consistent with consent notice
  "R-S05-003": "textOnly", // must: statutory basis and period (trigger is in the text: "관련 법령에 따라" needs the statute and period; self-review 2026-10-02)
  "R-S05-004": "factDependent", // should: items kept under statute
  "R-S05-005": "textOnly", // must: concrete period per task
  "R-S05-006": "factDependent", // should: extension exceptions
  "R-S05-007": "factDependent", // must: HR statutory retention from verified table
  // S06 Destruction procedure and method (mandatory)
  "R-S06-001": "textOnly", // must: destroy without delay
  "R-S06-002": "factDependent", // must: preservation basis, items, period
  "R-S06-003": "textOnly", // must: procedure and method stated
  "R-S06-005": "textOnly", // should: selection and approval step (split from R-S06-003, self-review 2026-10-02)
  "R-S06-004": "factDependent", // should: separate storage statement
  // S07 Provision to third parties (conditional)
  "R-S07-001": "textOnly", // must: consent-based provision fields
  "R-S07-002": "textOnly", // must: no-consent provision fields
  "R-S07-003": "textOnly", // must: recipients named
  "R-S07-007": "factDependent", // must: ambiguous party: provision candidate
  // S08 Criteria for ongoing additional use or provision (conditional)
  "R-S08-001": "factDependent", // must: details of ongoing additional use
  "R-S08-002": "factDependent", // must: judgment criteria
  // S09 Outsourcing of processing (conditional)
  "R-S09-001": "textOnly", // must: processor and task
  "R-S09-002": "textOnly", // must: processors named
  "R-S09-007": "factDependent", // must: ambiguous party: manual review, both candidates
  // S10 Overseas collection and transfer (conditional)
  "R-S10-001": "textOnly", // must: separate section
  "R-S10-002": "factDependent", // must: direct collection countries
  "R-S10-003": "textOnly", // must: transfer checklist
  "R-S10-004": "factDependent", // must: all countries (cloud)
  "R-S10-005": "factDependent", // must: other-law basis named
  "R-S10-007": "factDependent", // must: re-transfer after direct collection
  // S11 Safety measures (mandatory)
  "R-S11-001": "textOnly", // must: measures stated
  "R-S11-002": "factDependent", // must: actual measures by category
  // S12 Sensitive-data disclosure risk and opt-out (conditional)
  "R-S12-001": "factDependent", // must: disclosure possibility (only if public information may include sensitive data; self-review 2026-10-02)
  "R-S12-002": "textOnly", // must: how to choose non-disclosure
  // S13 Pseudonymized information (conditional)
  "R-S13-001": "textOnly", // must: purpose
  "R-S13-002": "textOnly", // must: period
  "R-S13-003": "textOnly", // must: items pseudonymized
  "R-S13-004": "factDependent", // must: provision (if any)
  "R-S13-005": "factDependent", // must: outsourcing (if any)
  "R-S13-006": "textOnly", // must: safety measures (28-4)
  // S14 Automatic collection devices (conditional)
  "R-S14-001": "textOnly", // must: device basics
  "R-S14-002": "textOnly", // must: refusal steps
  "R-S14-003": "factDependent", // must: identified behavioral data
  "R-S14-005": "factDependent", // should: non-identified behavioral data
  "R-S14-006": "factDependent", // should: both modes
  "R-S14-007": "factDependent", // must: collection on third-party sites
  // S15 Third-party behavioral data collection (recommended)
  "R-S15-001": "textOnly", // should: tracker table
  "R-S15-002": "textOnly", // should: refusal method
  "R-S15-003": "factDependent", // should: periodic review (operational)
  // S16 Rights of data subjects and legal representatives (mandatory)
  "R-S16-001": "textOnly", // must: core rights and how to exercise (전송요구·자동화된 결정 split out, self-review 2026-10-02)
  "R-S16-002": "factDependent", // must: website self-service. A breach of PIPA 38(4) needs collection through the website, which the text cannot show (re-run 2026-10-03: High on 5 policies)
  "R-S16-003": "factDependent", // must: no harder than collection
  "R-S16-004": "textOnly", // should: request form and contact
  "R-S16-005": "factDependent", // must: transmission request (if transmitter)
  "R-S16-006": "factDependent", // should: agents, limits, identity check, response time
  "R-S16-007": "factDependent", // should: minors
  "R-S16-009": "textOnly", // should: consent withdrawal named as a right (self-review 2026-10-03)
  "R-S16-008": "factDependent", // should: automated-decision rights pointer (only if fully automated decisions are made)
  // S17 Automated decisions (conditional)
  "R-S17-001": "textOnly", // must: fact, purpose, scope of subjects
  "R-S17-002": "factDependent", // must: main data types and relation
  "R-S17-003": "factDependent", // must: considerations and procedure
  "R-S17-004": "factDependent", // must: sensitive or child data
  "R-S17-005": "textOnly", // must: refusal and explanation requests
  "R-S17-006": "factDependent", // should: plain, visual explanation
  // S18 Privacy officer and complaint department (mandatory)
  "R-S18-001": "textOnly", // must: officer name or department, with contact
  "R-S18-002": "textOnly", // should: phone and e-mail
  "R-S18-003": "factDependent", // must: working contact
  "R-S18-004": "textOnly", // should: both officer and department
  "R-S18-005": "factDependent", // should: officer shown = officer designated and reported (large processors)
  "R-S18-006": "textOnly", // should: officer duties described with the amended list (a duty list in the text is the trigger; self-review 2026-10-02)
  "R-S18-007": "factDependent", // should: small business: owner or representative is the officer
  // S19 Domestic representative (conditional)
  "R-S19-001": "textOnly", // must: representative details
  "R-S19-002": "factDependent", // must: reachable Korean phone
  "R-S19-003": "factDependent", // should: affiliate selection (applicability context)
  // S20 Remedies for infringement (recommended)
  "R-S20-001": "textOnly", // should: remedy bodies and contacts
  "R-S20-002": "factDependent", // must: current contacts
  "R-S20-003": "factDependent", // should: escalation path
  // S21 Fixed video devices (CCTV) (conditional)
  "R-S21-002": "textOnly", // must: all Decree 25(1) items
  "R-S21-003": "factDependent", // should: installation/management outsourcing
  // S22 Mobile video devices (conditional)
  "R-S22-002": "textOnly", // must: all required items
  "R-S22-003": "factDependent", // should: de-identification in processing method
  // S23 Voluntary items (recommended)
  "R-S23-002": "factDependent", // should: AI training-data criteria
  "R-S23-003": "factDependent", // must: claims are true
  // S24 Policy changes (versioned change notice) (mandatory)
  "R-S24-001": "factDependent", // must: change and effective dates, changed content
  "R-S24-002": "factDependent", // must: prior versions with application periods
  "R-S24-003": "factDependent", // should: change notice
  "R-S24-004": "factDependent", // must: comparison table for major changes
  // A1 Generative-AI service appendix (conditional)
  "R-A1-001": "factDependent", // should: intended use (S02)
  "R-A1-002": "factDependent", // should: training use disclosed (S02/S16)
  "R-A1-003": "factDependent", // should: prompts and outputs as items (S03)
  "R-A1-004": "factDependent", // should: separate retention per purpose (S05)
  "R-A1-005": "factDependent", // should: plug-in provision vs model outsourcing (S07/S09)
  "R-A1-006": "factDependent", // should: training without consent (S08)
  "R-A1-007": "factDependent", // should: overseas model servers (S10)
  "R-A1-008": "factDependent", // should: pseudonymized prompts (S13)
  "R-A1-009": "factDependent", // should: rights checklist (S16)
  "R-A1-011": "factDependent", // should: AI development purpose and type (upcoming)
};

export const ruleClassOf = (ruleId: string): RuleClass => RULE_CLASSES[ruleId] ?? "factDependent";
