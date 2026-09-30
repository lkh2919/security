/**
 * Shared primitives for all data contracts (design R4).
 *
 * Every object schema in this package is strict: unknown keys are rejected, never stripped.
 * That is the structural basis for the AuditEnvelope allowlist (design R6.3).
 */
import { z } from "zod";

/** Masked evidence quotes and finding quotes are capped (design R4.3 / R4.5). */
export const MAX_QUOTE_LENGTH = 300;

/** Run identifier. Also used as a directory name, so path separators and dots are excluded. */
export const RunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/, "runId must be 3-64 chars of [A-Za-z0-9_-]");
export type RunId = z.infer<typeof RunIdSchema>;

/** Transcript segment ID such as `T0001`. */
export const SegmentIdSchema = z.string().regex(/^T\d{4,}$/, "segmentId must look like T0001");
export type SegmentId = z.infer<typeof SegmentIdSchema>;

/** Privacy item (S01..S24, A1, X1) or terms article (T01..T15). */
export const ItemIdSchema = z
  .string()
  .regex(/^(S\d{2}|T\d{2}|A1|X1)$/, "itemId must be S01..S24, T01..T15, A1 or X1");
export type ItemId = z.infer<typeof ItemIdSchema>;

export const DocTypeSchema = z.enum(["privacy", "terms"]);
export type DocType = z.infer<typeof DocTypeSchema>;

export const SeveritySchema = z.enum(["blocker", "major", "minor", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256");
export type Sha256 = z.infer<typeof Sha256Schema>;

/** ISO-8601 timestamp with offset, e.g. `2026-09-29T10:00:00.000Z`. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
/** Calendar date `YYYY-MM-DD`. */
export const IsoDateSchema = z.iso.date();

/** Semver-like version string used for prompts, rule packs and templates. */
export const VersionSchema = z.string().min(1).max(64);

export const NonEmptyString = z.string().min(1);

/** Any JSON value. Used for slot values whose shape is defined by the runtime slot registry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

// --- Slot identifiers -----------------------------------------------------------------------

/**
 * Syntactic shape of a slot ID: `<group>.<name>`, e.g. `gate.membership` or `privacy.S02_purposes`.
 * The concrete list of valid IDs is NOT hardcoded here; it comes from a `SlotRegistry`
 * (loaded at runtime from the Interview Template slot list).
 */
export const SLOT_ID_PATTERN = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/;
export const SlotIdSchema = z.string().regex(SLOT_ID_PATTERN, "slot id must look like group.name");
/** Plain string alias; membership is checked against a registry, not by the type system. */
export type SlotId = string;

export interface SlotDefinition {
  readonly id: SlotId;
  /** Registry-defined value type label (`yes_no`, `text`, `table`, ...). Informational. */
  readonly type: string;
  readonly itemRefs?: readonly string[];
  readonly desc?: string;
}

export interface SlotRegistry {
  readonly version: string;
  has(id: string): boolean;
  get(id: string): SlotDefinition | undefined;
  ids(): readonly SlotId[];
}

/** Error thrown when a registry is built from bad data. */
export class SlotRegistryError extends Error {}

export function createSlotRegistry(version: string, definitions: readonly SlotDefinition[]): SlotRegistry {
  const byId = new Map<string, SlotDefinition>();
  for (const def of definitions) {
    if (!SLOT_ID_PATTERN.test(def.id)) throw new SlotRegistryError(`invalid slot id shape: ${def.id}`);
    if (byId.has(def.id)) throw new SlotRegistryError(`duplicate slot id: ${def.id}`);
    byId.set(def.id, def);
  }
  const ids = [...byId.keys()].sort();
  return {
    version,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    ids: () => ids,
  };
}

/**
 * Parses the `slots.json` shape (`{ version, slots: [{ id, type, ... }] }`).
 * Extra per-slot keys (columns, pending, inR43, ...) are tolerated because the file is
 * authored outside this package; only the fields the registry needs are validated.
 */
const SlotRegistryFileSchema = z.looseObject({
  version: z.string().min(1),
  slots: z.array(z.looseObject({ id: SlotIdSchema, type: z.string().min(1), itemRefs: z.array(z.string()).optional(), desc: z.string().optional() })),
});

export function slotRegistryFromJson(json: unknown): SlotRegistry {
  const parsed = SlotRegistryFileSchema.parse(json);
  return createSlotRegistry(
    parsed.version,
    parsed.slots.map((s) => ({ id: s.id, type: s.type, itemRefs: s.itemRefs, desc: s.desc })),
  );
}

/** Schema accepting only slot IDs that exist in `registry`. */
export function slotIdSchemaFor(registry: SlotRegistry): z.ZodType<SlotId> {
  return SlotIdSchema.refine((id) => registry.has(id), { message: "unknown slot id (not in slot registry)" });
}

/** Returns the IDs in `ids` that the registry does not define. */
export function unknownSlotIds(registry: SlotRegistry, ids: Iterable<string>): string[] {
  const unknown = new Set<string>();
  for (const id of ids) if (!registry.has(id)) unknown.add(id);
  return [...unknown].sort();
}

// --- Conditions (Interview Template showIf/enterIf, clause conditions) -----------------------

export type Cond =
  | { always: true }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond }
  | { slot: SlotId; op: "eq" | "in" | "exists" | "truthy"; value?: JsonValue };

export const CondSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    /** Explicit "always". The legacy `{ all: [] }` spelling (used by rule packs) is still accepted and means the same. */
    z.strictObject({ always: z.literal(true) }),
    z.strictObject({ all: z.array(CondSchema) }),
    z.strictObject({ any: z.array(CondSchema).min(1) }),
    z.strictObject({ not: CondSchema }),
    z.strictObject({ slot: SlotIdSchema, op: z.enum(["eq", "in", "exists", "truthy"]), value: JsonValueSchema.optional() }),
  ]),
);

/** Collects every slot ID referenced by a condition tree. */
export function condSlotIds(cond: Cond): string[] {
  if ("always" in cond) return [];
  if ("all" in cond) return cond.all.flatMap(condSlotIds);
  if ("any" in cond) return cond.any.flatMap(condSlotIds);
  if ("not" in cond) return condSlotIds(cond.not);
  return [cond.slot];
}

// --- Warnings ---------------------------------------------------------------------------------

/** Non-blocking notice (special data types, manual-review placeholders, freshness drift). */
export const WarningSchema = z.strictObject({
  code: NonEmptyString,
  itemId: ItemIdSchema.optional(),
  kind: z.enum(["special_type", "manual_review", "freshness", "coverage", "other"]),
  message: NonEmptyString,
});
export type Warning = z.infer<typeof WarningSchema>;

/** Parses with a `[CONTRACT_ERROR]` diagnostic instead of a bare ZodError (zod-contract-gate). */
export class ContractError extends Error {
  constructor(
    readonly contract: string,
    readonly issues: readonly string[],
  ) {
    super(`[CONTRACT_ERROR] Invalid ${contract}: ${issues.join("; ")}`);
    this.name = "ContractError";
  }
}

export function parseContract<S extends z.ZodType>(contract: string, schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ContractError(
      contract,
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}
