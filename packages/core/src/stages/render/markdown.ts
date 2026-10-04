/** RDoc -> Markdown. Anchors use explicit `<a id>` so TOC links resolve on any renderer. */
import type { RBlock, RDoc, RRun } from "./types";

function runMd(run: RRun, inTable: boolean): string {
  let t = run.text.replace(/\r?\n/g, inTable ? "<br>" : "  \n");
  if (inTable) t = t.replace(/\|/g, "\\|");
  switch (run.kind) {
    case "unresolved":
      return `**${t}**`;
    case "link":
      return /^(https?:|mailto:|#)/.test(run.href ?? "") ? `[${t}](${run.href})` : t;
    default:
      if (!run.strong || !t.trim()) return t;
      {
        // CommonMark: the markers must hug non-space text, so leading/trailing spaces stay outside.
        const lead = t.match(/^\s*/)![0];
        const trail = t.match(/\s*$/)![0];
        return `${lead}**${t.trim()}**${trail}`;
      }
  }
}

/** Adjacent strong text runs are merged first, so the output never contains "****". */
function mergeStrong(runs: readonly RRun[]): RRun[] {
  const out: RRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "text" && r.kind === "text" && prev.strong && r.strong) out[out.length - 1] = { ...prev, text: prev.text + r.text };
    else out.push(r);
  }
  return out;
}

export const runsMd = (runs: readonly RRun[], inTable = false): string => mergeStrong(runs).map((r) => runMd(r, inTable)).join("");

export function tableMd(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  return [`| ${header.map(esc).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)];
}

function blockMd(b: RBlock): string {
  switch (b.t) {
    case "para":
      return runsMd(b.runs);
    case "list":
      return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : "-"} ${runsMd(it)}`).join("\n");
    case "table": {
      const lines = [`**${b.caption}**`, ""];
      lines.push(`| ${b.header.join(" | ")} |`, `| ${b.header.map(() => "---").join(" | ")} |`);
      for (const row of b.rows) lines.push(`| ${row.map((c) => runsMd(c, true)).join(" | ")} |`);
      return lines.join("\n");
    }
    case "note":
      return `> **${b.label}** ${runsMd(b.runs)}`;
  }
}

export function docToMarkdown(doc: RDoc): string {
  const out: string[] = [`# ${doc.title}`, ""];
  for (const s of doc.subtitle) out.push(s, "");
  if (doc.banner) out.push(`> **${doc.banner}**`, "");
  if (doc.sections.length > 0) {
    out.push("## 목차", "");
    for (const s of doc.sections) out.push(`- [${s.heading}](#${s.anchor})`);
    out.push("");
  }
  for (const s of doc.sections) {
    out.push(`<a id="${s.anchor}"></a>`, "", `## ${s.heading}`, "");
    for (const b of s.blocks) out.push(blockMd(b), "");
  }
  if (doc.changeHistory) {
    out.push(`## ${doc.changeHistory.caption}`, "", ...tableMd(doc.changeHistory.header, doc.changeHistory.rows), "");
  }
  out.push("---", "");
  if (doc.disclaimer) out.push(`> ${doc.disclaimer}`, "");
  if (doc.attribution) out.push(doc.attribution, "");
  if (doc.stamps.length > 0) {
    out.push("<sub>", "");
    for (const st of doc.stamps) out.push(`- ${st}`);
    out.push("", "</sub>", "");
  }
  return out.join("\n");
}
