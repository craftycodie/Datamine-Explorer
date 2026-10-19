// The rows the table shows: the entry ids that pass the severity and category filters (and, when
// asked, are search matches), in file order. Built with one loop over the typed columns.
// A session divider stays when filters are on only if an event after it is shown.
import { categoryMatches, type Filters, filtersActive, filtersDefault } from "../lib/filter";
import type { EntryIndex } from "./entry-index";

// A growable list of entry ids.
class IdList {
  data = new Uint32Array(1 << 12);
  length = 0;

  push(id: number) {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = id;
  }

  clear() {
    this.length = 0;
  }
}

// Index of the first element that is >= id.
function lowerBound(list: IdList, id: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (list.data[mid] < id) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export class View {
  // true shows only search matches
  restrict = false;
  searchActive = false;
  private filters: Filters = filtersDefault();
  // by level + 1, so entries without a level (-1) land on slot 0
  private levelPass = new Uint8Array(7).fill(1);
  // by category id
  private categoryPass = new Uint8Array(0);
  private categoriesDone = 0;
  private passing = new IdList();
  private processed = 0;
  // every entry the search matched, and the ones among them that pass the filters
  private matched = new IdList();
  private matchedPassing = new IdList();
  // the matches plus the dividers of the sessions they are in: the rows when only matches show
  private matchedRows = new IdList();
  private matchedDone = 0;
  private active = false;
  // sessions are listed in the index; these track the last one at or before the entry being looked
  // at, and the last one whose divider was added
  private passCursor = -1;
  private passShown = -1;
  private matchCursor = -1;
  private matchShown = -1;

  constructor(private index: EntryIndex) {}

  clear() {
    this.passing.clear();
    this.matched.clear();
    this.matchedPassing.clear();
    this.matchedRows.clear();
    this.processed = 0;
    this.matchedDone = 0;
    this.categoriesDone = 0;
    this.passCursor = this.passShown = this.matchCursor = this.matchShown = -1;
  }

  private shown(): IdList {
    return this.restrict && this.searchActive ? this.matchedRows : this.passing;
  }

  get length(): number {
    return this.shown().length;
  }

  // entries of the index taken in so far
  get processedCount(): number {
    return this.processed;
  }

  get matchCount(): number {
    return this.matchedPassing.length;
  }

  at(row: number): number {
    return this.shown().data[row];
  }

  // The row an entry is on, -1 when it is not in the view.
  rowOf(id: number): number {
    const list = this.shown();
    const row = lowerBound(list, id);
    return row < list.length && list.data[row] === id ? row : -1;
  }

  // The first row at or after an entry, for jumping to a place the filters may have hidden.
  rowNear(id: number): number {
    return lowerBound(this.shown(), id);
  }

  matchEntry(position: number): number | undefined {
    return position >= 0 && position < this.matchedPassing.length ? this.matchedPassing.data[position] : undefined;
  }

  // Whether the id is a search match, for marking rows.
  isMatch(id: number): boolean {
    const row = lowerBound(this.matched, id);
    return row < this.matched.length && this.matched.data[row] === id;
  }

  filtersSet(filters: Filters) {
    this.filters = filters;
    for (let slot = 0; slot < 7; slot++) {
      this.levelPass[slot] = slot === 0 || filters.levels[slot - 1] ? 1 : 0;
    }
    this.active = filtersActive(filters);
    this.categoriesDone = 0;
    this.passing.clear();
    this.processed = 0;
    this.matchedPassing.clear();
    this.matchedRows.clear();
    this.matchedDone = 0;
    this.passCursor = this.passShown = this.matchCursor = this.matchShown = -1;
    this.extend();
  }

  // Works out which of the category names pass, for the ones added since last time.
  private categoriesSync() {
    const names = this.index.categoryNames;
    if (this.categoryPass.length < names.length) {
      const next = new Uint8Array(Math.max(names.length, this.categoryPass.length * 2));
      next.set(this.categoryPass);
      this.categoryPass = next;
    }
    const { include, exclude } = this.filters;
    for (let id = this.categoriesDone; id < names.length; id++) {
      const name = names[id];
      const wanted = include.length === 0 || include.some((prefix) => categoryMatches(name, prefix));
      this.categoryPass[id] = wanted && !exclude.some((prefix) => categoryMatches(name, prefix)) ? 1 : 0;
    }
    this.categoriesDone = names.length;
  }

  passes(level: number, category: number): boolean {
    this.categoriesSync();
    return this.levelPass[level + 1] === 1 && this.categoryPass[category] === 1;
  }

  // Moves `cursor` to the last session whose row is at or before `id`.
  private cursorTo(cursor: number, id: number): number {
    const sessions = this.index.sessions;
    while (cursor + 1 < sessions.length && sessions[cursor + 1].id <= id) {
      cursor++;
    }
    return cursor;
  }

  // Takes in the entries added to the index since last time.
  extend() {
    this.categoriesSync();
    const { count, levels, categories, kinds, sessions } = this.index;
    const { levelPass, categoryPass, passing, active } = this;
    for (let id = this.processed; id < count; id++) {
      if (kinds[id] === 1) {
        // with filters on, a divider waits for an event of its session to show
        if (!active) {
          passing.push(id);
        }
      } else if (levelPass[levels[id] + 1] === 1 && categoryPass[categories[id]] === 1) {
        if (active) {
          this.passCursor = this.cursorTo(this.passCursor, id);
          if (this.passCursor >= 0 && this.passCursor !== this.passShown) {
            passing.push(sessions[this.passCursor].id);
            this.passShown = this.passCursor;
          }
        }
        passing.push(id);
      }
    }
    this.processed = count;
    this.matchesExtend();
  }

  private matchesExtend() {
    this.categoriesSync();
    const { levels, categories, sessions } = this.index;
    for (; this.matchedDone < this.matched.length; this.matchedDone++) {
      const id = this.matched.data[this.matchedDone];
      if (this.levelPass[levels[id] + 1] === 1 && this.categoryPass[categories[id]] === 1) {
        this.matchedPassing.push(id);
        this.matchCursor = this.cursorTo(this.matchCursor, id);
        if (this.matchCursor >= 0 && this.matchCursor !== this.matchShown) {
          this.matchedRows.push(sessions[this.matchCursor].id);
          this.matchShown = this.matchCursor;
        }
        this.matchedRows.push(id);
      }
    }
  }

  // Rows for the entries the parser has not finished with (ids from index.count on), shown after the rest.
  // Their dividers can be a committed session's, whose divider no row has needed yet.
  overlayRows(): number[] {
    const rows: number[] = [];
    if (this.restrict && this.searchActive) {
      return rows;
    }
    const { overlay, count, sessions } = this.index;
    const last = sessions.length - 1;
    let divider = last >= 0 ? { id: sessions[last].id, shown: !this.active || this.passShown === last } : undefined;
    overlay.forEach((entry, at) => {
      const id = count + at;
      if (entry.session) {
        divider = { id, shown: !this.active };
        if (!this.active) {
          rows.push(id);
        }
      } else if (this.passes(entry.level, entry.category)) {
        if (divider && !divider.shown) {
          rows.push(divider.id);
          divider.shown = true;
        }
        rows.push(id);
      }
    });
    return rows;
  }

  matchesAdd(ids: number[]) {
    for (const id of ids) {
      this.matched.push(id);
    }
    this.matchesExtend();
  }

  matchesClear() {
    this.matched.clear();
    this.matchedPassing.clear();
    this.matchedRows.clear();
    this.matchedDone = 0;
    this.matchCursor = this.matchShown = -1;
  }
}
