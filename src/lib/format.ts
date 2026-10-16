// Small display helpers and the file kinds the tree cares about.

export const VIEWABLE_EXTENSIONS = [".txt", ".log", ".datamine", ".zip", ".bin", ".dat"];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function isViewable(name: string): boolean {
  return VIEWABLE_EXTENSIONS.includes(extensionOf(name));
}

export function pathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function dateTimeText(ms: number): string {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Like dateTimeText, with milliseconds, for entries that arrive with a time rather than a line of text.
export function timeStampText(ms: number): string {
  return Number.isFinite(ms) ? `${dateTimeText(ms)}.${pad(Math.floor(ms) % 1000, 3)}` : "";
}

export function durationText(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : m > 0 ? `${m}m ${pad(s)}s` : `${s}s`;
}

const TIME_OF_DAY = /\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/;

// The column shows just the time of day; the detail pane has the full stamp.
export function timeColumnText(timeText: string): string {
  return TIME_OF_DAY.exec(timeText)?.[0] ?? timeText;
}
