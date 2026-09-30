# Lotte group domain profiles (public privacy policies and terms)

Status: DRAFT by kb-curator, 2026-09-30. Basis: heading-level reading of all 34 captured documents plus a keyword presence scan and sampled reading of retention, delegation and overseas sections. It is not a full clause-by-clause read (that is Row 6b). No clause records were created and no rule-pack section ids were invented; ids like S05 are provisional topic hints from `rulepacks/privacy-2026.04/index.json`. Finance affiliates are excluded. Metadata for every document is in `index.json`.

## 1. Coverage

| domainGroup | Captured (ok) | Sites | Not captured |
|-------------|:-------------:|-------|--------------|
| group_holding | 1 | Lotte Holdings corporate | none |
| hr_corporate | 2 | Lotte Group recruiting (privacy, terms) | none |
| it_services | 2 | Lotte Innovate (privacy, CCTV) | cloud site unreachable |
| retail_ecommerce | 11 | Department Store (3), Mart/Super (3), 7-Eleven (2), Himart corporate (2), Himart online mall (1) | LOTTE ON, Homeshopping, Duty Free: robots.txt disallows; Himart main site: TLS certificate mismatch |
| services_leisure | 5 | Cinema (privacy, terms), Rental (privacy, terms), Charlotte Theater (terms) | Lotte World, Lotte World Adventure, Lotte Hotel: JS-rendered; Charlotte privacy: robots-disallowed |
| construction_realestate | 4 | Lotte E&C (privacy), Lotte Castle (privacy, CCTV, terms) | none |
| logistics | 4 | Global Logistics (privacy, parcel terms, location terms, CCTV) | none |
| food_manufacturing | 5 | Wellfood (privacy, terms, CCTV), Chilsung (privacy, terms) | Lotte Chemical, Fine Chemical: robots-disallowed |

The 34 captures include 8 CCTV or video-policy documents (`subType: cctv`) and 12 terms documents.

## 2. Common group skeleton (privacy policies)

Most Lotte privacy policies share this order, derived from headings:

1. Title and short preamble (operator, laws complied with); some add a key-points summary block (Innovate, Wellfood, Cinema, Department Store use one).
2. Purposes of processing.
3. Items processed, usually split into "without consent" and "with consent" (older policies: "collected items" only).
4. Collection method (older policies) and automatically generated information.
5. Retention (per service, statutory periods with the law named).
6. Destruction procedure and method.
7. Third-party provision.
8. Delegation (table: vendor, task; domestic re-delegation and overseas delegation sub-tables in the larger ones).
9. Overseas transfer (only where it happens).
10. Rights of data subjects and legal representatives, and how to exercise them.
11. Automatic collection devices (cookies) and how to refuse; behavioral information in retail and food policies.
12. Security measures (managerial, technical, physical).
13. Privacy officer and department, complaint handling.
14. Remedies (external agencies with numbers).
15. Change notice, dates and version; old/new comparison table in several sites.

Two generations coexist. Older layout (Chilsung, E&C, Rental, Cinema-terms era): `제N조` items in the order collected items, method, purpose, third party, delegation, retention, destruction, then many extras (links, postings, advertising messages, identity theft). Newer layout (Innovate, Holdings, Himart, Wellfood, Castle, Logistics): guideline-style order above with the statutory disclosure items. The current guideline generation is the second.

## 3. Boilerplate common to all Lotte policies

