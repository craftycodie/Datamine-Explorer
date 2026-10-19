// The debug output of an Xbox 360, as a live source like an event server: the desktop app holds the
// console's debug monitor connection (xbdm.rs) and hands each line here through the main thread. The
// lines become entries of one run per connection, a new session each time another title starts, and
// the connection comes back by itself when the console drops it.
import type { LiveState } from "../lib/types";
import type { Text } from "../localization";
import type { LiveEvents } from "./live-connection";
import { BACKLOG_ALL } from "./live-session";
import type { ServerHello } from "./live-types";
import { XBDM_SCHEME, xbdmUrl } from "../lib/xbdm";
import { debugEvent } from "./xbdm-lines";

const RETRY_MS = 3000;

// What the desktop app says of a link, as it says it (see e_xbdm_event in xbdm.rs).
export type XbdmEvent =
  | { kind: "hello"; link: number; name: string; title: string }
  | { kind: "line"; link: number; thread: number; text: string }
  | { kind: "title"; link: number; title: string }
  | { kind: "closed"; link: number; error: string };

// The worker's way to the desktop app's links.
export interface XbdmHost {
  open(link: number, host: string): Promise<void>;
  close(link: number): Promise<void>;
}

// The links of every connection in the worker, by number, for the events to find their way back.
const links = new Map<number, (event: XbdmEvent) => void>();
// A link's number is random: the desktop app outlives this worker, and a number from a worker before it
// must not be taken for one of this one's.
function linkNumber(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
}

export function xbdmDispatch(event: XbdmEvent) {
  links.get(event.link)?.(event);
}

function runId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class XbdmConnection {
  private link = 0;
  private closed = false;
  private everLive = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly prefix: string;
  private readonly host: string;
  // one run for as long as this connection lasts, so a reconnect carries on in it
  private readonly run = runId();
  private index = 0;
  private session = 1;
  private title: string | undefined;
  private name = "";
  private startedMs = Date.now();
  // events are taken one at a time, in order: the first waits for an earlier spool to open
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly url: string,
    private on: LiveEvents,
    private xbdm: XbdmHost | undefined
  ) {
    this.prefix = xbdmUrl(url);
    this.host = new URL(this.prefix.replace(XBDM_SCHEME, "http://")).host;
  }

  async start() {
    await this.open();
  }

  private stateSet(state: LiveState, error?: Text) {
    this.on.state(state, error);
  }

  private async open() {
    if (this.closed) {
      return;
    }
    if (!this.xbdm) {
      this.stateSet("closed", { key: "xbox_desktop_only" });
      return;
    }
    links.delete(this.link);
    this.link = linkNumber();
    links.set(this.link, (event) => {
      this.queue = this.queue.then(() => this.receive(event)).catch(() => undefined);
    });
    this.stateSet(this.everLive ? "reconnecting" : "connecting");
    try {
      await this.xbdm.open(this.link, this.host);
    } catch (error) {
      this.dropped(error instanceof Error ? error.message : String(error));
    }
  }

  private hello(): ServerHello {
    return {
      backlog_count: 0,
      entry_count: this.index,
      name: this.name,
      protocol: 1,
      run_id: this.run,
      session_number: this.session,
      started_ms: this.startedMs,
      version_string: this.title || this.name,
    };
  }

  private async receive(event: XbdmEvent) {
    if (this.closed) {
      return;
    }
    switch (event.kind) {
      case "hello": {
        this.name = event.name;
        if (!this.everLive) {
          this.title = event.title;
          await this.on.prefix(this.prefix, this.hello());
          this.on.hello(this.hello(), false, BACKLOG_ALL);
          this.everLive = true;
        } else {
          this.titleSet(event.title);
          this.on.hello(this.hello(), true, BACKLOG_ALL);
        }
        this.stateSet("live");
        break;
      }
      case "title":
        this.titleSet(event.title);
        break;
      case "line": {
        const found = debugEvent(event.text, Date.now(), event.thread);
        if (found) {
          this.on.entry({ ...found, index: this.index++, session: this.session });
        }
        break;
      }
      case "closed":
        this.dropped(event.error);
        break;
    }
  }

  // Another title runs: its lines are a session of their own.
  private titleSet(title: string) {
    if (title === this.title) {
      return;
    }
    this.title = title;
    this.session++;
    this.startedMs = Date.now();
    this.on.session({ number: this.session, started_ms: this.startedMs, version: title || this.name });
  }

  private dropped(error: string) {
    links.delete(this.link);
    if (this.closed) {
      return;
    }
    if (!this.everLive) {
      this.stateSet("closed", error || { key: "xbox_error_closed" });
      return;
    }
    this.stateSet("reconnecting");
    this.timer = setTimeout(() => void this.open(), RETRY_MS);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    links.delete(this.link);
    void this.xbdm?.close(this.link).catch(() => undefined);
  }
}
