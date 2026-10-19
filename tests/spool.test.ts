import { describe, expect, it } from "vitest";
import { COLUMN_DEFAULTS, COLUMN_MINIMUMS, columnsParse, gridMinimum, widthClamp } from "../src/lib/columns";
import { SPOOL_AGE_MAXIMUM_MS, savedName, spoolCleanupPlan } from "../src/lib/spool";
import { spoolName } from "../src/worker/live-feed";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

describe("spool names", () => {
  it("are host, port and the local time", () => {
    expect(spoolName("http://127.0.0.1:32557/datamine", new Date(2026, 9, 16, 23, 5, 9))).toBe("127.0.0.1_32557_20261016_230509.txt");
    expect(spoolName("https://example.org/datamine", new Date(2026, 0, 2, 3, 4, 5))).toBe("example.org_443_20260102_030405.txt");
    expect(spoolName("http://[::1]:5/datamine", new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^[A-Za-z0-9._-]+_5_20260102_030405\.txt$/);
  });
});

describe("saved names", () => {
  it("put datamine_ in front of the spool's name, once", () => {
    expect(savedName("127.0.0.1_32557_20261017_031500.txt")).toBe("datamine_127.0.0.1_32557_20261017_031500.txt");
    expect(savedName("datamine_x.txt")).toBe("datamine_x.txt");
  });
});

describe("tidying the spool folder", () => {
  const group = (name: string, age: number, server?: string) => ({ modifiedMs: NOW - age * DAY, name, server });

  it("drops what is older than a week and what is past the newest five", () => {
    const groups = Array.from({ length: 8 }, (_, n) => group(`s${n}`, n, "x"));
    expect(spoolCleanupPlan(groups, NOW)).toEqual(["s5", "s6", "s7"]);
    expect(spoolCleanupPlan([group("old", 8, "x")], NOW)).toEqual(["old"]);
    expect(SPOOL_AGE_MAXIMUM_MS).toBe(7 * DAY);
  });

  it("keeps the newest of each server, and never one being written", () => {
    const groups = [...Array.from({ length: 6 }, (_, n) => group(`s${n}`, n, "x")), group("other", 6, "y"), group("lost", 2)];
    const plan = spoolCleanupPlan(groups, NOW);
    expect(plan).not.toContain("other");
    expect(plan).toContain("s5");
    expect(spoolCleanupPlan(groups, NOW, new Set(["s5"]))).not.toContain("s5");
  });
});

describe("column widths", () => {
  it("fall back to the defaults and are held between their minimum and 600", () => {
    expect(columnsParse(null)).toEqual(COLUMN_DEFAULTS);
    expect(columnsParse("nonsense")).toEqual(COLUMN_DEFAULTS);
    expect(columnsParse(JSON.stringify({ category: 150.4, index: "x", level: 9000, time: 10 }))).toEqual({
      category: 150,
      index: 64,
      level: 600,
      source: COLUMN_DEFAULTS.source,
      time: COLUMN_MINIMUMS.time,
    });
    expect(widthClamp("index", -5)).toBe(COLUMN_MINIMUMS.index);
    expect(widthClamp("category", 79)).toBe(80);
  });

  it("make a grid at least as wide as its columns and some message", () => {
    expect(gridMinimum(COLUMN_DEFAULTS)).toBe(96 + 64 + 52 + 160 + 4 * 8 + 240 + 16);
  });
});
