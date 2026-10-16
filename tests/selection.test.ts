import { describe, expect, it } from "vitest";
import {
  type IdRange,
  rangesAdd,
  rangesHas,
  rangesRemove,
  rangesSize,
  rangesToggle,
  SELECTION_EMPTY,
  selectionAll,
  selectionClick,
  selectionCollapse,
  selectionSingle,
} from "../src/lib/selection";

const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const both = { ctrl: true, shift: true };

// the ids a selection holds, the slow way
function ids(ranges: IdRange[]): number[] {
  return ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
}

describe("selection ranges", () => {
  it("adds, merging ranges that overlap or touch", () => {
    let ranges = rangesAdd([], 5, 7);
    ranges = rangesAdd(ranges, 10, 12);
    expect(ranges).toEqual([[5, 7], [10, 12]]);
    expect(rangesAdd(ranges, 8, 8)).toEqual([[5, 8], [10, 12]]);
    expect(rangesAdd(ranges, 8, 9)).toEqual([[5, 12]]);
    expect(rangesAdd(ranges, 0, 100)).toEqual([[0, 100]]);
    expect(rangesAdd(ranges, 2, 4)).toEqual([[2, 7], [10, 12]]);
    expect(rangesAdd(ranges, 13, 13)).toEqual([[5, 7], [10, 13]]);
  });

  it("removes from the middle, the ends, and across ranges", () => {
    const ranges: IdRange[] = [[0, 9], [20, 29]];
    expect(rangesRemove(ranges, 4, 4)).toEqual([[0, 3], [5, 9], [20, 29]]);
    expect(rangesRemove(ranges, 0, 0)).toEqual([[1, 9], [20, 29]]);
    expect(rangesRemove(ranges, 9, 20)).toEqual([[0, 8], [21, 29]]);
    expect(rangesRemove(ranges, 10, 19)).toEqual(ranges);
    expect(rangesRemove(ranges, 0, 100)).toEqual([]);
  });

  it("answers membership and size", () => {
    const ranges: IdRange[] = [[3, 5], [9, 9], [20, 1_000_000]];
    expect(rangesHas(ranges, 2)).toBe(false);
    expect(rangesHas(ranges, 3)).toBe(true);
    expect(rangesHas(ranges, 6)).toBe(false);
    expect(rangesHas(ranges, 9)).toBe(true);
    expect(rangesHas(ranges, 1_000_001)).toBe(false);
    expect(rangesSize(ranges)).toBe(3 + 1 + 999_981);
    expect(rangesToggle(ranges, 4)).toEqual([[3, 3], [5, 5], [9, 9], [20, 1_000_000]]);
    expect(rangesToggle([[3, 3], [5, 5]], 4)).toEqual([[3, 5]]);
    expect(rangesToggle([[3, 5]], 4)).toEqual([[3, 3], [5, 5]]);
  });

  it("agrees with a plain set over random operations", () => {
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let ranges: IdRange[] = [];
    const set = new Set<number>();
    for (let step = 0; step < 400; step++) {
      const lo = next(60);
      const hi = lo + next(8);
      if (next(2) === 0) {
        ranges = rangesAdd(ranges, lo, hi);
        for (let id = lo; id <= hi; id++) {
          set.add(id);
        }
      } else {
        ranges = rangesRemove(ranges, lo, hi);
        for (let id = lo; id <= hi; id++) {
          set.delete(id);
        }
      }
      expect(ids(ranges)).toEqual([...set].sort((a, b) => a - b));
    }
  });
});

describe("selecting like a file list", () => {
  it("a click selects one entry, and it is the anchor and the focus", () => {
    const selection = selectionClick(SELECTION_EMPTY, 7, plain);
    expect(selection).toEqual({ anchor: 7, focus: 7, ranges: [[7, 7]] });
    expect(selectionClick(selection, 3, plain)).toEqual({ anchor: 3, focus: 3, ranges: [[3, 3]] });
  });

  it("ctrl-click toggles an entry in and out, moving the anchor", () => {
    let selection = selectionClick(SELECTION_EMPTY, 2, plain);
    selection = selectionClick(selection, 5, ctrl);
    selection = selectionClick(selection, 9, ctrl);
    expect(selection.ranges).toEqual([[2, 2], [5, 5], [9, 9]]);
    expect(selection.anchor).toBe(9);
    selection = selectionClick(selection, 5, ctrl);
    expect(selection.ranges).toEqual([[2, 2], [9, 9]]);
    // the entry just toggled off is still the focus, which the detail pane shows
    expect(selection.focus).toBe(5);
  });

  it("shift-click selects from the anchor, either way, and keeps the anchor", () => {
    let selection = selectionClick(SELECTION_EMPTY, 10, plain);
    selection = selectionClick(selection, 14, shift);
    expect(selection).toEqual({ anchor: 10, focus: 14, ranges: [[10, 14]] });
    selection = selectionClick(selection, 6, shift);
    expect(selection).toEqual({ anchor: 10, focus: 6, ranges: [[6, 10]] });
    selection = selectionClick(selection, 12, shift);
    expect(selection.ranges).toEqual([[10, 12]]);
  });

  it("shift-click replaces the selection but ctrl-shift-click adds to it", () => {
    let selection = selectionClick(SELECTION_EMPTY, 1, plain);
    selection = selectionClick(selection, 20, ctrl);
    selection = selectionClick(selection, 24, both);
    expect(selection.ranges).toEqual([[1, 1], [20, 24]]);
    expect(selection.anchor).toBe(20);
    expect(selectionClick(selection, 22, shift).ranges).toEqual([[20, 22]]);
  });

  it("starts a shift range at the focus when there is no anchor", () => {
    expect(selectionClick({ focus: 4, ranges: [] }, 8, shift).ranges).toEqual([[4, 8]]);
    expect(selectionClick(SELECTION_EMPTY, 8, shift).ranges).toEqual([[8, 8]]);
  });

  it("select all is one range, however many entries; the focus stays", () => {
    const selection = selectionAll(selectionSingle(40), 5_000_000);
    expect(selection.ranges).toEqual([[0, 5_000_000]]);
    expect(selection.focus).toBe(40);
    expect(selection.anchor).toBe(40);
    // a ctrl-click out of it splits it in two
    expect(selectionClick(selection, 100, ctrl).ranges).toEqual([[0, 99], [101, 5_000_000]]);
  });

  it("escape leaves only the focused entry", () => {
    const selection = selectionAll(selectionClick(selectionSingle(3), 9, shift), 100);
    expect(selectionCollapse(selection)).toEqual({ anchor: 9, focus: 9, ranges: [[9, 9]] });
    expect(selectionCollapse(SELECTION_EMPTY)).toEqual(SELECTION_EMPTY);
  });

  it("holds ids, so it survives filtering: the same ids are selected whichever rows show", () => {
    let selection = selectionClick(SELECTION_EMPTY, 10, plain);
    selection = selectionClick(selection, 30, shift);
    // a filter shows only the even ids; the selected rows are the even ids in the range
    const evens = Array.from({ length: 50 }, (_, k) => k * 2);
    expect(evens.filter((id) => rangesHas(selection.ranges, id))).toEqual([10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]);
    // with the filter off they are all there again
    const everything = Array.from({ length: 100 }, (_, k) => k);
    expect(everything.filter((id) => rangesHas(selection.ranges, id))).toHaveLength(21);
    // and rows arriving later are not in it
    expect(rangesHas(selection.ranges, 150)).toBe(false);
  });
});
