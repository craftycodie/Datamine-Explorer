// Walks a text log in chunks and records where every entry starts and ends, keeping only the
// columns the filters need. The package's parser decides what is an entry; this tracks which
// byte each of its lines began at, so an entry can be read again later on its own.
import { c_log_text_parser, type s_log_entry, type t_log_text_format } from "@blamnetwork/datamine/reading";
import type { EntryIndex, OverlayEntry } from "./entry-index";
import { categoryText, levelNumber, lineCount, textDecode } from "./entry-map";
import { CHUNK_BYTES, type ByteSource } from "./source";

// The newest entry is shown early only when it is this small.
const OVERLAY_BYTES_MAXIMUM = 4 * 1024 * 1024;
const SESSION_ID = /^networking:sessionid:\s*\[([^\]]*)\]/i;

function eventNumber(entry: s_log_entry): number {
  return entry.event_index ?? -1;
}

export class TextIndexer {
  // Offset just past the last complete line fed to the parser.
  consumed = 0;
  private parser: c_log_text_parser | undefined;
  // Byte offsets of the lines the parser has not finished with, starting at line `firstLine`; the
  // last one is where the next line starts. The parser holds one entry back until the next starts.
  private starts = new Float64Array(1 << 16);
  private startsLength = 1;
  private firstLine = 1;

  // No format means the file is plain text and every line is an entry.
  constructor(
    private index: EntryIndex,
    readonly format: t_log_text_format | undefined
  ) {
    this.parser = format ? new c_log_text_parser(format) : undefined;
  }

  private startPush(offset: number) {
    if (this.startsLength === this.starts.length) {
      const next = new Float64Array(this.starts.length * 2);
      next.set(this.starts);
      this.starts = next;
    }
    this.starts[this.startsLength++] = offset;
  }

  // Indexes every complete line from `consumed` up to `size`. A last line without its newline waits.
  async advance(source: ByteSource, size: number, stale: () => boolean, progress: (done: number) => void) {
    let ahead: Promise<Uint8Array> | undefined;
    let want = CHUNK_BYTES;
    try {
      while (this.consumed < size && !stale()) {
        const at = this.consumed;
        const bytes = await (ahead ?? source.read(at, Math.min(want, size - at)));
        ahead = undefined;
        if (stale() || bytes.length === 0) {
          return;
        }
        const last = bytes.lastIndexOf(10);
        if (last < 0) {
          if (at + bytes.length >= size) {
            return;
          }
          // a line longer than the chunk
          want *= 2;
          continue;
        }
        want = CHUNK_BYTES;
        const used = last + 1;
        // read the next chunk while this one is parsed
        if (at + used < size) {
          ahead = source.read(at + used, Math.min(CHUNK_BYTES, size - at - used));
        }
        this.feed(bytes.subarray(0, used), at);
        this.consumed = at + used;
        progress(this.consumed);
      }
    } finally {
      ahead?.catch(() => undefined);
    }
  }

  private feed(bytes: Uint8Array, base: number) {
    const first = this.startsLength - 1;
    let lines = 0;
    for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) {
      this.startPush(base + at + 1);
      lines++;
    }
    if (!this.parser) {
      for (let line = 0; line < lines; line++) {
        const offset = this.starts[first + line];
        this.index.add(offset, this.starts[first + line + 1] - offset, -1, "", Number.NaN, -1);
      }
      this.starts[0] = this.starts[first + lines];
      this.startsLength = 1;
      this.firstLine += lines;
      return;
    }
    const entries = this.parser.push(textDecode(bytes));
    let end = 0;
    for (const entry of entries) {
      const count = lineCount(entry.raw ?? "");
      const at = (entry.line ?? 0) - this.firstLine;
      if (at < 0 || at + count >= this.startsLength) {
        continue;
      }
      const offset = this.starts[at];
      if (entry.kind === "session") {
        this.index.addSession(offset, this.starts[at + count] - offset, entry.session?.version ?? "", undefined, Number.NaN);
        end = at + count;
        continue;
      }
      this.index.add(
        offset,
        this.starts[at + count] - offset,
        levelNumber(entry),
        categoryText(entry),
        entry.date ? entry.date.getTime() : Number.NaN,
        eventNumber(entry)
      );
      if (this.index.sessionId === undefined && entry.categories[0] === "networking") {
        this.index.sessionId = SESSION_ID.exec(entry.text)?.[1] || undefined;
      }
      end = at + count;
    }
    if (end > 0) {
      this.starts.copyWithin(0, end, this.startsLength);
      this.startsLength -= end;
      this.firstLine += end;
    }
    this.index.bannerVersion = this.parser.banner_version;
  }

  // The entry the parser is still holding, plus a last line that has no newline yet. They are
  // parsed again on their own so the newest lines show without waiting for another entry.
  async overlay(source: ByteSource, size: number, stale: () => boolean): Promise<OverlayEntry[]> {
    const from = this.starts[0];
    if (size <= from || size - from > OVERLAY_BYTES_MAXIMUM) {
      return [];
    }
    const bytes = await source.read(from, size - from);
    if (stale() || bytes.length === 0) {
      return [];
    }
    // where each line of the region starts, ending with the end of the region
    const lines = [0];
    for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) {
      lines.push(at + 1);
    }
    if (lines[lines.length - 1] !== bytes.length) {
      lines.push(bytes.length);
    }
    const found: OverlayEntry[] = [];
    if (!this.parser) {
      for (let line = 0; line + 1 < lines.length; line++) {
        found.push({
          category: 0,
          event: -1,
          length: lines[line + 1] - lines[line],
          level: -1,
          offset: from + lines[line],
          time: Number.NaN,
        });
      }
      return found;
    }
    const temp = new c_log_text_parser(this.format);
    for (const entry of [...temp.push(textDecode(bytes)), ...temp.finish()]) {
      const at = (entry.line ?? 1) - 1;
      const end = Math.min(at + lineCount(entry.raw ?? ""), lines.length - 1);
      const session = entry.kind === "session" ? { number: 0, version: entry.session?.version ?? "" } : undefined;
      found.push({
        session,
        category: session ? 0 : this.index.categoryId(categoryText(entry)),
        event: eventNumber(entry) <= 0x7f_ff_ff_ff ? eventNumber(entry) : -1,
        length: lines[end] - lines[at],
        level: levelNumber(entry),
        offset: from + lines[at],
        time: entry.date ? entry.date.getTime() : Number.NaN,
      });
    }
    return found;
  }
}
