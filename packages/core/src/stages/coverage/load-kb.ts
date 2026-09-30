/**
 * Loads the Korean knowledge-base inputs C1 / R2 need: the Interview Template, the slot registry
 * (plus raw per-slot columns for the extraction map) and the per-item rule-pack applicability.
 * Pure parsing lives in `parse*`; `loadKrKnowledge` is the thin filesystem wrapper.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { slotRegistryFromJson, type SlotRegistry } from "../../contracts/common";
import { InterviewTemplateSchema, templateUnknownSlots, type InterviewTemplate } from "../../contracts/interview-template";
import type { LooseCond } from "./eval-cond";

export interface RulePackItem {
  readonly id: string;
  readonly classification: "mandatory" | "conditional" | "recommended";
  readonly title: string;
  readonly handling: string;
  /** Applicability condition; `{ all: [] }` means always. */
  readonly when: LooseCond;
}

export interface SlotHint {
  readonly columns?: readonly string[];
  readonly options?: readonly string[];
}

export interface KrKnowledge {
  readonly template: InterviewTemplate;
  readonly registry: SlotRegistry;
  /** Extra per-slot info from slots.json that the registry type does not keep. */
  readonly slotHints: Readonly<Record<string, SlotHint>>;
  readonly rulePackVersion: string;
  readonly rulePackItems: readonly RulePackItem[];
  readonly termsPackAvailable: boolean;
}

/** X1 (location) has no rule pack file; its applicability is fixed here (design R4.1, X1 = warn-only). */
export const X1_ITEM: RulePackItem = {
  id: "X1",
  classification: "conditional",
  title: "Location information",
  handling: "warn",
  when: { slot: "gate.locationInfo", op: "truthy" },
};

const RulePackFileSchema = z.looseObject({
  id: z.string(),
  title: z.looseObject({ ko: z.string().optional(), en: z.string().optional() }).optional(),
  classification: z.enum(["mandatory", "conditional", "recommended"]),
  handling: z.string().default("llm"),
  applicability: z.looseObject({ when: z.unknown() }),
});

const CondLooseSchema: z.ZodType<LooseCond> = z.lazy(() =>
  z.union([
    z.object({ always: z.literal(true) }),
    z.object({ all: z.array(CondLooseSchema) }),
    z.object({ any: z.array(CondLooseSchema) }),
    z.object({ not: CondLooseSchema }),
    z.object({ slot: z.string(), op: z.enum(["eq", "in", "exists", "truthy"]), value: z.any().optional() }),
  ]),
);

export function parseRulePackItem(json: unknown): RulePackItem {
  const f = RulePackFileSchema.parse(json);
  return {
    id: f.id,
    classification: f.classification,
    title: f.title?.en ?? f.title?.ko ?? f.id,
    handling: f.handling,
    when: CondLooseSchema.parse(f.applicability.when),
  };
}

export function parseSlotHints(slotsJson: unknown): Record<string, SlotHint> {
  const parsed = z
    .looseObject({ slots: z.array(z.looseObject({ id: z.string(), columns: z.array(z.string()).optional(), options: z.array(z.string()).optional() })) })
    .parse(slotsJson);
  const out: Record<string, SlotHint> = {};
  for (const s of parsed.slots) if (s.columns || s.options) out[s.id] = { columns: s.columns, options: s.options };
  return out;
}

export interface KrKnowledgePaths {
  readonly interviewDir: string;
  readonly rulePackDir: string;
  /** Terms rule-pack directory; absent or without index.json means terms packs are pending. */
  readonly termsPackDir?: string;
}

/** Default layout under a repo root: `kb/jurisdictions/kr/...`. */
export function krPaths(repoRoot: string, rulePackVersion = "privacy-2026.04"): KrKnowledgePaths {
  const kr = join(repoRoot, "kb", "jurisdictions", "kr");
  return { interviewDir: join(kr, "interview"), rulePackDir: join(kr, "rulepacks", rulePackVersion), termsPackDir: join(kr, "rulepacks", "terms-kftc-10023") };
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function loadKrKnowledge(paths: KrKnowledgePaths): KrKnowledge {
  const template = InterviewTemplateSchema.parse(read(join(paths.interviewDir, "template-v1.json")));
  const slotsJson = read(join(paths.interviewDir, "slots.json"));
  const registry = slotRegistryFromJson(slotsJson);
  const unknown = templateUnknownSlots(template, registry);
  if (unknown.length > 0) throw new Error(`[KB] template references unknown slots: ${unknown.join(", ")}`);

  const index = z
    .looseObject({ packVersion: z.string(), sections: z.array(z.looseObject({ id: z.string(), file: z.string() })) })
    .parse(read(join(paths.rulePackDir, "index.json")));
  const items = index.sections.map((s) => parseRulePackItem(read(join(paths.rulePackDir, s.file))));
  if (!items.some((i) => i.id === "X1")) items.push(X1_ITEM);

  const termsPackAvailable = paths.termsPackDir !== undefined && existsSync(join(paths.termsPackDir, "index.json"));
  return { template, registry, slotHints: parseSlotHints(slotsJson), rulePackVersion: index.packVersion, rulePackItems: items, termsPackAvailable };
}
