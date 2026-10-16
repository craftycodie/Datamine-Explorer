// Binary datamine files: records are length-prefixed, so one pass over the file finds every record.
// The package reads whole files, so each chunk of records is wrapped back into a small file (the
// header, the definitions its occurrences use, the records) and read with it.
import {
  k_data_mine_header_layout_sizes,
  log_entries_from_datamine,
  read_datamine_file,
  type s_data_mine_header,
  type s_datamine_file_record,
  type s_log_entry,
} from "@blamnetwork/datamine/reading";
import type { EntryIndex } from "./entry-index";
import { categoryText, levelNumber } from "./entry-map";
import { CHUNK_BYTES, type ByteSource } from "./source";

// Layout detection needs the first few bytes after the marker, and the header is at most this long.
const HEAD_BYTES = 512;
// v3 records are u32 total size, u8 kind, and an occurrence goes on with u32 event index, u32 definition id.
const KIND_DEFINITION = 1;
const KIND_OCCURRENCE = 2;
export const OCCURRENCE_DEFINITION_AT = 9;
const SIZE_MINIMUM = 5;

export interface DatamineRecord {
  // offset in the bytes it was found in
  at: number;
  size: number;
  isDefinition: boolean;
  // occurrences only
  definitionId?: number;
}

export interface DatamineLayout {
  header: s_data_mine_header;
  headerBytes: Uint8Array;
  little: boolean;
  isV3: boolean;
}

export function bytesJoin(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

// Splits bytes that start on a record boundary into records. `stop` says why it ended: the end of
// the bytes, a record that runs past them (`need` is how long it says it is), or a size no record has.
export function recordsScan(
  layout: DatamineLayout,
  bytes: Uint8Array
): { records: DatamineRecord[]; end: number; stop: "end" | "partial" | "malformed"; need: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: DatamineRecord[] = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const size = view.getUint32(at, layout.little);
    if (size < SIZE_MINIMUM) {
      return { end: at, need: 0, records, stop: "malformed" };
    }
    if (at + size > bytes.length) {
      return { end: at, need: size, records, stop: "partial" };
    }
    if (!layout.isV3) {
      // v1 and v2 files are events only
      records.push({ at, isDefinition: false, size });
    } else if (bytes[at + 4] === KIND_OCCURRENCE) {
      records.push({
        at,
        definitionId: size >= OCCURRENCE_DEFINITION_AT + 4 ? view.getUint32(at + OCCURRENCE_DEFINITION_AT, layout.little) : undefined,
        isDefinition: false,
        size,
      });
    } else if (bytes[at + 4] === KIND_DEFINITION) {
      records.push({ at, isDefinition: true, size });
    } else {
      return { end: at, need: 0, records, stop: "malformed" };
    }
    at += size;
  }
  return { end: at, need: at < bytes.length ? 4 : 0, records, stop: at < bytes.length ? "partial" : "end" };
}

// Reads some records with the package: a small datamine file of the header, the definitions the
// records use and the records themselves. `entries[k]` belongs to the k-th record that is not a definition.
export function recordsRead(
  layout: DatamineLayout,
  definitions: Map<number, Uint8Array>,
  records: DatamineRecord[],
  bytes: Uint8Array
): { entries: s_log_entry[]; parsed: s_datamine_file_record[]; truncated: boolean } {
  const wanted = new Set<number>();
  for (const record of records) {
    if (record.definitionId !== undefined && definitions.has(record.definitionId)) {
      wanted.add(record.definitionId);
    }
  }
  const before: Uint8Array[] = [];
  for (const id of wanted) {
    before.push(definitions.get(id) as Uint8Array);
  }
  const file = read_datamine_file(bytesJoin([layout.headerBytes, ...before, bytes]));
  const parsed = file.records.slice(before.length);
  return {
    // the package puts a session row for the header first; here that is not wanted again
    entries: log_entries_from_datamine(file).filter((entry) => entry.kind !== "session"),
    parsed,
    truncated: file.truncated_at !== undefined || parsed.length < records.length,
  };
}

export class DatamineIndexer {
  layout!: DatamineLayout;
  // definition id to the bytes of its record; an occurrence can only be read with its definition
  definitions = new Map<number, Uint8Array>();
  // offset of the next record to read
  next = 0;
  // where a record could not be read, or has a size no record has
  brokenAt: number | undefined;
  // the file ends in the middle of a record here; more bytes may complete it
  partialAt: number | undefined;

  constructor(private index: EntryIndex) {}

  async init(source: ByteSource, size: number) {
    const head = await source.read(0, Math.min(size, HEAD_BYTES));
    const file = read_datamine_file(head);
    const layout = file.header.layout;
    const headerSize = k_data_mine_header_layout_sizes[layout];
    this.layout = {
      header: file.header,
      headerBytes: head.slice(0, headerSize),
      isV3: layout === "3.1",
      little: file.header.byte_order === "little",
    };
    this.next = headerSize;
    // the header is the file's one session divider
    const session = log_entries_from_datamine(file).find((entry) => entry.kind === "session");
    this.index.addSession(
      0,
      headerSize,
      session?.session?.version ?? "",
      session?.session?.session_id || undefined,
      session?.date ? session.date.getTime() : Number.NaN
    );
  }

  async advance(source: ByteSource, size: number, stale: () => boolean, progress: (done: number) => void) {
    this.partialAt = undefined;
    let want = CHUNK_BYTES;
    while (this.next < size && this.brokenAt === undefined && !stale()) {
      const at = this.next;
      const bytes = await source.read(at, Math.min(want, size - at));
      if (stale() || bytes.length === 0) {
        return;
      }
      const scan = recordsScan(this.layout, bytes);
      if (scan.records.length === 0) {
        if (scan.stop === "malformed") {
          this.brokenAt = at;
        } else if (scan.need > bytes.length && at + scan.need <= size) {
          // a record bigger than the chunk
          want = scan.need;
          continue;
        } else if (scan.stop === "partial") {
          this.partialAt = at;
        }
        return;
      }
      want = CHUNK_BYTES;
      const used = bytes.subarray(0, scan.end);
      const read = recordsRead(this.layout, this.definitions, scan.records, used);
      let entry = 0;
      read.parsed.forEach((parsed, k) => {
        const record = scan.records[k];
        if (parsed.kind === "definition") {
          this.definitions.set(parsed.definition.definition_id, used.slice(record.at, record.at + record.size));
          return;
        }
        const found = read.entries[entry++];
        this.index.add(
          at + record.at,
          record.size,
          levelNumber(found),
          categoryText(found),
          found.date ? found.date.getTime() : Number.NaN,
          found.event_index ?? -1
        );
      });
      if (read.truncated) {
        this.brokenAt = at + (scan.records[read.parsed.length]?.at ?? scan.end);
        return;
      }
      this.next = at + scan.end;
      if (scan.stop === "malformed") {
        this.brokenAt = this.next;
        return;
      }
      progress(this.next);
    }
  }
}
