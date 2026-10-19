// What a line of an Xbox 360's debug output says, as an event. The output is everything the console
// prints, game or not, and a game's lines rarely carry their time or level, so this goes easy: a whole log
// line is read as one; otherwise a line that starts with a category ("networking:session: ...") is an
// event of no level at the time it arrived; anything else is the console's own, a verbose event under
// the xbdm category.
import { c_log_text_parser, e_event_level, k_event_level_none, log_category_split, log_detect_text_format } from "@blamnetwork/datamine/reading";

// the category of what the console prints that is not a game log
export const XBDM_CATEGORY = "xbdm";

export interface DebugEvent {
  category_path: string;
  level: number;
  // the line as the game printed it, category included
  text: string;
  time_ms: number;
  game_time?: number;
  thread_id?: number;
}

// The event of a line of debug output, undefined for an empty one. `received` is when it arrived.
export function debugEvent(line: string, received: number, thread?: number): DebugEvent | undefined {
  // a line is one line in the spool it goes to
  const text = line.replace(/[\r\n]+$/, "").replace(/[\r\n]+/g, " ");
  if (text.trim() === "") {
    return undefined;
  }
  const format = log_detect_text_format(text);
  if (format) {
    const parser = new c_log_text_parser(format);
    const [entry] = [...parser.push(`${text}\n`), ...parser.finish()];
    if (entry && entry.kind !== "session") {
      const time = entry.date?.getTime();
      return {
        category_path: entry.category_path,
        game_time: entry.game_time,
        level: entry.level ?? k_event_level_none,
        text: entry.text,
        thread_id: entry.thread_id ?? thread,
        time_ms: time !== undefined && Number.isFinite(time) ? time : received,
      };
    }
  }
  const split = log_category_split(text);
  if (split.categories.length === 0 || split.message.trim() === "") {
    // the category goes in the text too: the spool's lines are read back by it
    return { category_path: XBDM_CATEGORY, level: e_event_level.verbose, text: `${XBDM_CATEGORY}: ${text.trim()}`, thread_id: thread, time_ms: received };
  }
  return { category_path: split.category_path, level: k_event_level_none, text, thread_id: thread, time_ms: received };
}
