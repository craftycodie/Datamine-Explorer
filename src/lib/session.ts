// Opens the chosen file in the log worker and keeps the facts about it current: counts, progress,
// the number of rows, the search state. The rows themselves are fetched on demand (see rows.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerResponse } from "../worker/protocol";
import { LogClient } from "./log-client";
import type { FileLoadInfo, LiveStatus, LogStats, SearchStatus, SessionMeta, StatsSnapshot } from "./types";
import { LEVEL_NAMES } from "./types";

// What the worker last said about the rows. See the "view" message.
export interface ViewState {
  count: number;
  version: number;
  flags: number;
  serial: number;
  // rows from here on may have changed
  dirtyFrom: number;
}

// What the worker opens: a file by path, or an event server by URL. `nonce` makes a second
// connection to the same URL a new source.
// `fresh` leaves an earlier spool of the same server alone.
export type LogSource = { kind: "file"; path: string } | { kind: "live"; url: string; nonce: number; fresh: boolean };

// The server status tagged with the connection it belongs to, so a late one is not mistaken for the next.
export type LiveView = LiveStatus & { nonce: number };

export interface LogData {
  file?: FileLoadInfo;
  // set while the source is an event server
  live?: LiveView;
  meta?: SessionMeta;
  stats: LogStats;
  // changes whenever `stats` does, for components that memoize on it
  statsVersion: number;
  view: ViewState;
  search: SearchStatus;
}

function statsEmpty(): LogStats {
  return { categoryCounts: new Map(), count: 0, levelCounts: new Array(LEVEL_NAMES.length + 1).fill(0), sessions: [] };
}

function statsFrom(snapshot: StatsSnapshot): LogStats {
  return {
    categoryCounts: new Map(snapshot.categories),
    count: snapshot.count,
    firstTime: snapshot.firstTime,
    lastTime: snapshot.lastTime,
    levelCounts: snapshot.levelCounts,
    sessions: snapshot.sessions,
  };
}

const SEARCH_IDLE: SearchStatus = { matches: 0, progress: 0, state: "idle" };
const VIEW_EMPTY: ViewState = { count: 0, dirtyFrom: 0, flags: 0, serial: 0, version: 0 };
const UPDATE_INTERVAL_MS = 100;

export function useLogSession(source: LogSource | undefined, onView: (view: ViewState) => void) {
  const [data, setData] = useState<LogData>(() => ({
    search: SEARCH_IDLE,
    stats: statsEmpty(),
    statsVersion: 0,
    view: VIEW_EMPTY,
  }));
  const [client, setClient] = useState<LogClient>();
  const live = useRef({ data, id: 0, path: undefined as string | undefined, isLive: false, nonce: 0 });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  // Updates reach React at most every UPDATE_INTERVAL_MS, since indexing reports far more often.
  const flushSoon = useCallback(() => {
    flushTimer.current ??= setTimeout(() => {
      flushTimer.current = undefined;
      setData(live.current.data);
    }, UPDATE_INTERVAL_MS);
  }, []);

  const patch = useCallback(
    (change: Partial<LogData>, now = false) => {
      live.current.data = { ...live.current.data, ...change };
      if (now) {
        clearTimeout(flushTimer.current);
        flushTimer.current = undefined;
        setData(live.current.data);
      } else {
        flushSoon();
      }
    },
    [flushSoon]
  );

  useEffect(() => {
    const worker = new LogClient((message: WorkerResponse) => {
      const l = live.current;
      // -1 is the worker itself failing; anything else belongs to the file it was sent for
      if ("id" in message && message.id !== l.id && message.id !== -1) {
        return;
      }
      switch (message.type) {
        case "reset":
          l.data = {
            ...l.data,
            file: l.path ? { indexed: 0, loading: true, modifiedMs: 0, path: l.path, size: 0 } : undefined,
            live: undefined,
            meta: undefined,
            stats: statsEmpty(),
            statsVersion: l.data.statsVersion + 1,
          };
          flushSoon();
          break;
        case "file":
          if (l.data.file) {
            patch({ file: { ...l.data.file, modifiedMs: message.modifiedMs, size: message.size } });
          }
          break;
        case "meta":
          patch({ meta: message.meta });
          break;
        case "progress":
          if (l.data.file?.loading) {
            patch({ file: { ...l.data.file, indexed: message.done } });
          }
          break;
        case "live":
          patch({ live: { ...message.status, nonce: l.nonce } });
          break;
        case "stats":
          patch({ stats: statsFrom(message.stats), statsVersion: l.data.statsVersion + 1 });
          break;
        case "view": {
          const view = { count: message.count, dirtyFrom: message.dirtyFrom, flags: message.flags, serial: message.serial, version: message.version };
          // the row cache hears about it at once; the counts can wait for the next flush
          onViewRef.current(view);
          patch({ view });
          break;
        }
        case "search":
          patch({ search: message.status });
          break;
        case "done":
          if (l.data.file) {
            patch({ file: { ...l.data.file, loading: false } }, true);
          }
          break;
        case "error":
          if (l.data.file) {
            patch({ file: { ...l.data.file, error: message.message, loading: false } }, true);
          }
          break;
      }
    });
    setClient(worker);
    return () => {
      worker.terminate();
      setClient(undefined);
    };
  }, [flushSoon, patch]);

  useEffect(() => {
    const l = live.current;
    l.path = source ? (source.kind === "file" ? source.path : source.url) : undefined;
    l.isLive = source?.kind === "live";
    l.nonce = source?.kind === "live" ? source.nonce : 0;
    l.id++;
    if (!client) {
      return;
    }
    if (source?.kind === "live") {
      client.connect(l.id, source.url, source.fresh);
    } else if (source) {
      client.open(l.id, source.path);
    } else {
      client.close(l.id);
      l.data = { ...l.data, file: undefined, live: undefined, meta: undefined, stats: statsEmpty(), statsVersion: l.data.statsVersion + 1, view: VIEW_EMPTY };
      onViewRef.current(VIEW_EMPTY);
      setData(l.data);
    }
  }, [client, source]);

  // Called when the folder watcher says something changed.
  const refresh = useCallback(() => {
    const l = live.current;
    if (l.path && !l.isLive && client) {
      client.refresh(l.id);
    }
  }, [client]);

  // Reads the open file again from the start.
  const reload = useCallback(() => {
    const l = live.current;
    if (l.path && !l.isLive && client) {
      l.id++;
      client.open(l.id, l.path);
    }
  }, [client]);

  const disconnect = useCallback(() => {
    client?.disconnect(live.current.id);
  }, [client]);

  return { client, data, disconnect, refresh, reload };
}
