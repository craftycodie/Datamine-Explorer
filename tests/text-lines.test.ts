// Every line carries its own shape: the indexer and an entry read back out of the middle of the
// file need no context from the banner, and a banner with an old `columns:` line is only text.
import { build_banner, format_event_for_log, type t_data_mine_header_layout } from "@blamnetwork/datamine/reading";
import { describe, expect, it } from "vitest";
import { EntryIndex } from "../src/worker/entry-index";
import type { ByteSource } from "../src/worker/source";
import { TextStore } from "../src/worker/stores";
import { TextIndexer } from "../src/worker/text-indexer";

const DATE = new Date(2026, 9, 16, 0, 53, 27, 67);

function line(layout: t_data_mine_header_layout, index: number, text: string, level: 2 | 4 = 2): string {
  return format_event_for_log(
    { category_path: "ai", context: "", date: DATE, event_index: index, game_time: 25, level, text, thread_id: 9 },
    layout
  );
}

function sourceOf(text: string): { size: number; source: ByteSource } {
  const bytes = new TextEncoder().encode(text);
  return { size: bytes.length, source: { read: async (offset, length) => bytes.subarray(offset, offset + length) } };
}

async function indexed(text: string, format: "halo_style_log" | "destiny_style_log") {
  const { size, source } = sourceOf(text);
  const index = new EntryIndex();
  const indexer = new TextIndexer(index, format);
  await indexer.advance(source, size, () => false, () => undefined);
  // the last entry is held until another comes; the overlay shows it
  index.overlay = await indexer.overlay(source, size, () => false);
  return { index, source, store: new TextStore(index, source, format) };
}

describe("an event log read by line", () => {
  it("indexes each run by its banner and reads entries from the middle of the file", async () => {
    const text =
      build_banner("run one") +
      line("3.1", 0, "ai: first") +
      line("3.1", 1, "ai: second", 4) +
      build_banner("run two") +
      line("3.1", 0, "ai: third");
    const { index, store } = await indexed(text, "destiny_style_log");
    expect(index.sessions.map((session) => session.version)).toEqual(["run one", "run two"]);
    expect(index.overlay).toHaveLength(1);
    expect(index.total).toBe(5);

    const rows = await store.entries([0, 1, 2, 3, 4], true);
    expect(rows.map((row) => row.message)).toEqual(["run one", "first", "second", "run two", "third"]);
    expect(rows[1].timeText).toBe("10/16/2026 00:53:27.067");
    expect(rows[2].level).toBe(4);
    expect(rows[4].threadId).toBe(9);
    expect(rows[4].gameTime).toBe(25);
  });

  it("reads Halo style lines the same way", async () => {
    const text = build_banner("run one") + line("1.1", 7, "ai: first") + line("1.1", 8, "ai: second", 4) + line("1.1", 9, "ai: third");
    const { index, store } = await indexed(text, "halo_style_log");
    expect(index.total).toBe(4);
    const rows = await store.entries([2, 3], true);
    expect(rows.map((row) => row.message)).toEqual(["second", "third"]);
    expect(rows.map((row) => row.eventIndex)).toEqual([8, 9]);
    expect(rows[0].timeText).toBe("10.16.26 00:53:27.067");
    expect(rows[0].level).toBe(4);
  });

  it("takes the columns line of an old spool banner as banner text", async () => {
    const banner = ["=".repeat(80), "web-tiger 1.0", "columns: date=long,event_index,game_time,thread_id,level=lower,context", "=".repeat(80), "", ""].join("\r\n");
    const { index, store } = await indexed(banner + line("3.1", 0, "ai: first") + line("3.1", 1, "ai: second"), "destiny_style_log");
    expect(index.sessions.map((session) => session.version)).toEqual(["web-tiger 1.0"]);
    // the banner, then two entries: the columns line is not one
    expect(index.total).toBe(3);
    const rows = await store.entries([0, 1, 2], true);
    expect(rows.map((row) => row.message)).toEqual(["web-tiger 1.0", "first", "second"]);
    expect(rows[0].raw).toContain("columns: date=long");
  });
});
