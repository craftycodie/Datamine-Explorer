// The explorer's own shapes. The worker maps the datamine package's entries onto these,
// so the UI never touches the package directly.
import type { MessageKey, Text } from "../localization";

export interface FileNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
  children: FileNode[];
}

export interface FileStat {
  size: number;
  modifiedMs: number;
}

export interface ChangeEvent {
  paths: string[];
  // create, remove, rename, modify or other: the strongest of the batch
  kind: string;
}

// Severity names by level number.
export const LEVEL_NAMES = ["verbose", "status", "message", "warning", "error", "critical"] as const;
// An entry without a level (a plain line, a console's debug output) counts as verbose.
export const LEVEL_UNLEVELED = 0;

export interface LogParameter {
  name: string;
  type: string;
  value: string;
}

export interface LogEntry {
  ordinal: number;
  // set on table rows: the search matched this entry
  matched?: boolean;
  // epoch ms, when the line carried a full date
  time?: number;
  timeText: string;
  eventIndex?: number;
  gameTime?: number;
  frameIndex?: number;
  threadId?: number;
  level: number;
  levelText: string;
  // Session rows stand for a banner or a datamine header and are drawn as dividers.
  kind?: "session";
  session?: { number: number; version: string; sessionId?: string };
  // "networking:session:" with the trailing colon, "" when there is none
  category: string;
  message: string;
  // set on table rows whose message was cut short (the detail pane has all of it)
  truncated?: boolean;
  // the line without its columns, as the package parsed it
  text: string;
  context?: string;
  customPrefix?: string;
  definitionId?: number;
  parameters?: LogParameter[];
  raw?: string;
  // the event server's session number, on live entries
  sessionNumber?: number;
  // the nickname of the source it came from, when several are open together
  source?: string;
}

export interface ReportFolderInfo {
  name: string;
  date?: number;
  dateText?: string;
  suffix?: string;
}

export interface SessionMeta {
  format: Text;
  bannerVersion?: string;
  sessionId?: string;
  // label/value rows of the datamine header
  header?: [MessageKey, string][];
  // label/value rows of the server a live log was taken from, read from its sidecar
  server?: [MessageKey, string][];
  reportFolder?: ReportFolderInfo;
  // read problems the parser reported, e.g. a truncated datamine file
  notes: Note[];
}

// A problem the reader ran into, and which of several sources it was in.
export interface Note {
  text: Text;
  source?: string;
}

export interface LogStats {
  count: number;
  sessions: SessionInfo[];
  levelCounts: number[];
  categoryCounts: Map<string, number>;
  firstTime?: number;
  lastTime?: number;
}

// One session divider: where it is and when the session's first event happened.
export interface SessionInfo {
  // entry id of the divider row
  id: number;
  number: number;
  version: string;
  sessionId?: string;
  time?: number;
  // the nickname of its source, when several are open together
  source?: string;
}

// The entries between one divider and the next.
export interface SessionStats {
  count: number;
  levelCounts: number[];
  firstTime?: number;
  lastTime?: number;
}

// What the worker knows after indexing: compact counts, no entries.
export interface StatsSnapshot {
  // events, not counting session rows
  count: number;
  sessions: SessionInfo[];
  levelCounts: number[];
  categories: [string, number][];
  firstTime?: number;
  lastTime?: number;
}

export interface FileLoadInfo {
  path: string;
  size: number;
  modifiedMs: number;
  // the file is being indexed
  loading: boolean;
  // bytes indexed so far, while loading
  indexed: number;
  error?: string;
}

export type SearchState = "idle" | "waiting" | "running" | "done";

export interface SearchStatus {
  state: SearchState;
  // 0..1 of the file scanned
  progress: number;
  // matches that pass the filters
  matches: number;
}

export interface DetailResult {
  entry: LogEntry;
  // the entries around it, unfiltered, starting at entry id `aroundFrom`
  around: LogEntry[];
  aroundFrom: number;
  // the entry ids of `around`, when they are not consecutive from `aroundFrom` (several sources)
  aroundIds?: number[];
  // for a session row
  sessionStats?: SessionStats;
}

export type LiveState = "connecting" | "live" | "reconnecting" | "closed";

// A connection to an event server, as the worker reports it about once a second.
export interface LiveStatus {
  // as typed
  url: string;
  // the server's resolved prefix, e.g. http://127.0.0.1:32557/datamine
  prefix?: string;
  state: LiveState;
  error?: Text;
  name?: string;
  version?: string;
  sessionId?: string;
  systemId?: string;
  build?: string;
  startedMs?: number;
  // events held, not counting dividers
  entries: number;
  // entries per second over the last few seconds
  rate: number;
  // what the index of the entries takes in the worker, roughly; the text is on disk
  memoryBytes: number;
  // the log file the entries are written to, once the first of them is; "Save as" copies it
  spoolPath?: string;
}

// One of several files or servers shown together. `key` tells them apart for as long as they are open.
export interface SourceSpec {
  key: string;
  // what the user called it; shown in the source column
  name: string;
  kind: "file" | "server";
  // the path the backend reads by, or the server URL
  target: string;
}

export type SourceState = "loading" | "ready" | "failed" | LiveState;

// How one of several sources is doing, as the worker reports it.
export interface SourceStatus {
  key: string;
  state: SourceState;
  error?: Text;
  // events held, not counting dividers
  entries: number;
  // a server's resolved prefix
  prefix?: string;
}
