// What a connection to an event server means for the spool: which hellos start a new run, where
// the session dividers go, which entries are already held. Every entry becomes a log line in the
// server's own format plus a line of the sidecar (see sidecar.ts); a divider is a banner. The
// ordinals it hands out are the entries' ids once the file engine has indexed the spool, so it
// counts the same way the text parser does: one per banner, one per entry.
import type { ServerEntry, ServerHello, ServerSession } from "./live-types";
import { type SidecarEntry, sidecarLine } from "./sidecar";
import { entryLine, SPOOL_FORMAT, spoolBanner } from "./spool-line";

// The protocol asks for a number of entries; this is more than any server holds.
export const BACKLOG_ALL = 2_147_483_647;
// Asked for on top of the entries wanted, since more arrive while the stream opens.
export const BACKLOG_MARGIN = 512;
const RESTARTS_MAXIMUM = 3;

// Open the stream again asking for this many entries.
export type HelloVerdict = "continue" | { restart: number };

// The run a hello is from; a server that predates run ids is told apart by its session instead.
export function runOf(hello: ServerHello): string {
  return hello.run_id ?? `${hello.session_id ?? ""}|${hello.started_ms}`;
}

export interface SessionFacts {
  version: string;
  sessionId?: string;
  startedMs: number;
}

// Where an earlier connection left a spool.
export interface ResumeState {
  format: typeof SPOOL_FORMAT;
  // the run the last entries came from, empty when the spool has no hello
  runId: string;
  // the server's index of the last entry of that run, -1 for none
  lastIndex: number;
  // the server session the spool is in
  session?: number;
  sessions: Map<number, SessionFacts>;
  // the ordinal the next banner or entry gets
  nextOrdinal: number;
  // the last slot is the divider of `session`
  endsWithDivider: boolean;
}

export interface SpoolSink {
  text(chunk: string): void;
  side(chunk: string): void;
}

export class LiveSession {
  // the server's latest hello
  hello: ServerHello | undefined;
  format: typeof SPOOL_FORMAT | undefined;
  // entries written, not counting dividers
  events = 0;
  private ordinal = 0;
  // which run of the server the entries come from
  private identity: string | undefined;
  private lastIndex = -1;
  private sessions = new Map<number, SessionFacts>();
  // the server session the spool is in; undefined until a divider or an entry says
  private current: number | undefined;
  // the next entry decides which session the divider is for
  private dividerPending = false;
  // the last slot is a divider
  private endsWithDivider = false;
  private lastTime: number | undefined;
  private helloWritten = false;
  private restarts = 0;

  constructor(private sink: SpoolSink) {}

  get nextOrdinal(): number {
    return this.ordinal;
  }

  resume(state: ResumeState) {
    this.format = state.format;
    this.identity = state.runId || undefined;
    this.lastIndex = state.lastIndex;
    this.current = state.session;
    this.sessions = state.sessions;
    this.ordinal = state.nextOrdinal;
    this.endsWithDivider = state.endsWithDivider;
  }

  // --- what the server says

  // A hello opens every connection. The same run carries on after the entries held; a different
  // one (the server restarted) starts a new session in the same spool. `requested` is the backlog
  // the stream was opened with: it may be too small to reach the entries held, and a stream that
  // resumed with an index means nothing to a new run.
  helloApply(hello: ServerHello, requested: number, resumed: boolean): HelloVerdict {
    if (this.identity === runOf(hello)) {
      const wanted = hello.entry_count - this.lastIndex - 1;
      if (requested < BACKLOG_ALL && wanted > requested) {
        this.restarts++;
        return { restart: this.restarts > RESTARTS_MAXIMUM ? BACKLOG_ALL : Math.min(BACKLOG_ALL, wanted + BACKLOG_MARGIN * 2 ** this.restarts) };
      }
      this.hello = hello;
      this.format ??= SPOOL_FORMAT;
      if (!this.helloWritten) {
        this.helloRecord(hello);
      }
      return "continue";
    }
    if (this.identity !== undefined && (resumed || requested < BACKLOG_ALL)) {
      return { restart: BACKLOG_ALL };
    }
    this.identity = runOf(hello);
    this.hello = hello;
    this.format ??= SPOOL_FORMAT;
    this.lastIndex = -1;
    this.sessions.clear();
    this.sessions.set(hello.session_number, {
      sessionId: hello.session_id,
      startedMs: hello.started_ms,
      version: hello.version_string,
    });
    this.current = undefined;
    this.helloRecord(hello);
    if (hello.backlog_count === 0) {
      this.dividerAdd(hello.session_number);
    } else {
      this.dividerPending = true;
    }
    return "continue";
  }

  private helloRecord(hello: ServerHello) {
    this.helloWritten = true;
    this.sink.side(sidecarLine({ kind: "hello", next: this.ordinal, hello }));
  }

  // The server's event system started over. A session the spool is already in only learns more.
  sessionApply(session: ServerSession) {
    const facts = { sessionId: session.session_id, startedMs: session.started_ms, version: session.version };
    this.sessions.set(session.number, facts);
    if (this.current === session.number) {
      if (this.endsWithDivider) {
        this.sessionRecord(this.ordinal - 1, session.number);
      }
      return;
    }
    this.dividerAdd(session.number);
  }

  private sessionRecord(ordinal: number, number: number) {
    const facts = this.sessions.get(number);
    this.sink.side(
      // ordinal first, then kind: the scan of the sidecar reads them from the bytes
      sidecarLine({
        ordinal,
        kind: "session",
        number,
        session_id: facts?.sessionId,
        started_ms: facts?.startedMs ?? 0,
        version: facts?.version ?? "",
      })
    );
  }

  private dividerAdd(number: number) {
    const facts = this.sessions.get(number);
    const version = facts?.version || this.hello?.version_string || "unknown";
    this.sessions.set(number, { ...(facts ?? { startedMs: 0 }), version });
    if (this.format) {
      this.sink.text(spoolBanner(version));
    }
    this.sessionRecord(this.ordinal, number);
    this.ordinal++;
    this.dividerPending = false;
    this.endsWithDivider = true;
    this.current = number;
  }

  // False when the entry was already held.
  entryApply(entry: ServerEntry): boolean {
    if (!this.format || entry.index <= this.lastIndex) {
      return false;
    }
    this.lastIndex = entry.index;
    if (this.dividerPending || (this.current !== undefined && entry.session !== this.current)) {
      this.dividerAdd(entry.session);
    }
    this.current = entry.session;
    this.endsWithDivider = false;
    if (Number.isFinite(entry.time_ms)) {
      this.lastTime = entry.time_ms;
    }
    this.sink.text(entryLine(entry, this.lastTime ?? this.hello?.started_ms ?? Date.now()));
    const line: SidecarEntry = { ordinal: this.ordinal, index: entry.index, session: entry.session };
    if (entry.context) {
      line.context = entry.context;
    }
    if (entry.thread_id !== undefined) {
      line.thread_id = entry.thread_id;
    }
    if (entry.game_time !== undefined) {
      line.game_time = entry.game_time;
    }
    if (entry.frame_index !== undefined) {
      line.frame_index = entry.frame_index;
    }
    if (entry.parameters && entry.parameters.length > 0) {
      line.parameters = entry.parameters;
    }
    this.sink.side(sidecarLine(line));
    this.ordinal++;
    this.events++;
    return true;
  }
}
