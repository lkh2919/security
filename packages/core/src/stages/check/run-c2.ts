/**
 * C2 Deterministic Checker (design R6.2, layer 1): pre-output validation, code only, zero tokens.
 *
 * Checks (ids are stable, used by the auditor and Reviewer Sheet):
 *   structure : `structure.schema`, `structure.unresolved_syntax`, `structure.empty_sections`,
 *               `structure.mandatory_present`, `structure.conditional_handled`
 *   evidence  : `evidence.slot_refs`, `evidence.transcript_quotes`, `evidence.citations`, `evidence.repeated_values`
 *   style     : `style.house_style` (APPROVED regex rules only; candidates are never enforced)
 *   safety    : `safety.unfair_clauses` (terms), `safety.vague_recipients` (S07/S08/S09), `safety.disclaimer`
 *   cross_doc : `cross_doc.values_equal`
 *
 * The rule packs' `check.expr` pseudo-DSL targets a typed section model (`section.S05.rows`) that the block-based
 * SectionAST does not have, so the checks here are the generic, AST-native ones. LLM-only and structure-specific
 * rules stay with R7. Findings carry AST paths so drafters can fix only the flagged sections.
 */
import { DocASTSchema, type Block, type DocAST, type Inline } from "../../contracts/ast";
import type { Finding } from "../../contracts/audit-report";
import { CheckResultsSchema, type CheckResults } from "../../contracts/check-results";
import type { ApplicabilityMap } from "../../contracts/applicability";
import type { FactLedger } from "../../contracts/fact-ledger";
import { verifyTranscriptEvidence } from "../../contracts/fact-ledger";
import type { HouseStyleFile } from "../../contracts/house-style";
import type { MaskedTranscript } from "../../contracts/masked-transcript";
import type { Citation } from "../../contracts/statutes";
import type { RulePackItem } from "../coverage/load-kb";
import { findInconsistencies, ledgerValues, statedValues } from "./consistency";

export interface LexiconEntry {
  readonly id: string;
  readonly pattern: string;
  readonly severity: "blocker" | "major" | "minor" | "info";
  readonly sections?: readonly string[];
  readonly check?: string;
  readonly statuteRef?: readonly string[];
  readonly explanation_ko?: string;
  /** Regex sources: a sentence that matches `pattern` AND one of these is lawful wording and is not flagged. */
  readonly suppress?: readonly string[];
}

export interface C2Input {
  readonly runId: string;
  readonly docType: "privacy" | "terms";
  readonly ast: unknown;
  readonly ledger: FactLedger;
  readonly applicability: ApplicabilityMap;
  readonly rulePackItems: readonly RulePackItem[];
  readonly transcript: MaskedTranscript;
  /** Resolvable citations (legal-ref keys). Omitted -> `evidence.citations` fails every cite (nothing can be verified). */
  readonly citations?: readonly Citation[];
  readonly houseStyle?: HouseStyleFile;
  readonly lexicon?: readonly LexiconEntry[];
  /** The R8 renderer always appends the fixed disclaimer, so the AST needs none. Set false to require an AST disclaimer note. Default true. */
  readonly disclaimerByRenderer?: boolean;
  /** Cross-document values of this document and of the sibling (`org`, `minAge`, ...). Omitted -> check skipped. */
  readonly crossFacts?: { readonly own: Readonly<Record<string, string>>; readonly other: Readonly<Record<string, string>> };
  /**
   * `published`: a policy that is already live (Policy Monitor, design M5). There is no ledger, transcript, citation table or house style,
   * so only the checks that need none of them run: `structure.schema`, `structure.empty_sections`, `structure.mandatory_present`
   * (mandatory items only, applicability ignored) and `safety.vague_recipients`. The skipped checks are absent from the result, not
   * reported as passed. `ledger`, `applicability` and `transcript` are then unused (pass empty placeholders). Omitted -> unchanged behaviour.
   */
  readonly profile?: "published";
}

