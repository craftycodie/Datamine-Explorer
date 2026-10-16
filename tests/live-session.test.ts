import { c_log_text_parser } from "@blamnetwork/datamine/reading";
import { describe, expect, it } from "vitest";
import { BACKLOG_ALL, LiveSession } from "../src/worker/live-session";
import type { ServerEntry, ServerHello, ServerSession } from "../src/worker/live-types";
import { Sidecar } from "../src/worker/sidecar";
import { SPOOL_FORMAT } from "../src/worker/spool-line";

class Sink {
  text = "";
  side = "";
}

function hello(overrides: Partial<ServerHello> = {}): ServerHello {
  return {
    backlog_count: 0,
    entry_count: 0,
    name: "tiger",
    protocol: 1,
    run_id: "aaaa",
    session_id: "sid-1",
    session_number: 1,
    started_ms: 1_000_000,
    version_string: "alpha tiger 1",
    ...overrides,
  };
}

function entry(index: number, session = 1, overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    category_path: "ai",
    index,
    level: 2,
    session,
    text: `ai: event ${index}`,
    time_ms: 1_700_000_000_000 + index,
    ...overrides,
  };
}

function session(number: number, overrides: Partial<ServerSession> = {}): ServerSession {
  return { number, session_id: `sid-${number}`, started_ms: 2_000_000 + number, version: `alpha tiger ${number}`, ...overrides };
}

function make() {
  const sink = new Sink();
  const live = new LiveSession({
    side: (chunk) => {
      sink.side += chunk;
    },
    text: (chunk) => {
      sink.text += chunk;
    },
  });
  return { live, sink };
}

// Reads the sink back the way the explorer does: the package parser over the text, the sidecar scan over the lines.
async function readBack(sink: Sink) {
  const parser = new c_log_text_parser(SPOOL_FORMAT);
  const parsed = [...parser.push(sink.text), ...parser.finish()];
  const bytes = new TextEncoder().encode(sink.side);
  const sidecar = new Sidecar("x.json", { read: async (offset, length) => bytes.subarray(offset, offset + length) });
  await sidecar.advance(bytes.length, () => false);
  return { parsed, sidecar };
}

const kinds = (parsed: { kind?: string }[]) => parsed.map((e) => e.kind ?? "event");

