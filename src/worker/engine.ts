// Everything the worker does, without the worker: opens a file, indexes it in chunks, answers for
// rows on demand and runs the search. It reads through a `Host` and talks through `emit`, so Node
// can drive it too.
import {
  log_detect_format,
  log_entries_from_datamine,
  log_header_from_datamine,
  read_datamine_upload,
  report_folder_parse,
  type s_log_datamine_header,
  type t_log_text_format,
} from "@blamnetwork/datamine/reading";
import type { Filters, SearchSpec } from "../lib/filter";
import { baseName } from "../lib/format";
import type { DetailResult, FileStat, LiveStatus, LogEntry, Note, ReportFolderInfo, SearchStatus, SessionMeta, StatsSnapshot } from "../lib/types";
import type { MessageKey, Text } from "../localization";
import { DatamineIndexer } from "./datamine-indexer";
import { EntryIndex } from "./entry-index";
import { entryMap } from "./entry-map";
import { LiveFeed, type SpoolOpened } from "./live-feed";
import type { IdRange } from "../lib/selection";
import type { CallRequest, DividerResult, RawResult, RowsResult, WorkerResponse } from "./protocol";
import { lineEndTrim, rowSpans, spansSize } from "./raw-copy";
import { matcherCreate } from "./search";
import { Sidecar, sidecarPathOf } from "./sidecar";
import { CHUNK_BYTES, type ByteSource } from "./source";
import type { SpoolHost } from "./spool-writer";
import { DatamineStore, type EntryStore, MemoryStore, TextStore } from "./stores";
import { TextIndexer } from "./text-indexer";
import { View } from "./view";

export interface Host {
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  stat(path: string): Promise<FileStat>;
  // where a live session is spooled to; missing where there is nowhere to write
  spool?: SpoolHost;
}

const HEAD_BYTES = 64 * 1024;
// The first bytes of the file are kept to tell a file that was replaced from one that grew.
const IDENTITY_BYTES = 4096;
const ROW_CACHE_ROWS = 4000;
const CONTEXT_ENTRIES = 6;
const EMIT_INTERVAL_MS = 120;
const SEARCH_BATCH_ENTRIES = 100_000;
// A copy reads and joins this many entries at a time, at most.
const COPY_BATCH_ENTRIES = 20_000;

const TEXT_FORMATS: string[] = ["halo_style_log", "destiny_style_log", "datamine_text"];

type Kind = "text" | "datamine" | "upload";

function reportFolderOf(path: string): ReportFolderInfo | undefined {
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const folder = report_folder_parse(parts[i]);
    if (folder) {
      return { date: folder.date.getTime(), name: parts[i], suffix: folder.suffix };
    }
  }
}

// A format by name, for the UI to say in its language.
function formatText(format: t_log_text_format | "datamine_binary" | "datamine_upload" | "empty" | "plain_text"): Text {
  return { key: `format_${format}` };
}

function headerRows(header: s_log_datamine_header): [MessageKey, string][] {
  const rows: [MessageKey, string][] = [
    ["field_session_id", header.sessionid],
    ["field_build", `${header.build_string} (${header.build_number})`],
    ["field_system_id", header.systemid],
    ["field_title", header.title],
    ["field_start_date", header.session_start_date ? header.session_start_date.toLocaleString() : ""],
    ["field_layout", header.layout],
    ["field_byte_order", header.byte_order],
  ];
  return rows.filter(([, value]) => value !== "");
}

