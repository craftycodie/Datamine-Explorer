// What the explorer keeps of a file: one slot per entry in typed columns, plus a table of the category
// names. Text, parameters and everything else is read from the file again when a row needs it.
import type { SessionInfo, SessionStats, StatsSnapshot } from "../lib/types";

// An entry the parser is still holding (the newest one, whose text may go on): shown, not counted.
export interface OverlayEntry {
  offset: number;
  length: number;
  level: number;
  category: number;
  time: number;
  event: number;
  // set for a session row
  session?: { number: number; version: string; sessionId?: string };
}

const FIRST_CAPACITY = 1 << 16;
const LEVEL_SLOTS = 7;

export class EntryIndex {
  count = 0;
  // byte offset of the entry in the file; files can pass 4 GB
  offsets = new Float64Array(FIRST_CAPACITY);
  lengths = new Uint32Array(FIRST_CAPACITY);
  // -1 when the entry has none
  levels = new Int8Array(FIRST_CAPACITY);
  categories = new Uint32Array(FIRST_CAPACITY);
  // epoch ms, NaN when the entry has no date
  times = new Float64Array(FIRST_CAPACITY);
  events = new Int32Array(FIRST_CAPACITY);
  // 1 for a session row (a banner or a datamine header), 0 for an event
  kinds = new Uint8Array(FIRST_CAPACITY);

  // "networking:session:" with the trailing colon; id 0 is "" for entries without one
  categoryNames: string[] = [""];
  categoryCounts: number[] = [0];
  private categoryIds = new Map<string, number>([["", 0]]);
  // per level 0..5, the last slot is entries without a level
  levelCounts: number[] = new Array(LEVEL_SLOTS).fill(0);
  firstTime: number | undefined;
  lastTime: number | undefined;
  bannerVersion: string | undefined;
  sessionId: string | undefined;
  overlay: OverlayEntry[] = [];
  // the session rows so far, in order
  sessions: SessionInfo[] = [];

  get total(): number {
    return this.count + this.overlay.length;
  }

  clear() {
    this.count = 0;
    this.categoryNames = [""];
    this.categoryCounts = [0];
    this.categoryIds = new Map([["", 0]]);
    this.levelCounts = new Array(LEVEL_SLOTS).fill(0);
    this.firstTime = undefined;
    this.lastTime = undefined;
    this.bannerVersion = undefined;
    this.sessionId = undefined;
    this.overlay = [];
    this.sessions = [];
  }

  categoryId(name: string): number {
    let id = this.categoryIds.get(name);
    if (id === undefined) {
      id = this.categoryNames.length;
      this.categoryIds.set(name, id);
      this.categoryNames.push(name);
      this.categoryCounts.push(0);
    }
    return id;
  }

  private grow() {
    const capacity = Math.ceil(this.offsets.length * 1.5);
    const widen = <T extends Float64Array | Uint32Array | Uint8Array | Int8Array | Int32Array>(old: T): T => {
      const next = new (old.constructor as new (n: number) => T)(capacity);
      next.set(old);
      return next;
    };
    this.offsets = widen(this.offsets);
    this.lengths = widen(this.lengths);
    this.levels = widen(this.levels);
    this.categories = widen(this.categories);
    this.times = widen(this.times);
    this.events = widen(this.events);
    this.kinds = widen(this.kinds);
  }

  add(offset: number, length: number, level: number, category: string, time: number, event: number) {
    if (this.count === this.offsets.length) {
      this.grow();
    }
    const at = this.count++;
    const categoryId = this.categoryId(category);
    this.offsets[at] = offset;
    this.lengths[at] = Math.min(length, 0xff_ff_ff_ff);
    this.kinds[at] = 0;
    this.levels[at] = level;
    this.categories[at] = categoryId;
    this.times[at] = time;
    // too big for 32 bits is left out; the row shows the real number
    this.events[at] = event >= 0 && event <= 0x7f_ff_ff_ff ? event : -1;
    this.levelCounts[level < 0 ? LEVEL_SLOTS - 1 : level]++;
    this.categoryCounts[categoryId]++;
    if (!Number.isNaN(time)) {
      this.firstTime ??= time;
      this.lastTime = Math.max(this.lastTime ?? time, time);
      const session = this.sessions.at(-1);
      if (session && session.time === undefined) {
        session.time = time;
      }
    }
  }

