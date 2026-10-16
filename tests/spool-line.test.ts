// The spool's lines are written by the package's own line writer in the Destiny style, and the
// package's parser reads them back.
import { build_banner, c_log_text_parser, format_event_for_log } from "@blamnetwork/datamine/reading";
import { describe, expect, it } from "vitest";
import type { ServerEntry } from "../src/worker/live-types";
import { entryLine, SPOOL_FORMAT, SPOOL_LAYOUT, spoolBanner } from "../src/worker/spool-line";

const DATE = new Date(2026, 9, 16, 0, 53, 27, 67);

function entry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    category_path: "networking",
    index: 61,
    level: 2,
    session: 1,
    text: "networking: request started",
    time_ms: DATE.getTime(),
    ...overrides,
  };
}

describe("the spool lines", () => {
  it("are Destiny style", () => {
    expect(SPOOL_LAYOUT).toBe("3.1");
    expect(SPOOL_FORMAT).toBe("destiny_style_log");
  });

  it("write the line the package writes", () => {
    const mine = entryLine(
      entry({ context: "[(type)description]", frame_index: 92_363, game_time: 25_637, index: 8550, thread_id: 0xab_cd }),
      0
    );
    const theirs = format_event_for_log(
      {
        category_path: "networking",
        context: "[(type)description]",
        date: DATE,
        event_index: 8550,
        frame_index: 92_363,
        game_time: 25_637,
        level: 2,
        text: "networking: request started",
        thread_id: 0xab_cd,
      },
      "3.1"
    );
    expect(mine).toBe(theirs);
    expect(mine).toBe("10/16/2026 00:53:27.067 g00025637 0000ABCD message  networking: request started\r\n");
  });

  it("write the banner the package writes, with no columns line", () => {
    expect(spoolBanner("web-tiger 1.0")).toBe(build_banner("web-tiger 1.0"));
    expect(spoolBanner("v")).not.toContain("columns:");
  });

  it("are read back by the package parser, banners as dividers", () => {
    const text =
      spoolBanner("version one") +
      entryLine(entry({ game_time: 7, index: 0 }), 0) +
      entryLine(entry({ index: 1, level: 3, text: "ai: two" }), 0) +
      spoolBanner("version two") +
      entryLine(entry({ index: 0, level: 4, text: "world: three\nwith a second line", thread_id: 5 }), 0);
    const parser = new c_log_text_parser(SPOOL_FORMAT);
    const read = [...parser.push(text), ...parser.finish()];
    expect(read.map((e) => e.kind ?? "event")).toEqual(["session", "event", "event", "session", "event"]);
    expect(read.map((e) => e.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(read[0].session).toEqual({ number: 1, version: "version one" });
    expect(read[3].session?.version).toBe("version two");
    expect(read[1].category_path).toBe("networking");
    expect(read[1].level).toBe(2);
    expect(read[1].date?.getTime()).toBe(DATE.getTime());
    expect(read[1].game_time).toBe(7);
    expect(read[1].thread_id).toBe(0);
    expect(read[2].category_path).toBe("ai");
    expect(read[2].message).toBe("two");
    expect(read[2].level).toBe(3);
    expect(read[4].text).toBe("world: three\nwith a second line");
    expect(read[4].thread_id).toBe(5);
  });

  it("keep a long line whole and write a level they cannot as a message", () => {
    const long = "x".repeat(5000);
    expect(entryLine(entry({ text: long }), 0)).toContain(long);
    const parser = new c_log_text_parser(SPOOL_FORMAT);
    const [, read] = [...parser.push(spoolBanner("v") + entryLine(entry({ level: 9 }), 0)), ...parser.finish()];
    expect(read.level).toBe(2);
  });

  it("stand in a time for an entry without one", () => {
    const line = entryLine(entry({ time_ms: Number.NaN }), DATE.getTime());
    expect(line.startsWith("10/16/2026 00:53:27.067")).toBe(true);
  });
});
