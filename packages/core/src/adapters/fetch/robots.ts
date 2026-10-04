/**
 * Minimal robots.txt parser (RFC 9309 subset): `User-agent`, `Allow`, `Disallow`, `Crawl-delay`. Our group (matched by product token)
 * wins over `*`; inside a group the longest matching path decides and Allow wins a tie. `*` and a trailing `$` work in paths.
 */

export interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly crawlDelay?: number;
}

export interface RobotsFile {
  readonly groups: readonly RobotsGroup[];
}

export interface RobotsDecision {
  readonly allowed: boolean;
  /** Seconds, from the group that applied; absent when none was declared. */
  readonly crawlDelay?: number;
}

export const EMPTY_ROBOTS: RobotsFile = { groups: [] };

/** True when the body looks like an HTML page: some sites answer /robots.txt with their 404 page (treated as "no rules"). */
export const looksLikeHtml = (body: string, contentType: string | null): boolean => /html/i.test(contentType ?? "") || /^\s*<(?:!doctype|html|head|body)/i.test(body);

export function parseRobots(text: string): RobotsFile {
  const groups: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number }[] = [];
  let cur: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number } | null = null;
  let lastWasAgent = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow means "nothing is disallowed"; an empty Allow matches nothing.
      if (value) cur.rules.push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
    }
  }
  return { groups };
}

function pathRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** `userAgent` is the full header value; its product token (text before `/`) is matched against the group agents. */
export function evaluateRobots(robots: RobotsFile, userAgent: string, pathAndQuery: string): RobotsDecision {
  const token = (userAgent.split("/")[0] ?? userAgent).trim().toLowerCase();
  const own = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && a.length > 0 && token.includes(a)));
  const groups = own.length > 0 ? own : robots.groups.filter((g) => g.agents.includes("*"));
  if (groups.length === 0) return { allowed: true };
  const rules = groups.flatMap((g) => g.rules);
  const delays = groups.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);
  const crawlDelay = delays.length > 0 ? Math.max(...delays) : undefined;
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!pathRegex(r.path).test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  return { allowed: best ? best.allow : true, ...(crawlDelay !== undefined ? { crawlDelay } : {}) };
}
