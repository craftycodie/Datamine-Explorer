// The File menu's recent list. Paths and URLs live in localStorage; what a browser picked cannot be
// written down, so its handle is kept by the backend under `recentKey` and only the name is here.
import { baseName, pathKey } from "./format";
import { storedGet, storedSet } from "./stored";

export type RecentKind = "file" | "folder" | "server";

export interface RecentItem {
  kind: RecentKind;
  // a path or a server URL; for something picked in a browser, its name
  target: string;
  // picked in a browser: the handle is kept under recentKey
  handle?: boolean;
}

// "dmv." is from the app's old name, Datamine Viewer; kept so the recent list survives the rename.
const RECENT_KEY = "dmv.recent";
export const RECENT_MAXIMUM = 10;

export function recentKey(item: RecentItem): string {
  return `recent:${item.kind}:${item.target}`;
}

function same(a: RecentItem, b: RecentItem): boolean {
  return a.kind === b.kind && (a.kind === "server" ? a.target === b.target : pathKey(a.target) === pathKey(b.target));
}

export function recentLabel(item: RecentItem): string {
  return item.kind === "server" ? item.target.replace(/^https?:\/\//, "") : baseName(item.target);
}

export function recentTitle(item: RecentItem): string {
  return item.handle ? `${item.target} (picked in this browser)` : item.target;
}

function valid(value: unknown): value is RecentItem {
  const item = value as Partial<RecentItem> | null;
  return (
    typeof item === "object" &&
    item !== null &&
    (item.kind === "file" || item.kind === "folder" || item.kind === "server") &&
    typeof item.target === "string" &&
    item.target !== ""
  );
}

export function recentLoad(): RecentItem[] {
  try {
    const parsed: unknown = JSON.parse(storedGet(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, RECENT_MAXIMUM) : [];
  } catch {
    return [];
  }
}

export function recentStore(items: RecentItem[]) {
  storedSet(RECENT_KEY, JSON.stringify(items));
}

// `item` goes first. Returns the new list and the items that fell off it (or were replaced), whose
// handles are no longer needed.
export function recentPush(items: RecentItem[], item: RecentItem): { items: RecentItem[]; dropped: RecentItem[] } {
  const rest = items.filter((other) => !same(other, item));
  const next = [item, ...rest].slice(0, RECENT_MAXIMUM);
  const dropped = [...rest.slice(RECENT_MAXIMUM - 1), ...items.filter((other) => same(other, item) && other.handle && !item.handle)];
  return { dropped, items: next };
}

export function recentRemove(items: RecentItem[], item: RecentItem): RecentItem[] {
  return items.filter((other) => !same(other, item));
}
