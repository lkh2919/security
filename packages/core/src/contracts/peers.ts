/**
 * Peer Watch contracts (design C5): the peer registry (committed, `kb/jurisdictions/kr/monitor/peers/peer-registry.json`), the
 * snapshot of one fetched policy (hashes only; the normalized text lives next to it outside git), the change event (hashes and
 * short masked quotes) and the group-level urgency signal.
 *
 * Peers are reference only: change detection, never a rating or ranking. Quotes are capped at 25 words and carry no contacts.
 */
import { z } from "zod";
import { IsoDateSchema, IsoDateTimeSchema, NonEmptyString, Sha256Schema } from "./common";

/** The only wording a peer signal may carry (design C5). */
export const PEER_SIGNAL_LABEL = "업계 동향(참고) — 법적 요구사항 아님";
/** Shown for a peer change whose cause cannot be attributed to an amendment (confidence Low). */
export const PEER_UNKNOWN_CAUSE_LABEL = "변경 감지 (원인 미상)";
export const MAX_PEER_QUOTE_WORDS = 25;

/** Directory-safe id: peers and Lotte captures become snapshot folder names. */
export const PeerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/, "peerId must be 2-64 chars of [A-Za-z0-9_-]");
export type PeerId = z.infer<typeof PeerIdSchema>;

// --- registry (loose: the committed file carries notes and provenance) ----------------------------------------

export const PeerRenderSchema = z.enum(["html", "js_required", "pdf", "unknown"]);
export const PeerStatusSchema = z.enum(["active", "excluded", "to_verify"]);

export const PeerEntrySchema = z.looseObject({
  peerId: PeerIdSchema,
  name: NonEmptyString,
  url: NonEmptyString,
  finalUrl: z.string().optional(),
  render: PeerRenderSchema,
  /** `allowed`, `none`, `disallowed`, `unreachable` ... as recorded by the last manual check. */
  robots: z.string(),
  robotsCheckedAt: z.string().optional(),
  termsNote: z.string().optional(),
  status: PeerStatusSchema,
  note: z.string().optional(),
});
export type PeerEntry = z.infer<typeof PeerEntrySchema>;

/**
 * Policy version history of a peer (registry `history`, read by `scripts/peer-history.ts`). Loose and parsed on its own: an invalid
 * `history` makes that peer "이력 미공개" instead of failing the whole registry.
 */
export const PeerHistoryVersionSchema = z.looseObject({
  /** `YYYY-MM-DD`: the day this version of the policy took effect. */
  effectiveDate: NonEmptyString,
  url: NonEmptyString,
  /** `http` plain fetch, `browser` rendered fetch, `form` only available through a form or search page (not fetched). */
  fetch: z.enum(["http", "browser", "form"]),
  formNote: z.string().optional(),
});
export const PeerHistorySchema = z.looseObject({
  currentEffectiveDate: z.string().nullable().optional(),
  versions: z.array(PeerHistoryVersionSchema),
  /** Indexes into `versions`: the version in force just before / after the amendment under study. */
  beforeAmendment: z.number().int().nonnegative().nullable().optional(),
  afterAmendment: z.number().int().nonnegative().nullable().optional(),
  note: z.string().optional(),
});
export type PeerHistory = z.infer<typeof PeerHistorySchema>;

export const PeerGroupSchema = z.looseObject({
  groupId: PeerIdSchema,
  nameKo: NonEmptyString,
  /** Capture ids from `kb/jurisdictions/kr/clauses/_captures/index.json`. */
  lotte: z.array(NonEmptyString),
  peers: z.array(PeerEntrySchema),
});
export type PeerGroup = z.infer<typeof PeerGroupSchema>;

export const PeerRegistrySchema = z.looseObject({
  version: NonEmptyString,
  updated: z.string().optional(),
  note: z.string().optional(),
  groups: z.array(PeerGroupSchema),
  /** capture id -> `browser`: the capture needs a rendered fetch. */
  lotteFetch: z.record(z.string(), z.string()).default({}),
});
export type PeerRegistry = z.infer<typeof PeerRegistrySchema>;

// --- snapshot, change event, signal ----------------------------------------------------------------------------