describe("a live session", () => {
  it("writes a banner for the first run, then its entries, with ordinals the parser agrees with", async () => {
    const { live, sink } = make();
    expect(live.helloApply(hello(), BACKLOG_ALL, false)).toBe("continue");
    for (let i = 0; i < 3; i++) {
      expect(live.entryApply(entry(i))).toBe(true);
    }
    const { parsed, sidecar } = await readBack(sink);
    expect(kinds(parsed)).toEqual(["session", "event", "event", "event"]);
    expect(live.nextOrdinal).toBe(4);
    for (const e of parsed) {
      if (e.kind !== "session") {
        const line = (await sidecar.entries([e.ordinal])).get(e.ordinal);
        expect(line?.index).toBe(e.ordinal - 1);
        expect(line?.session).toBe(1);
      }
    }
    expect(sidecar.sessions.get(0)?.session_id).toBe("sid-1");
    expect(sidecar.hello?.run_id).toBe("aaaa");
  });

  it("waits for the session event of a backlog before the divider, and does not repeat it", async () => {
    const { live, sink } = make();
    live.helloApply(hello({ backlog_count: 5, entry_count: 5 }), BACKLOG_ALL, false);
    expect(sink.text).toBe("");
    live.sessionApply(session(1, { version: "from the session event" }));
    live.entryApply(entry(0));
    live.sessionApply(session(1));
    live.entryApply(entry(1));
    const { parsed } = await readBack(sink);
    expect(kinds(parsed)).toEqual(["session", "event", "event"]);
    expect(parsed[0].session?.version).toBe("from the session event");
  });

  it("starts a divider when the session changes, from an event or an entry", async () => {
    const { live, sink } = make();
    live.helloApply(hello({ backlog_count: 1, entry_count: 1 }), BACKLOG_ALL, false);
    live.sessionApply(session(1));
    live.entryApply(entry(0, 1));
    live.sessionApply(session(2));
    live.entryApply(entry(1, 2));
    // an entry of a session no event announced
    live.entryApply(entry(2, 3));
    const { parsed, sidecar } = await readBack(sink);
    expect(kinds(parsed)).toEqual(["session", "event", "session", "event", "session", "event"]);
    expect([...sidecar.sessions.values()].map((s) => s.number)).toEqual([1, 2, 3]);
  });

  it("skips entries it already holds", () => {
    const { live } = make();
    live.helloApply(hello(), BACKLOG_ALL, false);
    expect(live.entryApply(entry(0))).toBe(true);
    expect(live.entryApply(entry(1))).toBe(true);
    expect(live.entryApply(entry(1))).toBe(false);
    expect(live.entryApply(entry(0))).toBe(false);
    expect(live.entryApply(entry(2))).toBe(true);
    expect(live.events).toBe(3);
  });

  it("carries on in the same run without a banner and a new run gets one", async () => {
    const { live, sink } = make();
    live.helloApply(hello(), BACKLOG_ALL, false);
    live.entryApply(entry(0));
    live.entryApply(entry(1));
    const before = sink.text;
    expect(live.helloApply(hello({ entry_count: 4 }), BACKLOG_ALL, true)).toBe("continue");
    expect(sink.text).toBe(before);
    live.entryApply(entry(2));
    expect(live.entryApply(entry(1))).toBe(false);

    // the server restarted: a Last-Event-ID means nothing to it, so the stream opens again for everything
    expect(live.helloApply(hello({ run_id: "bbbb" }), BACKLOG_ALL, true)).toEqual({ restart: BACKLOG_ALL });
    expect(live.helloApply(hello({ backlog_count: 2, entry_count: 2, run_id: "bbbb" }), BACKLOG_ALL, false)).toBe("continue");
    live.sessionApply(session(1));
    live.entryApply(entry(0));
    live.entryApply(entry(1));
    const { parsed, sidecar } = await readBack(sink);
    expect(kinds(parsed)).toEqual(["session", "event", "event", "event", "session", "event", "event"]);
    expect(sidecar.hellos.map((h) => h.hello.run_id)).toEqual(["aaaa", "bbbb"]);
  });

  it("resumes a spool: only newer entries, no banner, and asks for more when the backlog fell short", async () => {
    const { live, sink } = make();
    live.resume({
      endsWithDivider: false,
      format: SPOOL_FORMAT,
      lastIndex: 9,
      nextOrdinal: 11,
      runId: "aaaa",
      session: 1,
      sessions: new Map([[1, { startedMs: 1, version: "v" }]]),
    });
    // 30 entries now, 10 held: 20 wanted, but only 5 were asked for
    expect(live.helloApply(hello({ entry_count: 30 }), 5, false)).toEqual({ restart: expect.any(Number) });
    expect(live.helloApply(hello({ entry_count: 30 }), 600, false)).toBe("continue");
    // the stream replays from before the last held entry; those are skipped
    for (let i = 8; i < 14; i++) {
      live.entryApply(entry(i));
    }
    live.sessionApply(session(1));
    const { parsed, sidecar } = await readBack(sink);
    expect(kinds(parsed)).toEqual(["event", "event", "event", "event"]);
    expect((await sidecar.entries([11])).get(11)?.index).toBe(10);
    expect(live.nextOrdinal).toBe(15);
  });

  it("opens the stream for everything when the run is not the one held", () => {
    const { live } = make();
    live.resume({ endsWithDivider: false, format: SPOOL_FORMAT, lastIndex: 9, nextOrdinal: 11, runId: "aaaa", session: 1, sessions: new Map() });
    expect(live.helloApply(hello({ run_id: "zzzz" }), 700, false)).toEqual({ restart: BACKLOG_ALL });
  });
});