/** Checks the `published` profile does not run (see `C2Input.profile`). */
export const PUBLISHED_SKIPPED_CHECKS: ReadonlySet<string> = new Set([
  "structure.unresolved_syntax",
  "structure.blank_values",
  "structure.conditional_handled",
  "evidence.slot_refs",
  "evidence.transcript_quotes",
  "evidence.citations",
  "evidence.repeated_values",
  "style.house_style",
  "style.emphasis",
  "safety.unfair_clauses",
  "safety.disclaimer",
  "cross_doc.values_equal",
]);

interface Located {
  readonly path: string;
  readonly sectionIndex: number;
  readonly sectionId: string;
  readonly inline: Inline;
}

const VARIABLE_SYNTAX = /\{\{\s*[a-z][A-Za-z0-9_]*\s*\}\}|\{%[^%]*%\}/;

function* locate(ast: DocAST): Generator<Located> {
  for (let s = 0; s < ast.sections.length; s++) {
    const sec = ast.sections[s]!;
    for (let b = 0; b < sec.blocks.length; b++) {
      const block: Block = sec.blocks[b]!;
      const base = `sections[${s}].blocks[${b}]`;
      const at = (path: string, runs: readonly Inline[]): Located[] => runs.map((inline, k) => ({ path: `${path}[${k}]`, sectionIndex: s, sectionId: sec.id, inline }));
      if (block.t === "para" || block.t === "note") yield* at(`${base}.runs`, block.runs);
      else if (block.t === "list") for (let i = 0; i < block.items.length; i++) yield* at(`${base}.items[${i}]`, block.items[i]!);
      else for (let r = 0; r < block.rows.length; r++) for (let c = 0; c < block.rows[r]!.length; c++) yield* at(`${base}.rows[${r}][${c}]`, block.rows[r]![c]!);
    }
  }
}

const inlineText = (i: Inline): string => (i.t === "text" || i.t === "link" ? i.text : "");
const quote = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);

let counter = 0;
function finding(f: Omit<Finding, "id" | "layer" | "evidence"> & { astPath: string; quote: string }): Finding {
  counter += 1;
  const { astPath, quote: q, ...rest } = f;
  return { id: `C2-${String(counter).padStart(4, "0")}`, layer: "deterministic", evidence: { astPath, quote: quote(q) }, ...rest };
}

/** Sentences/cells as checked units: one per paragraph, list item and table cell. */
function* units(ast: DocAST): Generator<{ path: string; sectionId: string; text: string; cellIndex?: number; isNote?: boolean }> {
  for (let s = 0; s < ast.sections.length; s++) {
    const sec = ast.sections[s]!;
    for (let b = 0; b < sec.blocks.length; b++) {
      const block = sec.blocks[b]!;
      const base = `sections[${s}].blocks[${b}]`;
      const join = (runs: readonly Inline[]): string => runs.map(inlineText).join("");
      if (block.t === "para" || block.t === "note") yield { path: `${base}.runs`, sectionId: sec.id, text: join(block.runs), ...(block.t === "note" ? { isNote: true } : {}) };
      else if (block.t === "list") for (let i = 0; i < block.items.length; i++) yield { path: `${base}.items[${i}]`, sectionId: sec.id, text: join(block.items[i]!) };
      else for (let r = 0; r < block.rows.length; r++) for (let c = 0; c < block.rows[r]!.length; c++) yield { path: `${base}.rows[${r}][${c}]`, sectionId: sec.id, text: join(block.rows[r]![c]!), cellIndex: c };
    }
  }
}

