// A live source for the engine: one connection, the session that turns its events into log lines,
// the writer that spools them to disk, and the numbers the Session pane shows (state, rate, memory).
// The engine reads the spool back like any other file; nothing of the text stays here.
import type { LiveState, LiveStatus } from "../lib/types";
import { LiveConnection } from "./live-connection";
import { BACKLOG_ALL, BACKLOG_MARGIN, LiveSession, type ResumeState, runOf } from "./live-session";
import { SPOOL_FORMAT } from "./spool-line";
import type { ServerHello } from "./live-types";
import { runStartOf, type Sidecar, type SidecarSpool } from "./sidecar";
import { type SpoolHost, SpoolWriter } from "./spool-writer";

const STATUS_INTERVAL_MS = 500;
// The rate is the average over this long.
const RATE_WINDOW_MS = 5000;
const SPOOL_VERSION = 1;

// What the engine tells of a spool it opened, to carry on in it.
export interface SpoolOpened {
  sidecar: Sidecar;
  // entries and banners in it
  total: number;
  // entries, not counting banners
  events: number;
  size: number;
}

export interface FeedHooks {
  // Opens a spool in the engine so its entries show at once.
  open(path: string, format?: typeof SPOOL_FORMAT): Promise<SpoolOpened>;
  // More was appended.
  grown(): Promise<void>;
  status(status: LiveStatus): void;
  memoryBytes(): number;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

// `<host>_<port>_<YYYYMMDD_HHMMSS>.txt`
export function spoolName(prefix: string, now: Date): string {
  const url = new URL(prefix);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const host = url.hostname.replace(/[^A-Za-z0-9.-]/g, "_");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${host}_${port}_${stamp}.txt`;
}

// Where an earlier connection left off, read from the sidecar of its spool.
async function resumeStateOf(opened: SpoolOpened): Promise<ResumeState> {
  const { sidecar } = opened;
  const lastHello = sidecar.hellos.at(-1);
  const entry = await sidecar.lastEntry(runStartOf(sidecar.hellos));
  const sessions = new Map<number, { version: string; sessionId?: string; startedMs: number }>();
  for (const session of sidecar.sessions.values()) {
    sessions.set(session.number, { sessionId: session.session_id, startedMs: session.started_ms, version: session.version });
  }
  return {
    endsWithDivider: sidecar.sessions.has(opened.total - 1),
    format: SPOOL_FORMAT,
    lastIndex: entry?.index ?? -1,
    nextOrdinal: opened.total,
    runId: lastHello ? runOf(lastHello.hello) : "",
    session: entry?.session ?? [...sidecar.sessions.values()].at(-1)?.number,
    sessions,
  };
}

export class LiveFeed {
  state: LiveState = "connecting";
  readonly session: LiveSession;
  private error: string | undefined;
  private prefix: string | undefined;
  private connection: LiveConnection;
  private writer: SpoolWriter;
  private timer: ReturnType<typeof setInterval> | undefined;
  private received = 0;
  private marks: { at: number; total: number }[] = [];

  // `fresh`: leave the spool of an earlier connection alone and start a new one.
  constructor(
    readonly url: string,
    private fresh: boolean,
    private spool: SpoolHost | undefined,
    // the connection before this one, still writing
    private after: Promise<void>,
    private hooks: FeedHooks
  ) {
    this.writer = new SpoolWriter(
      spool as SpoolHost,
      () => this.spoolStart(),
      {
        failed: (message) => this.fail(`the spool could not be written: ${message}`),
        grown: async () => {
          await hooks.grown();
          this.statusEmit();
        },
        opened: async (path) => {
          await hooks.open(path, SPOOL_FORMAT);
          this.statusEmit();
        },
      }
    );
    this.session = new LiveSession(this.writer);
    this.connection = new LiveConnection(url, {
      entry: (entry) => {
        if (this.session.entryApply(entry)) {
          this.received++;
        }
      },
      hello: (hello, resumed, requested) => this.session.helloApply(hello, requested, resumed),
      prefix: (prefix, info) => this.prefixFound(prefix, info),
      session: (session) => this.session.sessionApply(session),
      state: (state, error) => {
        this.state = state;
        this.error = error;
        this.statusEmit();
      },
    });
  }

  private spoolStart(): { name: string; head: string } {
    const prefix = this.prefix ?? this.url;
    const url = new URL(prefix);
    const record: SidecarSpool = {
      created_ms: Date.now(),
      format: SPOOL_FORMAT,
      host: url.hostname,
      kind: "spool",
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      prefix,
      version: SPOOL_VERSION,
    };
    return { head: `${JSON.stringify(record)}\n`, name: spoolName(prefix, new Date()) };
  }

  // The server is found: carry on in the newest spool of it if there is one, and say how many
  // entries to ask for.
  private async prefixFound(prefix: string, info: ServerHello): Promise<number> {
    this.prefix = prefix;
    await this.after;
    if (this.fresh || !this.spool) {
      return BACKLOG_ALL;
    }
    try {
      const path = await this.spool.find(prefix);
      if (!path) {
        return BACKLOG_ALL;
      }
      await this.spool.resume(path);
      const opened = await this.hooks.open(path);
      const head = opened.sidecar.spool;
      // a spool written in another format is left alone
      if (!head || head.format !== SPOOL_FORMAT) {
        return BACKLOG_ALL;
      }
      const state = await resumeStateOf(opened);
      this.session.resume(state);
      this.writer.attach(path, opened.size);
      this.statusEmit();
      // only the entries after the last held, when it is the same run of the server
      if (runOf(info) === state.runId && state.lastIndex >= 0 && info.entry_count > state.lastIndex) {
        return info.entry_count - state.lastIndex - 1 + BACKLOG_MARGIN;
      }
      return BACKLOG_ALL;
    } catch {
      // a spool that cannot be carried on in is left alone
      return BACKLOG_ALL;
    }
  }

  start() {
    this.timer = setInterval(() => this.statusEmit(), STATUS_INTERVAL_MS);
    void this.connection.start();
  }

  private fail(message: string) {
    this.connection.close();
    this.state = "closed";
    this.error = message;
    this.statusEmit();
  }

  // Leaves the entries held; only the link goes, once what is received is written.
  async stop() {
    this.connection.close();
    clearInterval(this.timer);
    this.timer = undefined;
    await this.writer.close();
    if (this.state !== "closed") {
      this.state = "closed";
    }
    this.statusEmit();
  }

  private rate(now: number): number {
    this.marks.push({ at: now, total: this.received });
    while (this.marks.length > 2 && now - this.marks[1].at >= RATE_WINDOW_MS) {
      this.marks.shift();
    }
    const first = this.marks[0];
    const seconds = (now - first.at) / 1000;
    return seconds > 0 ? (this.received - first.total) / seconds : 0;
  }

  status(): LiveStatus {
    const hello = this.session.hello;
    return {
      build: hello?.build_string,
      entries: this.session.events,
      error: this.error,
      memoryBytes: this.hooks.memoryBytes(),
      prefix: this.prefix,
      name: hello?.name,
      rate: this.state === "closed" ? 0 : this.rate(Date.now()),
      sessionId: hello?.session_id,
      spoolPath: this.writer.path,
      startedMs: hello?.started_ms,
      state: this.state,
      systemId: hello?.system_id,
      url: this.url,
      version: hello?.version_string,
    };
  }

  private statusEmit() {
    this.hooks.status(this.status());
  }
}
