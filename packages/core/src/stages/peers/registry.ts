/**
 * Peer registry and capture index loading, and the fetch targets derived from them (design C5): the active peers of each group
 * plus the Lotte captures listed in `groups[].lotte`. Only the exact URLs of the files are used.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PeerRegistrySchema, type PeerRegistry } from "../../contracts/peers";

export const CaptureEntrySchema = z.looseObject({
  id: z.string(),
  site: z.string().optional(),
  /** A URL, or a URL followed by a note ("... (footer button, in-page modal)") for pages without a direct address. */
  url: z.string().nullable().optional(),
  fetchUrl: z.string().nullable().optional(),
  capture: z.string().optional(),
  docType: z.string().optional(),
});
export type CaptureEntry = z.infer<typeof CaptureEntrySchema>;
export const CaptureIndexSchema = z.looseObject({ captures: z.array(CaptureEntrySchema) });

function readJson(file: string, tag: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`[${tag}] ${file} is not readable JSON: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`);
  }
}

export function loadPeerRegistry(file: string): PeerRegistry {
  const r = PeerRegistrySchema.safeParse(readJson(file, "PEER_REGISTRY"));
  if (!r.success) throw new Error(`[PEER_REGISTRY] ${file} is invalid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

export function loadCaptureIndex(file: string): CaptureEntry[] {
  const r = CaptureIndexSchema.safeParse(readJson(file, "CAPTURE_INDEX"));
  if (!r.success) throw new Error(`[CAPTURE_INDEX] ${file} is invalid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data.captures;
}

export interface PeerTarget {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly kind: "peer" | "lotte";
  readonly url: string;
  readonly render: "html" | "browser";
}

export interface SkippedTarget {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly kind: "peer" | "lotte";
  readonly reason: string;
}

export interface TargetOptions {
  readonly group?: string;
  /** At most this many targets are fetched (peers first within each group). */
  readonly limit?: number;
  /** Include the Lotte captures of each group (default true). The standalone `peers` command leaves them to the daily chain. */
  readonly includeLotte?: boolean;
}

const DIRECT_URL = /^https?:\/\/\S+$/;

export function buildTargets(registry: PeerRegistry, captures: readonly CaptureEntry[], opts: TargetOptions = {}): { targets: PeerTarget[]; skipped: SkippedTarget[] } {
  const groups = opts.group ? registry.groups.filter((g) => g.groupId === opts.group) : registry.groups;
  if (opts.group && groups.length === 0) throw new Error(`[PEER_REGISTRY] unknown group "${opts.group}" (groups: ${registry.groups.map((g) => g.groupId).join(", ")})`);
  const byId = new Map(captures.map((c) => [c.id, c]));
  const targets: PeerTarget[] = [];
  const skipped: SkippedTarget[] = [];
  for (const g of groups) {
    for (const p of g.peers) {
      const base = { id: p.peerId, groupId: g.groupId, name: p.name, kind: "peer" as const };
      if (p.status !== "active") skipped.push({ ...base, reason: `status_${p.status}` });
      else if (p.render === "pdf" || p.render === "unknown") skipped.push({ ...base, reason: `render_${p.render}: manual capture needed` });
      else targets.push({ ...base, url: p.url, render: p.render === "js_required" ? "browser" : "html" });
    }
    for (const id of opts.includeLotte === false ? [] : g.lotte) {
      const c = byId.get(id);
      const base = { id, groupId: g.groupId, name: c?.site ?? id, kind: "lotte" as const };
      const url = (c?.fetchUrl ?? c?.url ?? "").trim();
      if (!c) skipped.push({ ...base, reason: "capture_not_found" });
      else if (!DIRECT_URL.test(url)) skipped.push({ ...base, reason: "capture_url_not_direct: no direct policy URL (modal or button), manual capture needed" });
      else targets.push({ ...base, url, render: registry.lotteFetch[id] === "browser" ? "browser" : "html" });
    }
  }
  return { targets: opts.limit !== undefined ? targets.slice(0, Math.max(0, opts.limit)) : targets, skipped };
}
