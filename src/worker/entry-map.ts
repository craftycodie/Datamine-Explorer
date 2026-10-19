// Turns the datamine package's entries into the explorer's own shape, and decodes file bytes.
import { k_datamine_parameter_type_names, type s_log_entry } from "@blamnetwork/datamine/reading";
import { LEVEL_UNLEVELED, type LogEntry } from "../lib/types";

export function parameterTypeName(type: number): string {
  return (k_datamine_parameter_type_names as Record<number, string>)[type] ?? String(type);
}

// Table rows only show the start of a message; the detail pane reads the entry whole.
export const ROW_MESSAGE_MAXIMUM = 2000;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

// UTF-8, and latin1 for bytes that are not valid UTF-8.
export function textDecode(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

export function levelNumber(entry: s_log_entry): number {
  return entry.level ?? LEVEL_UNLEVELED;
}

export function categoryText(entry: s_log_entry): string {
  return entry.category_path ? `${entry.category_path}:` : "";
}

// `full` keeps the whole text and the raw lines; a row keeps just enough to draw.
export function entryMap(entry: s_log_entry, full: boolean): LogEntry {
  const mapped: LogEntry = {
    category: categoryText(entry),
    level: levelNumber(entry),
    levelText: entry.level_text,
    message: full || entry.message.length <= ROW_MESSAGE_MAXIMUM ? entry.message : entry.message.slice(0, ROW_MESSAGE_MAXIMUM),
    ordinal: entry.ordinal,
    text: full ? entry.text : "",
    timeText: entry.date_text,
  };
  if (!full && entry.message.length > ROW_MESSAGE_MAXIMUM) {
    mapped.truncated = true;
  }
  if (entry.kind === "session" && entry.session) {
    mapped.kind = "session";
    mapped.session = { number: entry.session.number, sessionId: entry.session.session_id, version: entry.session.version };
  }
  if (entry.date) {
    mapped.time = entry.date.getTime();
  }
  if (entry.event_index !== undefined) {
    mapped.eventIndex = entry.event_index;
  }
  if (entry.game_time !== undefined) {
    mapped.gameTime = entry.game_time;
  }
  if (entry.frame_index !== undefined) {
    mapped.frameIndex = entry.frame_index;
  }
  if (entry.thread_id !== undefined) {
    mapped.threadId = entry.thread_id;
  }
  if (entry.context !== undefined) {
    mapped.context = entry.context;
  }
  if (entry.custom_prefix !== undefined) {
    mapped.customPrefix = entry.custom_prefix;
  }
  if (entry.definition_id !== undefined) {
    mapped.definitionId = entry.definition_id;
  }
  if (entry.parameters) {
    mapped.parameters = entry.parameters.map((p) => ({
      name: p.name,
      type: parameterTypeName(p.type),
      value: String(p.value),
    }));
  }
  if (full && entry.raw !== undefined) {
    mapped.raw = entry.raw;
  }
  return mapped;
}

// A line of a file with no log format is an entry of its own.
export function plainEntry(line: string, ordinal: number, full: boolean): LogEntry {
  const text = line.startsWith("﻿") ? line.slice(1) : line;
  return {
    truncated: !full && text.length > ROW_MESSAGE_MAXIMUM ? true : undefined,
    category: "",
    level: LEVEL_UNLEVELED,
    levelText: "",
    message: full || text.length <= ROW_MESSAGE_MAXIMUM ? text : text.slice(0, ROW_MESSAGE_MAXIMUM),
    ordinal,
    text: "",
    timeText: "",
  };
}

// How many lines an entry's raw text has.
export function lineCount(raw: string): number {
  let lines = 1;
  for (let at = raw.indexOf("\n"); at >= 0; at = raw.indexOf("\n", at + 1)) {
    lines++;
  }
  return lines;
}
