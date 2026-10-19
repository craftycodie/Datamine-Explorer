import { useEffect, useRef, useState } from "react";
import { baseName } from "../lib/format";
import { recentLabel, type RecentItem } from "../lib/recent";
import { useT } from "../localization";
import { KindIcon } from "./FileMenu";
import { RecentList } from "./RecentList";

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
  onRecentRemove,
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
  onRecentRemove: (item: RecentItem) => void;
  onSubmit: (sources: SourceDraft[]) => void;
  recents: RecentItem[];
  serverDefault: string;
  // nicknames and targets of the sources open already
  taken: { names: string[]; targets: string[] };
}) {
  const t = useT();
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
      setError(t("sources_dialog_recent_failed", { name: recentLabel(item) }));
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
      const which = rows.length > 1 ? t("sources_dialog_which", { number: k + 1 }) : t("sources_dialog_which_one");
      const target = row.target.trim();
      if (!target) {
        return t(row.kind === "file" ? "sources_dialog_needs_file" : "sources_dialog_needs_server", { which });
      }
      const name = row.name.trim();
      if (!name) {
        return t("sources_dialog_needs_name", { which });
      }
      if (names.has(name.toLowerCase())) {
        return t("sources_dialog_name_taken", { name });
      }
      if (targets.has(target)) {
        return t("sources_dialog_open_already", { target: row.kind === "file" ? baseName(target) : target });
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
        aria-label={t(mode === "open" ? "sources_dialog_open" : "sources_dialog_add")}
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
          <KindIcon kind="sources" /> {t(mode === "open" ? "sources_dialog_open" : "sources_dialog_add")}
        </div>
        <div className="hint">{t(mode === "open" ? "sources_dialog_open_hint" : "sources_dialog_add_hint")}</div>
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
                    title={t(kind === "file" ? "sources_dialog_kind_file" : "sources_dialog_kind_server")}
                    type="button"
                  >
                    <KindIcon kind={kind} />
                  </button>
                ))}
              </div>
              <input
                aria-label={t("sources_dialog_nickname_aria", { number: k + 1 })}
                className="source-name"
                onChange={(e) => change(row.id, { name: e.target.value })}
                placeholder={t("sources_dialog_nickname")}
                ref={k === 0 ? first : undefined}
                spellCheck={false}
                value={row.name}
              />
              {row.kind === "file" ? (
                <button className="source-target" onClick={() => void pick(row.id)} title={row.target || "Choose a file"} type="button">
                  {row.target ? baseName(row.target) : t("sources_dialog_choose")}
                </button>
              ) : (
                <input
                  aria-label={t("sources_dialog_url_aria", { number: k + 1 })}
                  className="source-target"
                  onChange={(e) => change(row.id, { target: e.target.value })}
                  placeholder={serverDefault}
                  spellCheck={false}
                  value={row.target}
                />
              )}
              {mode === "open" && rows.length > 2 ? (
                <button
                  aria-label={t("sources_dialog_remove", { number: k + 1 })}
                  className="source-remove"
                  onClick={() => setRows(rows.filter((other) => other.id !== row.id))}
                  title={t("sources_dialog_remove_title")}
                  type="button"
                >
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
              {t("sources_dialog_another")}
            </button>
          </div>
        )}
        <RecentList className="sources-recent" items={usable} nicknames onOpen={(item) => void recentUse(item)} onRemove={onRecentRemove} />
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-buttons">
          <button className="primary" onClick={submit} type="button">
            {t(mode === "open" ? "sources_dialog_open_button" : "sources_dialog_add_button")}
          </button>
          <button onClick={onCancel} type="button">
            {t("common_cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
