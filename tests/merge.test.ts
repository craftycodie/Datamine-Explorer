import { build_banner, format_event_for_log } from "@blamnetwork/datamine/reading";
import { afterEach, describe, expect, it } from "vitest";
import { filtersDefault } from "../src/lib/filter";
import type { DetailResult, LogEntry, SourceSpec } from "../src/lib/types";
import type { Host } from "../src/worker/engine";
import { MergeEngine } from "../src/worker/merge";
import type { RawResult, RowsResult, WorkerResponse } from "../src/worker/protocol";

const BASE = new Date(2026, 9, 16, 12, 0, 0, 0).getTime();

// An event `seconds` after BASE.
function line(seconds: number, index: number, text: string, level: 2 | 4 = 2): string {
  return format_event_for_log(
    { category_path: "ai", context: "", date: new Date(BASE + seconds * 1000), event_index: index, game_time: 25, level, text, thread_id: 9 },
    "3.1"
  );
}

// Files in memory, which a test can add to.
function hostOver(files: Map<string, string>): Host {
  const bytesOf = (path: string) => new TextEncoder().encode(files.get(path) ?? "");
  return {
    read: async (path, offset, length) => bytesOf(path).subarray(offset, offset + length),
    stat: async (path) => {
      if (!files.has(path)) {
        throw new Error(`no ${path}`);
      }
      return { modifiedMs: files.get(path)?.length ?? 0, size: bytesOf(path).length };
    },
  };
}

const engines: MergeEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.close(0);
  }
});

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function mergeOver(files: Map<string, string>, specs: SourceSpec[]) {
  const sent: WorkerResponse[] = [];
  const engine = new MergeEngine(hostOver(files), (message) => sent.push(message));
  engines.push(engine);
  engine.sourcesSet(1, specs);
  await until(() => sent.some((message) => message.type === "done"));
  // the last view, once nothing more comes in
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rows = async () => ((await engine.call({ from: 0, name: "rows", to: 1000 })) as RowsResult).rows;
  return { engine, rows, sent };
}

const messages = (rows: LogEntry[]) => rows.filter((row) => row.kind !== "session").map((row) => `${row.source} ${row.message}`);

const specs: SourceSpec[] = [
  { key: "a", kind: "file", name: "game", target: "game.txt" },
  { key: "b", kind: "file", name: "server", target: "server.txt" },
];

describe("merging sources", () => {
  it("interleaves the entries of every source by time, each tagged with its source", async () => {
    const files = new Map([
      ["game.txt", build_banner("game") + line(0, 0, "ai: g0") + line(2, 1, "ai: g2") + line(4, 2, "ai: g4")],
      ["server.txt", build_banner("server") + line(1, 0, "ai: s1") + line(3, 1, "ai: s3", 4)],
    ]);
    const { rows } = await mergeOver(files, specs);
    const all = await rows();
    expect(messages(all)).toEqual(["game g0", "server s1", "game g2", "server s3", "game g4"]);
    // each source's divider comes before its own first event, and merged ids count up the rows
    expect(all.filter((row) => row.kind === "session").map((row) => row.source)).toEqual(["game", "server"]);
    expect(all.map((row) => row.ordinal)).toEqual(all.map((_, k) => k));
  });

  it("filters, searches and copies across the sources", async () => {
    const files = new Map([
      // the last entry of a file is still the parser's, and only what it is done with is searched
      ["game.txt", line(0, 0, "ai: g0") + line(2, 1, "ai: g2 boom", 4) + line(4, 2, "ai: g4")],
      ["server.txt", line(1, 0, "ai: s1 boom", 4) + line(3, 1, "ai: s3")],
    ]);
    const { engine, rows } = await mergeOver(files, specs);
    const filters = filtersDefault();
    filters.levels = filters.levels.map((_, level) => level === 4);
    engine.filtersSet(filters, false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages(await rows())).toEqual(["server s1 boom", "game g2 boom"]);

    engine.filtersSet(filtersDefault(), false);
    engine.searchSet({ caseSensitive: false, regex: false, text: "boom" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const first = (await engine.call({ name: "matchAt", position: 0 })) as { entry: number; row: number };
    const second = (await engine.call({ name: "matchAt", position: 1 })) as { entry: number; row: number };
    expect([first.row, second.row]).toEqual([1, 2]);

    const copy = (await engine.call({ limit: 1e9, mode: "message", name: "selectionRaw", ranges: [[0, 3]] })) as RawResult;
    expect(copy.text).toBe("g0\ns1 boom\ng2 boom\ns3");
  });

  it("shows only some sources, or all but some", async () => {
    const files = new Map([
      ["game.txt", line(0, 0, "ai: g0") + line(2, 1, "ai: g2")],
      ["server.txt", line(1, 0, "ai: s1") + line(3, 1, "ai: s3")],
    ]);
    const { engine, rows } = await mergeOver(files, specs);
    engine.sourceFilterSet(["b"], []);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages(await rows())).toEqual(["server s1", "server s3"]);
    engine.sourceFilterSet([], ["b"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages(await rows())).toEqual(["game g0", "game g2"]);
    engine.sourceFilterSet([], []);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages(await rows())).toEqual(["game g0", "server s1", "game g2", "server s3"]);
  });

  it("shows a selected entry's neighbours from its own source, by merged id", async () => {
    const files = new Map([
      ["game.txt", line(0, 0, "ai: g0") + line(2, 1, "ai: g2")],
      ["server.txt", line(1, 0, "ai: s1") + line(3, 1, "ai: s3")],
    ]);
    const { engine } = await mergeOver(files, specs);
    const detail = (await engine.call({ entry: 2, name: "detail" })) as DetailResult;
    expect(detail.entry.message).toBe("g2");
    expect(detail.entry.source).toBe("game");
    expect(detail.aroundIds).toEqual([0, 2]);
  });

  it("puts entries that arrive later on the end, keeping the ids already shown", async () => {
    const files = new Map([
      ["game.txt", line(0, 0, "ai: g0") + line(10, 1, "ai: g10")],
      ["server.txt", line(5, 0, "ai: s5")],
    ]);
    const { engine, rows } = await mergeOver(files, specs);
    expect(messages(await rows())).toEqual(["game g0", "server s5", "game g10"]);
    // older than the newest entry shown, but it came last
    files.set("server.txt", (files.get("server.txt") ?? "") + line(6, 1, "ai: s6"));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(messages(await rows())).toEqual(["game g0", "server s5", "game g10", "server s6"]);
    void engine;
  });

  it("drops a source that is taken out, and reads one that is added", async () => {
    const files = new Map([
      ["game.txt", line(0, 0, "ai: g0")],
      ["server.txt", line(1, 0, "ai: s1")],
      ["third.txt", line(2, 0, "ai: t2")],
    ]);
    const { engine, rows, sent } = await mergeOver(files, specs);
    sent.length = 0;
    engine.sourcesSet(2, [specs[1], { key: "c", kind: "file", name: "third", target: "third.txt" }]);
    await until(() => sent.some((message) => message.type === "done"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(messages(await rows())).toEqual(["server s1", "third t2"]);
    const sources = sent.filter((message) => message.type === "sources").at(-1);
    expect(sources?.type === "sources" && sources.sources.map((source) => [source.key, source.state])).toEqual([
      ["b", "ready"],
      ["c", "ready"],
    ]);
  });
});
