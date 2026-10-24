import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { CategoryFilter } from "./components/CategoryFilter";
import { ConnectDialog } from "./components/ConnectDialog";
import { DetailPane } from "./components/DetailPane";
import { FileMenu, KindIcon } from "./components/FileMenu";
import { FileTree } from "./components/FileTree";
import { FilterBar } from "./components/FilterBar";
import { DetailIcon, SessionIcon } from "./components/Icons";
import { LiveBadge } from "./components/LiveBadge";
import { LogTable, type ScrollRequest } from "./components/LogTable";
import { MENU_OPEN_EVENT } from "./components/Menu";
import { PreReleaseWatermark } from "./components/PreReleaseWatermark";
import { SessionPane } from "./components/SessionPane";
import { type SourceDraft, SourcesDialog } from "./components/SourcesDialog";
import { RecentList } from "./components/RecentList";
import { type SourceFilter, type SourceMode, SourcesPane } from "./components/SourcesPane";
import { Sized } from "./components/Sized";
import { Toolbar } from "./components/Toolbar";
import { UpdateDialog } from "./components/UpdateDialog";
import { ViewMenu, type Theme } from "./components/ViewMenu";
import { BUILD_INFO } from "./build-info";
import { backend } from "./lib/backend";
import { embeddedView } from "./lib/embedded";
import { clipboardWrite } from "./lib/clipboard";
import { useColumns } from "./lib/columns";
import { filtersActive, filtersDefault, matcherBuild, type Filters, type SearchSpec } from "./lib/filter";
import { baseName, pathKey, sizeText } from "./lib/format";
import { recentKey, recentLabel, recentLoad, recentPush, recentRemove, recentStore, type RecentItem, type RecentKind } from "./lib/recent";
import { useRows } from "./lib/rows";
import { SELECTION_EMPTY, selectionAll, selectionClick, selectionCollapse, selectionSingle, type SelectModifiers } from "./lib/selection";
import { useLogSession, type LogSource, type ViewState } from "./lib/session";
import { textOf, translate, translateCount, useT } from "./localization";
import { isXbdmUrl, xbdmUrl } from "./lib/xbdm";
import { storedGet, storedSet } from "./lib/stored";
import { DESKTOP_BUILD } from "./lib/desktop";
import { useUpdateCheck } from "./lib/update-hook";
import type { DetailResult, FileNode, LogEntry, SessionInfo, SourceSpec } from "./lib/types";

// The dmv. prefix (here, in columns.ts and recent.ts, and on the pane size keys below) is from the app's
// old name, Datamine Viewer. Kept so existing installs keep their settings.
const SERVER_URL_KEY = "dmv.serverUrl";
const SERVER_URL_DEFAULT = "http://127.0.0.1:32557";
// the address of the last Xbox 360 connected to
const CONSOLE_ADDRESS_KEY = "dmv.consoleAddress";
const NOTICE_MS = 7000;
const SHOW_ALL_KEY = "dmv.showAll";
const THEME_KEY = "dmv.theme";
const LEFT_HIDDEN_KEY = "dmv.leftHidden";
const RIGHT_HIDDEN_KEY = "dmv.rightHidden";
const WRAP_KEY = "dmv.wrap";
// A search over a big file takes a moment, so wait for a pause in typing.
const SEARCH_DELAY_MS = 250;
// A copy of more text than this is refused: it has to fit in one string on its way to the clipboard.
const COPY_LIMIT_BYTES = 50 * 1024 * 1024;
const COPIED_MS = 2500;

// `host:port` of a server, with its path only when it is not the usual /datamine; an Xbox 360 by its address.
function serverName(url: string): string {
  if (isXbdmUrl(url)) {
    return url.replace(/^xbdm:\/\//i, "").replace(/:730$/, "");
  }
  try {
    const { host, pathname } = new URL(url);
    const path = pathname.replace(/\/+$/, "");
    return path === "" || path === "/datamine" ? host : `${host}${path}`;
  } catch {
    return url;
  }
}

// One of several sources open together. `root` is what the backend opens a file by and what recent
// keeps; `target` is the path the worker reads it at.
interface MultiSource extends SourceSpec {
  root: string;
}

function usePersisted<T>(key: string, initial: T, parse: (text: string) => T | undefined): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const text = storedGet(key);
    return (text === null ? undefined : parse(text)) ?? initial;
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      storedSet(key, String(next));
    },
    [key]
  );
  return [value, set];
}

