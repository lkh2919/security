/**
 * C1 Coverage Engine (design R3 row C1): code only, zero tokens.
 * Walks the Interview Template against the FactLedger and produces the ApplicabilityMap
 * (privacy S01-S24, A1, X1 and terms T01-T15), the GapList, and special-type warnings.
 *
 * Gap rules (documented decisions):
 *  - A module is walked when `enterIf` is known-true; a node is asked when its module is entered and
 *    `showIf` is known-true or absent. Unknown gates are themselves gaps (the gate questions are
 *    unconditional `core` nodes), so detail nodes appear only after their gate is answered.
 *  - A node is resolved when at least one target slot is resolved (`filled` with confidence >= 0.5, or
 *    `not_applicable`) and no target is in conflict / manual review / low confidence. Optional sibling
 *    targets (e.g. businessGroup) therefore do not re-ask a whole question.
 *  - Reason precedence when a node is unresolved: conflict > needs_manual_review > low_confidence > missing.
 *  - `preAnswered` (node id -> slot ids) lets a future intake sheet mark targets as already answered; when
 *    the remaining targets are empty the node is skipped. This is the only hook the sheet needs.
 */
import { WarningSchema, parseContract, type Warning } from "../../contracts/common";
import { ApplicabilityMapSchema, type ApplicabilityMap } from "../../contracts/applicability";
import type { FactLedger, SlotEntry } from "../../contracts/fact-ledger";
import { GapListSchema, type Gap, type GapList } from "../../contracts/gap-list";
import type { InterviewTemplate, QuestionNode } from "../../contracts/interview-template";
import { detectDelegationAmbiguity } from "./delegation";
import { contextFromLedger, evalCond, looseCondSlotIds, type Tri } from "./eval-cond";
import type { RulePackItem } from "./load-kb";

/** Slots below this confidence are re-asked (`low_confidence`). R2 maps high/medium/low to 0.9/0.7/0.4. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export const TERMS_ITEM_IDS = Array.from({ length: 15 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);

export interface CoverageInput {
  readonly runId: string;
  readonly ledger: FactLedger;
  readonly template: InterviewTemplate;
  readonly rulePackItems: readonly RulePackItem[];
  readonly rulePackVersion: string;
  /** False (default) while terms packs are absent: T01-T15 become `pending` plus a TERMS_PACK_PENDING warning. */
  readonly termsPackAvailable?: boolean;
  /** Interview round this list is computed for (0 = after first extraction). */
  readonly round?: 0 | 1 | 2;
  /** Node id -> slot ids already answered by an intake sheet. */
  readonly preAnswered?: Readonly<Record<string, readonly string[]>>;
}

export interface CoverageResult {
  readonly applicability: ApplicabilityMap;
  readonly gapList: GapList;
}

type SlotState = "resolved" | "missing" | "conflict" | "needs_manual_review" | "low_confidence";

export function slotState(entry: SlotEntry | undefined): SlotState {
  if (!entry) return "missing";
  switch (entry.status) {
    case "not_applicable":
      return "resolved";
    case "filled":
      return entry.confidence < LOW_CONFIDENCE_THRESHOLD ? "low_confidence" : "resolved";
    case "conflict":
      return "conflict";
    case "needs_manual_review":
      return "needs_manual_review";
    case "missing":
      return "missing";
  }
}

const REASON_ORDER: readonly Gap["reason"][] = ["conflict", "needs_manual_review", "low_confidence", "missing"];

/** Gap for one node, or null when the node is resolved. Exported so R3 and tests can reuse the rule. */
export function nodeGap(node: QuestionNode, ledger: Pick<FactLedger, "slots">, preAnswered: readonly string[] = []): Gap | null {
  const targets = node.targets.filter((t) => !preAnswered.includes(t));
  if (targets.length === 0) return null;
  const states = targets.map((t) => ({ t, s: slotState(ledger.slots[t]) }));
  const bad = REASON_ORDER.slice(0, 3).find((r) => states.some((x) => x.s === r));
  let reason: Gap["reason"];
  let gapTargets: string[];
  if (bad) {
    reason = bad;
    gapTargets = states.filter((x) => x.s === bad).map((x) => x.t);
  } else if (states.some((x) => x.s === "resolved") || targets.length < node.targets.length) {
    return null;
  } else {
    reason = "missing";
    gapTargets = targets;
  }
  return { questionId: node.id, itemRefs: node.itemRefs, targets: gapTargets, priority: node.priority, reason };
}

const tri = (t: Tri): "yes" | "no" | "unknown" => (t === true ? "yes" : t === false ? "no" : "unknown");

function isTruthySlot(ledger: FactLedger, id: string): boolean {
  return evalCond({ slot: id, op: "truthy" }, contextFromLedger(ledger)) === true;
}

