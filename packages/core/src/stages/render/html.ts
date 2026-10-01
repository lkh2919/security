/** RDoc -> standalone accessible HTML (lang=ko, semantic headings, th scope, inline CSS, no scripts/assets). */
import type { RBlock, RDoc, RRun } from "./types";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function runHtml(run: RRun): string {
  const t = esc(run.text).replace(/\r?\n/g, "<br>");
  switch (run.kind) {
    case "unresolved":
      return `<mark class="unresolved">${t}</mark>`;
    case "cite":
      return `<cite class="cite">${t}</cite>`;
    case "link":
      return /^(https?:|mailto:|#)/.test(run.href ?? "") ? `<a href="${esc(run.href!)}">${t}</a>` : t;
    default:
      return run.strong ? `<strong>${t}</strong>` : t;
  }
}

export const runsHtml = (runs: readonly RRun[]): string => runs.map(runHtml).join("");

export function tableHtml(caption: string, header: readonly string[], rows: readonly (readonly string[])[]): string {
  return blockHtml({ t: "table", caption, header: [...header], rows: rows.map((r) => r.map((c): RRun[] => [{ kind: "text", text: c }])) });
}

function blockHtml(b: RBlock): string {
  switch (b.t) {
    case "para":
      return `<p>${runsHtml(b.runs)}</p>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((it) => `<li>${runsHtml(it)}</li>`).join("")}</${tag}>`;
    }
    case "table": {
      const head = b.header.map((h) => `<th scope="col">${esc(h)}</th>`).join("");
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${runsHtml(c)}</td>`).join("")}</tr>`).join("");
      return `<table><caption>${esc(b.caption)}</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    case "note":
      return `<aside class="note note-${b.kind}" role="note"><strong>${esc(b.label)}</strong> ${runsHtml(b.runs)}</aside>`;
  }
}

const CSS = `
:root{color-scheme:light;--fg:#1a1a1a;--muted:#555;--line:#888;--head:#eef1f5;--warn:#fff3cd;--bg:#fff}
*{box-sizing:border-box}
body{font-family:"Malgun Gothic","맑은 고딕","Noto Sans KR",sans-serif;color:var(--fg);background:var(--bg);line-height:1.7;max-width:52rem;margin:0 auto;padding:1.5rem 1rem}
h1{font-size:1.6rem;margin:0 0 .5rem}h2{font-size:1.2rem;margin:2rem 0 .75rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
nav ul{list-style:none;padding-left:0}nav li{margin:.2rem 0}
a{color:#0b4f9c}a:focus-visible{outline:3px solid #0b4f9c;outline-offset:2px}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.95rem}
caption{text-align:left;font-weight:bold;margin-bottom:.4rem}
th,td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:var(--head)}
.note{border-left:4px solid var(--line);background:#f7f7f7;padding:.5rem .8rem;margin:1rem 0}
.note-manual_review{background:var(--warn);border-color:#b58900}
.banner{background:var(--warn);border:2px solid #b58900;padding:.75rem 1rem;font-weight:bold}
mark.unresolved{background:#ffd6d6;color:#7a0000;font-weight:bold;padding:0 .2em}
footer{margin-top:3rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted);font-size:.85rem}
footer ul{padding-left:1.2rem}
@media print{body{max-width:none;padding:0}a{color:inherit;text-decoration:none}h2{break-after:avoid}table,aside{break-inside:avoid}}
@page{size:A4;margin:20mm}
`.trim();

export function docToHtml(doc: RDoc): string {
  const parts: string[] = [];
  parts.push(`<!DOCTYPE html>`, `<html lang="${doc.lang}">`, `<head>`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`);
  parts.push(`<title>${esc(doc.title)}</title>`, `<style>${CSS}</style>`, `</head>`, `<body>`, `<main>`);
  parts.push(`<header><h1>${esc(doc.title)}</h1>`);
  for (const s of doc.subtitle) parts.push(`<p>${esc(s)}</p>`);
  if (doc.banner) parts.push(`<p class="banner" role="alert">${esc(doc.banner)}</p>`);
  parts.push(`</header>`);
  if (doc.sections.length > 0) {
    parts.push(`<nav aria-labelledby="toc-title"><h2 id="toc-title">목차</h2><ul>`);
    for (const s of doc.sections) parts.push(`<li><a href="#${s.anchor}">${esc(s.heading)}</a></li>`);
    parts.push(`</ul></nav>`);
  }
  for (const s of doc.sections) {
    parts.push(`<section aria-labelledby="${s.anchor}"><h2 id="${s.anchor}">${esc(s.heading)}</h2>`);
    for (const b of s.blocks) parts.push(blockHtml(b));
    parts.push(`</section>`);
  }
  if (doc.changeHistory) {
    const c = doc.changeHistory;
    parts.push(`<section aria-labelledby="change-history"><h2 id="change-history">${esc(c.caption)}</h2>`, tableHtml(c.caption, c.header, c.rows), `</section>`);
  }
  parts.push(`</main>`, `<footer>`);
  if (doc.disclaimer) parts.push(`<p class="disclaimer">${esc(doc.disclaimer)}</p>`);
  if (doc.attribution) parts.push(`<p>${esc(doc.attribution)}</p>`);
  if (doc.stamps.length > 0) parts.push(`<ul>${doc.stamps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`);
  parts.push(`</footer>`, `</body>`, `</html>`);
  return parts.join("\n") + "\n";
}
