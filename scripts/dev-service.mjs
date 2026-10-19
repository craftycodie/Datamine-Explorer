// Browser-mode stand-in for the Tauri commands, so the UI can be built with
// `npm run dev` and no desktop shell. The vite dev server mounts it under /api.
//
//   GET /api/list?root=<dir>                        the tree; also sets the root (not with quiet=1)
//   GET /api/file?path=<file>                       the file's node; also sets the root to that one file
//   GET /api/files?paths=<json array>               the nodes of several files; also sets the root to those
//   GET /api/kind?path=<path>                       { kind: "file" | "folder" | "missing" }
//   GET /api/stat?path=<file>                       { size, modifiedMs }
//   GET /api/read?path=<file>&offset=N&length=N     raw bytes
//
// Like the app, it only reads inside the root the last list call named. A browser that can pick a
// folder itself (File System Access API) does not use it; `?folder=` and the toolbar's path box do.
import { promises as fs } from "node:fs";
import path from "node:path";

const SKIPPED = new Set(["node_modules", ".git"]);
const DEPTH_MAXIMUM = 12;
const ENTRIES_MAXIMUM = 50_000;
const READ_MAXIMUM = 256 * 1024 * 1024;

let root;
// set when a single file was opened: nothing else is readable
let onlyFile;
// set when several files were opened together: only those are readable
let onlyFiles;

async function directoryRead(dir, depth, budget) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes = [];
  for (const entry of entries) {
    if (budget.left <= 0) {
      break;
    }
    const isDir = entry.isDirectory();
    if (isDir && SKIPPED.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    budget.left--;
    nodes.push({
      children: isDir && depth < DEPTH_MAXIMUM ? await directoryRead(full, depth + 1, budget) : [],
      isDir,
      modifiedMs: Math.round(stat.mtimeMs),
      name: entry.name,
      path: full,
      size: isDir ? 0 : stat.size,
    });
  }
  nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return nodes;
}

async function insideRoot(file) {
  const real = await fs.realpath(file);
  if (onlyFiles) {
    // each file's sidecar reads with it
    if (!onlyFiles.has(real) && !(real.endsWith(".json") && onlyFiles.has(real.slice(0, -5)))) {
      throw new Error(`${file} is not one of the opened files`);
    }
    return real;
  }
  if (!root) {
    throw new Error("no folder is open");
  }
  // a single file's sidecar reads with it
  if (onlyFile && real !== onlyFile && real !== `${onlyFile}.json`) {
    throw new Error(`${file} is outside the opened file`);
  }
  const relative = path.relative(root, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${file} is outside the opened folder`);
  }
  return real;
}

export async function handleApi(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  // polls ask quietly: they must not move the root a newer open has set
  const quiet = url.searchParams.get("quiet") === "1";
  try {
    switch (url.pathname) {
      case "/list": {
        const wanted = url.searchParams.get("root") ?? "";
        const real = await fs.realpath(wanted);
        if (!(await fs.stat(real)).isDirectory()) {
          throw new Error(`${wanted} is not a folder`);
        }
        if (!quiet) {
          root = real;
          onlyFile = undefined;
          onlyFiles = undefined;
        }
        json(200, await directoryRead(real, 0, { left: ENTRIES_MAXIMUM }));
        return;
      }
      case "/file": {
        const wanted = url.searchParams.get("path") ?? "";
        const real = await fs.realpath(wanted);
        const stat = await fs.stat(real);
        if (!stat.isFile()) {
          throw new Error(`${wanted} is not a file`);
        }
        if (!quiet) {
          root = path.dirname(real);
          onlyFile = real;
          onlyFiles = undefined;
        }
        json(200, { children: [], isDir: false, modifiedMs: Math.round(stat.mtimeMs), name: path.basename(real), path: real, size: stat.size });
        return;
      }
      case "/files": {
        const wanted = JSON.parse(url.searchParams.get("paths") ?? "[]");
        const nodes = [];
        for (const one of wanted) {
          const real = await fs.realpath(String(one));
          const stat = await fs.stat(real);
          if (!stat.isFile()) {
            throw new Error(`${one} is not a file`);
          }
          nodes.push({ children: [], isDir: false, modifiedMs: Math.round(stat.mtimeMs), name: path.basename(real), path: real, size: stat.size });
        }
        onlyFiles = new Set(nodes.map((node) => node.path));
        onlyFile = undefined;
        root = undefined;
        json(200, nodes);
        return;
      }
      case "/kind": {
        try {
          const stat = await fs.stat(url.searchParams.get("path") ?? "");
          json(200, { kind: stat.isDirectory() ? "folder" : "file" });
        } catch {
          json(200, { kind: "missing" });
        }
        return;
      }
      case "/stat": {
        const stat = await fs.stat(await insideRoot(url.searchParams.get("path") ?? ""));
        json(200, { modifiedMs: Math.round(stat.mtimeMs), size: stat.size });
        return;
      }
      case "/read": {
        const file = await insideRoot(url.searchParams.get("path") ?? "");
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const handle = await fs.open(file, "r");
        try {
          const { size } = await handle.stat();
          const length = Math.max(0, Math.min(Number(url.searchParams.get("length") ?? size), size - offset, READ_MAXIMUM));
          const buffer = Buffer.alloc(length);
          if (length > 0) {
            await handle.read(buffer, 0, length, offset);
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/octet-stream");
          res.end(buffer);
        } finally {
          await handle.close();
        }
        return;
      }
      default:
        json(404, { error: `no ${url.pathname}` });
    }
  } catch (error) {
    json(500, { error: error instanceof Error ? error.message : String(error) });
  }
}
