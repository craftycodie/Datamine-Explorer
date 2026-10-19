// The one place that knows where files come from: Tauri's commands, or a browser. A browser has
// three ways in: a folder or file picked with the File System Access API (live, polled), one picked
// with <input webkitdirectory> / <input type=file> (a snapshot of File objects), and a path given to
// the dev server (scripts/dev-service.mjs), which `?folder=` and the toolbar's path box use.
// A "root" is what listTree or fileInfo take: a path, or the name of something picked in a browser.
import { translate } from "../localization";
import type { HostCall } from "../worker/protocol";
import type { XbdmEvent } from "../worker/xbdm-connection";
import { baseName, pathKey } from "./format";
import { isOpfsPath, liveDirectory, opfsName } from "./opfs";
import { savedName, spoolCleanupPlan, type SpoolGroup } from "./spool";
import type { ChangeEvent, FileNode, FileStat } from "./types";

// What saving a live session gave: the root to open the saved log by (when it can be opened again),
// or none when it was only downloaded.
export interface SpoolSaved {
  name: string;
  root?: string;
}

export interface Backend {
  kind: "tauri" | "browser";
  // Opens `root` as a folder and lists it.
  listTree(root: string): Promise<FileNode[]>;
  // Opens `root` as a single file; reads work for that file alone.
  fileInfo(root: string): Promise<FileNode>;
  // Opens several files to be read together, for several sources in one feed. Gives their nodes in order.
  filesOpen(roots: string[]): Promise<FileNode[]>;
  // Whether a path can be opened by name: always on the desktop, in a browser only through the dev
  // server. A static build (GitHub Pages) has no /api, so it opens things by picking them.
  pathsSupported: boolean;
  // What a typed path is.
  pathKind(path: string): Promise<"file" | "folder" | "missing">;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  stat(path: string): Promise<FileStat>;
  // Watches a folder, or the one file `root` names.
  watch(root: string): Promise<void>;
  unwatch(): Promise<void>;
  onChanged(callback: (event: ChangeEvent) => void): Promise<() => void>;
  // The native dialog (Tauri) or the browser's. Gives the root to pass to listTree.
  pickFolder(): Promise<string | undefined>;
  // The same for one file; the root goes to fileInfo. With `keep`, what was picked before keeps its
  // name and a file of the same name gets another (a browser knows a picked file by its name).
  pickFile(options?: { keep?: boolean }): Promise<string | undefined>;
  // Browser: keeps what was picked as `root` under `key` so it can be reopened later. False when
  // it cannot be kept (a snapshot, or a path, which needs no handle).
  handleSave(key: string, root: string): Promise<boolean>;
  // Browser: the kept handle, with the browser asking for access again; must run in a click. Gives
  // the root to open, or undefined when it is gone or access was refused. `keep` as for pickFile.
  handleRestore(key: string, options?: { keep?: boolean }): Promise<{ root: string; isFile: boolean } | undefined>;
  handleForget(key: string): Promise<void>;
  // a folder or file named on the command line (Tauri)
  startupPath(): Promise<string | undefined>;
  // Whether `root` is a real path that can be reopened later, not a picked folder.
  isPathRoot(root: string): boolean;
  // Something to tell the user about how this folder is read, e.g. that it does not update.
  note(): string | undefined;
  // Whether the folder or file can be read again; a snapshot cannot.
  canReload(): boolean;
  // The spool of a live session (see worker/spool-writer.ts). Tauri answers the worker's calls for it.
  spoolCall(call: Exclude<HostCall, { kind: "read" | "stat" }>): Promise<string | undefined>;
  // Asks where to, copies the spool's log there (not its sidecar); undefined when the user dismissed it.
  spoolSave(path: string): Promise<SpoolSaved | undefined>;
  // Deletes old spools once at start-up (the desktop app does it itself).
  spoolCleanup(): Promise<void>;
  // Whether `path` is in the spool folder, which recents leave out.
  isSpoolPath(path: string): boolean;
  // Opens or closes a link to an Xbox 360's debug monitor (desktop only; a browser cannot open the socket).
  xbdmCall(call: Extract<HostCall, { kind: "xbdmOpen" | "xbdmClose" }>): Promise<void>;
  // What the links say, as it arrives.
  onXbdm(callback: (event: XbdmEvent) => void): Promise<() => void>;
  // Lets go of the links a page before this one left open.
  xbdmCloseAll(): Promise<void>;
}

