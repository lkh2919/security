/**
 * R8 Renderer: intermediate resolved document model (design R3 row R8).
 * The AST is resolved once (placeholders rehydrated, citations formatted) into this neutral tree;
 * the Markdown, HTML and DOCX writers only walk this tree, so all three formats carry the same content.
 */
import type { PiiVault } from "../../contracts/pii-vault";

export interface ChangeHistoryEntry {
  readonly date: string;
  readonly version: string;
  readonly summary: string;
}

export interface CitationEntry {
  readonly law: string;
  /** Display article, e.g. `제30조` or `제25조의2`. */
  readonly article: string;
}

export interface RenderOptions {
  /** Local-only PII map. Used at render time and never logged. */
  readonly vault?: PiiVault;
  /** Optional `citations.json` lookup (citationId -> law/article). Built-in abbreviations are the fallback. */
  readonly citations?: Readonly<Record<string, CitationEntry>>;
  /** ISO timestamp for the footer. Omitted -> no timestamp line, so output is fully deterministic. */
  readonly generatedAt?: string;
  /** PIPC guideline edition stamped in the footer and attribution line. Default `2026.4`. */
  readonly guidelineVersion?: string;
  readonly organizationName?: string;
  /** `true` -> default "DRAFT — unresolved findings" banner; a string -> custom banner text. */
  readonly draftBanner?: boolean | string;
  readonly changeHistory?: readonly ChangeHistoryEntry[];
}

export type RRunKind = "text" | "cite" | "link" | "unresolved";
export interface RRun {
  readonly text: string;
  readonly kind: RRunKind;
  readonly href?: string;
  /** Bold emphasis for important content. */
  readonly strong?: boolean;
}

export type RBlock =
  | { readonly t: "para"; readonly runs: RRun[] }
  | { readonly t: "list"; readonly ordered: boolean; readonly items: RRun[][] }
  | { readonly t: "table"; readonly caption: string; readonly header: string[]; readonly rows: RRun[][][] }
  | { readonly t: "note"; readonly kind: "info" | "manual_review" | "freshness" | "disclaimer"; readonly label: string; readonly runs: RRun[] };

export interface RSection {
  readonly id: string;
  readonly anchor: string;
  /** Numbered heading text, e.g. `3. 개인정보의 처리 및 보유 기간` or `제3조 (약관의 게시)`. */
  readonly heading: string;
  readonly blocks: RBlock[];
}

export interface RDoc {
  readonly lang: "ko";
  readonly title: string;
  /** Short lines under the title (effective date, ...). */
  readonly subtitle: string[];
  readonly banner?: string;
  readonly sections: RSection[];
  readonly changeHistory?: { readonly caption: string; readonly header: string[]; readonly rows: string[][] };
  readonly disclaimer?: string;
  readonly attribution?: string;
  /** Footer version-stamp lines (`label: value`). */
  readonly stamps: string[];
}

export function plain(runs: readonly RRun[]): string {
  return runs.map((r) => r.text).join("");
}