export function App() {
  const t = useT();
  // the folder or file that is open, and whether it is a file on its own
  const [folder, setFolder] = useState<string>();
  const [single, setSingle] = useState(false);
  const [tree, setTree] = useState<FileNode[]>([]);
  // set while an event server is the source; `nonce` makes connecting again a new source
  const [live, setLive] = useState<{ url: string; nonce: number; fresh: boolean }>();
  // set while several files and servers are shown together; `nonce` changes with the list
  const [multi, setMulti] = useState<{ sources: MultiSource[]; nonce: number }>();
  const [sourcesDialog, setSourcesDialog] = useState<"open" | "add">();
  const [recents, setRecents] = useState<RecentItem[]>(recentLoad);
  const [notice, setNotice] = useState<string>();
  // the connect dialog that is open, for a server or an Xbox 360
  const [connectOpen, setConnectOpen] = useState<"server" | "console">();
  const [aboutOpen, setAboutOpen] = useState(false);
  const update = useUpdateCheck();
  const [folderError, setFolderError] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [showAll, setShowAll] = usePersisted(SHOW_ALL_KEY, false, (t) => t === "true");
  const [theme, setTheme] = usePersisted<Theme>(THEME_KEY, "auto", (t) => (t === "dark" || t === "light" ? t : "auto"));
  const [leftHidden, setLeftHidden] = usePersisted(LEFT_HIDDEN_KEY, false, (t) => t === "true");
  const [rightHidden, setRightHidden] = usePersisted(RIGHT_HIDDEN_KEY, false, (t) => t === "true");
  const [wrap, setWrap] = usePersisted(WRAP_KEY, true, (t) => t === "true");
  const [follow, setFollow] = useState(false);
  const [filters, setFilters] = useState<Filters>(filtersDefault);
  const [search, setSearch] = useState<SearchSpec>({ caseSensitive: false, regex: false, text: "" });
  const [onlyMatches, setOnlyMatches] = useState(false);
  // The selected entries (by id), with the focused one that the detail pane shows, and the table row
  // that is on (-1: hidden by the filters).
  const [selection, setSelection] = useState(SELECTION_EMPTY);
  const selected = selection.focus;
  const [selectedRow, setSelectedRow] = useState(-1);
  // how many rows the selection is on, for the note in the detail pane
  const [selectedCount, setSelectedCount] = useState(0);
  const [copied, setCopied] = useState<string>();
  const [detail, setDetail] = useState<DetailResult>();
  const [matchPosition, setMatchPosition] = useState(0);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest>();
  const [rightTab, setRightTab] = useState<"detail" | "session">("detail");
  const searchRef = useRef<HTMLInputElement>(null);
  const nonce = useRef(0);
  const viewChanged = useRef<(view: ViewState) => void>(() => undefined);

  const source = useMemo<LogSource | undefined>(() => {
    if (multi) {
      return { kind: "multi", nonce: multi.nonce, sources: multi.sources.map(({ key, kind, name, target }) => ({ key, kind, name, target })) };
    }
    if (live) {
      return { fresh: live.fresh, kind: "live", nonce: live.nonce, url: live.url };
    }
    return selectedPath ? { kind: "file", path: selectedPath } : undefined;
  }, [live, multi, selectedPath]);
  const { client, data, disconnect, refresh, reload } = useLogSession(source, (view) => viewChanged.current(view));
  const rows = useRows(client);
  const columns = useColumns();
  viewChanged.current = rows.viewChanged;

  const deferredSearch = useDeferredValue(search);
  const { matcher, error: searchError } = useMemo(() => matcherBuild(deferredSearch), [deferredSearch]);
  const viewCount = data.view.count;

  useEffect(() => {
    document.documentElement.dataset.theme = theme === "auto" ? "" : theme;
  }, [theme]);

  const folderRef = useRef(folder);
  folderRef.current = folder;
  const singleRef = useRef(single);
  singleRef.current = single;
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const recentsRef = useRef(recents);
  recentsRef.current = recents;
  const leftHiddenRef = useRef(leftHidden);
  leftHiddenRef.current = leftHidden;
  const rightHiddenRef = useRef(rightHidden);
  rightHiddenRef.current = rightHidden;
  const liveNonce = useRef(0);
  const multiNonce = useRef(0);
  const sourceKey = useRef(0);
  const closeRef = useRef<() => Promise<void>>(async () => undefined);
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const nodesFetch = useCallback(async (root: string, asFile: boolean): Promise<FileNode[]> => {
    return asFile ? [await backend.fileInfo(root)] : backend.listTree(root);
  }, []);

  const treeLoad = useCallback(
    async (root: string, asFile: boolean) => {
      setTree(await nodesFetch(root, asFile));
    },
    [nodesFetch]
  );

  // --- the recent list

  const recentsSet = useCallback((items: RecentItem[]) => {
    recentsRef.current = items;
    setRecents(items);
    recentStore(items);
  }, []);

  const recentForget = useCallback((items: RecentItem[]) => {
    for (const item of items) {
      if (item.handle) {
        void backend.handleForget(recentKey(item));
      }
    }
  }, []);

  // Something opened fine, so it goes to the top. What a browser picked is kept as a handle; a
  // snapshot cannot be opened again, so it is not listed.
  const recentAdd = useCallback(
    async (kind: RecentKind, target: string, nickname?: string) => {
      // what a connection spooled to the temp folder is not a recent thing unless it was saved
      if ((kind === "file" || kind === "folder") && backend.isSpoolPath(target)) {
        return;
      }
      const item: RecentItem = nickname ? { kind, nickname, target } : { kind, target };
      if ((kind === "file" || kind === "folder") && !backend.isPathRoot(target)) {
        item.handle = true;
        if (!(await backend.handleSave(recentKey(item), target))) {
          return;
        }
      }
      const { dropped, items } = recentPush(recentsRef.current, item);
      recentForget(dropped);
      recentsSet(items);
    },
    [recentForget, recentsSet]
  );

  // Takes something off the recent list, when asked to.
  const recentRemoveOne = useCallback(
    (item: RecentItem) => {
      recentForget([item]);
      recentsSet(recentRemove(recentsRef.current, item));
    },
    [recentForget, recentsSet]
  );

  // ...or because it could not be opened.
  const recentDrop = useCallback(
    (item: RecentItem, why?: string) => {
      recentRemoveOne(item);
      const name = recentLabel(item);
      setNotice(why ? translate("notice_recent_dropped_why", { name, why }) : translate("notice_recent_dropped", { name }));
    },
    [recentRemoveOne]
  );

  // --- opening things; each gives back what went wrong, or nothing

  const folderOpen = useCallback(
    async (root: string, remember = true): Promise<string | undefined> => {
      try {
        setFolderError(undefined);
        const nodes = await nodesFetch(root, false);
        setTree(nodes);
        setSingle(false);
        setLive(undefined);
        setMulti(undefined);
        setFolder(root);
        setSelectedPath(undefined);
        // A folder is browsed from the tree, so bring the left pane back.
        setLeftHidden(false);
        await backend.watch(root);
        if (remember) {
          void recentAdd("folder", root);
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        setFolderError(why);
        return why;
      }
    },
    [nodesFetch, recentAdd, setLeftHidden]
  );

  const fileOpen = useCallback(
    async (root: string): Promise<string | undefined> => {
      try {
        setFolderError(undefined);
        const [node] = await nodesFetch(root, true);
        setTree([node]);
        setSingle(true);
        setLive(undefined);
        setMulti(undefined);
        setFolder(root);
        setSelectedPath(node.path);
        await backend.watch(root);
        void recentAdd("file", root);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        setFolderError(why);
        return why;
      }
    },
    [nodesFetch, recentAdd]
  );

  // Lets go of the folder or file that is open: nothing is watched or listed.
  const folderClear = useCallback(() => {
    void backend.unwatch().catch(() => undefined);
    setTree([]);
    setFolder(undefined);
    setSingle(false);
    setSelectedPath(undefined);
    setFolderError(undefined);
  }, []);

  const liveConnect = useCallback((url: string, fresh = false) => {
    if (isXbdmUrl(url)) {
      storedSet(CONSOLE_ADDRESS_KEY, serverName(url));
    } else {
      storedSet(SERVER_URL_KEY, url);
    }
    setConnectOpen(undefined);
    folderClear();
    setMulti(undefined);
    setLive({ fresh, nonce: ++liveNonce.current, url });
    setFollow(true);
  }, [folderClear]);

  // Shows these sources together. The backend is told of every file among them, so it reads those and
  // nothing else; the worker carries on with the ones it has already. None left closes everything.
  const multiSet = useCallback(
    async (sources: MultiSource[]): Promise<string | undefined> => {
      if (sources.length === 0) {
        await closeRef.current();
        return;
      }
      try {
        const files = sources.filter((one) => one.kind === "file");
        const nodes = files.length > 0 ? await backend.filesOpen(files.map((one) => one.root)) : [];
        const paths = new Map(files.map((one, k) => [one.key, nodes[k].path]));
        folderClear();
        setLive(undefined);
        setMulti({ nonce: ++multiNonce.current, sources: sources.map((one) => ({ ...one, target: paths.get(one.key) ?? one.target })) });
        setLeftHidden(false);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [folderClear, setLeftHidden]
  );

  const pathOpen = useCallback(
    async (path: string) => {
      const kind = await backend.pathKind(path).catch(() => "missing" as const);
      await (kind === "file" ? fileOpen(path) : folderOpen(path));
    },
    [fileOpen, folderOpen]
  );

  const openFileDialog = useCallback(async () => {
    const picked = await backend.pickFile();
    if (picked) {
      await fileOpen(picked);
    }
  }, [fileOpen]);

  const openFolderDialog = useCallback(async () => {
    const picked = await backend.pickFolder();
    if (picked) {
      await folderOpen(picked);
    }
  }, [folderOpen]);

  const recentOpen = useCallback(
    async (item: RecentItem) => {
      if (item.kind === "server" || item.kind === "console") {
        // a failure to connect is noticed when the connection reports it
        liveConnect(item.target);
        return;
      }
      let root = item.target;
      if (item.handle) {
        const restored = await backend.handleRestore(recentKey(item));
        if (!restored) {
          recentDrop(item, translate("notice_no_access"));
          return;
        }
        root = restored.root;
      }
      // what went wrong is already in the status bar
      if (await (item.kind === "file" ? fileOpen(root) : folderOpen(root))) {
        recentDrop(item);
      }
    },
    [fileOpen, folderOpen, liveConnect, recentDrop]
  );

  const recentClear = useCallback(() => {
    recentForget(recentsRef.current);
    recentsSet([]);
  }, [recentForget, recentsSet]);

  // A connection that gets through is a recent server or console. One that never does is not added.
  const handledNonce = useRef(0);
  const liveStatus = data.live;
  useEffect(() => {
    if (!live || !liveStatus || liveStatus.nonce !== live.nonce || handledNonce.current === live.nonce) {
      return;
    }
    if (liveStatus.state === "live") {
      handledNonce.current = live.nonce;
      // by the server's own prefix, so every way of typing its address is one entry
      void recentAdd(isXbdmUrl(live.url) ? "console" : "server", liveStatus.prefix ?? live.url);
    }
    // One that cannot be reached stays in the recent list, and its error shows in place of the rows: it
    // is likely just off (a console reboots with every title), unlike a file that is gone.
  }, [live, liveStatus, recentAdd]);

  // Copies the spool of the live session where the user says. A session that has ended opens as
  // the saved file; one still going keeps going and only has what is written so
  // far copied.
  const sessionSave = useCallback(async () => {
    const status = liveStatus;
    if (!status?.spoolPath) {
      return;
    }
    try {
      const saved = await backend.spoolSave(status.spoolPath);
      if (!saved) {
        return;
      }
      if (!saved.root) {
        setNotice(translate("notice_downloaded", { name: saved.name }));
      } else if (status.state === "closed") {
        await fileOpen(saved.root);
        setNotice(translate("notice_saved", { name: saved.name }));
      } else {
        void recentAdd("file", saved.root);
        setNotice(translate("notice_saved_partial", { name: saved.name }));
      }
    } catch (error) {
      setNotice(translate("notice_save_failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [fileOpen, liveStatus, recentAdd]);

  // Reads the tree and the open file again, for changes the watcher missed.
  const reloadAll = useCallback(async () => {
    if (folder) {
      await treeLoad(folder, single).catch(() => undefined);
    }
    reload();
  }, [folder, reload, single, treeLoad]);

  // Closes whatever is open and goes back to the start state. A live connection is let go of
  // first; its spool stays in the temp folder for the next connection to carry on in.
  const closeAll = useCallback(async () => {
    disconnect();
    folderClear();
    setLive(undefined);
    setMulti(undefined);
    setFollow(false);
    setFilters(filtersDefault());
    setSearch({ caseSensitive: false, regex: false, text: "" });
    setOnlyMatches(false);
    setSelection(SELECTION_EMPTY);
    setSelectedRow(-1);
    setDetail(undefined);
  }, [disconnect, folderClear]);

  closeRef.current = closeAll;
  reloadRef.current = reloadAll;

  // What the sources dialog gave: a new set of sources, or more for the ones open.
  const sourcesSubmit = useCallback(
    async (mode: "open" | "add", drafts: SourceDraft[]) => {
      setSourcesDialog(undefined);
      const added: MultiSource[] = drafts.map((draft) => ({ key: `s${++sourceKey.current}`, kind: draft.kind, name: draft.name, root: draft.root, target: draft.root }));
      const why = await multiSet(mode === "add" && multi ? [...multi.sources, ...added] : added);
      if (why) {
        setNotice(translate("notice_sources_failed", { error: why }));
        return;
      }
      if (mode === "open") {
        setFollow(added.some((one) => one.kind === "server"));
      }
      for (const one of added) {
        if (one.kind === "file") {
          void recentAdd("file", one.root, one.name);
        }
      }
    },
    [multi, multiSet, recentAdd]
  );

  // Shows only a source, or hides it, as the + and - of a category do; the same button again undoes it.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>({ exclude: [], include: [] });
  const sourceMode = useCallback((key: string, mode: SourceMode) => {
    setSourceFilter((before) => {
      const current = before.include.includes(key) ? "include" : before.exclude.includes(key) ? "exclude" : undefined;
      const include = before.include.filter((other) => other !== key);
      const exclude = before.exclude.filter((other) => other !== key);
      if (current !== mode) {
        (mode === "include" ? include : exclude).push(key);
      }
      return { exclude, include };
    });
  }, []);
  // the filter only names sources that are open
  const sourceKeys = multi?.sources.map((one) => one.key).join(" ") ?? "";
  useEffect(() => {
    const open = new Set(sourceKeys.split(" "));
    setSourceFilter((before) =>
      before.include.every((key) => open.has(key)) && before.exclude.every((key) => open.has(key))
        ? before
        : { exclude: before.exclude.filter((key) => open.has(key)), include: before.include.filter((key) => open.has(key)) }
    );
  }, [sourceKeys]);
  useEffect(() => {
    client?.sourceFilter(sourceFilter.include, sourceFilter.exclude);
  }, [client, sourceFilter]);

  const sourceRemove = useCallback(
    (key: string) => {
      if (multi) {
        void multiSet(multi.sources.filter((one) => one.key !== key)).then((why) => why && setNotice(translate("notice_sources_failed", { error: why })));
      }
    },
    [multi, multiSet]
  );

  // A server among the sources that gets through is a recent server, like one connected on its own.
  const serversListed = useRef(new Set<string>());
  const sourceStatuses = data.sources;
  useEffect(() => {
    for (const status of sourceStatuses ?? []) {
      const one = multi?.sources.find((source) => source.key === status.key);
      if (one?.kind === "server" && status.state === "live" && !serversListed.current.has(one.key)) {
        serversListed.current.add(one.key);
        void recentAdd(isXbdmUrl(one.target) ? "console" : "server", status.prefix ?? one.target, one.name);
      }
    }
  }, [multi, recentAdd, sourceStatuses]);

  // Old spools in the temp folder go once, at start (the desktop app tidies them itself).
  useEffect(() => {
    void backend.spoolCleanup();
  }, []);

  // Nothing opens by itself. A ?folder= (and ?file= in it), a ?file=, a ?connect= or a path given on the
  // command line is a request to open that.
  useEffect(() => {
    void (async () => {
      const query = new URLSearchParams(window.location.search);
      const fromFolder = query.get("folder");
      const fromFile = query.get("file");
      if ((fromFolder || fromFile) && !backend.pathsSupported) {
        setNotice(translate("notice_path_unsupported"));
      } else if (fromFolder) {
        await folderOpen(fromFolder);
        if (fromFile) {
          setSelectedPath(fromFile);
        }
      } else if (fromFile) {
        await fileOpen(fromFile);
      } else {
        const argument = await backend.startupPath();
        if (argument) {
          await pathOpen(argument);
        }
      }
      const server = query.get("connect");
      if (server) {
        liveConnect(server);
      }
    })();
  }, [fileOpen, folderOpen, liveConnect, pathOpen]);

  // Watcher events: the tree follows creates, deletes and renames, the open file follows its own writes.
  const treeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void backend
      .onChanged((event) => {
        const root = folderRef.current;
        if (!root) {
          return;
        }
        // plain writes only change sizes, so the tree can wait; structure changes cannot
        const delay = event.kind === "modify" ? 1500 : 200;
        treeTimer.current ??= setTimeout(() => {
          treeTimer.current = undefined;
          // something else may have been opened since
          if (folderRef.current === root) {
            void treeLoad(root, singleRef.current).catch(() => undefined);
          }
        }, delay);
        const open = selectedPathRef.current;
        if (open && (event.kind !== "modify" || event.paths.some((p) => pathKey(p) === pathKey(open)))) {
          refresh();
        }
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          off = unlisten;
        }
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [refresh, treeLoad]);

  // Dropped on the window: one file or folder opens as if picked, several files open together.
  const [dropOver, setDropOver] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void backend
      .onDrop((event) => {
        setDropOver(event.kind === "over");
        if (event.kind !== "drop") {
          return;
        }
        const files = event.dropped.filter((one) => one.isFile);
        if (event.dropped.length === 1) {
          const [one] = event.dropped;
          void (one.isFile ? fileOpen(one.root) : folderOpen(one.root));
        } else if (files.length > 0) {
          void sourcesSubmit(
            "open",
            files.map((one) => ({ kind: "file", name: baseName(one.root), root: one.root }))
          );
        }
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          off = unlisten;
        }
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [fileOpen, folderOpen, sourcesSubmit]);

  // The worker keeps the filters and the search between files, but a new worker starts without them.
  useEffect(() => {
    client?.filters(filters, onlyMatches);
  }, [client, filters, onlyMatches]);

  const jumpPending = useRef(false);
  useEffect(() => {
    if (!client) {
      return;
    }
    const timer = setTimeout(() => {
      jumpPending.current = matcher !== undefined;
      setMatchPosition(0);
      client.search(matcher ? deferredSearch : undefined);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [client, matcher, deferredSearch]);

  // a new file or connection starts clean
  const rowsClear = rows.clear;
  useEffect(() => {
    rowsClear();
    setSelection(SELECTION_EMPTY);
    setSelectedRow(-1);
    setDetail(undefined);
    setMatchPosition(0);
  }, [rowsClear, source]);

  // the detail pane follows the selected entry
  const loading = data.file?.loading;
  useEffect(() => {
    if (!client || selected === undefined) {
      setDetail(undefined);
      return;
    }
    let current = true;
    client.call({ entry: selected, name: "detail" }).then(
      (result) => current && setDetail(result),
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [client, selected, loading]);

  // and the filters decide which row, if any, it is on
  useEffect(() => {
    if (!client || selected === undefined) {
      return;
    }
    let current = true;
    client.call({ entry: selected, name: "locate" }).then(
      (row) => current && setSelectedRow(row),
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [client, selected, data.view.version]);

  const selectOnly = useCallback((id: number) => setSelection(selectionSingle(id)), []);

  const matchGo = useCallback(
    async (position: number) => {
      const found = await client?.call({ name: "matchAt", position });
      if (!found) {
        return;
      }
      setMatchPosition(position);
      selectOnly(found.entry);
      setSelectedRow(found.row);
      setScrollRequest({ nonce: ++nonce.current, row: found.row });
    },
    [client, selectOnly]
  );

  const matchCount = data.search.matches;
  const matchStep = useCallback(
    (direction: 1 | -1) => {
      if (matchCount > 0) {
        setFollow(false);
        void matchGo((matchPosition + direction + matchCount) % matchCount);
      }
    },
    [matchCount, matchGo, matchPosition]
  );

  // a new search jumps to its first match as soon as one is found
  useEffect(() => {
    if (jumpPending.current && matchCount > 0) {
      jumpPending.current = false;
      setFollow(false);
      void matchGo(0);
    }
  }, [matchCount, matchGo]);

  const viewCountRef = useRef(viewCount);
  viewCountRef.current = viewCount;
  const jumpToTail = useCallback(() => {
    setFollow(true);
    setScrollRequest({ nonce: ++nonce.current, row: Math.max(0, viewCountRef.current - 1) });
  }, []);

  const sessionJump = useCallback(
    async (session: SessionInfo) => {
      const row = await client?.call({ entry: session.id, name: "seek" });
      if (row !== undefined) {
        setFollow(false);
        setScrollRequest({ nonce: ++nonce.current, row });
      }
    },
    [client]
  );

  // A click or a key on a row: the entry is selected the way the modifiers say, and focused.
  const rowSelect = useCallback(
    (row: number, entry: LogEntry | undefined, modifiers: SelectModifiers) => {
      setSelectedRow(row);
      const apply = (id: number) => setSelection((before) => selectionClick(before, id, modifiers));
      if (entry) {
        apply(entry.ordinal);
        return;
      }
      void client?.call({ name: "entryAt", row }).then((id) => id !== undefined && apply(id));
    },
    [client]
  );

  const selectAll = useCallback(async () => {
    const rowCount = viewCountRef.current;
    if (!client || rowCount === 0) {
      return;
    }
    // every row up to the last one is one range of ids, however many there are
    const last = await client.call({ name: "entryAt", row: rowCount - 1 });
    if (last !== undefined) {
      setSelection((before) => selectionAll(before, last));
    }
  }, [client]);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const copying = useRef(false);
  // Copies the selected rows to the clipboard, in the order of the table.
  const copySelection = useCallback(
    async (mode: "raw" | "message") => {
      const { ranges } = selectionRef.current;
      if (!client || copying.current) {
        return;
      }
      if (ranges.length === 0) {
        setCopied(translate("copied_nothing_selected"));
        return;
      }
      copying.current = true;
      try {
        const result = await client.call({ limit: COPY_LIMIT_BYTES, mode, name: "selectionRaw", ranges });
        if (result.text === undefined) {
          setNotice(translate("notice_copy_too_big", { limit: COPY_LIMIT_BYTES / 1024 / 1024, size: sizeText(result.bytes) }));
        } else if (result.rows === 0) {
          setCopied(translate("copied_hidden"));
        } else {
          await clipboardWrite(result.text);
          setCopied(translateCount("copied_lines", result.rows));
        }
      } catch (error) {
        setNotice(translate("notice_copy_failed", { error: error instanceof Error ? error.message : String(error) }));
      } finally {
        copying.current = false;
      }
    },
    [client]
  );
  const copyRef = useRef(copySelection);
  copyRef.current = copySelection;
  const selectAllRef = useRef(selectAll);
  selectAllRef.current = selectAll;

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // The rows the selection is on. A single entry needs no asking.
  useEffect(() => {
    const { ranges } = selection;
    if (!client || ranges.length === 0 || (ranges.length === 1 && ranges[0][0] === ranges[0][1])) {
      setSelectedCount(ranges.length);
      return;
    }
    let current = true;
    client.call({ name: "selectionCount", ranges }).then(
      (rowCount) => current && setSelectedCount(rowCount),
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [client, selection, data.view.version, viewCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable);
      // Copy and select all belong to the table when focus is in it, or on the page with no text selected
      // (selected text in the detail pane is copied the usual way).
      const inTable = Boolean(target?.closest?.(".logtable"));
      const onPage = !target || target === document.body || target === document.documentElement;
      const tableKey = !typing && (inTable || (onPage && !window.getSelection()?.toString()));
      const letter = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && tableKey && (letter === "c" || letter === "a")) {
        e.preventDefault();
        if (letter === "c") {
          void copyRef.current("raw");
        } else {
          void selectAllRef.current();
        }
      } else if (e.key === "Escape" && inTable && !e.defaultPrevented) {
        setSelection(selectionCollapse);
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && (letter === "f" || letter === "v")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: letter === "f" ? "file" : "view" }));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (e.altKey) {
          setRightHidden(!rightHiddenRef.current);
        } else {
          setLeftHidden(!leftHiddenRef.current);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void (e.shiftKey ? openFolderDialog() : openFileDialog());
      } else if (e.key === "F5") {
        e.preventDefault();
        void reloadRef.current();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        void closeRef.current();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!e.shiftKey) {
          setConnectOpen("server");
        } else if (backend.kind === "tauri") {
          setConnectOpen("console");
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F3") {
        e.preventDefault();
        matchStep(e.shiftKey ? -1 : 1);
      } else if (e.key === "End" && !typing && !e.shiftKey) {
        e.preventDefault();
        jumpToTail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jumpToTail, matchStep, openFileDialog, openFolderDialog, setLeftHidden, setRightHidden]);

  const toolbarLabel = multi
    ? { kind: "sources" as const, name: multi.sources.map((one) => one.name).join(", "), title: translateCount("format_sources", multi.sources.length) }
    : live
    ? { kind: isXbdmUrl(live.url) ? ("console" as const) : ("server" as const), name: serverName(liveStatus?.prefix ?? live.url), title: liveStatus?.prefix ?? live.url }
    : folder
      ? { kind: single ? ("file" as const) : ("folder" as const), name: baseName(folder), title: folder }
      : undefined;
  const highlight = matcher?.highlight;
  const file = data.file;
  const filtered = filtersActive(filters) || (onlyMatches && matcher !== undefined);
  const indexedPercent = file && file.size > 0 ? Math.min(100, Math.floor((file.indexed / file.size) * 100)) : 0;
  const connected = live !== undefined && liveStatus !== undefined && liveStatus.state !== "closed";

  const table = (
    <LogTable
      columns={columns}
      count={viewCount}
      follow={follow}
      highlight={highlight}
      onCopy={(mode) => void copySelection(mode)}
      onFollowBreak={() => setFollow(false)}
      onFollowResume={() => setFollow(true)}
      onSelectAll={() => void selectAll()}
      onSelectRow={rowSelect}
      rows={rows}
      scrollRequest={scrollRequest}
      selected={selected}
      selectedRow={selectedRow}
      selection={selection}
      sessionKey={multi ? `multi ${multi.nonce}` : live ? `live ${live.nonce}` : (selectedPath ?? "")}
      showSource={multi !== undefined}
      viewVersion={data.view.version}
      wrap={wrap}
    />
  );

  // While a server is connected the left pane is only the categories; otherwise the tree sits above them.
  const categoryFilter = (
    <CategoryFilter counts={data.stats.categoryCounts} filters={filters} onFilters={setFilters} version={data.statsVersion} />
  );
  // The sources or the files on top, as tall as they need to be until the divider is dragged; the
  // categories take the rest.
  const categories = multi ? (
    <>
      <Sized axis="y" initial="fit" side="end" storageKey="dmv.sourcesHeight">
        <SourcesPane
          filter={sourceFilter}
          onAdd={() => setSourcesDialog("add")}
          onMode={sourceMode}
          onRemove={sourceRemove}
          sources={multi.sources}
          statuses={sourceStatuses}
        />
      </Sized>
      <div className="categories-fill">{categoryFilter}</div>
    </>
  ) : live ? (
    <div className="categories-fill">{categoryFilter}</div>
  ) : (
    <>
      <Sized axis="y" initial="fit" side="end" storageKey="dmv.filesHeight">
        <FileTree
          onSelect={(path) => {
            setLive(undefined);
            setSelectedPath(path);
          }}
          onShowAll={setShowAll}
          root={folder}
          selected={selectedPath}
          showAll={showAll}
          single={single}
          tree={tree}
        />
      </Sized>
      <div className="categories-fill">{categoryFilter}</div>
    </>
  );

  let center: React.ReactNode;
  if (multi) {
    if (viewCount > 0) {
      center = table;
    } else if (file?.loading) {
      center = <div className="placeholder">{translateCount("placeholder_reading_sources", multi.sources.length)}</div>;
    } else {
      center = <div className="placeholder">{t(filtered ? "placeholder_no_rows" : "placeholder_sources_empty")}</div>;
    }
  } else if (live) {
    if (viewCount > 0) {
      center = table;
    } else if (liveStatus?.state === "closed" && liveStatus.error) {
      center = <div className="placeholder error">{textOf(liveStatus.error)}</div>;
    } else if (!liveStatus || liveStatus.state === "connecting") {
      center = <div className="placeholder">{t("placeholder_connecting", { url: live.url })}</div>;
    } else {
      center = <div className="placeholder">{t(filtered ? "placeholder_no_rows" : "placeholder_waiting")}</div>;
    }
  } else if (!folder) {
    center = (
      <div className="placeholder">
        <img alt="" className="splash-icon" draggable={false} height="72" src={`${import.meta.env.BASE_URL}app-icon.svg`} width="72" />
        <div className="splash-title">Datamine Explorer</div>
        {backend.kind !== "tauri" && embeddedView() && (
          <div className="splash-warning">{t("splash_embedded")}</div>
        )}
        <div>{folderError ?? t("splash_prompt")}</div>
        <div className="splash-buttons">
          <button className="primary" onClick={() => void openFileDialog()} type="button">
            <KindIcon kind="file" /> {t("file_open_file")}
          </button>
          <button onClick={() => void openFolderDialog()} type="button">
            <KindIcon kind="folder" /> {t("file_open_folder")}
          </button>
          <button onClick={() => setConnectOpen("server")} type="button">
            <KindIcon kind="server" /> {t("file_connect")}
          </button>
          {/* a disabled button takes no pointer, so the reason hangs on what holds it */}
          <span title={backend.kind === "tauri" ? undefined : t("xbox_desktop_only")}>
            <button disabled={backend.kind !== "tauri"} onClick={() => setConnectOpen("console")} type="button">
              <KindIcon kind="console" /> {t("file_connect_xbox")}
            </button>
          </span>
        </div>
        <RecentList items={recents} onOpen={(item) => void recentOpen(item)} onRemove={recentRemoveOne} />
      </div>
    );
  } else if (!file) {
    center = <div className="placeholder">{t("placeholder_pick")}</div>;
  } else if (file.error && viewCount === 0) {
    center = <div className="placeholder error">{file.error}</div>;
  } else if (file.loading && viewCount === 0) {
    center = (
      <div className="placeholder">{t("placeholder_indexing", { name: baseName(file.path), percent: indexedPercent })}</div>
    );
  } else if (viewCount === 0) {
    center = <div className="placeholder">{filtered ? t("placeholder_no_rows") : t("placeholder_no_entries", { name: baseName(file.path) })}</div>;
  } else {
    center = table;
  }

  return (
    <div className="app">
      {dropOver && <div className="drop-overlay">{t("drop_prompt")}</div>}
      <Toolbar
        canSave={Boolean(live && liveStatus?.spoolPath)}
        connected={connected}
        label={toolbarLabel}
        leftShown={!leftHidden}
        menus={
          <>
            <FileMenu
              canClose={Boolean(folder || live || multi)}
              canReload={Boolean(folder && !live && backend.canReload())}
              canSaveSession={Boolean(live && liveStatus?.spoolPath)}
              connected={connected}
              onClearRecent={recentClear}
              onClose={() => void closeAll()}
              onConnect={() => setConnectOpen("server")}
              onConnectXbox={() => setConnectOpen("console")}
              onDisconnect={disconnect}
              onOpenFile={() => void openFileDialog()}
              onOpenFolder={() => void openFolderDialog()}
              onOpenMultiple={() => setSourcesDialog("open")}
              onRecent={(item) => void recentOpen(item)}
              onRecentRemove={recentRemoveOne}
              onReload={() => void reloadAll()}
              onSaveSession={() => void sessionSave()}
              recents={recents}
            />
            <ViewMenu
              columns={columns}
              leftShown={!leftHidden}
              onLeftToggle={() => setLeftHidden(!leftHidden)}
              onResetColumns={columns.reset}
              onRightToggle={() => setRightHidden(!rightHidden)}
              onTheme={setTheme}
              onWrapToggle={() => setWrap(!wrap)}
              rightShown={!rightHidden}
              sourceColumn={multi !== undefined}
              theme={theme}
              wrap={wrap}
            />
          </>
        }
        onAbout={() => setAboutOpen(true)}
        onDisconnect={disconnect}
        onLeftToggle={() => setLeftHidden(!leftHidden)}
        onRightToggle={() => setRightHidden(!rightHidden)}
        onSave={() => void sessionSave()}
        rightShown={!rightHidden}
      />
      <div className="main-row">
        <Sized axis="x" hidden={leftHidden} initial={320} side="end" storageKey="dmv.left">
          <div className="left-col">
            {categories}
          </div>
        </Sized>
        <div className="center-col">
          <FilterBar
            filters={filters}
            follow={follow}
            matchCurrent={matchCount > 0 ? matchPosition + 1 : 0}
            onFilters={setFilters}
            onFollow={(on) => (on ? jumpToTail() : setFollow(false))}
            onMatchStep={matchStep}
            onOnlyMatches={setOnlyMatches}
            onSearch={setSearch}
            onlyMatches={onlyMatches}
            search={search}
            searchError={searchError}
            searchRef={searchRef}
            searchStatus={data.search}
            stats={data.stats}
          />
          {center}
        </div>
        <Sized axis="x" hidden={rightHidden} initial={400} side="start" storageKey="dmv.right">
          <div className="right-col">
            <div className="tabbar">
              <button className={rightTab === "detail" ? "tab active" : "tab"} onClick={() => setRightTab("detail")} type="button">
                <DetailIcon />
                {t("tab_detail")}
              </button>
              <button className={rightTab === "session" ? "tab active" : "tab"} onClick={() => setRightTab("session")} type="button">
                <SessionIcon />
                {t("tab_session")}
              </button>
            </div>
            <div className="right-body">
              {rightTab === "detail" ? (
                <DetailPane
                  detail={detail}
                  highlight={highlight}
                  onSelect={selectOnly}
                  selected={selected}
                  selectedCount={selectedCount}
                />
              ) : (
                <SessionPane data={data} onJump={(session) => void sessionJump(session)} />
              )}
            </div>
          </div>
        </Sized>
      </div>
      <div className={`statusbar${file?.error || notice ? " failed" : ""}`}>
        <span>
          {multi ? translateCount("format_sources", multi.sources.length) : live ? (liveStatus?.prefix ?? live.url) : file ? baseName(file.path) : (folder ?? t("status_nothing_open"))}
        </span>
        {live && <LiveBadge live={liveStatus} />}
        {file && (
          <span>
            {filtered
              ? t("status_rows_of", { entries: translateCount("status_entries", data.stats.count), rows: viewCount.toLocaleString() })
              : translateCount("status_entries", data.stats.count)}
          </span>
        )}
        {file?.loading && !live && <span>{t("status_indexing", { percent: indexedPercent })}</span>}
        {file?.error && <span>{file.error}</span>}
        {notice && <span>{notice}</span>}
        {copied && <span className="copied">{copied}</span>}
        {folderError && folder && <span>{folderError}</span>}
        {backend.note() && <span>{backend.note()}</span>}
        <span className="toolbar-spacer" />
        <button className="statusbar-build" onClick={() => setAboutOpen(true)} title={t("about_title")} type="button">
          Datamine Explorer {BUILD_INFO.buildString}
        </button>
      </div>
      {BUILD_INFO.showWatermark && <PreReleaseWatermark overTable={rightHidden} />}
      {aboutOpen && (
        <AboutDialog
          onCheckUpdates={
            DESKTOP_BUILD && backend.kind === "tauri"
              ? async () => {
                  const outcome = await update.checkNow();
                  if (outcome.kind === "available") {
                    setAboutOpen(false);
                  }
                  return outcome;
                }
              : undefined
          }
          onClose={() => setAboutOpen(false)}
        />
      )}
      {DESKTOP_BUILD && update.release && <UpdateDialog onDownload={update.download} onLater={update.later} onSkip={update.skip} release={update.release} />}
      {sourcesDialog && (
        <SourcesDialog
          mode={sourcesDialog}
          onCancel={() => setSourcesDialog(undefined)}
          onPickFile={() => backend.pickFile({ keep: true })}
          onRecent={async (item) => (item.handle ? (await backend.handleRestore(recentKey(item), { keep: true }))?.root : item.target)}
          onRecentRemove={recentRemoveOne}
          onSubmit={(drafts) => void sourcesSubmit(sourcesDialog, drafts)}
          recents={recents}
          consoleDefault={storedGet(CONSOLE_ADDRESS_KEY) ?? ""}
          serverDefault={storedGet(SERVER_URL_KEY) ?? SERVER_URL_DEFAULT}
          taken={
            sourcesDialog === "add" && multi
              ? { names: multi.sources.map((one) => one.name), targets: multi.sources.map((one) => one.root) }
              : { names: [], targets: [] }
          }
        />
      )}
      {connectOpen && (
        <ConnectDialog
          initial={connectOpen === "console" ? (storedGet(CONSOLE_ADDRESS_KEY) ?? "") : (storedGet(SERVER_URL_KEY) ?? SERVER_URL_DEFAULT)}
          kind={connectOpen}
          onCancel={() => setConnectOpen(undefined)}
          onConnect={(address, fresh) => liveConnect(connectOpen === "console" ? xbdmUrl(address) : address, fresh)}
        />
      )}
    </div>
  );
}
