import type { Filters, SearchSpec } from "../lib/filter";
import type { IdRange } from "../lib/selection";
import type { DetailResult, FileStat, LiveStatus, LogEntry, SearchStatus, SessionMeta, StatsSnapshot } from "../lib/types";

// Questions the main thread asks about the open file; each is answered with a "result".
export type CallRequest =
  // table rows [from, to) of the filtered view
  | { name: "rows"; from: number; to: number }
  | { name: "detail"; entry: number }
  // the view row an entry sits on, -1 when the filters hide it
  | { name: "locate"; entry: number }
  | { name: "entryAt"; row: number }
  // the first view row at or after an entry
  | { name: "seek"; entry: number }
  // the position-th search match that passes the filters
  | { name: "matchAt"; position: number }
  // how many rows of the view the selected entry ids are on
  | { name: "selectionCount"; ranges: IdRange[] }
  // The text of the selected rows, in view order. `raw` is each entry's lines as they are in the file;
  // `message` is just the message. Nothing is read when the selection is bigger than `limit` bytes.
  | { name: "selectionRaw"; ranges: IdRange[]; limit: number; mode: "raw" | "message" }
  // the session divider at or above a view row
  | { name: "dividerNear"; row: number };

export interface RowsResult {
  rows: LogEntry[];
  from: number;
  // the view this was read from; see the "view" message
  serial: number;
  version: number;
}

export interface MatchResult {
  entry: number;
  row: number;
}

export interface RawResult {
  rows: number;
  // what the selection takes in the file; the real size of the text when it is read
  bytes: number;
  // missing when `bytes` is over the limit
  text?: string;
}

// The session divider row that applies to a row: the last one at or above it, and where the next one
// is. `row` is -1 before the first divider. `count` is the number of rows the answer was worked out for.
export interface DividerResult {
  row: number;
  next: number;
  count: number;
}

// What each call answers with.
export type CallResult = {
  rows: RowsResult;
  detail: DetailResult | undefined;
  locate: number;
  entryAt: number | undefined;
  seek: number;
  matchAt: MatchResult | undefined;
  selectionCount: number;
  selectionRaw: RawResult;
  dividerNear: DividerResult;
};

export type WorkerRequest =
  // a new file; `path` is whatever the backend reads by
  | { type: "open"; id: number; path: string }
  // the file may have changed
  | { type: "refresh"; id: number }
  // follow an event server instead of a file; `url` is what the user gave. `fresh` leaves the spool of an
  // earlier connection to the same server alone. `spool` is where the log is written: Tauri's temp folder
  // (through the main thread) or the browser's OPFS (by the worker itself).
  | { type: "connect"; id: number; url: string; fresh: boolean; spool: SpoolMode }
  // let go of the server, keeping the entries
  | { type: "disconnect"; id: number }
  // nothing is open any more: drop whatever is held
  | { type: "close"; id: number }
  | { type: "filters"; filters: Filters; onlyMatches: boolean }
  // undefined clears the search
  | { type: "search"; spec?: SearchSpec }
  | { type: "call"; req: number; call: CallRequest }
  | { type: "hostResult"; callId: number; bytes?: ArrayBuffer; stat?: FileStat; text?: string; error?: string };

export type SpoolMode = "tauri" | "opfs";

// The worker has no file access of its own (apart from OPFS); the main thread reads and writes for it.
export type HostCall =
  | { kind: "read"; path: string; offset: number; length: number }
  | { kind: "stat"; path: string }
  | { kind: "spoolCreate"; name: string }
  | { kind: "spoolFind"; prefix: string }
  | { kind: "spoolResume"; path: string }
  | { kind: "spoolAppend"; path: string; bytes: ArrayBuffer }
  | { kind: "spoolFinish"; path: string };

export type WorkerResponse =
  | { type: "host"; callId: number; call: HostCall }
  // the file is being indexed from scratch
  | { type: "reset"; id: number }
  | { type: "file"; id: number; size: number; modifiedMs: number }
  | { type: "meta"; id: number; meta: SessionMeta }
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "stats"; id: number; stats: StatsSnapshot }
  | { type: "live"; id: number; status: LiveStatus }
  // The filtered row count changed. `version` changes when rows moved or changed, `flags` when only
  // their match marks did, and `serial` with every message. Rows from `dirtyFrom` on may differ.
  | { type: "view"; id: number; serial: number; version: number; flags: number; count: number; dirtyFrom: number }
  | { type: "search"; id: number; status: SearchStatus }
  | { type: "done"; id: number }
  | { type: "error"; id: number; message: string }
  | { type: "result"; req: number; value: unknown }
  | { type: "failed"; req: number; message: string };
