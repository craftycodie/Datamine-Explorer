// Several files and servers in one feed. Each source has an engine of its own, which indexes,
// filters and searches it as if it were open alone; the merge interleaves their entries by time and
// answers for the rows with ids of its own: an entry's merged id is its place in that order, so the
// rows of the merged view are in id order like any other view.
//
// While a source is still being read the order is worked out again from the start whenever it
// changes. Once every source has been read, new entries go on the end in the order of their times,
// so the ids of what is shown do not move under a selection.
import type { IdRange } from "../lib/selection";
import type { DetailResult, LiveStatus, LogEntry, SearchStatus, SessionInfo, SessionMeta, SourceSpec, SourceStatus } from "../lib/types";
import { type Host, LogEngine } from "./engine";
import type { CallRequest, DividerResult, RawResult, RowsResult, WorkerResponse } from "./protocol";
import { rowSpans, spansSize } from "./raw-copy";
import { CHUNK_BYTES } from "./source";
import type { Filters, SearchSpec } from "../lib/filter";

const UPDATE_MS = 150;
// A full reorder is not run again sooner than this many times what the last one took.
const REORDER_SPACING = 4;
// Files are polled for growth this often; a merge has no watcher of its own.
const POLL_MS = 1000;
const COPY_BATCH_ENTRIES = 20_000;

class U32List {
  data = new Uint32Array(1 << 12);
  length = 0;

  push(value: number) {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }

  // makes room for index `at`, keeping what is there
  reserve(at: number) {
    if (at >= this.data.length) {
      let size = this.data.length;
      while (size <= at) {
        size *= 2;
      }
      const next = new Uint32Array(size);
      next.set(this.data);
      this.data = next;
    }
  }
}