function specialTypeWarnings(ledger: FactLedger): Warning[] {
  const w: Warning[] = [];
  const add = (code: string, itemId: string, message: string): void => {
    w.push({ code, itemId, kind: "special_type", message });
  };
  if (isTruthySlot(ledger, "gate.childrenU14")) add("SPECIAL_CHILDREN", "S04", "Children under 14: legal-guardian consent and verification flow needs manual review; draft is warn-only.");
  if (isTruthySlot(ledger, "gate.cctvFixed")) add("SPECIAL_CCTV_FIXED", "S21", "Fixed video devices (CCTV): optional in this policy or a separate CCTV policy; manual review required.");
  if (isTruthySlot(ledger, "gate.cctvMobile")) add("SPECIAL_CCTV_MOBILE", "S22", "Mobile video devices: manual review required; draft is warn-only.");
  if (isTruthySlot(ledger, "gate.locationInfo")) add("SPECIAL_LOCATION", "X1", "Location information: separate legal regime; manual review required, no final clause is generated.");
  if (isTruthySlot(ledger, "gate.genAI")) add("SPECIAL_GENAI", "A1", "Generative AI service: appendix is warn-only and needs manual review.");
  if (isTruthySlot(ledger, "gate.automatedDecision")) add("SPECIAL_AUTOMATED_DECISION", "S17", "Automated decisions: manual review flag required.");
  return w;
}

function termsDocument(ledger: FactLedger): { applicable: boolean; reason?: string } {
  const ctx = contextFromLedger(ledger);
  if (evalCond({ slot: "terms.applicable", op: "eq", value: false }, ctx) === true) {
    return { applicable: false, reason: "The operator stated that no terms of service apply to this service." };
  }
  const types = ledger.slots["profile.serviceTypes"];
  if (types?.status === "filled" && Array.isArray(types.value) && types.value.length > 0 && types.value.every((t) => t === "internal_hr")) {
    return { applicable: false, reason: "Internal HR system: employees are not users under standard terms of service." };
  }
  return { applicable: true };
}

export function runCoverage(input: CoverageInput): CoverageResult {
  const { ledger, template } = input;
  const ctx = contextFromLedger(ledger);
  const termsPack = input.termsPackAvailable === true;

  // --- Applicability -------------------------------------------------------------------------
  const terms = termsDocument(ledger);
  const items: ApplicabilityMap["items"] = {};
  for (const item of input.rulePackItems) {
    items[item.id] = { state: tri(evalCond(item.when, ctx)), basisSlots: [...new Set(looseCondSlotIds(item.when))] };
  }
  for (const id of TERMS_ITEM_IDS) {
    items[id] = !termsPack ? { state: "pending", basisSlots: [] } : { state: terms.applicable ? "yes" : "no", basisSlots: terms.applicable ? [] : ["terms.applicable", "profile.serviceTypes"] };
  }

  const warnings: Warning[] = specialTypeWarnings(ledger);
  if (!termsPack) {
    warnings.push({ code: "TERMS_PACK_PENDING", kind: "coverage", message: "Terms rule packs are not available yet: T01-T15 applicability is reported as pending." });
  }
  const delegation = detectDelegationAmbiguity(ledger);
  if (delegation.ambiguous) {
    warnings.push({
      code: "DELEGATION_VS_PROVISION",
      itemId: "S09",
      kind: "manual_review",
      message: `Delegation (S09) vs third-party provision (S07) is ambiguous; a manual-review question is required. ${delegation.reasons.join("; ")}`,
    });
  }

  const applicability = parseContract("ApplicabilityMap", ApplicabilityMapSchema, {
    runId: input.runId,
    ruleSetVersions: [input.rulePackVersion, ...(termsPack ? [] : ["terms: pending"])],
    documents: { privacy: { applicable: true }, terms },
    items,
    warnings,
  });

  // --- Gaps ----------------------------------------------------------------------------------
  const gaps: Gap[] = [];
  for (const mod of template.modules) {
    if (evalCond(mod.enterIf, ctx) !== true) continue;
    if (mod.id === "terms" && !terms.applicable) continue;
    for (const node of mod.nodes) {
      if (node.showIf && evalCond(node.showIf, ctx) !== true) continue;
      const gap = nodeGap(node, ledger, input.preAnswered?.[node.id]);
      if (gap) gaps.push(gap);
    }
  }

  const gapList = parseContract("GapList", GapListSchema, {
    runId: input.runId,
    templateVersion: template.version,
    round: input.round ?? 0,
    gaps,
    warnings: warnings.map((x) => WarningSchema.parse(x)),
  });
  return { applicability, gapList };
}
