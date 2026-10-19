// The log line and banner of the spool file, written with the package's own line writer. A spool
// is Destiny style whatever the server runs, since the hello does not name a layout, and it is read
// back with the parser like any other report. The index, context and frame of an entry are in the
// sidecar.
import {
  build_banner,
  e_event_level,
  format_event_for_log,
  type s_event_log_line,
  type t_data_mine_header_layout,
} from "@blamnetwork/datamine/reading";
import type { ServerEntry } from "./live-types";

// The format the spool is read back as.
export const SPOOL_FORMAT = "destiny_style_log";

// The datamine layout the spool lines are written for.
export const SPOOL_LAYOUT: t_data_mine_header_layout = "3.1";

// The package cuts its own log lines at the 2048 byte event buffer; the spool keeps what it was sent.
const LINE_MAXIMUM_CHARACTERS = 1 << 24;

// A level the writer cannot write is written as a message.
export function levelClamp(level: number): e_event_level {
  return Number.isInteger(level) && level >= e_event_level.verbose && level <= e_event_level.critical
    ? (level as e_event_level)
    : e_event_level.message;
}

export function spoolBanner(version: string): string {
  return build_banner(version);
}

// The line of a server entry. `time` stands in when the entry has no usable time.
export function entryLine(entry: ServerEntry, time: number): string {
  const line: s_event_log_line = {
    category_path: entry.category_path,
    context: entry.context ?? "",
    date: new Date(Number.isFinite(entry.time_ms) ? entry.time_ms : time),
    event_index: entry.index,
    frame_index: entry.frame_index,
    game_time: entry.game_time,
    level: levelClamp(entry.level),
    text: entry.text,
    thread_id: entry.thread_id ?? 0,
  };
  return format_event_for_log(line, SPOOL_LAYOUT, false, LINE_MAXIMUM_CHARACTERS);
}
