// The spool in a browser: files in the origin's private file system (OPFS), `datamine-viewer/live/`.
// Appending and reading back at once needs a synchronous access handle, which only a worker can
// open, so the log worker owns the files while they are written and answers reads for their paths
// itself. A handle is exclusive; `finish` closes them, and the files are read with the file API after.
import { liveDirectory, OPFS_PREFIX, opfsName } from "../lib/opfs";
import { SIDECAR_SUFFIX } from "./sidecar";
import type { SpoolHost } from "./spool-writer";

const HEAD_BYTES = 4096;

interface SyncHandle {
  read(buffer: Uint8Array, options?: { at: number }): number;
  write(buffer: Uint8Array, options?: { at: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}

type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

interface Opened {
  handle: SyncHandle;
  size: number;
  modifiedMs: number;
}

export class OpfsSpool implements SpoolHost {
  private opened = new Map<string, Opened>();

  private async exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  private async handleOpen(dir: FileSystemDirectoryHandle, name: string, create: boolean) {
    if (this.opened.has(`${OPFS_PREFIX}${name}`)) {
      return;
    }
    const file = (await dir.getFileHandle(name, { create })) as SyncFileHandle;
    const handle = await file.createSyncAccessHandle();
    this.opened.set(`${OPFS_PREFIX}${name}`, { handle, modifiedMs: Date.now(), size: handle.getSize() });
  }

  async create(name: string): Promise<string> {
    const dir = await liveDirectory();
    // two tabs in the same second would pick the same name
    let unique = name;
    for (let n = 1; await this.exists(dir, unique); n++) {
      unique = name.replace(/(\.[^.]*)?$/, `_${n}$1`);
    }
    await this.handleOpen(dir, unique, true);
    await this.handleOpen(dir, `${unique}${SIDECAR_SUFFIX}`, true);
    return `${OPFS_PREFIX}${unique}`;
  }

  async find(prefix: string): Promise<string | undefined> {
    const dir = await liveDirectory();
    let best: { name: string; modified: number } | undefined;
    for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (entry.kind !== "file" || !name.endsWith(SIDECAR_SUFFIX)) {
        continue;
      }
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        const head = await file.slice(0, HEAD_BYTES).text();
        const line = JSON.parse(head.slice(0, head.indexOf("\n") < 0 ? undefined : head.indexOf("\n"))) as { kind?: string; prefix?: string };
        const text = name.slice(0, -SIDECAR_SUFFIX.length);
        if (line.kind === "spool" && line.prefix === prefix && (!best || file.lastModified > best.modified) && (await this.exists(dir, text))) {
          best = { modified: file.lastModified, name: text };
        }
      } catch {
        // locked by another tab, or not a spool's sidecar
      }
    }
    return best ? `${OPFS_PREFIX}${best.name}` : undefined;
  }

  async resume(path: string): Promise<void> {
    const dir = await liveDirectory();
    const name = opfsName(path);
    await this.handleOpen(dir, name, false);
    await this.handleOpen(dir, `${name}${SIDECAR_SUFFIX}`, false);
  }

  async append(path: string, bytes: Uint8Array): Promise<void> {
    const file = this.opened.get(path);
    if (!file) {
      throw new Error(`${path} is not open for writing`);
    }
    let done = 0;
    while (done < bytes.length) {
      done += file.handle.write(bytes.subarray(done), { at: file.size + done });
    }
    file.size += bytes.length;
    file.modifiedMs = Date.now();
  }

  // The files are closed (so they can be copied or tidied); reads go through the file API from here.
  async finish(path: string): Promise<void> {
    for (const name of [path, `${path}${SIDECAR_SUFFIX}`]) {
      const file = this.opened.get(name);
      if (file) {
        file.handle.flush();
        file.handle.close();
        this.opened.delete(name);
      }
    }
  }

  // --- reading, for the paths this worker has open; others go through the file API

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const file = this.opened.get(path);
    if (file) {
      const bytes = new Uint8Array(Math.max(0, Math.min(length, file.size - offset)));
      const done = bytes.length > 0 ? file.handle.read(bytes, { at: offset }) : 0;
      return done === bytes.length ? bytes : bytes.subarray(0, done);
    }
    const stored = await (await this.fileOf(path)).getFile();
    return new Uint8Array(await stored.slice(offset, offset + length).arrayBuffer());
  }

  async stat(path: string): Promise<{ size: number; modifiedMs: number }> {
    const file = this.opened.get(path);
    if (file) {
      return { modifiedMs: file.modifiedMs, size: file.size };
    }
    const stored = await (await this.fileOf(path)).getFile();
    return { modifiedMs: stored.lastModified, size: stored.size };
  }

  private async fileOf(path: string): Promise<FileSystemFileHandle> {
    return (await liveDirectory()).getFileHandle(opfsName(path));
  }
}
