import { describe, expect, it } from "vitest";
import { recentPush, recentTitle } from "../src/lib/recent";

describe("recent nicknames", () => {
  it("remembers the nickname a source was opened with, and keeps it when it is opened on its own", () => {
    const named = recentPush([], { kind: "file", nickname: "game", target: "C:/logs/debug.txt" }).items;
    expect(named[0].nickname).toBe("game");
    const again = recentPush(named, { kind: "file", target: "C:/logs/debug.txt" }).items;
    expect(again).toEqual([{ kind: "file", nickname: "game", target: "C:/logs/debug.txt" }]);
    const renamed = recentPush(again, { kind: "file", nickname: "client", target: "C:/logs/debug.txt" }).items;
    expect(renamed[0].nickname).toBe("client");
    expect(recentTitle(renamed[0])).toBe("client: C:/logs/debug.txt");
  });
});
