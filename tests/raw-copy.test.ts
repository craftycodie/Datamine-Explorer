import { build_banner, format_event_for_log, type t_data_mine_header_layout } from "@blamnetwork/datamine/reading";
import { describe, expect, it } from "vitest";
import { filtersDefault } from "../src/lib/filter";
import type { IdRange } from "../src/lib/selection";
import { type Host, LogEngine } from "../src/worker/engine";
import type { DividerResult, RawResult, WorkerResponse } from "../src/worker/protocol";
import { lineEndTrim, readSegments, rowSpans, spansSize } from "../src/worker/raw-copy";

describe("selection to rows", () => {
  // the view rows are these ids; rowNear is the first row at or after an id
  const view = [0, 1, 2, 5, 6, 9, 10, 11, 40];
  const rowNear = (id: number) => {
    const at = view.findIndex((v) => v >= id);
    return at === -1 ? view.length : at;
  };

  it("turns id ranges into runs of rows, ignoring ids the filters hide", () => {
    expect(rowSpans([[1, 5]], rowNear)).toEqual([[1, 4]]);
    // 3 and 4 are hidden: no rows
    expect(rowSpans([[3, 4]], rowNear)).toEqual([]);
    expect(rowSpans([[0, 100]], rowNear)).toEqual([[0, 9]]);
    expect(spansSize(rowSpans([[0, 100]], rowNear))).toBe(9);
  });

  it("joins spans that touch because the ids between them are hidden", () => {
    const ranges: IdRange[] = [[0, 2], [3, 4], [5, 6], [40, 40]];
    expect(rowSpans(ranges, rowNear)).toEqual([[0, 5], [8, 9]]);
    expect(rowSpans([[0, 1], [9, 9]], rowNear)).toEqual([[0, 2], [5, 6]]);
  });
});

describe("reads", () => {
  const offsets = [0, 100, 200, 5000, 5100, 900_000];
  const lengths = [100, 100, 100, 100, 100, 100];
  const plan = (gap: number, chunk: number) => readSegments(offsets.length, (k) => offsets[k], (k) => lengths[k], gap, chunk);

  it("reads neighbours together and splits at a gap", () => {
    expect(plan(1000, 1_000_000)).toEqual([
      { end: 300, first: 0, last: 2, start: 0 },
      { end: 5200, first: 3, last: 4, start: 5000 },
      { end: 900_100, first: 5, last: 5, start: 900_000 },
    ]);
    expect(plan(10_000_000, 10_000_000)).toHaveLength(1);
  });

  it("splits when a read would pass the chunk size, and gives a big entry a read of its own", () => {
    expect(plan(1_000_000, 300).map((s) => [s.first, s.last])).toEqual([[0, 2], [3, 4], [5, 5]]);
    const big = readSegments(3, (k) => [0, 10, 5000][k], (k) => [10, 4990, 10][k], 1_000_000, 100);
    expect(big.map((s) => [s.first, s.last])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("trims one line break off the end of an entry", () => {
    expect(lineEndTrim("a\nb\n")).toBe("a\nb");
    expect(lineEndTrim("a\r\n")).toBe("a");
    expect(lineEndTrim("a\n\n")).toBe("a\n");
    expect(lineEndTrim("a")).toBe("a");
  });
});

const DATE = new Date(2026, 9, 16, 0, 53, 27, 67);

function line(layout: t_data_mine_header_layout, index: number, text: string, level: 2 | 4 = 2): string {
  return format_event_for_log({ category_path: "ai", context: "", date: DATE, event_index: index, game_time: 25, level, text, thread_id: 9 }, layout);
}

// An engine over a log in memory.
async function engineOver(text: string) {
  const bytes = new TextEncoder().encode(text);
  const host: Host = {
    read: async (_path, offset, length) => bytes.subarray(offset, offset + length),
    stat: async () => ({ modifiedMs: 1, size: bytes.length }),
  };
  const sent: WorkerResponse[] = [];
  const engine = new LogEngine(host, (message) => sent.push(message));
  await engine.open(1, "test.log");
  return { engine };
}

// An entry as the engine copies it: a banner is followed by a blank line in the file that belongs to no entry.
const noBreak = (l: string) => l.replace(/(\r?\n)+$/, "");

describe("copying raw text from the engine", () => {
  // two sessions; one event has continuation lines
  const lines = [
    build_banner("run one"),
    line("3.1", 0, "ai: first"),
    line("3.1", 1, "ai: second\ncontinued here\nand here", 4),
    line("3.1", 2, "ai: third"),
    build_banner("run two"),
    line("3.1", 0, "ai: fourth"),
    line("3.1", 1, "ai: fifth", 4),
  ];
  const text = lines.join("");

  it("copies exactly the file lines of the selected entries, in view order", async () => {
    const { engine } = await engineOver(text);
    const raw = async (ranges: IdRange[], limit = 1e9) => (await engine.call({ limit, mode: "raw", name: "selectionRaw", ranges })) as RawResult;
    // everything: banner, three events, banner, two events
    const all = await raw([[0, 6]]);
    expect(all.rows).toBe(7);
    expect(all.text).toBe(lines.map(noBreak).join("\n"));
    // entry 2 has three lines of its own
    const some = await raw([[2, 3], [5, 5]]);
    expect(some.rows).toBe(3);
    expect(some.text).toBe([lines[2], lines[3], lines[5]].map(noBreak).join("\n"));
    expect(some.text).toContain("continued here\n");
    // a divider copies as its banner
    expect((await raw([[4, 4]])).text).toBe(noBreak(lines[4]));
  });

  it("copies just the messages on request", async () => {
    const { engine } = await engineOver(text);
    const result = (await engine.call({ limit: 1e9, mode: "message", name: "selectionRaw", ranges: [[1, 3]] })) as RawResult;
    expect(result.text).toBe("first\nsecond\ncontinued here\nand here\nthird");
  });

  it("refuses without reading when the selection is over the limit", async () => {
    const { engine } = await engineOver(text);
    const result = (await engine.call({ limit: 50, mode: "raw", name: "selectionRaw", ranges: [[0, 6]] })) as RawResult;
    expect(result.text).toBeUndefined();
    expect(result.rows).toBe(7);
    expect(result.bytes).toBe(new TextEncoder().encode(lines.map((l) => `${noBreak(l)}\r\n`).join("")).length);
  });

  it("copies only the rows the filters show", async () => {
    const { engine } = await engineOver(text);
    // errors only: entries 2 and 6, with the dividers of their sessions
    const filters = filtersDefault();
    filters.levels = filters.levels.map((_, level) => level === 4);
    engine.filtersSet(filters, false);
    expect(await engine.call({ name: "selectionCount", ranges: [[0, 6]] })).toBe(4);
    const result = (await engine.call({ limit: 1e9, mode: "raw", name: "selectionRaw", ranges: [[0, 6]] })) as RawResult;
    expect(result.text).toBe([lines[0], lines[2], lines[4], lines[6]].map(noBreak).join("\n"));
  });

  it("finds the divider at or above a row, and where the next one is", async () => {
    const { engine } = await engineOver(text);
    const near = async (row: number) => (await engine.call({ name: "dividerNear", row })) as DividerResult;
    expect(await near(0)).toMatchObject({ next: 4, row: 0 });
    expect(await near(3)).toMatchObject({ next: 4, row: 0 });
    expect(await near(4)).toMatchObject({ next: 7, row: 4 });
    expect(await near(6)).toMatchObject({ next: 7, row: 4 });
  });
});