// What the sidecar says of the server the log was taken from.
function serverRows(sidecar: Sidecar): [MessageKey, string][] | undefined {
  const hello = sidecar.hello;
  if (!hello) {
    return;
  }
  const rows: [MessageKey, string][] = [
    ["field_server", sidecar.spool?.prefix ?? ""],
    ["field_name", hello.name ?? ""],
    ["field_version", hello.version_string],
    ["field_session_id", hello.session_id ?? ""],
    ["field_system_id", hello.system_id ?? ""],
    ["field_build", hello.build_string ?? ""],
    ["field_started", hello.started_ms ? new Date(hello.started_ms).toLocaleString() : ""],
  ];
  return rows.filter(([, value]) => value !== "");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

interface SearchRun {
  spec: SearchSpec;
  match: ReturnType<typeof matcherCreate>;
  // the next entry to look at
  scanned: number;
  running: boolean;
}

export class LogEngine {
  private id = 0;
  private path = "";
  // bumps with every open, so work started for an earlier file can tell
  private generation = 0;
  private index = new EntryIndex();
  private view = new View(this.index);
  private store: EntryStore | undefined;
  private kind: Kind | undefined;
  private text: TextIndexer | undefined;
  private datamine: DatamineIndexer | undefined;
  private size = 0;
  private modifiedMs = 0;
  private identity = new Uint8Array(0);
  private meta: SessionMeta | undefined;
  private notes: Note[] = [];
  private headerRows: [MessageKey, string][] | undefined;
  private formatName: Text = "";
  // indexing or catching up with the file; the search waits for it
  private busy = false;
  private refreshQueued = false;
  private search: SearchRun | undefined;
  private searchStatus: SearchStatus = { matches: 0, progress: 0, state: "idle" };
  // overlay entries that pass the filters, as entry ids
  private overlayIds: number[] = [];
  private serial = 0;
  private version = 0;
  private flags = 0;
  private emittedBase = 0;
  private lastEmit = 0;
  private cache = new Map<number, LogEntry>();
  private feed: LiveFeed | undefined;
  // the last connection being let go of, writing what it has received
  private feedStopping: Promise<void> = Promise.resolve();
  // `<file>.json` of the log shown, when there is one
  private sidecar: Sidecar | undefined;

  constructor(
    private host: Host,
    private emit: (message: WorkerResponse) => void
  ) {}

  private source(): ByteSource {
    return { read: (offset, length) => this.host.read(this.path, offset, length) };
  }

  private stale(generation: number): () => boolean {
    return () => generation !== this.generation;
  }

  // --- opening and following a file

  // Starts over for a new source (a file path or a server URL) and returns its generation.
  private begin(id: number, path: string): number {
    const generation = ++this.generation;
    this.feedStop();
    this.id = id;
    this.path = path;
    this.sourceReset();
    this.busy = true;
    this.emit({ id, type: "reset" });
    return generation;
  }

  // Forgets what was read from the source shown, keeping the filters and the search.
  private sourceReset() {
    this.index.clear();
    this.view.clear();
    this.store = undefined;
    this.kind = undefined;
    this.text = undefined;
    this.datamine = undefined;
    this.sidecar = undefined;
    this.meta = undefined;
    this.notes = [];
    this.headerRows = undefined;
    this.overlayIds = [];
    this.emittedBase = 0;
    this.cache.clear();
    this.refreshQueued = false;
    this.version++;
    if (this.search) {
      this.search.scanned = 0;
      this.search.running = false;
      this.view.matchesClear();
    }
    this.searchStatusSet({ matches: 0, progress: 0, state: this.search ? "waiting" : "idle" });
  }

  async open(id: number, path: string) {
    const generation = this.begin(id, path);
    try {
      await this.load(generation);
    } catch (error) {
      if (generation === this.generation) {
        this.emit({ id, message: error instanceof Error ? error.message : String(error), type: "error" });
      }
    }
    if (generation === this.generation) {
      this.busy = false;
      this.emit({ id, type: "done" });
      this.afterPass();
    }
  }

  private async load(generation: number) {
    const stale = this.stale(generation);
    const stat = await this.host.stat(this.path);
    if (stale()) {
      return;
    }
    this.size = stat.size;
    this.modifiedMs = stat.modifiedMs;
    this.emit({ id: this.id, modifiedMs: stat.modifiedMs, size: stat.size, type: "file" });
    const head = stat.size > 0 ? await this.host.read(this.path, 0, Math.min(stat.size, HEAD_BYTES)) : new Uint8Array(0);
    if (stale()) {
      return;
    }
    this.identity = head.slice(0, IDENTITY_BYTES);
    const format = head.length > 0 ? log_detect_format(baseName(this.path), head) : undefined;
    if (format === "datamine_binary") {
      await this.loadDatamine(generation);
    } else if (format === "datamine_upload") {
      await this.loadUpload(generation);
    } else {
      const text = TEXT_FORMATS.includes(format ?? "") ? (format as t_log_text_format) : undefined;
      this.formatName = formatText(text ?? (head.length === 0 ? "empty" : "plain_text"));
      await this.loadText(generation, text);
    }
  }

  private async loadText(generation: number, format: t_log_text_format | undefined) {
    this.kind = "text";
    this.sidecar = await this.sidecarOpen();
    this.text = new TextIndexer(this.index, format);
    this.store = new TextStore(this.index, this.source(), format, this.sidecar);
    await this.textAdvance(generation);
  }

  // `<file>.json` next to the file, when there is one.
  private async sidecarOpen(): Promise<Sidecar | undefined> {
    const path = sidecarPathOf(this.path);
    try {
      await this.host.stat(path);
    } catch {
      return;
    }
    return new Sidecar(path, { read: (offset, length) => this.host.read(path, offset, length) });
  }

  private async textAdvance(generation: number) {
    const text = this.text;
    if (!text) {
      return;
    }
    const stale = this.stale(generation);
    // the lines of the sidecar are read first, so every entry indexed has its line
    const sidecar = this.sidecar;
    if (sidecar) {
      const stat = await this.host.stat(sidecar.path).catch(() => undefined);
      if (stat) {
        await sidecar.advance(stat.size, stale);
      }
    }
    await text.advance(this.source(), this.size, stale, (done) => this.tick(generation, done));
    if (stale()) {
      return;
    }
    this.index.overlay = await text.overlay(this.source(), this.size, stale);
    if (!stale()) {
      this.sidecarApply();
      this.settle();
    }
  }

  // What the sidecar knows of the sessions: their ids, and the server.
  private sidecarApply() {
    const sidecar = this.sidecar;
    if (!sidecar) {
      return;
    }
    for (const session of this.index.sessions) {
      session.sessionId ??= sidecar.sessions.get(session.id)?.session_id;
    }
    this.index.sessionId ??= sidecar.hello?.session_id;
  }

  private async loadDatamine(generation: number) {
    this.kind = "datamine";
    const datamine = new DatamineIndexer(this.index);
    this.datamine = datamine;
    this.formatName = formatText("datamine_binary");
    await datamine.init(this.source(), this.size);
    const header = log_header_from_datamine(datamine.layout.header);
    this.headerRows = headerRows(header);
    this.index.sessionId = header.sessionid || undefined;
    this.store = new DatamineStore(this.index, this.source(), datamine);
    await this.datamineAdvance(generation);
  }

  private async datamineAdvance(generation: number) {
    const datamine = this.datamine;
    if (!datamine) {
      return;
    }
    const stale = this.stale(generation);
    await datamine.advance(this.source(), this.size, stale, (done) => this.tick(generation, done));
    if (stale()) {
      return;
    }
    this.notes = [];
    if (datamine.brokenAt !== undefined) {
      this.notes.push({ text: { key: "note_record_broken", params: { at: datamine.brokenAt.toLocaleString() } } });
    } else if (datamine.partialAt !== undefined) {
      this.notes.push({ text: { key: "note_record_partial", params: { at: datamine.partialAt.toLocaleString() } } });
    }
    this.settle();
  }

  // A zip upload is inflated whole and kept as entries; uploads are small.
  private async loadUpload(generation: number) {
    this.kind = "upload";
    this.formatName = formatText("datamine_upload");
    const bytes = await this.host.read(this.path, 0, this.size);
    if (generation !== this.generation) {
      return;
    }
    const file = read_datamine_upload(bytes);
    const found = log_entries_from_datamine(file);
    const entries = found.map((entry) => entryMap(entry, true));
    found.forEach((entry, at) => {
      const time = entry.date ? entry.date.getTime() : Number.NaN;
      if (entry.kind === "session") {
        this.index.addSession(at, 0, entry.session?.version ?? "", entry.session?.session_id || undefined, time);
        return;
      }
      this.index.add(at, 0, entry.level ?? -1, entry.category_path ? `${entry.category_path}:` : "", time, entry.event_index ?? -1);
    });
    const header = log_header_from_datamine(file.header);
    this.headerRows = headerRows(header);
    this.index.sessionId = header.sessionid || undefined;
    if (file.truncated_at !== undefined) {
      this.notes.push({ text: { key: "note_record_partial", params: { at: file.truncated_at.toLocaleString() } } });
    }
    this.store = new MemoryStore(entries);
    this.settle();
  }

  // Called after each chunk is indexed: rows and counts show up while the rest is still read.
  private tick(generation: number, done: number) {
    if (generation !== this.generation) {
      return;
    }
    this.emit({ done, id: this.id, total: this.size, type: "progress" });
    const now = Date.now();
    if (now - this.lastEmit >= EMIT_INTERVAL_MS) {
      this.lastEmit = now;
      this.view.extend();
      this.emitStats();
      this.emitView();
      this.emitMeta();
    }
  }

  // After a pass: bring the view up to date, and show the newest entries.
  private settle() {
    this.view.extend();
    this.overlayIds = this.view.overlayRows();
    this.emitStats();
    this.emitView();
    this.emitMeta();
  }

  // The file may have changed: index what was added, or start over when it was replaced.
  async refresh(id: number) {
    if (id !== this.id || !this.path) {
      return;
    }
    if (this.busy) {
      this.refreshQueued = true;
      return;
    }
    const generation = this.generation;
    this.busy = true;
    let reopen = false;
    try {
      const stat = await this.host.stat(this.path);
      if (generation !== this.generation) {
        return;
      }
      if (stat.size !== this.size || stat.modifiedMs !== this.modifiedMs) {
        reopen = await this.refreshApply(generation, stat);
      }
    } catch (error) {
      if (generation === this.generation) {
        // the file went away: say so and keep what is shown
        this.emit({ id: this.id, message: error instanceof Error ? error.message : String(error), type: "error" });
      }
    }
    if (generation !== this.generation) {
      return;
    }
    if (reopen) {
      void this.open(this.id, this.path);
      return;
    }
    this.busy = false;
    this.afterPass();
  }

  // True when the file has to be indexed again from the start.
  private async refreshApply(generation: number, stat: FileStat): Promise<boolean> {
    // an empty file has no format yet, so a file that was empty is read again once it has bytes
    if (this.kind === "upload" || stat.size < this.size || (!this.feed && this.identity.length === 0 && stat.size > 0)) {
      return true;
    }
    // a file recreated with more bytes than before looks like growth; its first bytes tell
    const head = await this.host.read(this.path, 0, Math.min(stat.size, this.identity.length));
    if (generation !== this.generation) {
      return false;
    }
    if (!bytesEqual(head, this.identity)) {
      return true;
    }
    this.size = stat.size;
    this.modifiedMs = stat.modifiedMs;
    this.emit({ id: this.id, modifiedMs: stat.modifiedMs, size: stat.size, type: "file" });
    if (this.kind === "text") {
      await this.textAdvance(generation);
    } else {
      await this.datamineAdvance(generation);
    }
    return false;
  }

  // Search and queued refreshes pick up where indexing stopped.
  private afterPass() {
    if (this.refreshQueued) {
      this.refreshQueued = false;
      void this.refresh(this.id);
    }
    this.searchKick();
  }

  // --- following an event server

  // The entries are spooled to a log file that is indexed like any other as it grows; the connection
  // only writes it. With an older spool of the same server, that is opened first and carried on in.
  connect(id: number, url: string, fresh: boolean) {
    const stopping = this.feedStopping;
    const generation = this.begin(id, url);
    this.busy = false;
    this.formatName = "";
    const feed = new LiveFeed(url, fresh, this.host.spool, stopping, {
      grown: async () => {
        if (generation === this.generation) {
          await this.refresh(id);
        }
      },
      memoryBytes: () => this.index.offsets.length * 30 + (this.sidecar?.memoryBytes() ?? 0),
      open: (path, format) => this.liveOpen(generation, path, format),
      status: (status) => this.feedStatus(generation, status),
    });
    this.feed = feed;
    this.emit({ id, type: "done" });
    feed.start();
  }

  // Shows the spool at `path`, indexed so far. Called when the first bytes are written, or to show
  // an earlier spool before the connection is made.
  private async liveOpen(generation: number, path: string, format?: t_log_text_format): Promise<SpoolOpened> {
    if (generation !== this.generation) {
      throw new Error("closed");
    }
    const reopened = this.kind !== undefined;
    if (reopened) {
      this.sourceReset();
      this.emit({ id: this.id, type: "reset" });
    }
    this.busy = true;
    this.path = path;
    try {
      const stat = await this.host.stat(path);
      this.size = stat.size;
      this.modifiedMs = stat.modifiedMs;
      this.emit({ id: this.id, modifiedMs: stat.modifiedMs, size: stat.size, type: "file" });
      const head = stat.size > 0 ? await this.host.read(path, 0, Math.min(stat.size, HEAD_BYTES)) : new Uint8Array(0);
      this.identity = head.slice(0, IDENTITY_BYTES);
      this.sidecar = await this.sidecarOpen();
      const stale = this.stale(generation);
      if (this.sidecar) {
        const sidecarStat = await this.host.stat(this.sidecar.path);
        await this.sidecar.advance(sidecarStat.size, stale);
      }
      // a spool written under a format that is gone ("event_log") is read as whatever its text looks like
      const spooled = this.sidecar?.spool?.format;
      const named = format ?? (TEXT_FORMATS.includes(spooled ?? "") ? spooled : undefined);
      const text = (named ?? log_detect_format(baseName(path), head)) as t_log_text_format;
      this.formatName = formatText(TEXT_FORMATS.includes(text) ? text : "plain_text");
      await this.loadText(generation, text);
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.afterPass();
        this.emit({ id: this.id, type: "done" });
      }
    }
    return { events: this.index.total - this.index.sessions.length, sidecar: this.sidecar as Sidecar, size: this.size, total: this.index.total };
  }

  // Nothing is open any more.
  close(id: number) {
    this.begin(id, "");
    this.busy = false;
    this.settle();
  }

  async disconnect(id: number) {
    const feed = this.feed;
    if (id === this.id && feed) {
      await feed.stop();
      await this.refresh(id);
      this.feedStatus(this.generation, feed.status());
    }
  }

  // Lets go of the connection of the source being left; what it has received is still written.
  private feedStop() {
    const feed = this.feed;
    this.feed = undefined;
    this.feedStopping = feed ? feed.stop().catch(() => undefined) : Promise.resolve();
  }

  private feedStatus(generation: number, status: LiveStatus) {
    if (generation === this.generation) {
      this.emit({ id: this.id, status, type: "live" });
    }
  }

  // --- what the table shows

  private emitView(force = false) {
    const length = this.view.length;
    const total = length + this.overlayIds.length;
    this.emit({
      count: total,
      dirtyFrom: force ? 0 : Math.min(this.emittedBase, length),
      flags: this.flags,
      id: this.id,
      serial: ++this.serial,
      type: "view",
      version: this.version,
    });
    this.emittedBase = length;
  }

  private emitStats() {
    this.emit({ id: this.id, stats: this.index.snapshot(), type: "stats" });
  }

  private emitMeta() {
    if (!this.kind) {
      return;
    }
    const meta: SessionMeta = {
      bannerVersion: this.index.bannerVersion,
      format: this.formatName,
      header: this.headerRows,
      notes: this.notes,
      server: this.sidecar ? serverRows(this.sidecar) : undefined,
      reportFolder: this.feed ? undefined : reportFolderOf(this.path.replaceAll("\\", "/")),
      sessionId: this.index.sessionId,
    };
    const signature = JSON.stringify(meta);
    if (signature !== JSON.stringify(this.meta)) {
      this.meta = meta;
      this.emit({ id: this.id, meta, type: "meta" });
    }
  }

  filtersSet(filters: Filters, onlyMatches: boolean) {
    this.view.restrict = onlyMatches;
    this.view.filtersSet(filters);
    this.version++;
    this.settle();
    this.searchStatusEmit();
  }

  private entryAtRow(row: number): number | undefined {
    const length = this.view.length;
    if (row < length) {
      return row >= 0 ? this.view.at(row) : undefined;
    }
    return this.overlayIds[row - length];
  }

  // Rows for the table, from the cache when it has them; undefined where an entry could not be read.
  private async rowsFetch(ids: number[]): Promise<(LogEntry | undefined)[]> {
    const store = this.store;
    if (!store) {
      return [];
    }
    const found = new Array<LogEntry | undefined>(ids.length);
    const missing: number[] = [];
    ids.forEach((id, k) => {
      const hit = id < this.index.count ? this.cache.get(id) : undefined;
      if (hit) {
        found[k] = hit;
        // most recently used goes last
        this.cache.delete(id);
        this.cache.set(id, hit);
      } else {
        missing.push(k);
      }
    });
    if (missing.length > 0) {
      const generation = this.generation;
      const read = await store.entries(
        missing.map((k) => ids[k]),
        false
      );
      missing.forEach((k, n) => {
        found[k] = read[n];
        if (generation === this.generation && ids[k] < this.index.count && read[n]) {
          this.cache.set(ids[k], read[n]);
        }
      });
      while (this.cache.size > ROW_CACHE_ROWS) {
        this.cache.delete(this.cache.keys().next().value as number);
      }
    }
    return found;
  }

  // Entries as table rows: marked when the search matched them, and a divider with its session's time.
  private async tableRows(ids: number[]): Promise<(LogEntry | undefined)[]> {
    const entries = await this.rowsFetch(ids);
    const matching = this.view.searchActive;
    return entries.map((entry, k) =>
      entry
        ? {
            ...entry,
            matched: matching && this.view.isMatch(ids[k]),
            // a divider shows the time of its session's first event
            time: entry.kind === "session" ? (entry.time ?? this.sessionAt(ids[k])?.time) : entry.time,
          }
        : undefined
    );
  }

  private async rows(from: number, to: number): Promise<RowsResult> {
    const version = this.version;
    const serial = this.serial;
    const ids: number[] = [];
    const end = Math.min(to, this.view.length + this.overlayIds.length);
    for (let row = Math.max(0, from); row < end; row++) {
      ids.push(this.entryAtRow(row) as number);
    }
    const entries = await this.tableRows(ids);
    return {
      from: Math.max(0, from),
      rows: entries.filter((entry): entry is LogEntry => entry !== undefined),
      serial,
      version,
    };
  }

  private sessionAt(id: number) {
    const at = this.index.sessionIndexBefore(id);
    return this.index.sessions[at]?.id === id ? this.index.sessions[at] : undefined;
  }

  private async detail(id: number): Promise<DetailResult | undefined> {
    const store = this.store;
    const total = this.index.total;
    if (!store || id < 0 || id >= total) {
      return undefined;
    }
    const first = Math.max(0, id - CONTEXT_ENTRIES);
    const ids: number[] = [];
    for (let at = first; at <= Math.min(total - 1, id + CONTEXT_ENTRIES); at++) {
      ids.push(at);
    }
    const [full] = await store.entries([id], true);
    const around = (await this.rowsFetch(ids)).filter((entry): entry is LogEntry => entry !== undefined);
    const session = this.sessionAt(id);
    const result: DetailResult = { around, aroundFrom: first, entry: full };
    if (session) {
      result.entry = { ...full, time: full.time ?? session.time };
      result.sessionStats = this.index.sessionStats(session.number - 1);
    }
    return result;
  }

  async call(call: CallRequest): Promise<unknown> {
    switch (call.name) {
      case "rows":
        return this.rows(call.from, call.to);
      case "detail":
        return this.detail(call.entry);
      case "locate":
        return this.rowOfAll(call.entry);
      case "seek":
        return this.view.rowNear(call.entry);
      case "entryAt":
        return this.entryAtRow(call.row);
      case "matchAt": {
        const entry = this.view.matchEntry(call.position);
        return entry === undefined ? undefined : { entry, row: this.view.rowOf(entry) };
      }
      case "selectionCount":
        return spansSize(this.selectionSpans(call.ranges));
      case "selectionRaw":
        return this.selectionRaw(call.ranges, call.limit, call.mode);
      case "dividerNear":
        return this.dividerNear(call.row);
    }
  }

  // --- selection

  // The row an entry is on, over the view and the overlay rows after it; -1 when the filters hide it.
  private rowOfAll(id: number): number {
    const row = this.view.rowOf(id);
    if (row >= 0) {
      return row;
    }
    const overlay = this.overlayIds.indexOf(id);
    return overlay >= 0 ? this.view.length + overlay : -1;
  }

  // The first row at or after an entry id, over the same rows.
  private rowNearAll(id: number): number {
    const row = this.view.rowNear(id);
    if (row < this.view.length) {
      return row;
    }
    let low = 0;
    let high = this.overlayIds.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.overlayIds[mid] < id) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return this.view.length + low;
  }

  private selectionSpans(ranges: IdRange[]) {
    return rowSpans(ranges, (id) => this.rowNearAll(id));
  }

  // The text of the selected rows, joined by line breaks. The size is worked out from the index first, so
  // a selection that is too big is refused without reading any of it.
  private async selectionRaw(ranges: IdRange[], limit: number, mode: "raw" | "message"): Promise<RawResult> {
    const store = this.store;
    const spans = this.selectionSpans(ranges);
    if (!store || spans.length === 0) {
      return { bytes: 0, rows: 0, text: "" };
    }
    const rows = spansSize(spans);
    let bytes = 0;
    for (const [from, to] of spans) {
      for (let row = from; row < to; row++) {
        bytes += this.index.lengthOf(this.entryAtRow(row) as number);
      }
    }
    if (bytes > limit) {
      return { bytes, rows };
    }
    const generation = this.generation;
    const parts: string[] = [];
    let batch: number[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) {
        return;
      }
      const texts = mode === "raw" ? await store.rawText(batch) : await this.messageTexts(store, batch);
      if (generation !== this.generation) {
        throw new Error("closed");
      }
      for (const text of texts) {
        parts.push(text);
      }
      batch = [];
      batchBytes = 0;
    };
    for (const [from, to] of spans) {
      for (let row = from; row < to; row++) {
        const id = this.entryAtRow(row) as number;
        const length = this.index.lengthOf(id);
        if (batch.length > 0 && (batch.length >= COPY_BATCH_ENTRIES || batchBytes + length > CHUNK_BYTES)) {
          await flush();
        }
        batch.push(id);
        batchBytes += length;
      }
    }
    await flush();
    return { bytes, rows, text: parts.join("\n") };
  }

  // Just the message of each entry; a session divider has only its banner.
  private async messageTexts(store: EntryStore, ids: number[]): Promise<string[]> {
    const entries = await store.entries(ids, true);
    return entries.map((entry) => (entry.kind === "session" ? lineEndTrim(entry.raw ?? entry.text) : entry.message));
  }

  // --- session dividers

  // The ids of the session rows, committed and overlay, ascending.
  sessionIds(): number[] {
    const starts = this.index.sessions.map((session) => session.id);
    this.index.overlay.forEach((entry, at) => {
      if (entry.session) {
        starts.push(this.index.count + at);
      }
    });
    return starts;
  }

  // The divider row at or above `row`, and the row the next one is at (or the end of the table).
  private dividerNear(row: number): DividerResult {
    const total = this.view.length + this.overlayIds.length;
    const id = this.entryAtRow(row);
    if (id === undefined) {
      return { count: total, next: total, row: -1 };
    }
    const starts = this.sessionIds();
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= id) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const after = starts[low];
    // a divider the filters hide has an earlier one standing in for it
    let divider = -1;
    for (let at = low - 1; at >= 0 && divider < 0; at--) {
      divider = this.rowOfAll(starts[at]);
    }
    const next = after === undefined ? total : this.rowNearAll(after);
    return { count: total, next: Math.max(next, row + 1), row: divider };
  }

  // --- search

  private searchStatusSet(status: SearchStatus) {
    this.searchStatus = status;
    this.emit({ id: this.id, status, type: "search" });
  }

  private searchStatusEmit() {
    const state = this.searchStatus.state;
    this.searchStatusSet({ matches: this.view.matchCount, progress: this.searchStatus.progress, state });
  }

  searchSet(spec: SearchSpec | undefined) {
    if (this.search) {
      this.search.running = false;
    }
    this.view.matchesClear();
    this.flags++;
    if (!spec || spec.text === "") {
      this.search = undefined;
    } else {
      try {
        this.search = { match: matcherCreate(spec), running: false, scanned: 0, spec };
      } catch {
        // the main thread has already told the user the pattern is bad
        this.search = undefined;
      }
    }
    this.view.searchActive = this.search !== undefined;
    this.version++;
    this.settle();
    this.searchStatusSet({ matches: 0, progress: 0, state: this.search ? "waiting" : "idle" });
    this.searchKick();
  }

  // The entries from `from` that fit in one chunk of file.
  private batchEnd(from: number): number {
    const { offsets, lengths, count } = this.index;
    const base = offsets[from];
    let to = from + 1;
    while (to < count && to - from < SEARCH_BATCH_ENTRIES && offsets[to] + lengths[to] - base <= CHUNK_BYTES) {
      to++;
    }
    return to;
  }

  private searchProgress(run: SearchRun): number {
    const { count, offsets, lengths } = this.index;
    if (count === 0 || run.scanned >= count) {
      return 1;
    }
    const end = offsets[count - 1] + lengths[count - 1];
    return end > 0 ? offsets[run.scanned] / end : run.scanned / count;
  }

  private searchKick() {
    const run = this.search;
    if (!run || run.running || this.busy || !this.store) {
      return;
    }
    if (run.scanned >= this.index.count) {
      this.searchStatusSet({ matches: this.view.matchCount, progress: 1, state: "done" });
      return;
    }
    void this.searchRun(run, this.generation);
  }

  private async searchRun(run: SearchRun, generation: number) {
    const store = this.store as EntryStore;
    run.running = true;
    let lastEmit = 0;
    try {
      // the next batch is read while the last one is searched
      const batchStart = (from: number) => {
        const to = this.batchEnd(from);
        const promise = store.searchText(from, to);
        promise.catch(() => undefined);
        return { from, promise, to };
      };
      let ahead = run.scanned < this.index.count ? batchStart(run.scanned) : undefined;
      while (ahead && run === this.search && generation === this.generation && !this.busy) {
        const { from, to } = ahead;
        const batch = await ahead.promise;
        if (run !== this.search || generation !== this.generation || !run.running) {
          return;
        }
        ahead = to < this.index.count ? batchStart(to) : undefined;
        // banners are not text to search
        this.view.matchesAdd(run.match(batch).map((k) => from + k).filter((id) => this.index.kinds[id] === 0));
        run.scanned = to;
        const now = Date.now();
        if (now - lastEmit >= EMIT_INTERVAL_MS) {
          lastEmit = now;
          this.flags++;
          if (this.view.restrict) {
            this.version++;
          }
          this.emitView();
          this.searchStatusSet({ matches: this.view.matchCount, progress: this.searchProgress(run), state: "running" });
        }
      }
    } catch (error) {
      // a read failed (the file may have been replaced); the next refresh starts over
      void error;
    } finally {
      if (run === this.search) {
        run.running = false;
      }
    }
    if (run !== this.search || generation !== this.generation) {
      return;
    }
    this.flags++;
    if (this.view.restrict) {
      this.version++;
    }
    this.emitView();
    if (run.scanned >= this.index.count) {
      this.searchStatusSet({ matches: this.view.matchCount, progress: 1, state: "done" });
    } else {
      this.searchStatusSet({ matches: this.view.matchCount, progress: this.searchProgress(run), state: "waiting" });
    }
  }

  // --- what a merged view (merge.ts) reads of each of its sources

  // entries the parser is done with; the ones after are overlay entries
  get committed(): number {
    return this.index.count;
  }

  // Entries a merge can take: the committed ones the view has taken in, and the overlay entries after
  // them once the view has caught up. An overlay entry keeps its id when it is committed.
  get mergeable(): number {
    const processed = this.view.processedCount;
    return processed === this.index.count ? this.index.total : processed;
  }

  // epoch ms of an entry, NaN when it has no date
  timeOf(id: number): number {
    return id < this.index.count ? this.index.times[id] : (this.index.overlay[id - this.index.count]?.time ?? Number.NaN);
  }

  kindOf(id: number): number {
    return this.index.kindOf(id);
  }

  lengthOf(id: number): number {
    return this.index.lengthOf(id);
  }

  // changes when rows of the view moved or changed
  get viewVersion(): number {
    return this.version;
  }

  // changes when only the match marks did
  get viewFlags(): number {
    return this.flags;
  }

  // rows of the view from committed entries; the overlay rows come after them
  get viewLength(): number {
    return this.view.length;
  }

  viewEntry(row: number): number {
    return this.view.at(row);
  }

  // the first row of the view at or after an entry
  viewRowNear(id: number): number {
    return this.view.rowNear(id);
  }

  get overlayRows(): readonly number[] {
    return this.overlayIds;
  }

  // search matches that pass the filters, in file order
  get matchCount(): number {
    return this.view.matchCount;
  }

  matchEntryAt(position: number): number | undefined {
    return this.view.matchEntry(position);
  }

  get searchState(): SearchStatus {
    return this.searchStatus;
  }

  stats(): StatsSnapshot {
    return this.index.snapshot();
  }

  // the connection's status, when the source is an event server
  liveStatus(): LiveStatus | undefined {
    return this.feed?.status();
  }

  entriesFor(ids: number[]): Promise<(LogEntry | undefined)[]> {
    return this.tableRows(ids);
  }

  detailOf(id: number): Promise<DetailResult | undefined> {
    return this.detail(id);
  }

  // the text of entries for a copy, in the order given
  async textsFor(ids: number[], mode: "raw" | "message"): Promise<string[]> {
    const store = this.store;
    if (!store) {
      return ids.map(() => "");
    }
    return mode === "raw" ? store.rawText(ids) : this.messageTexts(store, ids);
  }

  // The view's version and serial, and carrying on from another engine's: the table tells views
  // apart by them, so they never go back when the worker switches between this engine and a merge.
  counters(): { version: number; serial: number } {
    return { serial: this.serial, version: this.version };
  }

  countersFrom(other: { version: number; serial: number }) {
    this.version = Math.max(this.version, other.version) + 1;
    this.serial = Math.max(this.serial, other.serial);
  }

  // lets go of everything, the connection included
  dispose() {
    this.begin(this.id, "");
    this.busy = false;
  }
}
