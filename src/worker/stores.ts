// Reads entries back out of the file by their byte ranges, and hands the search their text.
import {
  c_log_text_parser,
  log_entries_from_datamine,
  read_datamine_file,
  type s_log_entry,
  type t_log_text_format,
} from "@blamnetwork/datamine/reading";
import type { LogEntry } from "../lib/types";
import { type DatamineIndexer, type DatamineRecord, OCCURRENCE_DEFINITION_AT, recordsRead } from "./datamine-indexer";
import type { EntryIndex } from "./entry-index";
import { entryMap, parameterTypeName, plainEntry, textDecode } from "./entry-map";
import type { Sidecar, SidecarEntry } from "./sidecar";
import { lineEndTrim, readSegments } from "./raw-copy";
import { type ByteSource, CHUNK_BYTES, ENTRY_BYTES_MAXIMUM } from "./source";

// Entries this close together are read with one call.
const READ_GAP_BYTES = 64 * 1024;

// The text of a run of entries for the search: `text` holds them all, and entry k is
// text[starts[k]..ends[k]). Whatever lies between entries is not part of any of them.
export interface SearchText {
  text: string;
  starts: Uint32Array;
  ends: Uint32Array;
}

export interface EntryStore {
  // The entries with these ids, ascending. `full` keeps the whole text, raw lines and parameters.
  entries(ids: number[], full: boolean): Promise<LogEntry[]>;
  searchText(from: number, to: number): Promise<SearchText>;
  // The original text of these entries, ascending: the lines as they are in the file, without the
  // break that ends the last one.
  rawText(ids: number[]): Promise<string[]>;
}

// What a store without the file's own lines has to give back for an entry.
function entryRawText(entry: LogEntry): string {
  return lineEndTrim(entry.raw ?? (entry.text || entry.message));
}

function lengthRead(index: EntryIndex, id: number): number {
  return Math.min(index.lengthOf(id), ENTRY_BYTES_MAXIMUM);
}

// Calls `each` with the bytes of every id, reading neighbours together.
async function rangesRead(
  index: EntryIndex,
  source: ByteSource,
  ids: number[],
  each: (k: number, bytes: Uint8Array) => void
) {
  let k = 0;
  while (k < ids.length) {
    const start = index.offsetOf(ids[k]);
    let end = start + lengthRead(index, ids[k]);
    let last = k;
    while (last + 1 < ids.length) {
      const offset = index.offsetOf(ids[last + 1]);
      const stop = offset + lengthRead(index, ids[last + 1]);
      if (offset - end > READ_GAP_BYTES || stop - start > CHUNK_BYTES) {
        break;
      }
      end = Math.max(end, stop);
      last++;
    }
    const bytes = await source.read(start, end - start);
    for (let at = k; at <= last; at++) {
      const offset = index.offsetOf(ids[at]) - start;
      each(at, bytes.subarray(offset, offset + lengthRead(index, ids[at])));
    }
    k = last + 1;
  }
}

function idsBetween(from: number, to: number): number[] {
  const ids: number[] = [];
  for (let id = from; id < to; id++) {
    ids.push(id);
  }
  return ids;
}

// What a log's sidecar adds to an entry the text line gave.
function sidecarApply(entry: LogEntry, line: SidecarEntry) {
  entry.eventIndex = line.index;
  entry.sessionNumber = line.session;
  if (line.context !== undefined) {
    entry.context = line.context;
  }
  if (line.thread_id !== undefined) {
    entry.threadId = line.thread_id;
  }
  if (line.game_time !== undefined) {
    entry.gameTime = line.game_time;
  }
  if (line.frame_index !== undefined) {
    entry.frameIndex = line.frame_index;
  }
  if (line.parameters) {
    entry.parameters = line.parameters.map((p) => ({ name: p.name, type: parameterTypeName(p.type), value: String(p.value) }));
  }
}

export class TextStore implements EntryStore {
  constructor(
    private index: EntryIndex,
    private source: ByteSource,
    private format: t_log_text_format | undefined,
    private sidecar?: Sidecar
  ) {}

  private parse(bytes: Uint8Array, id: number, full: boolean): LogEntry {
    const text = textDecode(bytes);
    if (!this.format) {
      return plainEntry(text.replace(/\r?\n$/, ""), id, full);
    }
    const parser = new c_log_text_parser(this.format);
    const found = [...parser.push(text), ...parser.finish()][0];
    if (!found) {
      return plainEntry(text.trimEnd(), id, full);
    }
    const entry = entryMap({ ...found, ordinal: id }, full);
    if (entry.session) {
      // a parser that starts at the banner counts one session; the file knows which one it is
      const at = this.index.sessionIndexBefore(id);
      entry.session.number = this.index.sessions[at]?.id === id ? this.index.sessions[at].number : this.index.sessions.length + 1;
    }
    return entry;
  }

  async entries(ids: number[], full: boolean): Promise<LogEntry[]> {
    const out = new Array<LogEntry>(ids.length);
    await rangesRead(this.index, this.source, ids, (k, bytes) => {
      out[k] = this.parse(bytes, ids[k], full);
    });
    // the detail pane wants the parameters and the rest; rows do not
    if (full && this.sidecar) {
      const lines = await this.sidecar.entries(ids.filter((id) => this.index.kindOf(id) === 0));
      ids.forEach((id, k) => {
        const line = lines.get(id);
        if (line) {
          sidecarApply(out[k], line);
        }
        const session = this.sidecar?.sessions.get(id);
        if (session && out[k].session) {
          out[k].session.sessionId = session.session_id;
        }
      });
    }
    return out;
  }

