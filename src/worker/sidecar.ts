// The sidecar of a log: `<file>.json`, JSON lines next to the text, holding what a text line cannot
// (parameters, context, the server's entry index and session number, the hello and session facts).
// A line that belongs to an entry starts `{"ordinal":<n>,` where n is the entry's id in the log, so
// the scan below finds it without parsing JSON and keeps one offset and length per entry. Lines
// with a "kind" (a session's or a hello's facts) are small and rare and are kept parsed. A later
// line for the same ordinal replaces an earlier one.
import { textDecode } from "./entry-map";
import type { ServerHello, ServerParameter } from "./live-types";
import { type ByteSource, CHUNK_BYTES } from "./source";

export const SIDECAR_SUFFIX = ".json";
const PREFIX = '{"ordinal":';
const FIRST_CAPACITY = 1 << 16;
// An ordinal this far out is not from a log of ours.
const ORDINAL_MAXIMUM = 1 << 28;

export function sidecarPathOf(path: string): string {
  return `${path}${SIDECAR_SUFFIX}`;
}

// What an entry's line holds.
export interface SidecarEntry {
  kind?: undefined;
  ordinal: number;
  index: number;
  session: number;
  context?: string;
  thread_id?: number;
  game_time?: number;
  frame_index?: number;
  parameters?: ServerParameter[];
}

// A divider's facts, keyed by the ordinal of its banner.
export interface SidecarSession {
  ordinal: number;
  kind: "session";
  number: number;
  version: string;
  session_id?: string;
  started_ms: number;
}

// Written for every hello; not tied to an entry.
export interface SidecarHello {
  kind: "hello";
  // the ordinal the next entry or banner gets
  next: number;
  hello: ServerHello;
}

// The first line of every sidecar: which server the log is from and how it is written. A later
// connection to the same server finds the log by it and carries on in it.
export interface SidecarSpool {
  kind: "spool";
  version: number;
  prefix: string;
  host: string;
  port: number;
  created_ms: number;
  format: string;
}

export type SidecarRecord = SidecarEntry | SidecarSession | SidecarHello | SidecarSpool;

const COMMA = 0x2c;
const ZERO = 0x30;
const NINE = 0x39;
const PREFIX_BYTES = new TextEncoder().encode(PREFIX);
const KIND_BYTES = new TextEncoder().encode('"kind":"');

function startsWith(bytes: Uint8Array, at: number, wanted: Uint8Array): boolean {
  if (at + wanted.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < wanted.length; i++) {
    if (bytes[at + i] !== wanted[i]) {
      return false;
    }
  }
  return true;
}

export class Sidecar {
  // by ordinal; a length of 0 means the entry has no line
  offsets = new Float64Array(FIRST_CAPACITY);
  lengths = new Uint32Array(FIRST_CAPACITY);
  // offset just past the last complete line scanned
  consumed = 0;
  // the facts of dividers and hellos, parsed, in file order
  sessions = new Map<number, SidecarSession>();
  hellos: SidecarHello[] = [];
  spool: SidecarSpool | undefined;
  // the highest ordinal that has a line, -1 for none
  last = -1;

  constructor(
    readonly path: string,
    private source: ByteSource
  ) {}

  get hello(): ServerHello | undefined {
    return this.hellos[0]?.hello;
  }

  memoryBytes(): number {
    return this.offsets.length * 12;
  }

  private grow(ordinal: number) {
    let capacity = this.offsets.length;
    while (capacity <= ordinal) {
      capacity = Math.ceil(capacity * 1.5);
    }
    const offsets = new Float64Array(capacity);
    offsets.set(this.offsets);
    const lengths = new Uint32Array(capacity);
    lengths.set(this.lengths);
    this.offsets = offsets;
    this.lengths = lengths;
  }