export const SnapshotSectionSchema = z.strictObject({
  /** `S01`..`S24`, `PREAMBLE` (text before the first heading) or `UNMAPPED`. */
  sectionId: NonEmptyString,
  sha256: Sha256Schema,
  /** Hash of the date-neutralized section text (dates replaced, 시행일/공고일 lines dropped); optional for older snapshots. */
  neutralSha256: Sha256Schema.optional(),
  charCount: z.number().int().nonnegative(),
});

export const PolicySnapshotSchema = z
  .strictObject({
    peerId: PeerIdSchema,
    url: NonEmptyString,
    fetchedAt: IsoDateTimeSchema,
    /** Hash over the per-section hashes of the normalized text: equal for whitespace, markup, navigation and block-order edits. */
    contentSha256: Sha256Schema.optional(),
    neutralContentSha256: Sha256Schema.optional(),
    sections: z.array(SnapshotSectionSchema),
    render: z.enum(["html", "browser"]),
    status: z.enum(["ok", "skipped", "failed"]),
    reason: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.status === "ok" && !s.contentSha256) ctx.addIssue({ code: "custom", path: ["contentSha256"], message: "an ok snapshot needs contentSha256" });
  });
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;

/**
 * Committed, hash-only baseline of one peer policy (`kb/jurisdictions/kr/monitor/peers/baselines/<peerId>.json`). The cloud container is
 * ephemeral, so the "previous" side of a comparison must survive in git. No policy text and no quotes: hashes, counts and the
 * effective date as written on the page (digits and date punctuation only).
 */
export const PeerBaselineSchema = z.strictObject({
  peerId: PeerIdSchema,
  url: NonEmptyString,
  fetchedAt: IsoDateTimeSchema,
  contentSha256: Sha256Schema,
  neutralContentSha256: Sha256Schema.optional(),
  sections: z.array(SnapshotSectionSchema),
  effectiveDateText: z.string().regex(/^[0-9.\-/년월일 ]{6,24}$/, "effectiveDateText holds only digits and date punctuation").optional(),
});
export type PeerBaseline = z.infer<typeof PeerBaselineSchema>;

export const QuoteSchema = z.string().refine((q) => q.trim().split(/\s+/).filter(Boolean).length <= MAX_PEER_QUOTE_WORDS, { message: `a quote holds at most ${MAX_PEER_QUOTE_WORDS} words` });

export const ChangedSectionSchema = z.strictObject({
  sectionId: NonEmptyString,
  kind: z.enum(["added", "removed", "modified"]),
  quote: QuoteSchema,
});
export type ChangedSection = z.infer<typeof ChangedSectionSchema>;

export const PolicyChangeEventSchema = z.strictObject({
  peerId: PeerIdSchema,
  groupId: PeerIdSchema,
  detectedAt: IsoDateTimeSchema,
  fromSha: Sha256Schema,
  toSha: Sha256Schema,
  changedSections: z.array(ChangedSectionSchema),
  /** True when only whitespace, markup or navigation changed: no section differs. Never an alert. */
  cosmeticOnly: z.boolean(),
});
export type PolicyChangeEvent = z.infer<typeof PolicyChangeEventSchema>;

export const UrgencySignalSchema = z.strictObject({
  /** Legal-ref key of the amended unit (`PIPA:38(1)`). */
  articleKey: NonEmptyString,
  sectionId: NonEmptyString,
  groupId: PeerIdSchema,
  k: z.number().int().positive(),
  n: z.number().int().positive(),
  windowDays: z.number().int().positive(),
  confidence: z.enum(["high", "medium", "low"]),
  label: z.literal(PEER_SIGNAL_LABEL),
});
export type UrgencySignal = z.infer<typeof UrgencySignalSchema>;

/** Persisted fetch bookkeeping per URL and host (conditional GET validators, daily limit). */
export const FetchStateSchema = z.strictObject({
  version: z.literal(1),
  hosts: z.record(
    z.string(),
    z.strictObject({ lastPageDay: IsoDateSchema.optional(), backoffUntilDay: IsoDateSchema.optional(), strikes: z.number().int().nonnegative().optional() }),
  ),
  urls: z.record(
    z.string(),
    z.strictObject({ etag: z.string().optional(), lastModified: z.string().optional(), rawSha256: Sha256Schema.optional(), lastCheckedAt: IsoDateTimeSchema.optional() }),
  ),
});
export type FetchState = z.infer<typeof FetchStateSchema>;
export const EMPTY_FETCH_STATE: FetchState = { version: 1, hosts: {}, urls: {} };