// the desktop app's events for its links to Xbox 360s (XBDM_EVENT in xbdm.rs)
const XBDM_EVENT = "datamine-explorer://xbdm";

// "datamine-viewer" is the spool folder's name from the app's old name (see spool_dir in spool.rs).
export function spoolPathHas(path: string): boolean {
  return isOpfsPath(path) || pathKey(path).includes("/datamine-viewer/live/");
}

const CHANGED_EVENT = "datamine-explorer://changed";
const SKIPPED = new Set(["node_modules", ".git"]);
const DEPTH_MAXIMUM = 12;
const ENTRIES_MAXIMUM = 50_000;
const POLL_MS = 1000;

function tauriBackend(): Backend {
  return {
    isPathRoot: () => true,
    kind: "tauri",
    pathsSupported: true,
    async listTree(root) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<FileNode[]>("list_tree", { root });
    },
    async fileInfo(root) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<FileNode>("open_file", { path: root });
    },
    async filesOpen(roots) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<FileNode[]>("open_files", { paths: roots });
    },
    handleForget: async () => undefined,
    handleRestore: async () => undefined,
    handleSave: async () => false,
    canReload: () => true,
    isSpoolPath: spoolPathHas,
    note: () => undefined,
    async onChanged(callback) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<ChangeEvent>(CHANGED_EVENT, (event) => callback(event.payload));
    },
    async onXbdm(callback) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<XbdmEvent>(XBDM_EVENT, (event) => callback(event.payload));
    },
    async xbdmCloseAll() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("xbdm_close_all");
    },
    async xbdmCall(call) {
      const { invoke } = await import("@tauri-apps/api/core");
      await (call.kind === "xbdmOpen" ? invoke("xbdm_open", { host: call.host, link: call.link }) : invoke("xbdm_close", { link: call.link }));
    },
    async pathKind(path) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<"file" | "folder" | "missing">("path_kind", { path });
    },
    async pickFile() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: false,
        filters: [
          { extensions: ["txt", "log", "datamine", "zip", "bin", "dat"], name: translate("dialog_filter_logs") },
          { extensions: ["*"], name: translate("dialog_filter_all") },
        ],
        multiple: false,
        title: translate("dialog_open_file"),
      });
      return typeof picked === "string" ? picked : undefined;
    },
    async pickFolder() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: translate("dialog_open_folder") });
      return typeof picked === "string" ? picked : undefined;
    },
    async readRange(path, offset, length) {
      const { invoke } = await import("@tauri-apps/api/core");
      return new Uint8Array(await invoke<ArrayBuffer>("read_file_range", { length, offset, path }));
    },
    async spoolCall(call) {
      const { invoke } = await import("@tauri-apps/api/core");
      switch (call.kind) {
        case "spoolCreate":
          return invoke<string>("spool_create", { name: call.name });
        case "spoolFind":
          return (await invoke<string | null>("spool_find", { prefix: call.prefix })) ?? undefined;
        case "spoolResume":
          await invoke("spool_resume", { path: call.path });
          return;
        case "spoolFinish":
          await invoke("spool_finish", { path: call.path });
          return;
        case "spoolAppend":
          // the bytes go as the raw body; the path rides in a header, escaped
          await invoke("spool_append", new Uint8Array(call.bytes), { headers: { path: encodeURIComponent(call.path) } });
          return;
      }
    },
    spoolCleanup: async () => undefined,
    async spoolSave(path) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: savedName(baseName(path)),
        filters: [
          { extensions: ["txt", "log"], name: translate("dialog_filter_event_logs") },
          { extensions: ["*"], name: translate("dialog_filter_all") },
        ],
        title: translate("dialog_save_session"),
      });
      if (!dest) {
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("spool_copy", { dest, path });
      return { name: baseName(dest), root: dest };
    },
    async startupPath() {
      const { invoke } = await import("@tauri-apps/api/core");
      return (await invoke<string | null>("startup_path")) ?? undefined;
    },
    async stat(path) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<FileStat>("file_stat", { path });
    },
    async unwatch() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("unwatch_path");
    },
    async watch(root) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("watch_path", { path: root });
    },
  };
}

