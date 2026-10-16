// Row heights of a table whose rows can be taller than one line. Every row is `base` tall until it
// is measured; the measured ones are kept as differences from `base` in a Fenwick tree, so the top
// of any row, the row at any height and the whole height cost a few dozen steps however many rows
// there are and however few have been measured.
const FIRST_CAPACITY = 1 << 12;

export class RowHeights {
  // measured rows that are not `base` tall
  private measured = new Map<number, number>();
  private tree = new Float64Array(FIRST_CAPACITY + 1);
  private capacity = FIRST_CAPACITY;
  private sum = 0;

  constructor(readonly base: number) {}

  clear() {
    this.measured.clear();
    this.tree = new Float64Array(FIRST_CAPACITY + 1);
    this.capacity = FIRST_CAPACITY;
    this.sum = 0;
  }

  get(row: number): number {
    return this.measured.get(row) ?? this.base;
  }

  // Sets a row's height and returns how much it changed by.
  set(row: number, height: number): number {
    const delta = height - this.get(row);
    if (delta === 0) {
      return 0;
    }
    // growing rebuilds the tree from what was measured, so it comes before this row is
    if (row >= this.capacity) {
      this.grow(row + 1);
    }
    if (height === this.base) {
      this.measured.delete(row);
    } else {
      this.measured.set(row, height);
    }
    this.add(row, delta);
    return delta;
  }

  private add(row: number, delta: number) {
    this.sum += delta;
    for (let at = row + 1; at <= this.capacity; at += at & -at) {
      this.tree[at] += delta;
    }
  }

  private grow(rows: number) {
    let capacity = this.capacity;
    while (capacity < rows) {
      capacity *= 2;
    }
    this.capacity = capacity;
    this.tree = new Float64Array(capacity + 1);
    for (const [row, height] of this.measured) {
      const delta = height - this.base;
      for (let at = row + 1; at <= capacity; at += at & -at) {
        this.tree[at] += delta;
      }
    }
  }

  // How much taller than `base` the rows before `row` are, together.
  private extra(row: number): number {
    let at = Math.min(row, this.capacity);
    let total = 0;
    while (at > 0) {
      total += this.tree[at];
      at -= at & -at;
    }
    return total;
  }

  // The y of the top of a row.
  top(row: number): number {
    return row * this.base + this.extra(row);
  }

  // The height of `count` rows.
  total(count: number): number {
    return count * this.base + this.extra(count);
  }

  // The row that has y in it, held to 0..count-1.
  rowAt(y: number, count: number): number {
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.top(mid) <= y) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return Math.max(0, low);
  }

  get measuredCount(): number {
    return this.measured.size;
  }

  get extraTotal(): number {
    return this.sum;
  }
}
