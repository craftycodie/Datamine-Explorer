// The browser's private file system, where a live session is spooled when there is no desktop shell.
// The names are shared by the log worker (which writes) and the page (which copies and tidies).
export const OPFS_PREFIX = "opfs:live/";
// Folder name from the app's old name, Datamine Viewer; kept so spools already in OPFS are still found.
const ROOT = "datamine-viewer";
const LIVE = "live";

export function isOpfsPath(path: string): boolean {
  return path.startsWith(OPFS_PREFIX);
}

export function opfsName(path: string): string {
  return path.slice(OPFS_PREFIX.length);
}

export async function liveDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle(ROOT, { create: true });
  return app.getDirectoryHandle(LIVE, { create: true });
}
