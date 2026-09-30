/**
 * R4 business-group classification (design R3 row R4): code rules first, the Haiku fallback only when no rule fires.
 * Group ids are the clause-library folder names (`kb/jurisdictions/kr/clauses/<docType>/<group>`).
 */
import { z } from "zod";
import type { FactLedger } from "../../contracts/fact-ledger";
import type { LlmClient } from "../../llm/client";
import { wrapUntrusted, UNTRUSTED_NOTICE } from "../intake/sanitize";

export const BUSINESS_GROUPS = [
  "retail_ecommerce",
  "it_services",
  "hr_corporate",
  "logistics",
  "food_manufacturing",
  "services_leisure",
  "construction_realestate",
  "group_holding",
  "cross_group",
] as const;
export type BusinessGroup = (typeof BUSINESS_GROUPS)[number];

/** First match wins; patterns run over the free-text `profile.businessGroup` and `profile.serviceNames`. */
const KEYWORDS: readonly (readonly [BusinessGroup, RegExp])[] = [
  ["group_holding", /지주|홀딩스|holdings?/i],
  ["hr_corporate", /채용|인사|임직원|recruit|\bhr\b/i],
  ["logistics", /물류|택배|운송|logistics|delivery service/i],
  ["food_manufacturing", /식품|음료|제조|제과|food|beverage|manufactur/i],
  ["construction_realestate", /건설|부동산|분양|시공|construction|real ?estate/i],
  ["services_leisure", /호텔|리조트|레저|영화|극장|면세|여행|hotel|resort|leisure|cinema/i],
  ["it_services", /\bit\b|소프트웨어|시스템|플랫폼|클라우드|솔루션|software|platform|cloud|saas/i],
  ["retail_ecommerce", /쇼핑|커머스|마트|유통|백화점|리테일|편의점|shop|commerce|retail|mall/i],
];

/** Fallback from `profile.serviceTypes` when the free text says nothing. `other` has no rule. */
const SERVICE_TYPE_GROUP: Readonly<Record<string, BusinessGroup>> = {
  b2c_commerce: "retail_ecommerce",
  internal_hr: "hr_corporate",
  b2b_service: "it_services",
  member_community: "it_services",
  content_media: "services_leisure",
};

export interface GroupDecision {
  readonly group: BusinessGroup;
  readonly method: "rule" | "llm_fallback";
  /** Which signal decided it (`businessGroup`, `serviceNames`, `serviceTypes`, `default`). */
  readonly basis: string;
}

function textOf(ledger: Pick<FactLedger, "slots">, slotId: string): string {
  const e = ledger.slots[slotId];
  if (!e || e.status !== "filled" || e.value === null) return "";
  return Array.isArray(e.value) ? e.value.filter((v) => typeof v === "string").join(" ") : typeof e.value === "string" ? e.value : "";
}

/** Rule-only classification. Returns null when no rule fires (the caller may use the LLM fallback). */
export function classifyGroupByRule(ledger: Pick<FactLedger, "slots">): GroupDecision | null {
  for (const slot of ["profile.businessGroup", "profile.serviceNames"] as const) {
    const text = textOf(ledger, slot);
    if (!text) continue;
    const hit = KEYWORDS.find(([, re]) => re.test(text));
    if (hit) return { group: hit[0], method: "rule", basis: slot === "profile.businessGroup" ? "businessGroup" : "serviceNames" };
  }
  const types = ledger.slots["profile.serviceTypes"];
  if (types?.status === "filled" && Array.isArray(types.value)) {
    for (const t of types.value) {
      const g = typeof t === "string" ? SERVICE_TYPE_GROUP[t] : undefined;
      if (g) return { group: g, method: "rule", basis: "serviceTypes" };
    }
  }
  return null;
}

const FallbackOutputSchema = z.strictObject({ group: z.enum(BUSINESS_GROUPS) });
const FALLBACK_SYSTEM = [
  "You classify a service into exactly one business group of a Korean corporate group, for choosing privacy-policy clause examples.",
  `Groups: ${BUSINESS_GROUPS.join(", ")}. Use cross_group when none fits.`,
  UNTRUSTED_NOTICE,
  "Return only the JSON object.",
].join("\n");
export const GROUP_FALLBACK_PROMPT_VERSION = "1.0.0";

/** Rule first; then the Haiku fallback if `llm` is given; otherwise `cross_group` by rule default. */
export async function classifyBusinessGroup(ledger: FactLedger, deps: { llm?: LlmClient; description?: string } = {}): Promise<GroupDecision> {
  const byRule = classifyGroupByRule(ledger);
  if (byRule) return byRule;
  if (!deps.llm) return { group: "cross_group", method: "rule", basis: "default" };
  const facts = ["profile.serviceNames", "profile.channels", "profile.dataSubjectGroups"].map((s) => `${s}: ${textOf(ledger, s) || "(unknown)"}`).join("\n");
  const res = await deps.llm.callStructured({
    stageId: "R4-fallback",
    system: FALLBACK_SYSTEM,
    user: wrapUntrusted(`${facts}${deps.description ? `\ndescription: ${deps.description}` : ""}`),
    schema: FallbackOutputSchema,
    schemaName: "BusinessGroupFallback",
    promptVersion: GROUP_FALLBACK_PROMPT_VERSION,
  });
  return { group: res.data.group, method: "llm_fallback", basis: "llm" };
}
