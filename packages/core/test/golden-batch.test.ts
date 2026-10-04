import { describe, expect, test } from "bun:test";
import { waitForLimit } from "../../../scripts/golden-batch";

describe("golden-batch usage-limit wait", () => {
  const now = new Date("2026-10-01T11:00:00Z");
  test("reads the reset time and adds two minutes", () => {
    expect(waitForLimit("You've hit your session limit · resets 11:30am (UTC)", now)).toBe(32 * 60_000);
    expect(waitForLimit("usage limit · resets 3pm (UTC)", now)).toBe((4 * 60 + 2) * 60_000);
  });
  test("a reset time already past today means tomorrow; no readable time means 30 minutes", () => {
    expect(waitForLimit("session limit · resets 10am (UTC)", now)).toBe((23 * 60 + 2) * 60_000);
    expect(waitForLimit("You've hit your limit", now)).toBe(30 * 60_000);
  });
  test("other failures are not limits", () => {
    expect(waitForLimit("GATE FAILED: blockingFindings = 2", now)).toBeNull();
  });
});
