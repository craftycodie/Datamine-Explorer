// The link to a datamine event server: finds the server's prefix, follows its Server-Sent Events
// stream and comes back when it drops. What the events mean is up to the caller (live-session.ts).
import type { LiveState } from "../lib/types";
import type { Message, Text } from "../localization";
import { BACKLOG_ALL, type HelloVerdict } from "./live-session";
import type { ServerEntry, ServerHello, ServerSession } from "./live-types";

const PROBE_TIMEOUT_MS = 5000;
// The browser reconnects a dropped stream by itself; this is for the ones it gives up on.
const RETRY_MS = 3000;
const PROTOCOL = 1;
const DEFAULT_PREFIX = "/datamine";

// A connection failure the UI words in its language.
class LiveError extends Error {
  constructor(readonly text: Message) {
    super(text.key);
  }
}

export interface LiveEvents {
  state(state: LiveState, error?: Text): void;
  // The server is found. Gives how many entries to ask for; the caller may look for a log to carry on in first.
  prefix(prefix: string, info: ServerHello): Promise<number>;
  // `resumed`: the stream came back on its own and sent a Last-Event-ID. `requested`: the backlog it was opened with.
  hello(hello: ServerHello, resumed: boolean, requested: number): HelloVerdict;
  entry(entry: ServerEntry): void;
  session(session: ServerSession): void;
}

function urlClean(text: string): string {
  let url = text.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url.replace(/\/+$/, "").replace(/\/(events|info)$/, "");
}

// Accepts a base URL or the prefix itself, and returns the prefix with the server's hello.
async function prefixFind(typed: string): Promise<{ prefix: string; info: ServerHello }> {
  const base = urlClean(typed);
  const path = new URL(base).pathname.replace(/\/+$/, "");
  const candidates = path === "" ? [`${base}${DEFAULT_PREFIX}`, base] : [base, `${base}${DEFAULT_PREFIX}`];
  let failure: Message | undefined;
  for (const prefix of candidates) {
    try {
      const response = await fetch(`${prefix}/info`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) {
        failure ??= { key: "live_error_status", params: { status: response.status, url: `${prefix}/info` } };
        continue;
      }
      const info = (await response.json()) as Partial<ServerHello>;
      if (info.protocol !== PROTOCOL) {
        failure = { key: "live_error_protocol", params: { mine: PROTOCOL, prefix, theirs: String(info.protocol) } };
        continue;
      }
      return { info: info as ServerHello, prefix };
    } catch (error) {
      failure ??= { key: "live_error_unreachable", params: { error: error instanceof Error ? error.message : String(error), url: `${prefix}/info` } };
    }
  }
  throw new LiveError(failure ?? { key: "live_error_unreachable", params: { error: "", url: base } });
}

function parsed<T>(event: Event): T | undefined {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return undefined;
  }
}

export class LiveConnection {
  private source: EventSource | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  // a hello has arrived at least once; errors after that are drops, not a failure to connect
  private everLive = false;
  private prefix = "";
  private backlog = BACKLOG_ALL;
  // the current stream has delivered an event with an id, so its reconnects carry Last-Event-ID
  private idSeen = false;
  private errored = false;

  constructor(
    readonly url: string,
    private on: LiveEvents
  ) {}

  async start() {
    this.on.state("connecting");
    try {
      const found = await prefixFind(this.url);
      this.prefix = found.prefix;
      this.backlog = await this.on.prefix(found.prefix, found.info);
    } catch (error) {
      if (!this.closed) {
        this.on.state("closed", error instanceof LiveError ? error.text : error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!this.closed) {
      this.open();
    }
  }

  private open() {
    this.source?.close();
    this.idSeen = false;
    this.errored = false;
    const source = new EventSource(`${this.prefix}/events?backlog=${this.backlog}`);
    this.source = source;
    source.addEventListener("hello", (event) => {
      const hello = parsed<ServerHello>(event);
      if (!hello || source !== this.source) {
        return;
      }
      const resumed = this.errored && this.idSeen;
      this.errored = false;
      const verdict = this.on.hello(hello, resumed, this.backlog);
      if (verdict !== "continue") {
        this.backlog = verdict.restart;
        this.open();
        return;
      }
      this.everLive = true;
      this.on.state("live");
    });
    source.addEventListener("entry", (event) => {
      const entry = parsed<ServerEntry>(event);
      if (entry && source === this.source) {
        this.idSeen ||= (event as MessageEvent).lastEventId !== "";
        this.on.entry(entry);
      }
    });
    source.addEventListener("session", (event) => {
      const session = parsed<ServerSession>(event);
      if (session && source === this.source) {
        this.on.session(session);
      }
    });
    source.onerror = () => {
      if (source !== this.source || this.closed) {
        return;
      }
      this.errored = true;
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        if (!this.everLive) {
          this.on.state("closed", { key: "live_error_refused", params: { url: `${this.prefix}/events` } });
          return;
        }
        this.on.state("reconnecting");
        this.timer = setTimeout(() => this.open(), RETRY_MS);
      } else {
        this.on.state(this.everLive ? "reconnecting" : "connecting");
      }
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.source?.close();
    this.source = undefined;
  }
}