export function runC2(input: C2Input): CheckResults {
  counter = 0; // finding ids restart per call so equal inputs give equal results (and equal envelope hashes)
  const { docType } = input;
  const published = input.profile === "published";
  const outcomes: CheckResults["checks"] = [];
  const add = (checkId: string, category: CheckResults["checks"][number]["category"], findings: Finding[]): void => {
    if (published && PUBLISHED_SKIPPED_CHECKS.has(checkId)) return;
    outcomes.push({ checkId, category, passed: findings.length === 0, findings });
  };

  const parsed = DocASTSchema.safeParse(input.ast);
  if (!parsed.success || parsed.data.docType !== docType) {
    const msg = parsed.success ? `document is ${parsed.data.docType}, expected ${docType}` : parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    add("structure.schema", "structure", [finding({ ruleId: "C2-SCHEMA", docType, sectionId: "-", severity: "blocker", message: `AST is invalid: ${msg}`, fixHint: "Produce a schema-valid SectionAST.", astPath: "$", quote: "" })]);
    return CheckResultsSchema.parse({ runId: input.runId, docType, passed: false, checks: outcomes });
  }
  const ast: DocAST = parsed.data;
  add("structure.schema", "structure", []);

  // --- structure ---------------------------------------------------------------------------------
  const syntax: Finding[] = [];
  for (const l of locate(ast)) {
    const text = inlineText(l.inline);
    if (VARIABLE_SYNTAX.test(text)) syntax.push(finding({ ruleId: "C2-SYNTAX", docType, sectionId: l.sectionId, severity: "major", message: "Unresolved clause syntax ({{var}} or {%...%}) remains in the output.", fixHint: "Render the clause with the ledger or redraft the section.", astPath: l.path, quote: text }));
  }
  add("structure.unresolved_syntax", "structure", syntax);

  // A value the drafter left out mid-sentence ("반복하거나  이내에", "○○일", "( )"), or a Latin fragment glued inside a Korean word
  // ("공serv 양속"): both reach readers as broken text.
  const blanks: Finding[] = [];
  for (const u of units(ast)) {
    const blank = /\S\s{2,}(이내|일|개월|년|원|회|%)/u.test(u.text) || /[○◯]{1,3}\s*(일|개월|년|원|회|%)|\(\s*\)|\[\s*\]/u.test(u.text);
    const garbled = /[가-힣][a-z]{2,}(?=[\s가-힣])/u.test(u.text);
    const slotKey = /\b(profile|gate|privacy|terms)\.[A-Za-z][A-Za-z0-9_]*\b/.test(u.text);
    if (slotKey) blanks.push(finding({ ruleId: "C2-BLANK", docType, sectionId: u.sectionId, severity: "major", message: "An internal slot id appears in reader-facing text.", fixHint: "Write the fact itself, or a manual-review note naming what is missing; never the slot id.", astPath: u.path, quote: u.text }));
    if (blank || garbled) blanks.push(finding({ ruleId: "C2-BLANK", docType, sectionId: u.sectionId, severity: blank ? "major" : "minor", message: blank ? "A value is missing in the middle of a sentence (blank placeholder)." : "Garbled text: Latin letters inside a Korean word.", fixHint: blank ? "State the value from the facts, or drop it and add a manual-review note naming the missing value." : "Rewrite the word.", astPath: u.path, quote: u.text }));
  }
  add("structure.blank_values", "structure", blanks);

  const empty: Finding[] = [];
  ast.sections.forEach((sec, i) => {
    if ((sec.status === "drafted" || sec.status === "not_processed_statement" || sec.status === "manual_review") && sec.blocks.length === 0) {
      empty.push(finding({ ruleId: "C2-EMPTY", docType, sectionId: sec.id, severity: "major", message: `Section ${sec.id} has status ${sec.status} but no content.`, fixHint: "Draft the section or set an honest status.", astPath: `sections[${i}]`, quote: sec.title }));
    }
  });
  add("structure.empty_sections", "structure", empty);

  const present = new Map(ast.sections.map((s, i) => [s.id, { section: s, index: i }]));
  const mandatory: Finding[] = [];
  const conditional: Finding[] = [];
  const prefix = docType === "privacy" ? /^(S\d{2}|A1|X1)$/ : /^T\d{2}$/;
  if (published || input.applicability.documents[docType].applicable) {
    for (const item of input.rulePackItems.filter((i) => prefix.test(i.id))) {
      const state = published ? "yes" : input.applicability.items[item.id]?.state;
      const hit = present.get(item.id);
      const usable = hit && hit.section.status !== "not_applicable" && hit.section.status !== "omitted_recommended";
      if (item.classification === "mandatory" && state === "yes" && !usable) {
        mandatory.push(finding({ ruleId: `C2-M-${item.id}`, docType, sectionId: item.id, severity: "blocker", message: `Mandatory item ${item.id} (${item.title}) is missing or marked not applicable.`, fixHint: "Draft the mandatory section.", astPath: "sections", quote: item.title }));
      }
      if (item.classification === "conditional") {
        if (state === "yes" && !usable) conditional.push(finding({ ruleId: `C2-C-${item.id}`, docType, sectionId: item.id, severity: "major", message: `Conditional item ${item.id} applies but is not drafted.`, fixHint: "Draft the section.", astPath: "sections", quote: item.title }));
        if (state === "unknown" && hit?.section.status === "drafted") conditional.push(finding({ ruleId: `C2-C-${item.id}`, docType, sectionId: item.id, severity: "major", message: `Conditional item ${item.id} has an unknown gate; it must be manual_review, not drafted as fact.`, fixHint: "Set status manual_review with a manual-review note.", astPath: `sections[${hit.index}]`, quote: hit.section.title }));
      }
    }
  }
  add("structure.mandatory_present", "structure", mandatory);
  add("structure.conditional_handled", "structure", conditional);

  // --- evidence ----------------------------------------------------------------------------------
  const refs: Finding[] = [];
  for (const l of locate(ast)) {
    if (l.inline.t !== "text" || !l.inline.slotRef) continue;
    if (l.inline.slotRef === "document.effectiveDate") continue; // the payload's `document.effectiveDate`: the operator's confirmed date (meta)
    const e = input.ledger.slots[l.inline.slotRef];
    if (!e || (e.status !== "filled" && e.status !== "not_applicable")) {
      refs.push(finding({ ruleId: "C2-SLOTREF", docType, sectionId: l.sectionId, severity: "major", message: `slotRef ${l.inline.slotRef} is not a filled slot in the fact ledger.`, fixHint: "Ask the missing question or mark the statement for manual review.", astPath: l.path, quote: l.inline.text }));
    }
  }
  add("evidence.slot_refs", "evidence", refs);

  add(
    "evidence.transcript_quotes",
    "evidence",
    verifyTranscriptEvidence(input.ledger, input.transcript).map((p) => finding({ ruleId: "C2-EVIDENCE", docType, sectionId: "-", severity: "major", message: `Ledger evidence does not hold: ${p}`, fixHint: "Re-extract the slot from the transcript.", astPath: "$", quote: p })),
  );

  const known = new Map((input.citations ?? []).map((c) => [c.citationId, c]));
  const cites: Finding[] = [];
  for (const l of locate(ast)) {
    if (l.inline.t !== "cite") continue;
    if (!known.has(l.inline.citationId)) {
      cites.push(finding({ ruleId: "C2-CITE", docType, sectionId: l.sectionId, severity: "major", message: `Citation ${l.inline.citationId} does not resolve in the verified citation table.`, fixHint: "Use a citationId from citations.json or remove the citation.", astPath: l.path, quote: l.inline.citationId }));
    }
  }
  add("evidence.citations", "evidence", cites);

  // --- style (approved regex rules only) ---------------------------------------------------------
  const style: Finding[] = [];
  const docText = [...units(ast)].map((u) => u.text).join("\n");
  for (const r of input.houseStyle?.rules ?? []) {
    if (r.status !== "approved" || r.checkType !== "regex" || !r.pattern || (r.scope !== docType && r.scope !== "both")) continue;
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, "mu");
    } catch {
      style.push(finding({ ruleId: r.id, docType, sectionId: "-", severity: "major", message: `House-style rule ${r.id} has an invalid pattern and cannot be checked.`, fixHint: "Fix the pattern in the house-style file.", astPath: "$", quote: "" }));
      continue;
    }
    const hit = re.test(docText);
    const violated = r.patternMode === "forbid" ? hit : !hit;
    if (violated) style.push(finding({ ruleId: r.id, docType, sectionId: "-", severity: "minor", message: `House-style rule ${r.id} is violated: ${r.rule}`, fixHint: r.rule, astPath: "$", quote: "" }));
  }
  add("style.house_style", "style", style);

  // --- safety ------------------------------------------------------------------------------------
  const unfair: Finding[] = [];
  if (docType === "terms") {
    for (const entry of input.lexicon ?? []) {
      if (entry.severity === "info" || entry.check === "llm") continue; // routed to R7
      const re = new RegExp(entry.pattern, "u");
      const suppress = (entry.suppress ?? []).map((p) => new RegExp(p, "u"));
      for (const u of units(ast)) {
        if (u.isNote) continue; // manual-review and disclaimer notes are reviewer text, not clauses
        if (entry.sections && !entry.sections.includes(u.sectionId)) continue;
        for (const sentence of u.text.split(/(?<=[.다])\s+/)) {
          if (re.test(sentence) && !suppress.some((x) => x.test(sentence))) unfair.push(finding({ ruleId: entry.id, docType, sectionId: u.sectionId, severity: entry.severity, message: `Unfair-clause pattern ${entry.id} matched${entry.statuteRef?.length ? ` (${entry.statuteRef.join(", ")})` : ""}.`, fixHint: entry.explanation_ko ?? "Rewrite the clause so it does not exclude or shift liability without a substantial reason.", astPath: u.path, quote: sentence }));
        }
      }
    }
  }
  add("safety.unfair_clauses", "safety", unfair);

  // ARTC 3(1) / R-T01-002: withdrawal and refund content must stand out. Checked where it is certain to exist (a drafted T10).
  const emphasis: Finding[] = [];
  if (docType === "terms") {
    const t10 = ast.sections.findIndex((x) => x.id === "T10" && x.status === "drafted");
    if (t10 >= 0 && ![...locate(ast)].some((l) => l.sectionIndex === t10 && l.inline.t === "text" && l.inline.strong)) {
      emphasis.push(finding({ ruleId: "R-T01-002", docType, sectionId: "T10", severity: "major", message: "Withdrawal and refund conditions are not visually distinct (no bold text in T10).", fixHint: "Mark the operative withdrawal and refund sentences as strong.", astPath: `sections[${t10}]`, quote: ast.sections[t10]!.title }));
    }
  }
  add("style.emphasis", "style", emphasis);

  const vague: Finding[] = [];
  for (const u of units(ast)) {
    if (!["S07", "S08", "S09"].includes(u.sectionId) || u.cellIndex !== 0) continue;
    if (/(?:^|[^가-힣])등(?:$|[^가-힣])|외\s*\d*\s*(?:개)?사|등\s*\d+\s*개사/u.test(u.text)) {
      vague.push(finding({ ruleId: u.sectionId === "S09" ? "R-S09-002" : "R-S07-003", docType, sectionId: u.sectionId, severity: "major", message: "A recipient or processor is abbreviated (\"등\"); each must be named.", fixHint: "Name every recipient or processor, or link a full list where the rule allows it.", astPath: u.path, quote: u.text }));
    }
  }
  add("safety.vague_recipients", "safety", vague);

  const hasDisclaimer = input.disclaimerByRenderer !== false || ast.sections.some((s) => s.blocks.some((b) => b.t === "note" && b.kind === "disclaimer"));
  add("safety.disclaimer", "safety", hasDisclaimer ? [] : [finding({ ruleId: "C2-DISCLAIMER", docType, sectionId: "-", severity: "major", message: "The mandatory reference-draft disclaimer block is missing.", fixHint: "Add a disclaimer note block.", astPath: "sections", quote: "" })]);

  // A period stated in two articles (rejoin wait, terms-change notice) must be the same, and match the confirmed facts.
  const repeated: Finding[] = findInconsistencies(statedValues(ast), ledgerValues(input.ledger, `${docType}.`)).map(({ stated: v, expected, source }) =>
    finding({
      ruleId: "C2-CONSISTENCY",
      docType,
      sectionId: v.sectionId,
      severity: "major",
      message:
        source === "ledger"
          ? `${v.label}: this article states ${v.value}, the confirmed facts state ${expected}.`
          : `${v.label}: this article states ${v.value}, ${source.join(", ")} state${source.length > 1 ? "" : "s"} ${expected}.`,
      fixHint: source === "ledger" ? `State ${expected} as in the confirmed facts.` : `Use the same value as ${source.join(", ")}, or refer to that article by its title instead of restating it.`,
      astPath: v.path,
      quote: v.sentence,
    }),
  );
  add("evidence.repeated_values", "evidence", repeated);

  // --- cross-document ----------------------------------------------------------------------------
  if (input.crossFacts) {
    const cross: Finding[] = [];
    const { own, other } = input.crossFacts;
    for (const key of Object.keys(own).filter((k) => k in other).sort()) {
      const a = own[key]!.trim();
      const b = other[key]!.trim();
      // A name may be embedded in a longer run ("<org> 개인정보 처리방침"): containment counts as the same value.
      const same = a === b || (key === "org" && (a.includes(b) || b.includes(a)));
      if (!same) cross.push(finding({ ruleId: key === "org" ? "X-01" : key === "minAge" ? "X-02" : `X-${key}`, docType, sectionId: "-", severity: "major", message: `Cross-document value "${key}" differs: "${own[key]}" vs "${other[key]}".`, fixHint: "Use one value in both documents.", astPath: "$", quote: `${own[key]} | ${other[key]}` }));
    }
    add("cross_doc.values_equal", "cross_doc", cross);
  }

  return CheckResultsSchema.parse({ runId: input.runId, docType, passed: outcomes.every((c) => c.passed), checks: outcomes });
}

