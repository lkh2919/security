/**
 * Delegation (수탁, S09) vs third-party provision (제3자 제공, S07) ambiguity detector.
 *
 * User decision: this ambiguity must ALWAYS produce a manual-review question. The detector is pure
 * code over the FactLedger so C1 (warning) and R3 (question) agree without an LLM call.
 * It errs toward "ambiguous": a false positive costs one confirming question, a false negative can
 * put a recipient into the wrong policy section.
 */
import type { JsonValue } from "../../contracts/common";
import type { FactLedger } from "../../contracts/fact-ledger";

export const DELEGATION_GATES = ["gate.outsourcing", "gate.thirdPartyProvision"] as const;
export const DELEGATION_TABLES = ["privacy.S09_processors", "privacy.S07_thirdParties"] as const;

export interface DelegationAmbiguity {
  readonly ambiguous: boolean;
  readonly reasons: readonly string[];
}

function strings(v: JsonValue | undefined, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v.trim());
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

const DELEGATE_WORD = /위탁|수탁|맡기|맡겨|대신 처리/;
const PROVIDE_WORD = /제3자|제공|넘기|넘겨|자기 목적|자체 목적/;

export function detectDelegationAmbiguity(ledger: Pick<FactLedger, "slots">): DelegationAmbiguity {
  const reasons: string[] = [];
  const slots = ledger.slots;

  for (const gate of DELEGATION_GATES) {
    const s = slots[gate];
    if (s && (s.status === "conflict" || s.status === "needs_manual_review")) reasons.push(`${gate} is ${s.status}`);
  }

  const outsourcing = slots["gate.outsourcing"];
  const provision = slots["gate.thirdPartyProvision"];
  const truthy = (s: typeof outsourcing): boolean => s?.status === "filled" && s.value === true;
  const bothTrue = truthy(outsourcing) && truthy(provision);

  const names = (id: string): Set<string> => new Set(strings(slots[id]?.value ?? undefined).filter((x) => x.length >= 2));
  const processors = names("privacy.S09_processors");
  const providers = names("privacy.S07_thirdParties");
  const shared = [...processors].filter((n) => providers.has(n));
  if (shared.length > 0) reasons.push(`${shared.length} recipient value(s) appear in both S09 processors and S07 third parties`);

  // Recipients present but neither list is confirmed (the role of the recipient is undecided).
  const anyRecipients = processors.size > 0 || providers.size > 0;
  if (anyRecipients && !truthy(outsourcing) && !truthy(provision)) reasons.push("recipients exist but neither S09 nor S07 gate is confirmed true");

  if (bothTrue && reasons.length === 0) {
    // Both flows exist. Only ambiguous when the same party may sit in both; without names we cannot tell.
    if (processors.size === 0 || providers.size === 0) reasons.push("both gates are true but the recipient lists are incomplete, so roles cannot be told apart");
  }

  // Wording signal: the speaker described one recipient with both delegation and provision words.
  for (const id of [...DELEGATION_TABLES, ...DELEGATION_GATES]) {
    for (const ev of slots[id]?.evidence ?? []) {
      if (DELEGATE_WORD.test(ev.quote) && PROVIDE_WORD.test(ev.quote)) {
        reasons.push(`evidence for ${id} mixes delegation and provision wording`);
        break;
      }
    }
  }

  return { ambiguous: reasons.length > 0, reasons };
}
