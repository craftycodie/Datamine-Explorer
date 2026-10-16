import { describe, expect, it } from "vitest";
import { runStartOf, Sidecar, type SidecarEntry, type SidecarHello, sidecarLine } from "../src/worker/sidecar";

function sidecarOf(text: string, chunk?: number) {
  const bytes = new TextEncoder().encode(text);
  const sidecar = new Sidecar("x.json", {
    read: async (offset, length) => bytes.subarray(offset, offset + Math.min(length, chunk ?? length)),
  });
  return { bytes, sidecar };
}

describe("the sidecar", () => {
  it("finds the line of an entry by its ordinal and parses it on demand", async () => {
    const text =
      sidecarLine({ created_ms: 1, format: "destiny_style_log", host: "h", kind: "spool", port: 1, prefix: "http://h:1/datamine", version: 1 }) +
      sidecarLine({ hello: { run_id: "r" } as never, kind: "hello", next: 0 }) +
      sidecarLine({ kind: "session", number: 1, ordinal: 0, session_id: "s", started_ms: 5, version: "v" }) +
      sidecarLine({ index: 0, ordinal: 1, parameters: [{ name: "a", type: 3, value: "b" }], session: 1 }) +
      sidecarLine({ context: "[(c)d]", index: 1, ordinal: 2, session: 1 });
    const { bytes, sidecar } = sidecarOf(text);
    await sidecar.advance(bytes.length, () => false);
    expect(sidecar.spool?.prefix).toBe("http://h:1/datamine");
    expect(sidecar.hello?.run_id).toBe("r");
    expect(sidecar.sessions.get(0)?.session_id).toBe("s");
    expect(sidecar.last).toBe(2);
    const found = await sidecar.entries([0, 1, 2, 7]);
    expect(found.get(1)?.parameters?.[0].value).toBe("b");
    expect(found.get(2)?.context).toBe("[(c)d]");
    expect(found.has(7)).toBe(false);
    expect((await sidecar.lastEntry(0))?.index).toBe(1);
    expect(await sidecar.lastEntry(3)).toBeUndefined();
  });

  it("scans only what was added, and waits for a line that is not finished", async () => {
    const lines = [0, 1, 2, 3].map((n) => sidecarLine({ index: n, ordinal: n, session: 1 } satisfies SidecarEntry));
    const whole = lines.join("");
    const first = lines[0] + lines[1] + lines[2].slice(0, 10);
    const { sidecar } = sidecarOf(whole);
    await sidecar.advance(first.length, () => false);
    expect(sidecar.consumed).toBe(lines[0].length + lines[1].length);
    expect((await sidecar.entries([2])).size).toBe(0);
    await sidecar.advance(whole.length, () => false);
    expect((await sidecar.entries([2, 3])).size).toBe(2);
  });

  it("lets a later line replace an earlier one for the same ordinal", async () => {
    const text =
      sidecarLine({ kind: "session", number: 1, ordinal: 0, started_ms: 1, version: "first" }) +
      sidecarLine({ kind: "session", number: 1, ordinal: 0, session_id: "later", started_ms: 1, version: "second" });
    const { bytes, sidecar } = sidecarOf(text);
    await sidecar.advance(bytes.length, () => false);
    expect(sidecar.sessions.get(0)?.version).toBe("second");
  });

  it("reads in pieces and skips lines it cannot read", async () => {
    const text = `${sidecarLine({ index: 0, ordinal: 0, session: 1 })}not json\n{"ordinal":99999999999,"index":1}\n${sidecarLine({ index: 2, ordinal: 1, session: 1 })}`;
    const { bytes, sidecar } = sidecarOf(text, 40);
    await sidecar.advance(bytes.length, () => false);
    expect((await sidecar.entries([0, 1])).size).toBe(2);
  });
});

describe("where the latest run began", () => {
  const hello = (run: string, next: number) => ({ hello: { run_id: run } as never, kind: "hello", next }) satisfies SidecarHello;

  it("is its first hello, even when later connections to it added no entries", () => {
    expect(runStartOf([])).toBe(0);
    expect(runStartOf([hello("a", 0)])).toBe(0);
    expect(runStartOf([hello("a", 0), hello("b", 40), hello("b", 40), hello("b", 40)])).toBe(40);
    expect(runStartOf([hello("a", 0), hello("b", 40), hello("a", 90)])).toBe(90);
  });
});
