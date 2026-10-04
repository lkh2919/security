/**
 * Resolving the two law versions of a historical comparison (`scripts/peer-history.ts`).
 *
 * The previous version of a law is found from its version list (law.go.kr `lawSearch target=eflaw&LID=<법령ID>&nw=1,2,3`, which lists
 * 현행, 연혁 and 시행예정 versions; a version appears once per effective date): the distinct versions sorted by promulgation date,
 * the one just before the new version's promulgation. Example (PIPA, 법령ID 011357): MST 283839 (공포 2026-03-10, 공포번호 21445,
 * 시행 2026-09-11) follows MST 270351 (공포 2025-04-01, 공포번호 20897, 시행 2025-10-02).
 */
import type { LawVersion } from "../../adapters/lawapi";
import type { AmendmentDiff } from "../../contracts/amendment-diff";
import { diffArticles, parseLawXml } from "../monitor/article-diff";

/** What the resolution needs from the law API (LawApiClient implements it; tests inject a fake). */
export interface LawVersionsPort {
  listAllVersions(lawId: string): Promise<LawVersion[]>;
  getFullTextXml(mst: string): Promise<string>;
}

export interface ResolvedAmendment {
  readonly diff: AmendmentDiff;
  readonly oldMst: string;
  readonly newMst: string;
  readonly promulgatedOn: string | null;
  readonly promulgationNo: string;
  /** How the previous version was found (documented in the report). */
  readonly howFound: string;
}

/** Distinct versions (one per MST), oldest promulgation first. `effectiveOn` is the earliest effective date of the MST. */
export function distinctVersions(rows: readonly LawVersion[]): LawVersion[] {
  const byMst = new Map<string, LawVersion>();
  for (const r of rows) {
    if (!r.mst) continue;
    const cur = byMst.get(r.mst);
    if (!cur || (r.effectiveOn ?? "9999") < (cur.effectiveOn ?? "9999")) byMst.set(r.mst, r);
  }
  return [...byMst.values()].sort((a, b) => (a.promulgatedOn ?? "").localeCompare(b.promulgatedOn ?? "") || (a.effectiveOn ?? "").localeCompare(b.effectiveOn ?? ""));
}

/** The version promulgated just before `newMst`, or null. */
export function previousVersionOf(rows: readonly LawVersion[], newMst: string): LawVersion | null {
  const list = distinctVersions(rows);
  const i = list.findIndex((v) => v.mst === newMst);
  return i > 0 ? list[i - 1]! : null;
}

export interface ResolveInput {
  /** Code used in the unit keys (`PIPA`). */
  readonly law: string;
  readonly lawId: string;
  readonly newMst: string;
  readonly oldMst?: string;
  /** Effective date of the new version; default: the earliest one in the version list. */
  readonly effectiveOn?: string | null;
}

export async function resolveAmendment(port: LawVersionsPort, i: ResolveInput): Promise<ResolvedAmendment> {
  const rows = await port.listAllVersions(i.lawId);
  const list = distinctVersions(rows);
  const next = list.find((v) => v.mst === i.newMst);
  let oldMst = i.oldMst;
  let howFound = `--old-mst ${i.oldMst} (given)`;
  if (!oldMst) {
    const prev = previousVersionOf(rows, i.newMst);
    if (!prev) throw new Error(`[PEER_HISTORY] no version of law ${i.lawId} before MST ${i.newMst} in the law.go.kr version list; pass --old-mst`);
    oldMst = prev.mst;
    howFound = `lawSearch target=eflaw LID=${i.lawId} nw=1,2,3 (현행·연혁·시행예정): the version promulgated before MST ${i.newMst} is MST ${prev.mst} (공포 ${prev.promulgatedOn ?? "?"}, 공포번호 ${prev.promulgationNo}, 시행 ${prev.effectiveOn ?? "?"})`;
  }
  const effectiveOn = i.effectiveOn !== undefined ? i.effectiveOn : (next?.effectiveOn ?? null);
  const [oldXml, newXml] = [await port.getFullTextXml(oldMst), await port.getFullTextXml(i.newMst)];
  const diff = diffArticles(i.law, parseLawXml(oldXml), parseLawXml(newXml), { oldVersion: oldMst, newVersion: i.newMst, effectiveOn });
  return { diff, oldMst, newMst: i.newMst, promulgatedOn: next?.promulgatedOn ?? null, promulgationNo: next?.promulgationNo ?? "", howFound };
}