// --- dev server (path based)

// Only the vite dev server mounts /api; a built site has nothing there.
const DEV_SERVICE = import.meta.env.DEV;

async function api<T>(route: string, query: Record<string, string | number>): Promise<T> {
  if (!DEV_SERVICE) {
    throw new Error(translate("backend_dev_only"));
  }
  const url = `/api/${route}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`;
  const response = await fetch(url);
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // not json
    }
    throw new Error(message);
  }
  return (route === "read" ? new Uint8Array(await response.arrayBuffer()) : await response.json()) as T;
}

// --- File System Access API

interface Permissions {
  queryPermission(descriptor: { mode: "read" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "read" }): Promise<PermissionState>;
}

type PermissionedHandle = FileSystemDirectoryHandle & Permissions;
type PermissionedFileHandle = FileSystemFileHandle & Permissions;

interface DirectoryHandleEntries {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: "read" }) => Promise<PermissionedHandle>;
  showOpenFilePicker?: (options: { multiple: false }) => Promise<PermissionedFileHandle[]>;
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
};

// Hands a file to the browser's downloads.
function download(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// The spool files of OPFS grouped by spool, for tidying. The server a spool is from is the first
// line of its sidecar.
async function spoolGroups(dir: FileSystemDirectoryHandle): Promise<SpoolGroup[]> {
  const files = new Map<string, number>();
  const servers = new Map<string, string | undefined>();
  for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (entry.kind !== "file") {
      continue;
    }
    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      const base = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
      files.set(base, Math.max(files.get(base) ?? 0, file.lastModified));
      if (name.endsWith(".json")) {
        const head = await file.slice(0, 4096).text();
        servers.set(base, (JSON.parse(head.split("\n")[0]) as { prefix?: string }).prefix);
      }
    } catch {
      // locked by another tab, or not a spool's sidecar
    }
  }
  return [...files].map(([name, modifiedMs]) => ({ modifiedMs, name, server: servers.get(name) }));
}

// Database name from the app's old name, Datamine Viewer; kept so saved handles survive the rename.
const HANDLE_DB = "datamine-viewer";
const HANDLE_STORE = "handles";

function handleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function handlePut(key: string, handle: FileSystemHandle) {
  try {
    const db = await handleDb();
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(HANDLE_STORE, "readwrite");
      transaction.objectStore(HANDLE_STORE).put(handle, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  } catch {
    // not kept
  }
}

async function handleGet(key: string): Promise<PermissionedFileHandle | PermissionedHandle | undefined> {
  try {
    const db = await handleDb();
    return await new Promise((resolve) => {
      const request = db.transaction(HANDLE_STORE).objectStore(HANDLE_STORE).get(key);
      request.onsuccess = () => resolve(request.result as PermissionedFileHandle | PermissionedHandle | undefined);
      request.onerror = () => resolve(undefined);
    });
  } catch {
    return;
  }
}

async function handleDelete(key: string) {
  try {
    const db = await handleDb();
    db.transaction(HANDLE_STORE, "readwrite").objectStore(HANDLE_STORE).delete(key);
  } catch {
    // nothing to forget
  }
}

function nodeSorted(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// Walks a directory handle into the tree shape the other backends return. Paths are
// `<root name>/sub/file`.
async function handleWalk(dir: FileSystemDirectoryHandle, prefix: string, depth: number, budget: { left: number }): Promise<FileNode[]> {
  const found: Promise<FileNode | undefined>[] = [];
  for await (const [name, handle] of (dir as unknown as DirectoryHandleEntries).entries()) {
    if (budget.left <= 0) {
      break;
    }
    if (handle.kind === "directory" && SKIPPED.has(name)) {
      continue;
    }
    budget.left--;
    const path = `${prefix}/${name}`;
    if (handle.kind === "directory") {
      found.push(
        (depth < DEPTH_MAXIMUM ? handleWalk(handle as FileSystemDirectoryHandle, path, depth + 1, budget) : Promise.resolve([])).then(
          (children) => ({ children, isDir: true, modifiedMs: 0, name, path, size: 0 })
        )
      );
    } else {
      found.push(
        (handle as FileSystemFileHandle)
          .getFile()
          .then((file) => ({ children: [], isDir: false, modifiedMs: file.lastModified, name, path, size: file.size }))
          .catch(() => undefined)
      );
    }
  }
  return nodeSorted((await Promise.all(found)).filter((node): node is FileNode => node !== undefined));
}

function nodesFlatten(nodes: FileNode[], into = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    into.set(node.path, `${node.size}|${node.modifiedMs}`);
    nodesFlatten(node.children, into);
  }
  return into;
}

// Tree from the File objects of an <input webkitdirectory>.
function snapshotTree(files: File[]): { name: string; tree: FileNode[]; byPath: Map<string, File> } {
  const byPath = new Map<string, File>();
  const roots: FileNode[] = [];
  const dirs = new Map<string, FileNode>();
  let rootName = "";
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/");
    rootName ||= parts[0];
    if (parts.slice(1, -1).some((part) => SKIPPED.has(part))) {
      continue;
    }
    byPath.set(file.webkitRelativePath, file);
    let siblings = roots;
    let path = parts[0];
    for (const part of parts.slice(1, -1)) {
      path += `/${part}`;
      let dir = dirs.get(path);
      if (!dir) {
        dir = { children: [], isDir: true, modifiedMs: 0, name: part, path, size: 0 };
        dirs.set(path, dir);
        siblings.push(dir);
      }
      siblings = dir.children;
    }
    siblings.push({
      children: [],
      isDir: false,
      modifiedMs: file.lastModified,
      name: parts.at(-1) as string,
      path: file.webkitRelativePath,
      size: file.size,
    });
  }
  const sortAll = (nodes: FileNode[]) => {
    for (const node of nodeSorted(nodes)) {
      sortAll(node.children);
    }
  };
  sortAll(roots);
  // the picked folder itself is the root; its children are the top of the tree
  return { byPath, name: rootName, tree: roots };
}

function folderInputPick(): Promise<File[] | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.onchange = () => resolve(input.files && input.files.length > 0 ? [...input.files] : undefined);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