// Index of the first element that is >= value.
function lowerBound(data: Uint32Array, length: number, value: number): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (data[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

interface Member {
  spec: SourceSpec;
  engine: LogEngine;
  // the id this member's engine is driven with
  childId: number;
  // read as far as its first pass: a file opened, a server's spool shown
  settled: boolean;
  // a server's spool has started to be read since the last reset
  sawFile: boolean;
  failed?: string;
  live?: LiveStatus;
  meta?: SessionMeta;
  size: number;
  indexed: number;
  // committed entries in the merged order so far, and the merged id of each
  merged: number;
  toMerged: U32List;
  // the time an entry without one takes: the last one before it
  carry: number;
  // leading entries without a time take the first time after them; ids below `aheadUntil` have `aheadTime`
  aheadUntil: number;
  aheadTime: number;
  // the view of the engine as the merged view was built from it
  seenVersion: number;
  viewAt: number;
}

export class MergeEngine {
  private id = 0;
  private members: Member[] = [];
  private nextChild = 0;
  // the merged order: which member and which of its entries
  private orderMember = new Uint8Array(1 << 12);
  private orderLocal = new U32List();
  private orderCount = 0;
  // the rows: merged ids that pass the filters, ascending
  private rows = new U32List();
  // merged ids taken into the rows, and the first one that may still change
  private viewDone = 0;
  private volatileFrom = 0;
  // the first row the last build worked out again
  private rebuiltFrom = 0;
  private version = 0;
  private flagsOwn = 0;
  private serial = 0;
  private emittedRows = 0;
  private reorderWanted = true;
  private reorderNext = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private matchCache: { key: string; ids: Uint32Array } | undefined;
  private filters: { filters: Filters; onlyMatches: boolean } | undefined;
  private search: SearchSpec | undefined;
  private lastSources = "";
  private lastMeta = "";
  private sourceInclude = new Set<string>();
  private sourceExclude = new Set<string>();
  // the source filter changed: the rows are built again
  private viewStale = false;
  private doneSent = false;

  constructor(
    private host: Host,
    private emit: (message: WorkerResponse) => void
  ) {}

  get active(): boolean {
    return this.members.length > 0;
  }

  // as for LogEngine.counters
  counters(): { version: number; serial: number } {
    return { serial: this.serial, version: this.version };
  }

  countersFrom(other: { version: number; serial: number }) {
    this.version = Math.max(this.version, other.version) + 1;
    this.serial = Math.max(this.serial, other.serial);
  }

  // The sources to show, in order. Ones already open carry on; the rest are opened.
  sourcesSet(id: number, specs: SourceSpec[]) {
    this.id = id;
    const kept = new Map(this.members.map((member) => [member.spec.key, member]));
    const next: Member[] = [];
    for (const spec of specs) {
      const old = kept.get(spec.key);
      if (old && old.spec.target === spec.target && old.spec.kind === spec.kind) {
        old.spec = spec;
        kept.delete(spec.key);
        next.push(old);
      } else {
        next.push(this.memberOpen(spec));
      }
    }
    for (const gone of kept.values()) {
      gone.engine.dispose();
    }
    this.members = next;
    this.emit({ id, type: "reset" });
    this.lastSources = "";
    this.lastMeta = "";
    this.doneSent = false;
    this.reorderWanted = true;
    this.reorderNext = 0;
    this.poll ??= setInterval(() => this.pollFiles(), POLL_MS);
    this.update();
  }

  private memberOpen(spec: SourceSpec): Member {
    const childId = ++this.nextChild;
    const member: Member = {
      aheadTime: Number.NaN,
      aheadUntil: 0,
      carry: Number.NaN,
      childId,
      engine: undefined as unknown as LogEngine,
      indexed: 0,
      merged: 0,
      sawFile: false,
      seenVersion: -1,
      settled: false,
      size: 0,
      spec,
      toMerged: new U32List(),
      viewAt: 0,
    };
    member.engine = new LogEngine(this.host, (message) => this.childMessage(member, message));
    if (this.filters) {
      member.engine.filtersSet(this.filters.filters, this.filters.onlyMatches);
    }
    if (this.search) {
      member.engine.searchSet(this.search);
    }
    if (spec.kind === "server") {
      member.engine.connect(childId, spec.target, false);
    } else {
      void member.engine.open(childId, spec.target);
    }
    return member;
  }

  close(id: number) {
    this.id = id;
    for (const member of this.members) {
      member.engine.dispose();
    }
    this.members = [];
    clearInterval(this.poll);
    this.poll = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.orderCount = 0;
    this.rows.length = 0;
    this.viewDone = 0;
    this.volatileFrom = 0;
    this.matchCache = undefined;
  }

  // Which sources are shown, by key, like the category filters: some only, or all but some.
  sourceFilterSet(include: string[], exclude: string[]) {
    this.sourceInclude = new Set(include);
    this.sourceExclude = new Set(exclude);
    this.viewStale = true;
    this.soon();
  }

  private sourceShown(member: Member): boolean {
    const key = member.spec.key;
    return (this.sourceInclude.size === 0 || this.sourceInclude.has(key)) && !this.sourceExclude.has(key);
  }

  filtersSet(filters: Filters, onlyMatches: boolean) {
    this.filters = { filters, onlyMatches };
    for (const member of this.members) {
      member.engine.filtersSet(filters, onlyMatches);
    }
    this.soon();
  }

  searchSet(spec: SearchSpec | undefined) {
    this.search = spec;
    for (const member of this.members) {
      member.engine.searchSet(spec);
    }
    this.soon();
  }

  private pollFiles() {
    for (const member of this.members) {
      if (member.spec.kind === "file" && member.settled) {
        void member.engine.refresh(member.childId);
      }
    }
  }

  private childMessage(member: Member, message: WorkerResponse) {
    if (!this.members.includes(member)) {
      return;
    }
    switch (message.type) {
      case "reset":
        // its entries are numbered from the start again
        member.settled = false;
        member.sawFile = false;
        member.failed = undefined;
        member.merged = 0;
        member.indexed = 0;
        member.carry = Number.NaN;
        member.aheadUntil = 0;
        this.reorderWanted = true;
        break;
      case "file":
        member.size = message.size;
        member.sawFile = true;
        break;
      case "progress":
        member.indexed = message.done;
        break;
      case "done":
        // a server's engine is done at once, before anything of its spool is read
        if (member.spec.kind === "file" || member.sawFile) {
          member.settled = true;
        }
        break;
      case "error":
        member.failed = message.message;
        if (member.spec.kind === "file") {
          member.settled = true;
        }
        break;
      case "live":
        member.live = message.status;
        // a server with nothing to read, or one that is gone, has nothing more to wait for
        if (!member.sawFile && (message.status.state === "closed" || (message.status.state === "live" && message.status.entries === 0))) {
          member.settled = true;
        }
        break;
      case "meta":
        member.meta = message.meta;
        break;
      default:
        break;
    }
    this.soon();
  }

  private soon() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.update();
    }, UPDATE_MS);
  }

  // --- the merged order

  private get settled(): boolean {
    return this.members.every((member) => member.settled);
  }

  private update() {
    if (this.members.length === 0) {
      return;
    }
    let reordered = false;
    // an entry the parser held may be gone (read again as part of the one before): start over
    if (this.members.some((member) => member.engine.mergeable < member.merged)) {
      this.reorderWanted = true;
    }
    if (this.reorderWanted || !this.settled) {
      const now = performance.now();
      if (now >= this.reorderNext) {
        this.reorder();
        const took = performance.now() - now;
        this.reorderNext = performance.now() + took * REORDER_SPACING;
        // one more once every source is read, so the last of them is in place
        this.reorderWanted = !this.settled;
        reordered = true;
      } else {
        this.soon();
      }
    } else {
      this.append();
    }
    const changed = reordered || this.viewStale || this.members.some((member) => member.engine.viewVersion !== member.seenVersion);
    this.viewStale = false;
    this.viewBuild(changed);
    this.emitAll(changed);
  }

  // The time an entry is put in order by.
  private timeOf(member: Member, local: number, end: number): number {
    const time = member.engine.timeOf(local);
    if (!Number.isNaN(time)) {
      member.carry = time;
      return time;
    }
    if (!Number.isNaN(member.carry)) {
      return member.carry;
    }
    // nothing before it has a time: it goes with the first entry after it that has one
    if (local >= member.aheadUntil) {
      member.aheadTime = Number.NEGATIVE_INFINITY;
      member.aheadUntil = end;
      for (let at = local + 1; at < end; at++) {
        const next = member.engine.timeOf(at);
        if (!Number.isNaN(next)) {
          member.aheadTime = next;
          member.aheadUntil = at;
          break;
        }
      }
    }
    return member.aheadTime;
  }

  private orderPush(member: number, local: number) {
    const at = this.orderCount++;
    if (at >= this.orderMember.length) {
      const next = new Uint8Array(this.orderMember.length * 2);
      next.set(this.orderMember);
      this.orderMember = next;
    }
    this.orderMember[at] = member;
    this.orderLocal.reserve(at);
    this.orderLocal.data[at] = local;
    this.orderLocal.length = this.orderCount;
    const target = this.members[member];
    target.toMerged.reserve(local);
    target.toMerged.data[local] = at;
    target.toMerged.length = Math.max(target.toMerged.length, local + 1);
  }

  // Puts each member's entries from `merged` on in time order after what is there; ties go to the
  // source listed first.
  private interleave() {
    const members = this.members;
    const ends = members.map((member) => member.engine.mergeable);
    const heads = members.map((member) => member.merged);
    const times = members.map((member, k) => (heads[k] < ends[k] ? this.timeOf(member, heads[k], ends[k]) : Number.NaN));
    for (;;) {
      let best = -1;
      for (let k = 0; k < members.length; k++) {
        if (heads[k] < ends[k] && (best < 0 || times[k] < times[best])) {
          best = k;
        }
      }
      if (best < 0) {
        break;
      }
      this.orderPush(best, heads[best]);
      heads[best]++;
      members[best].merged = heads[best];
      if (heads[best] < ends[best]) {
        times[best] = this.timeOf(members[best], heads[best], ends[best]);
      }
    }
  }

  private reorder() {
    this.orderCount = 0;
    this.orderLocal.length = 0;
    for (const member of this.members) {
      member.merged = 0;
      member.carry = Number.NaN;
      member.aheadUntil = 0;
      member.toMerged.length = 0;
    }
    this.interleave();
    this.version++;
    this.matchCache = undefined;
  }

  private append() {
    if (this.members.some((member) => member.engine.mergeable > member.merged)) {
      this.interleave();
    }
  }

  // --- the merged view

  // Rows from merged id `from` on are worked out again; the ones before cannot have changed.
  private viewBuild(full: boolean) {
    const rows = this.rows;
    const members = this.members;
    if (full) {
      for (const member of members) {
        member.seenVersion = member.engine.viewVersion;
      }
      this.version++;
      this.matchCache = undefined;
    }
    const from = full ? 0 : Math.min(this.volatileFrom, this.viewDone);
    rows.length = lowerBound(rows.data, rows.length, from);
    this.rebuiltFrom = rows.length;
    // where each member's view is at `from`: its first entry at or after it in the merged order
    const overlay = members.map((member) => new Set(member.engine.overlayRows));
    for (const member of members) {
      member.viewAt = member.engine.viewRowNear(lowerBound(member.toMerged.data, member.merged, from));
    }
    const orderMember = this.orderMember;
    const orderLocal = this.orderLocal.data;
    const shown = members.map((member) => this.sourceShown(member));
    for (let id = from; id < this.orderCount; id++) {
      const index = orderMember[id];
      if (!shown[index]) {
        continue;
      }
      const member = members[index];
      const local = orderLocal[id];
      const engine = member.engine;
      const length = engine.viewLength;
      while (member.viewAt < length && engine.viewEntry(member.viewAt) < local) {
        member.viewAt++;
      }
      if (member.viewAt < length && engine.viewEntry(member.viewAt) === local) {
        rows.push(id);
        member.viewAt++;
      } else if (overlay[index].has(local)) {
        rows.push(id);
      }
    }
    this.viewDone = this.orderCount;
    // An entry the parser still holds can change, and so can whether the divider before it shows: from
    // the first of those on, the rows are worked out again next time.
    let volatile = this.orderCount;
    for (const member of members) {
      const committed = member.engine.committed;
      if (committed < member.merged) {
        volatile = Math.min(volatile, member.toMerged.data[committed]);
      }
      for (const local of member.engine.overlayRows) {
        if (local < member.merged) {
          volatile = Math.min(volatile, member.toMerged.data[local]);
        }
      }
    }
    this.volatileFrom = volatile;
  }

  // Which member and which of its entries a merged id is.
  private split(id: number): { member: Member; index: number; local: number } | undefined {
    if (id < 0 || id >= this.orderCount) {
      return undefined;
    }
    const index = this.orderMember[id];
    return { index, local: this.orderLocal.data[id], member: this.members[index] };
  }

  // The merged id of a member's entry, -1 when it is not in the merged order (yet).
  private mergedOf(index: number, local: number): number {
    const member = this.members[index];
    return local >= 0 && local < member.merged ? member.toMerged.data[local] : -1;
  }

  private rowOf(id: number): number {
    const row = lowerBound(this.rows.data, this.rows.length, id);
    return row < this.rows.length && this.rows.data[row] === id ? row : -1;
  }

  private rowNear(id: number): number {
    return lowerBound(this.rows.data, this.rows.length, id);
  }

  // --- telling the main thread

  private emitAll(full: boolean) {
    const flags = this.flagsOwn + this.members.reduce((sum, member) => sum + member.engine.viewFlags, 0);
    this.emit({
      count: this.rows.length,
      dirtyFrom: full ? 0 : Math.min(this.emittedRows, this.rebuiltFrom),
      flags,
      id: this.id,
      serial: ++this.serial,
      type: "view",
      version: this.version,
    });
    this.emittedRows = this.rows.length;
    this.emitStats();
    this.emitSearch();
    this.emitSources();
    const size = this.members.reduce((sum, member) => sum + member.size, 0);
    const indexed = this.members.reduce((sum, member) => sum + (member.settled ? member.size : member.indexed), 0);
    this.emit({ id: this.id, modifiedMs: 0, size, type: "file" });
    this.emit({ done: indexed, id: this.id, total: size, type: "progress" });
    const settled = this.settled;
    if (settled && !this.doneSent) {
      this.emit({ id: this.id, type: "done" });
    }
    this.doneSent = settled;
  }

  private emitStats() {
    let count = 0;
    let firstTime: number | undefined;
    let lastTime: number | undefined;
    const levelCounts: number[] = [];
    const categories = new Map<string, number>();
    const sessions: SessionInfo[] = [];
    this.members.forEach((member, index) => {
      const stats = member.engine.stats();
      count += stats.count;
      stats.levelCounts.forEach((n, slot) => {
        levelCounts[slot] = (levelCounts[slot] ?? 0) + n;
      });
      for (const [name, n] of stats.categories) {
        categories.set(name, (categories.get(name) ?? 0) + n);
      }
      if (stats.firstTime !== undefined) {
        firstTime = firstTime === undefined ? stats.firstTime : Math.min(firstTime, stats.firstTime);
      }
      if (stats.lastTime !== undefined) {
        lastTime = lastTime === undefined ? stats.lastTime : Math.max(lastTime, stats.lastTime);
      }
      for (const session of stats.sessions) {
        const id = this.mergedOf(index, session.id);
        if (id >= 0) {
          sessions.push({ ...session, id, source: member.spec.name });
        }
      }
    });
    sessions.sort((a, b) => a.id - b.id);
    this.emit({ id: this.id, stats: { categories: [...categories], count, firstTime, lastTime, levelCounts, sessions }, type: "stats" });
    const notes = this.members.flatMap((member) => [
      ...(member.failed ? [{ source: member.spec.name, text: member.failed }] : []),
      ...(member.meta?.notes ?? []).map((note) => ({ ...note, source: member.spec.name })),
    ]);
    const meta: SessionMeta = { format: { key: this.members.length === 1 ? "format_sources_one" : "format_sources_other", params: { count: this.members.length } }, notes };
    const signature = JSON.stringify(meta);
    if (signature !== this.lastMeta) {
      this.lastMeta = signature;
      this.emit({ id: this.id, meta, type: "meta" });
    }
  }

  private emitSearch() {
    const states = this.members.map((member) => member.engine.searchState);
    const has = (state: SearchStatus["state"]) => states.some((status) => status.state === state);
    const state: SearchStatus["state"] = has("running") ? "running" : has("waiting") ? "waiting" : has("done") ? "done" : "idle";
    const progress = states.length ? states.reduce((sum, status) => sum + status.progress, 0) / states.length : 0;
    this.emit({ id: this.id, status: { matches: this.matchIds().length, progress, state }, type: "search" });
  }

  private emitSources() {
    const sources: SourceStatus[] = this.members.map((member) => {
      const live = member.live;
      let state: SourceStatus["state"];
      if (member.spec.kind === "server") {
        state = live?.state ?? "connecting";
      } else {
        state = member.failed ? "failed" : member.settled ? "ready" : "loading";
      }
      return {
        entries: member.engine.stats().count,
        error: member.failed ?? live?.error,
        key: member.spec.key,
        prefix: live?.prefix,
        state,
      };
    });
    const signature = JSON.stringify(sources);
    if (signature !== this.lastSources) {
      this.lastSources = signature;
      this.emit({ id: this.id, sources, type: "sources" });
    }
  }

  // The search matches that pass the filters, as merged ids in order.
  private matchIds(): Uint32Array {
    const key = `${this.version}:${this.orderCount}:${this.members.map((member) => member.engine.matchCount).join(",")}`;
    if (this.matchCache?.key === key) {
      return this.matchCache.ids;
    }
    const ids: number[] = [];
    this.members.forEach((member, index) => {
      if (!this.sourceShown(member)) {
        return;
      }
      for (let position = 0; position < member.engine.matchCount; position++) {
        const local = member.engine.matchEntryAt(position) as number;
        const id = this.mergedOf(index, local);
        if (id >= 0) {
          ids.push(id);
        }
      }
    });
    const sorted = Uint32Array.from(ids).sort();
    this.matchCache = { ids: sorted, key };
    return sorted;
  }

  // --- answering calls

  async call(call: CallRequest): Promise<unknown> {
    switch (call.name) {
      case "rows":
        return this.rowsRead(call.from, call.to);
      case "detail":
        return this.detail(call.entry);
      case "locate":
        return this.rowOf(call.entry);
      case "seek":
        return this.rowNear(call.entry);
      case "entryAt":
        return call.row >= 0 && call.row < this.rows.length ? this.rows.data[call.row] : undefined;
      case "matchAt": {
        const ids = this.matchIds();
        const entry = call.position >= 0 && call.position < ids.length ? ids[call.position] : undefined;
        return entry === undefined ? undefined : { entry, row: this.rowOf(entry) };
      }
      case "selectionCount":
        return spansSize(rowSpans(call.ranges, (id) => this.rowNear(id)));
      case "selectionRaw":
        return this.selectionRaw(call.ranges, call.limit, call.mode);
      case "dividerNear":
        return this.dividerNear(call.row);
    }
  }

  // Reads entries by merged id, a member at a time, and gives them back in the order asked.
  private async entries(ids: number[]): Promise<(LogEntry | undefined)[]> {
    const groups = new Map<number, { locals: number[]; at: number[] }>();
    ids.forEach((id, at) => {
      const found = this.split(id);
      if (!found) {
        return;
      }
      const group = groups.get(found.index) ?? { at: [], locals: [] };
      group.locals.push(found.local);
      group.at.push(at);
      groups.set(found.index, group);
    });
    const out = new Array<LogEntry | undefined>(ids.length);
    await Promise.all(
      [...groups].map(async ([index, group]) => {
        const member = this.members[index];
        const read = await member.engine.entriesFor(group.locals);
        read.forEach((entry, k) => {
          if (entry) {
            out[group.at[k]] = { ...entry, ordinal: ids[group.at[k]], source: member.spec.name };
          }
        });
      })
    );
    return out;
  }

  private async rowsRead(from: number, to: number): Promise<RowsResult> {
    const version = this.version;
    const serial = this.serial;
    const start = Math.max(0, from);
    const end = Math.min(to, this.rows.length);
    const ids: number[] = [];
    for (let row = start; row < end; row++) {
      ids.push(this.rows.data[row]);
    }
    const read = await this.entries(ids);
    return { from: start, rows: read.filter((entry): entry is LogEntry => entry !== undefined), serial, version };
  }

  private async detail(id: number): Promise<DetailResult | undefined> {
    const found = this.split(id);
    if (!found) {
      return undefined;
    }
    const detail = await found.member.engine.detailOf(found.local);
    if (!detail) {
      return undefined;
    }
    const name = found.member.spec.name;
    const aroundIds = detail.around.map((entry) => this.mergedOf(found.index, entry.ordinal));
    return {
      ...detail,
      around: detail.around.map((entry, k) => ({ ...entry, ordinal: aroundIds[k], source: name })),
      aroundIds,
      entry: { ...detail.entry, ordinal: id, source: name },
    };
  }

  private async selectionRaw(ranges: IdRange[], limit: number, mode: "raw" | "message"): Promise<RawResult> {
    const spans = rowSpans(ranges, (id) => this.rowNear(id));
    if (spans.length === 0) {
      return { bytes: 0, rows: 0, text: "" };
    }
    const rows = spansSize(spans);
    const picked: { index: number; local: number }[] = [];
    let bytes = 0;
    for (const [from, to] of spans) {
      for (let row = from; row < to; row++) {
        const found = this.split(this.rows.data[row]);
        if (found) {
          picked.push({ index: found.index, local: found.local });
          bytes += found.member.engine.lengthOf(found.local);
        }
      }
    }
    if (bytes > limit) {
      return { bytes, rows };
    }
    const parts: string[] = [];
    // runs of one member are read together, in table order
    let at = 0;
    while (at < picked.length) {
      const index = picked[at].index;
      const engine = this.members[index].engine;
      const locals: number[] = [];
      let runBytes = 0;
      while (at < picked.length && picked[at].index === index && locals.length < COPY_BATCH_ENTRIES && runBytes <= CHUNK_BYTES) {
        locals.push(picked[at].local);
        runBytes += engine.lengthOf(picked[at].local);
        at++;
      }
      for (const text of await engine.textsFor(locals, mode)) {
        parts.push(text);
      }
    }
    return { bytes, rows, text: parts.join("\n") };
  }

  // The divider row at or above `row`, and the row the next one is at, over every source's dividers.
  private dividerNear(row: number): DividerResult {
    const total = this.rows.length;
    if (row < 0 || row >= total) {
      return { count: total, next: total, row: -1 };
    }
    const id = this.rows.data[row];
    const starts: number[] = [];
    this.members.forEach((member, index) => {
      for (const local of member.engine.sessionIds()) {
        const merged = this.mergedOf(index, local);
        if (merged >= 0) {
          starts.push(merged);
        }
      }
    });
    starts.sort((a, b) => a - b);
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
    let divider = -1;
    for (let at = low - 1; at >= 0 && divider < 0; at--) {
      divider = this.rowOf(starts[at]);
    }
    const next = after === undefined ? total : this.rowNear(after);
    return { count: total, next: Math.max(next, row + 1), row: divider };
  }
}
