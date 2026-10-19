import { build_banner, format_event_for_log } from "@blamnetwork/datamine/reading";
import { describe, expect, it } from "vitest";
import { xbdmUrl } from "../src/lib/xbdm";
import { entryLine } from "../src/worker/spool-line";
import { debugEvent } from "../src/worker/xbdm-lines";

const RECEIVED = new Date(2026, 9, 19, 13, 50, 0, 0).getTime();

describe("Xbox 360 debug output", () => {
  it("reads a game's line by its category, as verbose, at the time it arrived", () => {
    const event = debugEvent("networking:online:lsp: token=11, server acquired\r\n", RECEIVED, 0xf9000004);
    expect(event).toEqual({
      category_path: "networking:online:lsp",
      level: 0,
      text: "networking:online:lsp: token=11, server acquired",
      thread_id: 0xf9000004,
      time_ms: RECEIVED,
    });
  });

  it("reads a whole log line with its own time and level", () => {
    const date = new Date(2026, 9, 19, 13, 39, 55, 123);
    const line = format_event_for_log({ category_path: "net", context: "", date, event_index: 0, game_time: 25, level: 3, text: "net: boom", thread_id: 9 }, "3.1");
    const event = debugEvent(line, RECEIVED);
    expect(event).toMatchObject({ category_path: "net", level: 3, time_ms: date.getTime() });
  });

  it("files what is not a game log under xbdm, verbose, and leaves out empty lines", () => {
    for (const line of ["", "   ", "\r\n"]) {
      expect(debugEvent(line, RECEIVED), JSON.stringify(line)).toBeUndefined();
    }
    expect(debugEvent("[xbdm] something happened", RECEIVED, 7)).toEqual({
      category_path: "xbdm",
      level: 0,
      text: "xbdm: [xbdm] something happened",
      thread_id: 7,
      time_ms: RECEIVED,
    });
    expect(debugEvent("networking:", RECEIVED)?.category_path).toBe("xbdm");
    // a banner is printed as one string with line breaks in it; the spool takes it as one line
    expect(debugEvent(build_banner("game"), RECEIVED)?.text).not.toMatch(/[\r\n]/);
  });

  it("spools a console line so it reads back under xbdm", () => {
    const event = debugEvent("Halo 3 loaded", RECEIVED);
    const line = entryLine({ ...(event as NonNullable<typeof event>), index: 0, session: 1 }, RECEIVED);
    expect(line).toContain(" verbose  xbdm: Halo 3 loaded");
  });

  it("makes an address of whatever was typed", () => {
    expect(xbdmUrl("192.168.0.48")).toBe("xbdm://192.168.0.48:730");
    expect(xbdmUrl(" xbdm://jtag:731/ ")).toBe("xbdm://jtag:731");
  });
});