/**
 * Cross-document facts as the document STATES them (text carrying the slotRef, and the stated minimum age in T06), and as the
 * ledger records them. The check compares the two: a document that says something else than the ledger is inconsistent.
 */
export function statedFacts(ast: DocAST): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const sec of ast.sections) {
    for (const block of sec.blocks) {
      const runs: Inline[] = block.t === "para" || block.t === "note" ? block.runs : block.t === "list" ? block.items.flat() : block.rows.flat(2);
      for (const r of runs) {
        if (r.t === "text" && r.slotRef === "profile.orgNameRef" && !("org" in facts)) facts["org"] = r.text.trim();
        if (r.t === "text" && r.slotRef === "terms.minAge" && !("minAge" in facts)) facts["minAge"] = r.text.replace(/\D/g, "");
      }
      if (sec.id === "T06" && !("minAge" in facts)) {
        const text = runs.map(inlineText).join("");
        const m = /만\s*(\d{1,2})\s*세\s*이상/.exec(text);
        if (m) facts["minAge"] = m[1]!;
      }
    }
  }
  return facts;
}

export function ledgerFacts(ledger: Pick<FactLedger, "slots">): Record<string, string> {
  const facts: Record<string, string> = {};
  const org = ledger.slots["profile.orgNameRef"];
  if (org?.status === "filled" && typeof org.value === "string") facts["org"] = org.value.trim();
  const age = ledger.slots["terms.minAge"];
  if (age?.status === "filled" && (typeof age.value === "number" || typeof age.value === "string")) facts["minAge"] = String(age.value).replace(/\D/g, "");
  return facts;
}

/** `crossFacts` input for C2: what the document states versus what the ledger records. */
export function crossFactsFor(ast: DocAST, ledger: Pick<FactLedger, "slots">): NonNullable<C2Input["crossFacts"]> {
  return { own: statedFacts(ast), other: ledgerFacts(ledger) };
}
