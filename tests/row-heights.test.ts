import { describe, expect, it } from "vitest";
import { RowHeights } from "../src/lib/row-heights";

// the same answers the slow way
function brute(base: number, measured: Map<number, number>, count: number) {
  const tops: number[] = [];
  let y = 0;
  for (let row = 0; row < count; row++) {
    tops.push(y);
    y += measured.get(row) ?? base;
  }
  return { tops, total: y };
}

describe("row heights", () => {
  it("is one base height per row until measured", () => {
    const heights = new RowHeights(20);
    expect(heights.top(0)).toBe(0);
    expect(heights.top(1000)).toBe(20_000);
    expect(heights.total(50)).toBe(1000);
    expect(heights.rowAt(39, 100)).toBe(1);
    expect(heights.rowAt(1e9, 100)).toBe(99);
    expect(heights.rowAt(-5, 100)).toBe(0);
  });

  it("tops, total and the row at a height follow what was measured, growing past its first capacity", () => {
    const heights = new RowHeights(20);
    const measured = new Map<number, number>();
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed;
    };
    const count = 30_000;
    for (let k = 0; k < 3000; k++) {
      const row = next() % count;
      const height = 20 + 16 * (next() % 12);
      const before = measured.get(row) ?? 20;
      expect(heights.set(row, height)).toBe(height - before);
      if (height === 20) {
        measured.delete(row);
      } else {
        measured.set(row, height);
      }
    }
    const { tops, total } = brute(20, measured, count);
    expect(heights.total(count)).toBe(total);
    for (let k = 0; k < 500; k++) {
      const row = next() % count;
      expect(heights.top(row)).toBe(tops[row]);
      const y = tops[row] + (next() % (measured.get(row) ?? 20));
      expect(heights.rowAt(y, count)).toBe(row);
    }
  });

  it("forgets everything when cleared", () => {
    const heights = new RowHeights(20);
    heights.set(5, 100);
    expect(heights.total(10)).toBe(280);
    heights.clear();
    expect(heights.total(10)).toBe(200);
    expect(heights.get(5)).toBe(20);
    expect(heights.measuredCount).toBe(0);
  });

  it("measuring a row back to the base height removes it", () => {
    const heights = new RowHeights(20);
    heights.set(3, 52);
    heights.set(3, 20);
    expect(heights.measuredCount).toBe(0);
    expect(heights.top(10)).toBe(200);
  });
});
