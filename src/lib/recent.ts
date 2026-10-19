// The File menu's recent list. Paths and URLs live in localStorage; what a browser picked cannot be
// written down, so its handle is kept by the backend under `recentKey` and only the name is here.
import { translate } from "../localization";
import { baseName, pathKey } from "./format";
import { storedGet, storedSet } from "./stored";

export type RecentKind = "file" | "folder" | "server";

export interface RecentItem {
  kind: RecentKind;
  // a path or a server URL; for something picked in a browser, its name
  target: string;
  // picked in a browser: the handle is kept under recentKey
  handle?: boolean;
  // what it was called when last opened among several sources
  nickname?: string;
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

// The nickname is only shown where several sources are picked.
export function recentTitle(item: RecentItem, nickname = false): string {
  const where = item.handle ? translate("recent_picked", { target: item.target }) : item.target;
  return nickname && item.nickname ? `${item.nickname}: ${where}` : where;
}

function valid(value: unknown): value is RecentItem {
  const item = value as Partial<RecentItem> | null;
  return (
    typeof item === "object" &&
    item !== null &&
    (item.kind === "file" || item.kind === "folder" || item.kind === "server") &&
    typeof item.target === "string" &&
    item.target !== "" &&
    (item.nickname === undefined || typeof item.nickname === "string")
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
// Opened on its own, it keeps the nickname it had among several sources.
export function recentPush(items: RecentItem[], item: RecentItem): { items: RecentItem[]; dropped: RecentItem[] } {
  const rest = items.filter((other) => !same(other, item));
  const nickname = item.nickname ?? items.find((other) => same(other, item))?.nickname;
  const next = [nickname ? { ...item, nickname } : item, ...rest].slice(0, RECENT_MAXIMUM);
  const dropped = [...rest.slice(RECENT_MAXIMUM - 1), ...items.filter((other) => same(other, item) && other.handle && !item.handle)];
  return { dropped, items: next };
}

export function recentRemove(items: RecentItem[], item: RecentItem): RecentItem[] {
  return items.filter((other) => !same(other, item));
}