  private lineTake(bytes: Uint8Array, start: number, end: number, base: number) {
    // `{"ordinal":123,...`
    if (startsWith(bytes, start, PREFIX_BYTES)) {
      let at = start + PREFIX_BYTES.length;
      let ordinal = 0;
      while (at < end && bytes[at] >= ZERO && bytes[at] <= NINE) {
        ordinal = ordinal * 10 + (bytes[at] - ZERO);
        at++;
      }
      if (at > start + PREFIX_BYTES.length && ordinal < ORDINAL_MAXIMUM && bytes[at] === COMMA) {
        if (ordinal >= this.offsets.length) {
          this.grow(ordinal);
        }
        this.offsets[ordinal] = base + start;
        this.lengths[ordinal] = end - start;
        this.last = Math.max(this.last, ordinal);
        if (startsWith(bytes, at + 1, KIND_BYTES)) {
          this.recordKeep(bytes, start, end);
        }
        return;
      }
    }
    this.recordKeep(bytes, start, end);
  }

  private recordKeep(bytes: Uint8Array, start: number, end: number) {
    try {
      const record = JSON.parse(textDecode(bytes.subarray(start, end))) as SidecarRecord;
      if (record.kind === "spool") {
        this.spool ??= record;
      } else if (record.kind === "hello") {
        this.hellos.push(record);
      } else if (record.kind === "session" && typeof record.ordinal === "number") {
        this.sessions.set(record.ordinal, record);
      }
    } catch {
      // not ours; skipped
    }
  }

  // Scans the complete lines from `consumed` up to `size`.
  async advance(size: number, stale: () => boolean) {
    while (this.consumed < size && !stale()) {
      const at = this.consumed;
      const bytes = await this.source.read(at, Math.min(CHUNK_BYTES, size - at));
      if (stale() || bytes.length === 0) {
        return;
      }
      const last = bytes.lastIndexOf(10);
      if (last < 0) {
        // a line longer than the chunk, or one still being written
        if (at + bytes.length >= size) {
          return;
        }
        continue;
      }
      let start = 0;
      for (let stop = bytes.indexOf(10); stop >= 0; stop = bytes.indexOf(10, start)) {
        let end = stop;
        if (end > start && bytes[end - 1] === 13) {
          end--;
        }
        if (end > start) {
          this.lineTake(bytes, start, end, at);
        }
        start = stop + 1;
      }
      this.consumed = at + last + 1;
    }
  }

  // The last entry line at or after `from`, for finding where a log left off.
  async lastEntry(from: number): Promise<SidecarEntry | undefined> {
    for (let ordinal = this.last; ordinal >= from && ordinal >= 0; ordinal--) {
      const found = (await this.entries([ordinal])).get(ordinal);
      if (found && typeof found.index === "number") {
        return found;
      }
    }
  }

  // The line of each ordinal that has one, parsed.
  async entries(ordinals: number[]): Promise<Map<number, SidecarEntry>> {
    const found = new Map<number, SidecarEntry>();
    for (const ordinal of ordinals) {
      if (ordinal >= this.offsets.length || this.lengths[ordinal] === 0) {
        continue;
      }
      try {
        const bytes = await this.source.read(this.offsets[ordinal], this.lengths[ordinal]);
        found.set(ordinal, JSON.parse(textDecode(bytes)) as SidecarEntry);
      } catch {
        // a line that cannot be read is left out
      }
    }
    return found;
  }
}

// The ordinal the latest run of the server began at: its first hello, going back over the hellos of
// the same run (a connection that added no entries still wrote one).
function runKey(record: SidecarHello): string {
  const { run_id: run, session_id: sessionId, started_ms: startedMs } = record.hello;
  return run ?? `${sessionId ?? ""}|${startedMs}`;
}

export function runStartOf(hellos: readonly SidecarHello[]): number {
  const last = hellos.at(-1);
  let start = last?.next ?? 0;
  for (let i = hellos.length - 1; i >= 0 && runKey(hellos[i]) === (last ? runKey(last) : undefined); i--) {
    start = hellos[i].next;
  }
  return start;
}

// ---- writing

// One line of the sidecar. `ordinal` goes first (and `kind` second): the scan reads those from the bytes.
export function sidecarLine(record: SidecarRecord): string {
  const { kind, ordinal, ...rest } = record as { kind?: string; ordinal?: number };
  const head: { ordinal?: number; kind?: string } = {};
  if (ordinal !== undefined) {
    head.ordinal = ordinal;
  }
  if (kind !== undefined) {
    head.kind = kind;
  }
  return `${JSON.stringify({ ...head, ...rest })}
`;
}
