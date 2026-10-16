// Turns a selection into the bytes to read: id ranges become runs of view rows, and the entries on
// those rows are read in a few big pieces instead of one by one.
import type { IdRange } from "../lib/selection";

// [from, to) rows of the view
export type RowSpan = [number, number];

// The view rows a selection covers. `rowNear` gives the first row at or after an entry id, so the
// ids of an entry the filters hide fall between two rows and count for none. Spans that touch are one.
export function rowSpans(ranges: IdRange[], rowNear: (id: number) => number): RowSpan[] {
  const spans: RowSpan[] = [];
  for (const [lo, hi] of ranges) {
    const from = rowNear(lo);
    const to = rowNear(hi + 1);
    if (to <= from) {
      continue;
    }
    const last = spans.at(-1);
    if (last && from <= last[1]) {
      last[1] = Math.max(last[1], to);
    } else {
      spans.push([from, to]);
    }
  }
  return spans;
}

export function spansSize(spans: RowSpan[]): number {
  let size = 0;
  for (const [from, to] of spans) {
    size += to - from;
  }
  return size;
}

// One read: the file bytes [start, end), holding entries first..last of the list asked for.
export interface ReadSegment {
  start: number;
  end: number;
  first: number;
  last: number;
}

// Groups entries (ascending by offset) into reads. Entries closer than `gap` bytes share a read, as
// long as it stays under `chunk`; one entry bigger than `chunk` is a read on its own.
export function readSegments(count: number, offsetOf: (k: number) => number, lengthOf: (k: number) => number, gap: number, chunk: number): ReadSegment[] {
  const segments: ReadSegment[] = [];
  let k = 0;
  while (k < count) {
    const start = offsetOf(k);
    let end = start + lengthOf(k);
    let last = k;
    while (last + 1 < count) {
      const offset = offsetOf(last + 1);
      const stop = offset + lengthOf(last + 1);
      if (offset - end > gap || stop - start > chunk) {
        break;
      }
      end = Math.max(end, stop);
      last++;
    }
    segments.push({ end, first: k, last, start });
    k = last + 1;
  }
  return segments;
}

// An entry's text without the line break that ends it.
export function lineEndTrim(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