function fileInputPick(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

function fileNode(name: string, file: File): FileNode {
  return { children: [], isDir: false, modifiedMs: file.lastModified, name, path: name, size: file.size };
}

type Source =
  | { mode: "handle"; name: string; handle: FileSystemDirectoryHandle }
  | { mode: "snapshot"; name: string; byPath: Map<string, File> }
  // several files read together: picked ones by name, the rest by path through the dev server
  | { mode: "many" }
  | { mode: "file-handle"; name: string; handle: FileSystemFileHandle }
  | { mode: "file-snapshot"; name: string; file: File }
  // a real path on the machine running the dev server; `single` for one file
  | { mode: "path"; single: boolean };

function browserBackend(): Backend {
  const listeners = new Set<(event: ChangeEvent) => void>();
  const picked = new Map<string, FileSystemDirectoryHandle>();
  const snapshots = new Map<string, Map<string, File>>();
  const fileHandles = new Map<string, FileSystemFileHandle>();
  const fileSnapshots = new Map<string, File>();
  let source: Source = { mode: "path", single: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watching = false;
  // changes with every watch and unwatch, so a poll still running for an earlier one lets go
  let watchId = 0;
  let previous = new Map<string, string>();

  // What is picked last owns its name.
  const nameTake = (name: string) => {
    picked.delete(name);
    snapshots.delete(name);
    fileHandles.delete(name);
    fileSnapshots.delete(name);
  };

  // A name for something picked: its own, or with `keep` one no earlier pick has ("2/debug.txt").
  const nameFor = (name: string, keep: boolean | undefined): string => {
    const taken = (key: string) => picked.has(key) || snapshots.has(key) || fileHandles.has(key) || fileSnapshots.has(key);
    if (!keep || !taken(name)) {
      nameTake(name);
      return name;
    }
    let n = 2;
    while (taken(`${n}/${name}`)) {
      n++;
    }
    return `${n}/${name}`;
  };

  // files that sit next to one picked or saved, such as a sidecar
  const siblings = new Map<string, File>();
  // of several files open together, the ones the dev server reads by path
  let manyPaths = new Set<string>();
  // whether a read goes to the dev server; a sidecar goes with its file
  const byService = (path: string) =>
    source.mode === "path" || (source.mode === "many" && (manyPaths.has(path) || (path.endsWith(".json") && manyPaths.has(path.slice(0, -5)))));

  const fileOf = async (path: string): Promise<File> => {
    if (source.mode === "many") {
      const handle = fileHandles.get(path);
      const file = handle ? await handle.getFile() : (fileSnapshots.get(path) ?? siblings.get(path));
      if (!file) {
        throw new Error(translate("backend_not_opened_files", { path }));
      }
      return file;
    }
    const sibling = siblings.get(path);
    if (sibling && (source.mode === "file-handle" || source.mode === "file-snapshot")) {
      return sibling;
    }
    if (source.mode === "file-handle" || source.mode === "file-snapshot") {
      if (path !== source.name) {
        throw new Error(translate("backend_not_opened_file", { path }));
      }
      return source.mode === "file-handle" ? source.handle.getFile() : source.file;
    }
    if (source.mode === "snapshot") {
      const file = source.byPath.get(path);
      if (!file) {
        throw new Error(translate("backend_not_in_folder", { path }));
      }
      return file;
    }
    if (source.mode !== "handle") {
      throw new Error(translate("backend_no_folder"));
    }
    const parts = path.split("/");
    if (parts[0] !== source.name) {
      throw new Error(translate("backend_outside_folder", { path }));
    }
    let dir = source.handle;
    for (const part of parts.slice(1, -1)) {
      dir = await dir.getDirectoryHandle(part);
    }
    // getFile each time, so a file that grew is seen at its new size
    return (await dir.getFileHandle(parts.at(-1) as string)).getFile();
  };

  const treeOf = async (): Promise<FileNode[]> => {
    if (source.mode === "handle") {
      return handleWalk(source.handle, source.name, 0, { left: ENTRIES_MAXIMUM });
    }
    if (source.mode === "file-handle") {
      return [fileNode(source.name, await source.handle.getFile())];
    }
    throw new Error(translate("backend_no_folder"));
  };

  const pollOnce = async (): Promise<number> => {
    const started = performance.now();
    try {
      let tree: FileNode[];
      if (source.mode === "path") {
        // quiet: a poll must not move the service's root, a newer open may have
        tree = source.single
          ? [await api<FileNode>("file", { path: currentPathRoot, quiet: 1 })]
          : await api<FileNode[]>("list", { quiet: 1, root: currentPathRoot });
      } else {
        tree = await treeOf();
      }
      const next = nodesFlatten(tree);
      const changed: string[] = [];
      let kind = "modify";
      for (const [path, signature] of next) {
        if (!previous.has(path)) {
          changed.push(path);
          kind = "create";
        } else if (previous.get(path) !== signature) {
          changed.push(path);
        }
      }
      for (const path of previous.keys()) {
        if (!next.has(path)) {
          changed.push(path);
          kind = "remove";
        }
      }
      previous = next;
      if (changed.length > 0) {
        for (const listener of listeners) {
          listener({ kind, paths: changed });
        }
      }
    } catch {
      // the folder may be gone for a moment; try again next tick
    }
    return performance.now() - started;
  };

  let currentPathRoot = "";

  return {
    async fileInfo(root) {
      const handle = fileHandles.get(root);
      const snapshot = fileSnapshots.get(root);
      let node: FileNode;
      if (handle) {
        source = { handle, mode: "file-handle", name: root };
        node = fileNode(root, await handle.getFile());
      } else if (snapshot) {
        source = { file: snapshot, mode: "file-snapshot", name: root };
        node = fileNode(root, snapshot);
      } else {
        source = { mode: "path", single: true };
        currentPathRoot = root;
        node = await api<FileNode>("file", { path: root });
      }
      previous = nodesFlatten([node]);
      return node;
    },
    async filesOpen(roots) {
      const paths = roots.filter((root) => !fileHandles.has(root) && !fileSnapshots.has(root));
      const byPath = new Map<string, FileNode>();
      if (paths.length > 0) {
        const nodes = await api<FileNode[]>("files", { paths: JSON.stringify(paths) });
        paths.forEach((path, k) => byPath.set(path, nodes[k]));
      }
      const nodes: FileNode[] = [];
      for (const root of roots) {
        const handle = fileHandles.get(root);
        const snapshot = fileSnapshots.get(root);
        nodes.push(handle ? fileNode(root, await handle.getFile()) : snapshot ? fileNode(root, snapshot) : (byPath.get(root) as FileNode));
      }
      source = { mode: "many" };
      manyPaths = new Set(paths.map((path) => byPath.get(path)?.path ?? path));
      return nodes;
    },
    async handleForget(key) {
      await handleDelete(key);
    },
    async handleRestore(key, options) {
      const handle = await handleGet(key);
      if (!handle) {
        return;
      }
      // must come from a click: the browser asks the user again after a reload
      if ((await handle.requestPermission({ mode: "read" })) !== "granted") {
        return;
      }
      const name = nameFor(handle.name, options?.keep);
      if (handle.kind === "file") {
        fileHandles.set(name, handle as FileSystemFileHandle);
      } else {
        picked.set(name, handle as FileSystemDirectoryHandle);
      }
      return { isFile: handle.kind === "file", root: name };
    },
    async handleSave(key, root) {
      const handle = picked.get(root) ?? fileHandles.get(root);
      if (!handle) {
        return false;
      }
      await handlePut(key, handle);
      return true;
    },
    isPathRoot: (root) => !picked.has(root) && !snapshots.has(root) && !fileHandles.has(root) && !fileSnapshots.has(root),
    canReload: () => source.mode !== "snapshot" && source.mode !== "file-snapshot",
    isSpoolPath: spoolPathHas,
    kind: "browser",
    async listTree(root) {
      const handle = picked.get(root);
      const snapshot = snapshots.get(root);
      if (handle) {
        source = { handle, mode: "handle", name: root };
      } else if (snapshot) {
        source = { byPath: snapshot, mode: "snapshot", name: root };
      } else {
        source = { mode: "path", single: false };
        currentPathRoot = root;
      }
      let tree: FileNode[];
      if (source.mode === "handle") {
        tree = await treeOf();
      } else if (source.mode === "snapshot") {
        tree = snapshotTree([...source.byPath.values()]).tree;
      } else {
        tree = await api<FileNode[]>("list", { root });
      }
      previous = nodesFlatten(tree);
      return tree;
    },
    pathsSupported: DEV_SERVICE,
    note: () => {
      if (source.mode === "snapshot") {
        return translate("backend_snapshot_folder");
      }
      return source.mode === "file-snapshot" ? translate("backend_snapshot_file") : undefined;
    },
    async onChanged(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    onXbdm: async () => () => undefined,
    xbdmCloseAll: async () => undefined,
    async xbdmCall() {
      throw new Error(translate("xbox_desktop_only"));
    },
    async pathKind(path) {
      return (await api<{ kind: "file" | "folder" | "missing" }>("kind", { path })).kind;
    },
    async pickFile(options) {
      const picker = (window as PickerWindow).showOpenFilePicker;
      if (picker) {
        try {
          const [handle] = await picker.call(window, { multiple: false });
          const name = nameFor(handle.name, options?.keep);
          fileHandles.set(name, handle);
          return name;
        } catch {
          // dismissed
          return;
        }
      }
      const file = await fileInputPick();
      if (!file) {
        return;
      }
      const name = nameFor(file.name, options?.keep);
      fileSnapshots.set(name, file);
      return name;
    },
    async pickFolder() {
      const picker = (window as PickerWindow).showDirectoryPicker;
      if (picker) {
        try {
          const handle = await picker.call(window, { mode: "read" });
          nameTake(handle.name);
          picked.set(handle.name, handle);
          return handle.name;
        } catch {
          // dismissed
          return;
        }
      }
      const files = await folderInputPick();
      if (!files) {
        return;
      }
      const { byPath, name } = snapshotTree(files);
      nameTake(name);
      snapshots.set(name, byPath);
      return name;
    },
    readRange: async (path, offset, length) => {
      if (byService(path)) {
        return api<Uint8Array>("read", { length, offset, path });
      }
      const file = await fileOf(path);
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
    async spoolCall() {
      throw new Error("the browser spools in the worker");
    },
    async spoolCleanup() {
      try {
        const dir = await liveDirectory();
        for (const name of spoolCleanupPlan(await spoolGroups(dir), Date.now())) {
          await dir.removeEntry(name).catch(() => undefined);
          await dir.removeEntry(`${name}.json`).catch(() => undefined);
        }
      } catch {
        // no private file system here; nothing was spooled
      }
    },
    async spoolSave(path) {
      const dir = await liveDirectory();
      const name = opfsName(path);
      const text = await (await dir.getFileHandle(name)).getFile();
      const suggested = savedName(name);
      const picker = (window as PickerWindow).showSaveFilePicker;
      if (!picker) {
        download(text, suggested);
        return { name: suggested };
      }
      let handle: FileSystemFileHandle;
      try {
        handle = await picker.call(window, { suggestedName: suggested, types: [{ accept: { "text/plain": [".txt", ".log"] }, description: translate("dialog_filter_event_logs") }] });
      } catch {
        // dismissed
        return;
      }
      await text.stream().pipeTo(await handle.createWritable());
      nameTake(handle.name);
      fileHandles.set(handle.name, handle);
      return { name: handle.name, root: handle.name };
    },
    startupPath: async () => undefined,
    stat: async (path) => {
      if (byService(path)) {
        return api<FileStat>("stat", { path });
      }
      const file = await fileOf(path);
      return { modifiedMs: file.lastModified, size: file.size };
    },
    async unwatch() {
      watching = false;
      watchId++;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    async watch() {
      // a snapshot cannot change
      await this.unwatch();
      if (source.mode === "snapshot" || source.mode === "file-snapshot") {
        return;
      }
      watching = true;
      const id = ++watchId;
      const tick = async () => {
        const took = await pollOnce();
        if (watching && id === watchId) {
          // a big folder is walked less often
          timer = setTimeout(tick, took > 500 ? POLL_MS * 3 : POLL_MS);
        }
      };
      timer = setTimeout(tick, POLL_MS);
    },
  };
}

export const backend: Backend = "__TAURI_INTERNALS__" in window ? tauriBackend() : browserBackend();
