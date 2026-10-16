// Which entries are selected in the table. A selection is a list of inclusive entry id ranges, not
// row numbers, so it survives filtering, tailing and new rows. Rows come in id order, so a range of
// ids is also a run of rows. A million selected rows are one range.

export type IdRange = [number, number];

export interface Selection {
  // sorted, disjoint and not touching
  ranges: IdRange[];
  // where a shift-click or shift-arrow starts from
  anchor?: number;
  // the entry the detail pane shows: the last one clicked or moved to
  focus?: number;
}

export interface SelectModifiers {
  ctrl: boolean;
  shift: boolean;
}

export const SELECTION_EMPTY: Selection = { ranges: [] };

// Index of the first range that ends at or after `id`.
function rangeFrom(ranges: IdRange[], id: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid][1] < id) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function rangesHas(ranges: IdRange[], id: number): boolean {
  const at = rangeFrom(ranges, id);
  return at < ranges.length && ranges[at][0] <= id;
}

// The ranges with [lo, hi] added.
export function rangesAdd(ranges: IdRange[], lo: number, hi: number): IdRange[] {
  const first = rangeFrom(ranges, lo - 1);
  let from = lo;
  let to = hi;
  let last = first;
  while (last < ranges.length && ranges[last][0] <= hi + 1) {
    from = Math.min(from, ranges[last][0]);
    to = Math.max(to, ranges[last][1]);
    last++;
  }
  return [...ranges.slice(0, first), [from, to], ...ranges.slice(last)];
}

// The ranges with [lo, hi] taken out.
export function rangesRemove(ranges: IdRange[], lo: number, hi: number): IdRange[] {
  const first = rangeFrom(ranges, lo);
  const out = ranges.slice(0, first);
  let at = first;
  for (; at < ranges.length && ranges[at][0] <= hi; at++) {
    const [from, to] = ranges[at];
    if (from < lo) {
      out.push([from, lo - 1]);
    }
    if (to > hi) {
      out.push([hi + 1, to]);
    }
  }
  out.push(...ranges.slice(at));
  return out;
}

export function rangesToggle(ranges: IdRange[], id: number): IdRange[] {
  return rangesHas(ranges, id) ? rangesRemove(ranges, id, id) : rangesAdd(ranges, id, id);
}

// How many ids the ranges hold (not how many rows: some may be hidden by the filters).
export function rangesSize(ranges: IdRange[]): number {
  let size = 0;
  for (const [lo, hi] of ranges) {
    size += hi - lo + 1;
  }
  return size;
}

export function selectionSingle(id: number): Selection {
  return { anchor: id, focus: id, ranges: [[id, id]] };
}

// A click, or a move with the arrow keys (which is a click on the row moved to, without ctrl):
//   plain            the entry alone, and it becomes the anchor
//   ctrl             the entry toggles, and it becomes the anchor
//   shift            the range from the anchor to the entry, replacing the selection
//   ctrl and shift   the same range, added to the selection
export function selectionClick(selection: Selection, id: number, { ctrl, shift }: SelectModifiers): Selection {
  if (shift) {
    const anchor = selection.anchor ?? selection.focus ?? id;
    const lo = Math.min(anchor, id);
    const hi = Math.max(anchor, id);
    return { anchor, focus: id, ranges: ctrl ? rangesAdd(selection.ranges, lo, hi) : [[lo, hi]] };
  }
  if (ctrl) {
    return { anchor: id, focus: id, ranges: rangesToggle(selection.ranges, id) };
  }
  return selectionSingle(id);
}

// Everything up to `last`, the id of the last row. Where the focus was stays.
export function selectionAll(selection: Selection, last: number): Selection {
  return { ...selection, ranges: [[0, Math.max(0, last)]] };
}

// Escape: only the focused entry stays selected.
export function selectionCollapse(selection: Selection): Selection {
  return selection.focus === undefined ? SELECTION_EMPTY : selectionSingle(selection.focus);
}
