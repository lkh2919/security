# Terms rule pack `terms-kftc-10023` (v1.0.0, Row 4b)

Rule packs T01-T15 for Korean online-service terms of service, built on the KFTC
e-commerce standard terms No. 10023 and on statutes read from law.go.kr. Same JSON
shape as `privacy-2026.04` (rules per design R5.2, file-level `legalRefs` map with
`verifiedBy`, `commonDefects`, `interviewNodes`, `needsVerification`). Reference drafts only: InfoSec and legal review required.

## Files
- `T01.json` ... `T15.json`: one section each (rules, unfair patterns, defects, hints).
- `unfair-clause-lexicon.json`: 34 regex triggers for the C2 word-list check, each with
  statute ref, severity, Korean explanation, false-positive notes and a self-test string.
- `index.json`: sources, module map, applicability, `missingSlots`, reverse `lawIndex`.

## Sources (all fetched 2026-09-29; raw copies in `kb/_sources/terms/`, gitignored)
| Key | Source |
|-----|--------|
| `kftc-10023-2015-06-26` | ftc.go.kr board nttSn=11139, 전자상거래(인터넷사이버몰) 표준약관 제10023호 (2015. 6. 26. 개정), read via the official document viewer (fileNo 14800). No newer revision on the board. |
| `lawgokr-artc-MST260021` | 약관의 규제에 관한 법률, law.go.kr API MST 260021, in force since 2024-08-07 |
| `lawgokr-eca-MST282793` | 전자상거래법, law.go.kr API MST 282793, current version in force since 2026-07-21 |
| `lawgokr-eca-MST282793-ef20270121` | Same Act, scheduled version effective 2027-01-21 (amendment reason only) |
| `pipc-guideline-2026-04` | PIPA cross-document refs, inherited from the privacy pack |

The law.go.kr OC key is read from `.env` at fetch time and is redacted in every saved file.

## Module mapping
| Module | Sections | Applies when |
|--------|----------|--------------|
| core | T01-T05, T11, T13-T15 | `terms.applicable` is true |
| member | T06-T08 | also `gate.membership` |
| commerce | T09-T10 | also `terms.paid` |
| community | T12 | also `terms.ugc` |

Classification: mandatory T01-T04, T11, T13, T15; recommended T05, T14 (the T14 lexicon
checks still run over the whole document); conditional T06-T10, T12.

## Internal HR and employee systems
Interview node Q-T01-01 sets `terms.applicable = false`. C1 then marks every T section
`not_applicable` and R8 states why: no terms document is produced (design R4.2). The
privacy policy is still drafted.

## Missing slots (proposed in `index.json.missingSlots`; slots.json not edited)
`terms.usesStdTerms`, `terms.nonMemberPurchase`, `terms.businessIdentity`,
`terms.unfavourableChangeNoticeDays`, `terms.pointsMileage`, `terms.minorPurchase`,
`terms.goodsTypes`, `terms.deliveryPolicy`, `terms.withdrawalRestrictedGoods`,
`terms.marketplaceIntermediary`, `terms.buyerProtection`, `terms.customerType`,
`terms.complaintChannel`.

## Open questions
1. The standard terms date from 2015. Where they differ, the statutes read in 2026
   prevail: ECA 13(6) subscription consent and 21-2 dark patterns (both 2025-02-14,
   a date derived from Law 20302's addendum), and PIPA terminology in place of the old
   정보통신망법 제22조 wording.
2. The ECA amendment effective 2027-01-21 (C2C intermediaries, review-deletion policy)
   has not been diffed article by article. Re-check T09, T12 and T14 before that date.
3. The ECA decree (delay-interest rate, extra withdrawal exceptions) and ECA 20 to 20-5
   (intermediary duties) were not read. Rules avoid those facts.
4. UGC rules (T12) rest only on the ARTC general clause. Decide whether to also use the
   KFTC online-game standard terms (No. 10069) as a second source.
5. The notice periods of 7 and 30 days come from the standard terms, not a statute, so
   they are rule level `should`.
