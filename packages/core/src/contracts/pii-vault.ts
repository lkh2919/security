/**
 * PiiVault: placeholder -> real value map. LOCAL ONLY.
 *
 * Structural rule (design R3, R17): no LLM-facing contract (FactLedger, MaskedTranscript,
 * AuditEnvelope, ...) imports or references this module. Only R1 (writer) and R8 (rehydration)
 * use it. `findVaultLeaks` is the runtime backstop used by `MockLlmClient` and the real client
 * before a payload leaves the process.
 */
import { z } from "zod";
import { NonEmptyString, RunIdSchema } from "./common";
import { PlaceholderKeySchema } from "./masked-transcript";

export const PiiVaultSchema = z.strictObject({
  runId: RunIdSchema,
  entries: z.record(PlaceholderKeySchema, z.strictObject({ kind: NonEmptyString, value: NonEmptyString })),
});
export type PiiVault = z.infer<typeof PiiVaultSchema>;

/** Values shorter than this are ignored by the leak scan to avoid false positives (e.g. "A"). */
const MIN_LEAK_VALUE_LENGTH = 2;

/**
 * Returns the placeholder keys whose real value appears anywhere in `payload`
 * (searched in its JSON serialization, and in raw strings). Empty array means clean.
 */
export function findVaultLeaks(payload: unknown, vault: PiiVault): string[] {
  const haystack = typeof payload === "string" ? payload : JSON.stringify(payload) ?? "";
  const leaks: string[] = [];
  for (const [key, entry] of Object.entries(vault.entries)) {
    if (entry.value.length < MIN_LEAK_VALUE_LENGTH) continue;
    // Search both the raw value and its JSON-escaped form (quotes, backslashes, unicode escapes).
    const escaped = JSON.stringify(entry.value).slice(1, -1);
    if (haystack.includes(entry.value) || haystack.includes(escaped)) leaks.push(key);
  }
  return leaks.sort();
}

/** Replaces `{{KEY}}` placeholders with vault values (used by the local renderer only). */
export function rehydrate(text: string, vault: PiiVault): string {
  return text.replace(/\{\{([A-Z][A-Z0-9_]*_\d+)\}\}/g, (whole, key: string) => vault.entries[key]?.value ?? whole);
}