  // Whole entries, not cut at ENTRY_BYTES_MAXIMUM like the rows are.
  async rawText(ids: number[]): Promise<string[]> {
    const out = new Array<string>(ids.length);
    const offsetOf = (k: number) => this.index.offsetOf(ids[k]);
    const lengthOf = (k: number) => this.index.lengthOf(ids[k]);
    for (const segment of readSegments(ids.length, offsetOf, lengthOf, READ_GAP_BYTES, CHUNK_BYTES)) {
      const bytes = await this.source.read(segment.start, segment.end - segment.start);
      for (let k = segment.first; k <= segment.last; k++) {
        const at = offsetOf(k) - segment.start;
        out[k] = lineEndTrim(textDecode(bytes.subarray(at, at + lengthOf(k))));
      }
    }
    return out;
  }

  async searchText(from: number, to: number): Promise<SearchText> {
    const ids = idsBetween(from, to);
    const base = this.index.offsetOf(from);
    const bytes = await this.source.read(base, this.index.offsetOf(to - 1) + lengthRead(this.index, to - 1) - base);
    const starts = new Uint32Array(ids.length);
    const ends = new Uint32Array(ids.length);
    const text = textDecode(bytes);
    // when every byte decoded to one character, byte offsets are character offsets
    if (text.length === bytes.length) {
      ids.forEach((id, k) => {
        starts[k] = this.index.offsetOf(id) - base;
        ends[k] = starts[k] + lengthRead(this.index, id);
      });
      return { ends, starts, text };
    }
    const parts: string[] = [];
    let at = 0;
    ids.forEach((id, k) => {
      const offset = this.index.offsetOf(id) - base;
      const part = textDecode(bytes.subarray(offset, offset + lengthRead(this.index, id)));
      starts[k] = at;
      at += part.length;
      ends[k] = at;
      parts.push(part);
      at++;
    });
    return { ends, starts, text: parts.join("\n") };
  }
}

// What the search looks at in a decoded entry.
function entrySearchText(entry: LogEntry): string {
  const lines = [entry.text || `${entry.category} ${entry.message}`];
  for (const parameter of entry.parameters ?? []) {
    lines.push(parameter.value);
  }
  return lines.join("\n");
}

// One text for the search out of one string per entry.
export function searchTextJoin(parts: string[]): SearchText {
  const starts = new Uint32Array(parts.length);
  const ends = new Uint32Array(parts.length);
  let at = 0;
  parts.forEach((part, k) => {
    starts[k] = at;
    at += part.length;
    ends[k] = at;
    at++;
  });
  return { ends, starts, text: parts.join("\n") };
}

function searchTextOf(entries: LogEntry[]): SearchText {
  return searchTextJoin(entries.map(entrySearchText));
}

export class DatamineStore implements EntryStore {
  constructor(
    private index: EntryIndex,
    private source: ByteSource,
    private indexer: DatamineIndexer
  ) {}

  async entries(ids: number[], full: boolean): Promise<LogEntry[]> {
    const rows = ids.filter((id) => this.index.kindOf(id) === 0);
    const read = rows.length > 0 ? await this.recordsEntries(rows, full) : [];
    const header = rows.length < ids.length ? this.headerEntry() : undefined;
    let next = 0;
    return ids.map((id) => (this.index.kindOf(id) === 0 ? read[next++] : { ...header, ordinal: id }) as LogEntry);
  }

  // The header row, which has no record of its own.
  private headerEntry(): LogEntry {
    const file = read_datamine_file(this.indexer.layout.headerBytes);
    const session = log_entries_from_datamine(file).find((entry) => entry.kind === "session");
    return entryMap(session as s_log_entry, true);
  }

  private async recordsEntries(ids: number[], full: boolean): Promise<LogEntry[]> {
    const parts: Uint8Array[] = [];
    const records: DatamineRecord[] = [];
    let at = 0;
    await rangesRead(this.index, this.source, ids, (k, bytes) => {
      parts[k] = bytes;
      // read the definition id the same way the indexer did
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      records[k] = {
        at,
        definitionId: this.indexer.layout.isV3 && bytes.length >= OCCURRENCE_DEFINITION_AT + 4 ? view.getUint32(OCCURRENCE_DEFINITION_AT, this.indexer.layout.little) : undefined,
        isDefinition: false,
        size: bytes.length,
      };
      at += bytes.length;
    });
    const joined = new Uint8Array(at);
    parts.forEach((part, k) => joined.set(part, records[k].at));
    const read = recordsRead(this.indexer.layout, this.indexer.definitions, records, joined);
    return read.entries.map((entry, k) => entryMap({ ...entry, ordinal: ids[k] }, full));
  }

  async searchText(from: number, to: number): Promise<SearchText> {
    return searchTextOf(await this.entries(idsBetween(from, to), true));
  }

  async rawText(ids: number[]): Promise<string[]> {
    return (await this.entries(ids, true)).map(entryRawText);
  }
}

// A zip upload, inflated and read whole: uploads are small, so its entries stay in memory.
export class MemoryStore implements EntryStore {
  constructor(private all: LogEntry[]) {}

  async entries(ids: number[]): Promise<LogEntry[]> {
    return ids.map((id) => this.all[id]);
  }

  async searchText(from: number, to: number): Promise<SearchText> {
    return searchTextOf(this.all.slice(from, to));
  }

  async rawText(ids: number[]): Promise<string[]> {
    return ids.map((id) => entryRawText(this.all[id]));
  }
}
