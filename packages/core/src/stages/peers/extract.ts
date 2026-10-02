/**
 * Element extraction for in-page policy versions (history fetch modes `anchor`): the outer HTML of one element of a served page, found by
 * id (the URL fragment) or by a simple selector. No DOM dependency: a tag scanner with an element stack.
 *
 * Selector grammar: compound selectors `tag`, `#id`, `.class`, `tag.class.class2#id`, chained by spaces (descendant). First match in document order.
 */

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "source", "track", "wbr", "param"]);
const RAW_TEXT = new Set(["script", "style"]);
const IMPLIED_END: Readonly<Record<string, readonly string[]>> = { li: ["li"], p: ["p"], dt: ["dt", "dd"], dd: ["dt", "dd"], td: ["td", "th"], th: ["td", "th"], tr: ["tr"] };
const TAG = /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

interface Compound {
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
}

export function parseSelector(selector: string): Compound[] {
  const out: Compound[] = [];
  for (const part of selector.trim().split(/\s+/)) {
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:[#.][A-Za-z0-9_:-]+)*)$/.exec(part);
    if (!m || part === "") throw new Error(`unsupported selector "${selector}" (tag, #id, .class and descendant chains only)`);
    let id: string | undefined;
    const classes: string[] = [];
    for (const x of m[2]!.match(/[#.][A-Za-z0-9_:-]+/g) ?? []) {
      if (x.startsWith("#")) id = x.slice(1);
      else classes.push(x.slice(1));
    }
    out.push({ ...(m[1] ? { tag: m[1].toLowerCase() } : {}), ...(id ? { id } : {}), classes });
  }
  if (out.length === 0) throw new Error("empty selector");
  return out;
}

interface Open {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
}

const matches = (c: Compound, o: Open): boolean => (c.tag === undefined || c.tag === o.name) && (c.id === undefined || o.attrs.get("id") === c.id) && c.classes.every((k) => (o.attrs.get("class") ?? "").split(/\s+/).includes(k));

/** Outer HTML of the first element matching `selector`, or null. */
export function extractElementHtml(html: string, selector: string): string | null {
  const chain = parseSelector(selector);
  const stack: Open[] = [];
  let found: { start: number; depth: number } | null = null;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html)) !== null) {
    const name = m[2]?.toLowerCase();
    if (name === undefined) continue; // comment, doctype, processing instruction
    if (m[1] === "/") {
      const at = stack.map((o) => o.name).lastIndexOf(name);
      if (at < 0) continue;
      stack.splice(at);
      if (found && stack.length <= found.depth) return html.slice(found.start, m.index + m[0].length);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && IMPLIED_END[name]?.includes(top.name)) {
      stack.pop();
      if (found && stack.length <= found.depth) return html.slice(found.start, m.index);
    }
    const attrs = new Map<string, string>();
    for (const a of m[3]!.matchAll(ATTR)) attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    const el: Open = { name, attrs };
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, TAG.lastIndex);
      TAG.lastIndex = close < 0 ? html.length : close;
      continue;
    }
    if (VOID.has(name) || m[4] === "/") continue;
    if (!found && matches(chain[chain.length - 1]!, el)) {
      // every earlier compound must match an ancestor, in order
      let k = chain.length - 2;
      for (let i = stack.length - 1; i >= 0 && k >= 0; i--) if (matches(chain[k]!, stack[i]!)) k--;
      if (k < 0) found = { start: m.index, depth: stack.length };
    }
    stack.push(el);
  }
  return found ? html.slice(found.start) : null;
}

/** Selector for the URL fragment (`#popupPolicyOld20260728` -> `#popupPolicyOld20260728`), or null without one. */
export function fragmentSelector(url: string): string | null {
  const i = url.indexOf("#");
  const frag = i >= 0 ? url.slice(i + 1) : "";
  return /^[A-Za-z0-9_:-]+$/.test(frag) ? `#${frag}` : null;
}

export const withoutFragment = (url: string): string => {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
};
