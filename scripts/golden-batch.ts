/**
 * Runs golden cases one process at a time and survives Claude Code usage limits.
 *   bun scripts/golden-batch.ts --cases G2,G3,W1 [--runs 1] [--defects] [--max-wait-min 110] [--log-dir <dir>]
 *
 * Each case runs `golden-regression.ts --llm claude-code --cases <id>` in its own process, so a finished case keeps its
 * saved result even if a later one stops. When a run fails with a usage-limit message ("... limit · resets 11:30am (UTC)"),
 * the batch sleeps until the reset time plus two minutes and retries the same case. A wait longer than --max-wait-min stops
 * the batch (exit 3) and prints the remaining cases, so a scheduled check-in can resume them.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Milliseconds until the reset time a usage-limit message names, or null when the output has no such message. */
export function waitForLimit(output: string, now: Date = new Date()): number | null {
  if (!/(session|usage|rate) limit|hit your limit/i.test(output)) return null;
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(output);
  if (!m) return 30 * 60_000; // limit without a readable reset time: try again in 30 minutes
  let hour = Number(m[1]) % 12;
  if (m[3]!.toLowerCase() === "pm") hour += 12;
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, Number(m[2] ?? 0)));
  if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.getTime() - now.getTime() + 2 * 60_000;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cases = (opt("cases") ?? "").split(",").filter(Boolean);
  if (cases.length === 0) {
    console.error("usage: bun scripts/golden-batch.ts --cases G2,G3 [--runs 1] [--defects] [--max-wait-min 110] [--log-dir dir]");
    process.exit(2);
  }
  const runs = opt("runs") ?? "1";
  const maxWaitMs = Number(opt("max-wait-min") ?? 110) * 60_000;
  const root = join(import.meta.dir, "..");
  const logDir = opt("log-dir") ?? join(root, "golden", "runs");
  mkdirSync(logDir, { recursive: true });
  const summary = join(logDir, "batch.log");
  const note = (s: string): void => {
    const line = `${new Date().toISOString()} ${s}`;
    console.log(line);
    appendFileSync(summary, `${line}\n`);
  };

  const queue = [...cases];
  while (queue.length > 0) {
    const id = queue[0]!;
    note(`start ${id}`);
    const res = spawnSync("bun", [join(root, "scripts", "golden-regression.ts"), "--llm", "claude-code", "--cases", id, "--runs", runs, ...(args.includes("--defects") ? [] : ["--no-defects"])], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    appendFileSync(join(logDir, `batch-${id}.log`), out);
    const wait = res.status === 0 ? null : waitForLimit(out);
    if (wait === null) {
      note(`done ${id} exit=${res.status} ${(/GATE FAILED|gate passed|GATE PASSED/i.exec(out) ?? [""])[0]}`);
      queue.shift();
      continue;
    }
    if (wait > maxWaitMs) {
      note(`usage limit: reset in ${Math.round(wait / 60_000)} min exceeds --max-wait-min; remaining: ${queue.join(",")}`);
      process.exit(3);
    }
    note(`usage limit on ${id}: waiting ${Math.round(wait / 60_000)} min, then retrying`);
    await new Promise((r) => setTimeout(r, wait));
  }
  note("batch finished");
}

if (import.meta.main) void main();
