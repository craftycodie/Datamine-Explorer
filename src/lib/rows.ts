// The table's rows, fetched from the worker as they scroll into view. Only the rows near the
// window are held; there can be millions behind it.
import { useCallback, useMemo, useRef, useState } from "react";
import type { DividerResult } from "../worker/protocol";
import type { LogClient } from "./log-client";
import type { ViewState } from "./session";
import type { LogEntry } from "./types";

// More than this and the cache starts over; refetching a window is cheap.
const CACHE_ROWS_MAXIMUM = 6000;
const DIRTY_LOG_LENGTH = 64;

export interface RowSource {
  get(row: number): LogEntry | undefined;
  // Asks for the rows [from, to) that are not here yet.
  ensure(from: number, to: number): void;
  // The session divider row at or above a row, and where the next one is.
  divider(row: number): Promise<DividerResult | undefined>;
  // changes when rows arrive, so a table can draw them
  version: number;
  // The worker sent a new view; called with the message as it arrives.
  viewChanged(view: ViewState): void;
  // Something else is open: nothing held is drawn any more, not even as a stand-in.
  clear(): void;
}

export function useRows(client: LogClient | undefined): RowSource {
  const [version, setVersion] = useState(0);
  const state = useRef({
    // rows that are current, and rows from before a change in match marks, shown until replaced
    dirty: [] as { serial: number; from: number }[],
    fresh: new Map<number, LogEntry>(),
    flags: 0,
    pending: new Set<number>(),
    stale: new Map<number, LogEntry>(),
    version: 0,
    viewVersion: 0,
  });

  const get = useCallback((row: number) => state.current.fresh.get(row) ?? state.current.stale.get(row), []);

  const viewChanged = useCallback((view: ViewState) => {
    const s = state.current;
    // Rows that may be out of date are drawn as they were until the new ones arrive: dropping them would
    // leave the table blank where they are for a frame or two, which flickers at a busy tail.
    let from = view.dirtyFrom;
    if (view.version !== s.viewVersion) {
      // rows moved: none of them is current, but the old ones stand in for a moment
      s.viewVersion = view.version;
      s.stale = s.fresh;
      s.fresh = new Map();
      from = 0;
    } else if (view.flags !== s.flags) {
      // same rows, new match marks
      for (const [row, entry] of s.fresh) {
        s.stale.set(row, entry);
      }
      s.fresh.clear();
      from = 0;
    } else {
      for (const [row, entry] of s.fresh) {
        if (row >= from) {
          s.stale.set(row, entry);
          s.fresh.delete(row);
        }
      }
    }
    s.flags = view.flags;
    s.dirty.push({ from, serial: view.serial });
    if (s.dirty.length > DIRTY_LOG_LENGTH) {
      s.dirty.shift();
    }
    s.pending.clear();
    s.version++;
    setVersion(s.version);
  }, []);

  const clear = useCallback(() => {
    const s = state.current;
    s.fresh.clear();
    s.stale.clear();
    s.pending.clear();
    s.version++;
    setVersion(s.version);
  }, []);

  const ensure = useCallback(
    (from: number, to: number) => {
      const s = state.current;
      if (!client) {
        return;
      }
      let first = -1;
      let last = -1;
      for (let row = Math.max(0, from); row < to; row++) {
        if (!s.fresh.has(row) && !s.pending.has(row)) {
          first = first < 0 ? row : first;
          last = row;
        }
      }
      if (first < 0) {
        return;
      }
      for (let row = first; row <= last; row++) {
        s.pending.add(row);
      }
      client.call({ from: first, name: "rows", to: last + 1 }).then(
        (result) => {
          const now = state.current;
          if (result.version !== now.viewVersion) {
            return;
          }
          if (now.fresh.size > CACHE_ROWS_MAXIMUM) {
            now.fresh.clear();
            now.stale.clear();
          }
          result.rows.forEach((entry, k) => {
            const row = result.from + k;
            // a change after the worker answered may have made this row out of date
            if (!now.dirty.some((d) => d.serial > result.serial && d.from <= row)) {
              now.fresh.set(row, entry);
              now.stale.delete(row);
            }
            now.pending.delete(row);
          });
          now.version++;
          setVersion(now.version);
        },
        () => {
          for (let row = first; row <= last; row++) {
            state.current.pending.delete(row);
          }
        }
      );
    },
    [client]
  );

  const divider = useCallback(
    (row: number) => (client ? client.call({ name: "dividerNear", row }).catch(() => undefined) : Promise.resolve(undefined)),
    [client]
  );

  return useMemo(() => ({ clear, divider, ensure, get, version, viewChanged }), [clear, divider, ensure, get, version, viewChanged]);
}