  // A session row takes a slot but is not counted as an event. `time` is its own date, when it has one.
  addSession(offset: number, length: number, version: string, sessionId: string | undefined, time: number) {
    if (this.count === this.offsets.length) {
      this.grow();
    }
    const at = this.count++;
    this.offsets[at] = offset;
    this.lengths[at] = length;
    this.kinds[at] = 1;
    this.levels[at] = -1;
    this.categories[at] = 0;
    this.times[at] = Number.NaN;
    this.events[at] = -1;
    this.sessions.push({
      id: at,
      number: this.sessions.length + 1,
      sessionId,
      time: Number.isNaN(time) ? undefined : time,
      version,
    });
  }

  // The session whose events come at this entry: the last session row before it.
  sessionIndexBefore(id: number): number {
    let low = 0;
    let high = this.sessions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.sessions[mid].id <= id) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low - 1;
  }

  // Events, levels and times of the entries between a session row and the next one.
  sessionStats(session: number): SessionStats {
    const from = this.sessions[session].id + 1;
    const to = this.sessions[session + 1]?.id ?? this.count;
    const stats: SessionStats = { count: 0, levelCounts: new Array(LEVEL_SLOTS).fill(0) };
    for (let id = from; id < to; id++) {
      stats.count++;
      stats.levelCounts[this.levels[id] < 0 ? LEVEL_SLOTS - 1 : this.levels[id]]++;
      const time = this.times[id];
      if (!Number.isNaN(time)) {
        stats.firstTime = stats.firstTime === undefined ? time : Math.min(stats.firstTime, time);
        stats.lastTime = stats.lastTime === undefined ? time : Math.max(stats.lastTime, time);
      }
    }
    return stats;
  }

  kindOf(id: number): number {
    return id < this.count ? this.kinds[id] : this.overlay[id - this.count]?.session ? 1 : 0;
  }

  offsetOf(id: number): number {
    return id < this.count ? this.offsets[id] : (this.overlay[id - this.count]?.offset ?? 0);
  }

  lengthOf(id: number): number {
    return id < this.count ? this.lengths[id] : (this.overlay[id - this.count]?.length ?? 0);
  }

  levelOf(id: number): number {
    return id < this.count ? this.levels[id] : (this.overlay[id - this.count]?.level ?? -1);
  }

  categoryOf(id: number): number {
    return id < this.count ? this.categories[id] : (this.overlay[id - this.count]?.category ?? 0);
  }

  // Counts include the overlay entries, which are not in the columns.
  snapshot(): StatsSnapshot {
    const levelCounts = [...this.levelCounts];
    const counts = [...this.categoryCounts];
    let lastTime = this.lastTime;
    let firstTime = this.firstTime;
    let events = this.count - this.sessions.length;
    const sessions = this.sessions.map((session) => ({ ...session }));
    for (const [at, entry] of this.overlay.entries()) {
      if (entry.session) {
        sessions.push({ id: this.count + at, ...entry.session, number: sessions.length + 1 });
        continue;
      }
      events++;
      const open = sessions.at(-1);
      if (open && open.time === undefined && !Number.isNaN(entry.time)) {
        open.time = entry.time;
      }
      levelCounts[entry.level < 0 ? LEVEL_SLOTS - 1 : entry.level]++;
      counts[entry.category]++;
      if (!Number.isNaN(entry.time)) {
        firstTime ??= entry.time;
        lastTime = Math.max(lastTime ?? entry.time, entry.time);
      }
    }
    const categories: [string, number][] = [];
    for (let id = 0; id < counts.length; id++) {
      if (counts[id] > 0) {
        categories.push([this.categoryNames[id], counts[id]]);
      }
    }
    return { categories, count: events, firstTime, lastTime, levelCounts, sessions };
  }
}