- Operator defined as `회사` or a short brand name in the first sentence; polite `합니다` tone throughout.
- Statutory retention lines with the statute named (e-commerce records 5 years for contract and payment, 3 years for complaints, 6 months for advertising; communication-log retention 3 months or 3 years).
- Destruction wording: electronic files deleted irreversibly, paper shredded or incinerated; separate storage when a statute requires retention.
- Rights wording: access, correction, deletion, suspension of processing; exercise via writing, phone, email, fax; agent by power of attorney.
- Cookie paragraph explaining purpose and browser refusal path.
- Security list (training, access control, encryption, logs, physical control).
- Officer/department contact block and a list of external complaint agencies (KISA 118, prosecutors' cyber unit, police cyber bureau; sometimes the dispute mediation committee).
- Change notice via website announcement with announcement date, effective date and version.
- Group navigation (affiliate mega-menu) is embedded in several captured pages and must be stripped before any clause work.

## 4. Domain profiles

### 4.1 group_holding and hr_corporate

- Sites: Lotte Holdings corporate site (version announced 2026-03-10, effective 2026-03-16); Lotte Group recruiting site (privacy V9.1 applied from 2026-09-08; terms with membership contract chapters).
- Typical items: contact details of inquirers and compliance reporters (holding); for recruiting, identity, education, career, certificates, photos, self-introduction, disability or veteran status where relevant, test results.
- Purposes: inquiry handling, compliance reporting; recruiting adds identity check, screening, notice of results, talent pool, plagiarism check, statutory hiring duties.
- Third-party and delegation: recruiting shares applications with the affiliate the applicant selects; delegation covers system operation, identity verification, tests. Holdings names internal departments as contacts.
- Retention: talent-pool style retention with consent; result-based deletion; details need Row 6b.
- Special sections: recruitment data as its own domain; 14 articles with anchors in the recruiting policy; the recruiting terms end with the group affiliate list.
- Structure difference: recruiting uses `제N조` with numbered sub-lists; holdings uses 12 numbered headings and ends with an old/new comparison table.

### 4.2 it_services (Lotte Innovate)

See `lotte-innovate-analysis.md`. Summary: guideline-style 11 headings, key-points summary, consent-free versus consent tables, overseas delegation to a subsidiary, short retention (3 months to 3 years), separate CCTV document, version history table. No terms page.

### 4.3 retail_ecommerce

- Sites: Department Store, Mart/Super, 7-Eleven, Himart (corporate and online mall).
- Typical items: member identity and contact, order and delivery details, payment records, device and access logs, purchase history, membership number, children's data for family accounts, event entries, class enrolment (department store), gift-card and coupon usage.
- Purposes: membership, ordering and delivery, payment, refunds, customer service, marketing, event operation, fraud prevention.
- Third-party and delegation patterns (vendor types): delivery and parcel companies, payment and identity verification providers, SMS/push senders, call centers, system maintenance vendors, gift-card and coupon partners. Shops list third-party provision to store tenants or partner brands.
- Retention: withdrawal plus 30 days up to 1 year for fraud prevention; 5 years for contract and payment records, 3 years for complaints, 6 months for advertising records; 6 months for identity-verification logs, 3 years for access logs; separate storage of dormant data.
- Special sections: children under 14 (Department Store, Mart, 7-Eleven, Himart mall), behavioral information for tailored ads (Department Store, Mart, 7-Eleven, Himart mall), location information (Himart mall, 7-Eleven), overseas transfer (Mart, Himart mall), marketing consent, e-payment and credit-information records (Mart, 7-Eleven, Himart), pseudonymized data (Department Store, Mart, 7-Eleven), separate CCTV documents (Department Store, Mart, 7-Eleven).
- Structure difference: largest documents (Mart 23k chars, Himart mall 34k chars); Department Store uses `[제 N 조]` in bracket form and pairs each item with tables for many sub-services; Mart splits by brand (Mart, Super, app brands); Himart adds a plain-language summary block at the end.
- Terms: membership terms of 17 to 20 articles (purpose, definitions, service, withdrawal, notice, privacy, obligations, disclaimer, copyright, ads, dispute, jurisdiction); Himart terms add purchase contract, payment, delivery, refund and withdrawal chapters.
- Robots: LOTTE ON, Homeshopping and Duty Free disallow all crawling, so these are absent from the corpus.

### 4.4 services_leisure

- Sites: Cinema, Rental (car), Charlotte Theater (terms only).
- Typical items: member identity, booking and payment records, viewing or rental history, driver license and vehicle data (rental), location and telematics (rental), inquiry and lost-item records, group booking and venue rental records (cinema), event entries.
- Purposes: reservation and ticketing, rental contract performance and accident handling, membership benefits, marketing.
- Delegation patterns: payment, identity verification, ticketing/printing, call centers, vehicle maintenance and insurance handlers, overseas processors in Rental.
- Retention: e-commerce statutory periods; 3 years for one-to-one inquiries, 1 year for recruiting inquiries and lost items, 2 years for group and venue rental (Cinema).
- Special sections: overseas transfer (Cinema, Rental), behavioral information and location (Cinema), children under 14 (Cinema, Charlotte terms), minors' special membership clause (Cinema terms 제8조), non-member use clause, notification consent (informational versus marketing) inside the terms.
- Structure difference: Rental policy uses `가. 나. 다.` letters as top-level items (a distinct older layout) with an embedded ISMS-certification note; Cinema policy is 19 articles with a labeling block at the top. The Cinema and Innovate pages print all previous versions on the same page, which inflates the text (Cinema privacy 1.25M chars). Lotte World, World Adventure and Hotel are JS-rendered and absent.

### 4.5 construction_realestate

- Sites: Lotte E&C corporate site, Lotte Castle (residential brand site).
- Typical items: inquiry and consultation data, membership data for the Castle site, lead and subscription-interest data, resident contact data, CCTV video.
- Purposes: consultation, membership, event and promotion, after-sale service, marketing.
- Delegation patterns: call centers, marketing agencies, system operation; Castle lists third-party provision to sales agents (verify in Row 6b).
- Retention: consent-based periods, withdrawal-based deletion, statutory periods for contract-related records.
- Special sections: children under 14 in both; Castle has cookies with purpose and refusal, a complaint-service section, and a separate fixed-CCTV policy (9 headings).
- Structure difference: Lotte E&C uses `*` bullets and a two-part layout (the older overview list, then numbered detail) and a long list of complaint agencies; Castle follows the guideline-style split between consent-free and consent-based items. E&C's page also prints its whole version history (99k chars).

### 4.6 logistics

- Sites: Global Logistics (privacy, parcel service terms, location-service terms, CCTV).
- Typical items: sender and recipient names, addresses, phone numbers, delivery request data, customs data for import/export, location data of couriers and delivery status, member data.
- Purposes: parcel acceptance and delivery, customs clearance, tracking, customer service, location-based services.
- Delegation patterns: domestic delivery partners and re-delegation tables, call centers, system vendors, overseas partners for cross-border shipments.
- Retention: uniquely long and varied: 5 years, 10 years, 3 years for export declaration, 5 years for import declaration, plus member-based (until withdrawal, or 1 year of non-use).
- Special sections: overseas transfer (own heading 5), location information (own heading 11 in the privacy policy plus a separate location-service terms document with 17 articles), cookies, remedy agencies.
- Structure difference: the most complete guideline-style layout in the corpus; delegation is split into domestic and re-delegation; parcel terms follow the transport standard-terms style (chapters for acceptance, delivery, disposal, accidents).

### 4.7 food_manufacturing

- Sites: Wellfood (food-mall and sweet-mall services), Chilsung (corporate site); Lotte Chemical and Fine Chemical disallow crawling.
- Typical items: member data for online food malls, orders and delivery, inquiries, event entries, recruiting data (Chilsung), connected information (CI) in Wellfood.
- Purposes: membership, ordering and delivery, product inquiries, promotions, recruiting.
- Delegation patterns: delivery, payment and identity verification, system operation, marketing platform vendors.
- Retention: withdrawal plus 3 months, inquiries 1 to 3 years, delivery records 5 years, long-inactive account deletion for named services.
- Special sections: behavioral information (Wellfood), automatic collection devices (both), connected information CI (Wellfood), overseas transfer (Wellfood), children under 14 (both), advertising messages (Chilsung), identity-theft handling (Chilsung).
- Structure difference: Wellfood follows the newest layout with a key-points block and versioned history (v2.22 printed); Chilsung retains a 20-article older layout dated 2015 with amendments; both provide a separate CCTV or corporate policy; Wellfood's CCTV page contains an English-language section for foreign users.
- Terms: short (15 to 18 articles), standard membership terms with disclaimer, ownership and dispute clauses; the Wellfood terms include a CCTV-safety article that appears misplaced (observation only).

## 5. Cross-domain observations

- Group-wide: a shared skeleton and vocabulary (`회사`, `합니다`), statutory retention tables, and a similar rights and remedies text. These can seed group-level clause templates with slots.
- Domain-specific: children under 14, behavioral ads, location, overseas transfer, CI and long retention appear only where the business needs them. Clause selection should be driven by interview answers, not by domain alone.
- Format drift: the older `제N조` layout and the newer numbered guideline layout coexist. Clauses lifted from the older generation predate the 2026.4 guideline and must be flagged, not dropped (skill rule).
- Capture hazards: several pages print every previous version, embed a group mega-menu, or include named staff and emails. Clause work must strip these and never copy personal names.
- Terms are more uniform than privacy policies: all follow the standard membership-terms skeleton (purpose, definitions, notice/amendment, service, withdrawal, obligations, disclaimer, dispute, jurisdiction). Domain add-ons are transport chapters (logistics), purchase and refund chapters (Himart), ticketing chapters (theater), rental contract chapters (Rental).

## 6. Provisional topicHints for Row 6b (heading-based, unverified)

| Heading pattern in source | Provisional id |
|---------------------------|----------------|
| purposes of processing | S02 |
| items processed, consent-free and consent tables | S03 |
| children under 14 | S04 |
| retention | S05 |
| destruction | S06 |
| third-party provision | S07 |
| additional use criteria | S08 (rare in the corpus; only in Recruiting) |
| delegation | S09 |
| overseas transfer | S10 |
| security measures | S11 |
| pseudonymized data | S13 |
| cookies | S14 |
| behavioral information | S15 |
| rights and exercise | S16 |
| privacy officer, complaints | S18 |
| remedies | S20 |
| CCTV documents | S21 |
| change notice, history | S24 |

## 7. Needs user decision

- Loyalty and membership-data companies (for example the L.POINT operator) and any card, insurance, capital or securities affiliate: not captured. Confirm the exclusion.
- LOTTE ON, Homeshopping, Duty Free, Lotte Chemical, Fine Chemical, Lotte Eatz/GRS: robots.txt disallows crawling. Options: the user supplies saved text or PDF copies of these public pages, or accepts the gap.
- Lotte World, World Adventure, Lotte Hotel and Resort, Lotte Cinema's newer mobile policy: need a headless browser or saved page text.
- Himart main site and Skyhill: TLS certificate mismatch; not captured. Do not disable certificate checks.
- Lotte Innovate cloud site: unreachable from the capture machine; try from another network or supply a saved copy.

## 8. loyalty_membership (added 2026-09-30, user decision to include)

- Sites captured (4): L.POINT privacy policy (m.lpoint.com), L.POINT service terms (members.lpoint.com fragment), L.POINT members-portal service terms (fragment; purchase and service chapters), Lotte Members corporate site (home page with an embedded policy, page also holds corporate and compliance content). Operator: Lotte Members. Finance affiliates stay excluded.
- Typical items: identity and contact data, membership number and card number, point earn/spend history at partner merchants, partner-company usage data used for analysis, marketing consent records, optional lifestyle or demographic data.
- Purposes: membership and point service, partner point earning and payment, marketing and analytics, customer service.
- Third-party and delegation patterns: many partner-company ("제휴사") disclosures (dozens of mentions in the L.POINT terms and policy), delegation to call centers, messaging and system vendors.
- Structure: the L.POINT privacy policy uses the older 15-article `제N조` layout (collection items, method, purposes, third-party, delegation, retention, destruction, disclosure, links, postings, access and correction, consent withdrawal, ad messages, rights, complaints) and prints its version history on the page (dates from 2016 onward), so the current version date must be confirmed in Row 6b. Terms are long chaptered documents (general provisions, membership and card, points earn/spend/charge/gift, partners).
- Out of scope for our rule packs: wording tied to the Credit Information Act (credit-information collection and inquiry consents, insurance contract information lookups) and electronic-finance point-charge rules (charged points, refund of charged balance). Row 6b should tag these clauses as `outOfScope: credit-information` and not use them as templates for ordinary privacy policies or terms.
- Note: Lotte Hotel privacy policy shows L.POINT integrated-member sign-up as a distinct consent block (CI, DI, point conversion); useful cross-reference for member-integration wording.

## 9. Browser-pane captures (2026-09-30)

- `lotte-hotel-privacy`: current policy at lottehotel.com/global/ko/privacy/lotte-hotel-and-resort, effective 2026-08-13, 16 articles (children, pseudonymized data, additional use criteria, sensitive information, CI, CCTV as article 14, voluntary measures). Metadata recorded (`ok_browser_meta`); text file not yet saved.
- `lotte-world-privacy`: policy of the operating company shown in a modal on adventure.lotteworld.com, V6.0 dated 2026-09-28, 13 articles including behavioral information. Metadata recorded; text file not yet saved.
