import { useEffect, useRef, useState } from "react";
import { baseName } from "../lib/format";
import { recentLabel, recentTitle, type RecentItem } from "../lib/recent";
import { KindIcon } from "./FileMenu";

// One source as the dialog gives it back. `root` is what the backend opens a file by.
export interface SourceDraft {
  name: string;
  kind: "file" | "server";
  root: string;
}

interface Row {
  id: number;
  kind: "file" | "server";
  // a picked or recent file's root, or the server URL as typed
  target: string;
  name: string;
  // the name was made up from the target, so a new target may replace it
  named: boolean;
}

// A nickname for a source from what it is: a file's name without its extension, a server's host.
export function nicknameOf(kind: "file" | "server", target: string): string {
  if (kind === "server") {
    try {
      return new URL(target).hostname || target;
    } catch {
      return target.replace(/^https?:\/\//, "").split(/[/:]/)[0];
    }
  }
  const name = baseName(target);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

let nextRow = 0;

function rowEmpty(kind: "file" | "server" = "file"): Row {
  return { id: ++nextRow, kind, name: "", named: true, target: "" };
}

// Picks files and servers to show together, each with a nickname. "open" starts with two rows and can
// have more; "add" is one more for what is open already. Recent files and servers fill a row in a click.
export function SourcesDialog({
  mode,
  onCancel,
  onPickFile,
  onRecent,
  onSubmit,
  recents,
  serverDefault,
  taken,
}: {
  mode: "open" | "add";
  onCancel: () => void;
  // gives the root of a picked file, nothing when dismissed
  onPickFile: () => Promise<string | undefined>;
  // gives the root of a recent file (a browser asks for access again), nothing when it cannot be had
  onRecent: (item: RecentItem) => Promise<string | undefined>;
  onSubmit: (sources: SourceDraft[]) => void;
  recents: RecentItem[];
  serverDefault: string;
  // nicknames and targets of the sources open already
  taken: { names: string[]; targets: string[] };
}) {
  const [rows, setRows] = useState<Row[]>(() => (mode === "open" ? [rowEmpty(), rowEmpty()] : [rowEmpty()]));
  const [error, setError] = useState<string>();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  const change = (id: number, update: Partial<Row>) => {
    setError(undefined);
    setRows((before) =>
      before.map((row) => {
        if (row.id !== id) {
          return row;
        }
        const next = { ...row, ...update };
        if (update.name !== undefined) {
          next.named = update.name === "";
        } else if ((update.target !== undefined || update.kind !== undefined) && row.named) {
          next.name = next.target ? nicknameOf(next.kind, next.target) : "";
        }
        return next;
      })
    );
  };

  const pick = async (id: number) => {
    const root = await onPickFile();
    if (root) {
      change(id, { kind: "file", target: root });
    }
  };

  // A recent file or server goes in the first row that has nothing yet, or a new one.
  const recentUse = async (item: RecentItem) => {
    const kind = item.kind === "server" ? "server" : "file";
    const target = kind === "server" ? item.target : await onRecent(item);
    if (!target) {
      setError(`Could not open ${recentLabel(item)}.`);
      return;
    }
    // the nickname it had last time, if it was opened this way before
    const named = item.nickname ? { name: item.nickname } : {};
    const empty = rows.find((row) => row.target === "");
    if (empty) {
      change(empty.id, { kind, target, ...named });
    } else if (mode === "open") {
      setRows((before) => [...before, { ...rowEmpty(kind), name: item.nickname ?? nicknameOf(kind, target), named: !item.nickname, target }]);
    } else {
      change(rows[0].id, { kind, target, ...named });
    }
  };

  const problem = (): string | undefined => {
    const names = new Set(taken.names.map((name) => name.toLowerCase()));
    const targets = new Set(taken.targets);
    for (const [k, row] of rows.entries()) {
      const which = rows.length > 1 ? `Source ${k + 1}` : "The source";
      const target = row.target.trim();
      if (!target) {
        return `${which} needs ${row.kind === "file" ? "a file" : "a server address"}.`;
      }
      const name = row.name.trim();
      if (!name) {
        return `${which} needs a nickname.`;
      }
      if (names.has(name.toLowerCase())) {
        return `There is already a source called ${name}.`;
      }
      if (targets.has(target)) {
        return `${row.kind === "file" ? baseName(target) : target} is open already.`;
      }
      names.add(name.toLowerCase());
      targets.add(target);
    }
  };

  const submit = () => {
    const why = problem();
    if (why) {
      setError(why);
      return;
    }
    onSubmit(rows.map((row) => ({ kind: row.kind, name: row.name.trim(), root: row.target.trim() })));
  };

  const usable = recents.filter((item) => item.kind !== "folder");
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        aria-label={mode === "open" ? "Open multiple sources" : "Add a source"}
        aria-modal="true"
        className="dialog sources-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            submit();
          }
        }}
        role="dialog"
      >
        <div className="dialog-title">
          <KindIcon kind="sources" /> {mode === "open" ? "Open multiple sources" : "Add a source"}
        </div>
        <div className="hint">
          {mode === "open"
            ? "Files and servers shown in one feed, in time order. Each needs a nickname for the source column."
            : "Shown in the feed with the others, in time order. It needs a nickname for the source column."}
        </div>
        <div className="source-rows">
          {rows.map((row, k) => (
            <div className="source-row" key={row.id}>
              <div className="source-kind" role="group">
                {(["file", "server"] as const).map((kind) => (
                  <button
                    aria-pressed={row.kind === kind}
                    className={row.kind === kind ? "active" : undefined}
                    key={kind}
                    onClick={() => row.kind !== kind && change(row.id, { kind, target: kind === "server" ? serverDefault : "" })}
                    title={kind === "file" ? "A log or datamine file" : "A datamine event server"}
                    type="button"
                  >
                    <KindIcon kind={kind} />
                  </button>
                ))}
              </div>
              <input
                aria-label={`Source ${k + 1} nickname`}
                className="source-name"
                onChange={(e) => change(row.id, { name: e.target.value })}
                placeholder="nickname"
                ref={k === 0 ? first : undefined}
                spellCheck={false}
                value={row.name}
              />
              {row.kind === "file" ? (
                <button className="source-target" onClick={() => void pick(row.id)} title={row.target || "Choose a file"} type="button">
                  {row.target ? baseName(row.target) : "Choose file..."}
                </button>
              ) : (
                <input
                  aria-label={`Source ${k + 1} server URL`}
                  className="source-target"
                  onChange={(e) => change(row.id, { target: e.target.value })}
                  placeholder={serverDefault}
                  spellCheck={false}
                  value={row.target}
                />
              )}
              {mode === "open" && rows.length > 2 ? (
                <button aria-label={`Remove source ${k + 1}`} className="source-remove" onClick={() => setRows(rows.filter((other) => other.id !== row.id))} title="Remove" type="button">
                  ×
                </button>
              ) : (
                mode === "open" && <span className="source-remove" />
              )}
            </div>
          ))}
        </div>
        {mode === "open" && (
          <div>
            <button onClick={() => setRows([...rows, rowEmpty()])} type="button">
              Add another
            </button>
          </div>
        )}
        {usable.length > 0 && (
          <div className="recent-list sources-recent">
            <div className="dim">Recent</div>
            {usable.map((item) => (
              <button key={`${item.kind}-${item.target}`} onClick={() => void recentUse(item)} title={recentTitle(item)} type="button">
                <KindIcon kind={item.kind} />
                {item.nickname && <span className="recent-nickname">{item.nickname}</span>}
                {recentLabel(item)}
              </button>
            ))}
          </div>
        )}
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-buttons">
          <button className="primary" onClick={submit} type="button">
            {mode === "open" ? "Open" : "Add"}
          </button>
          <button onClick={onCancel} type="button">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
