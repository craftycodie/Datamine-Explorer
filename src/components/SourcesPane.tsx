import { baseName } from "../lib/format";
import type { SourceSpec, SourceStatus } from "../lib/types";
import { textOf, useT } from "../localization";
import { isXbdmUrl } from "../lib/xbdm";
import { KindIcon } from "./FileMenu";
import { MinusIcon, PlusIcon } from "./Icons";

// Which sources are shown, like the category filters: only the included ones when there are any, never
// the excluded ones. By source key.
export interface SourceFilter {
  include: string[];
  exclude: string[];
}

export type SourceMode = "include" | "exclude";

function modeOf(filter: SourceFilter, key: string): SourceMode | undefined {
  return filter.include.includes(key) ? "include" : filter.exclude.includes(key) ? "exclude" : undefined;
}

// The sources shown together: their nicknames with a dot for how each is doing, how many events each has,
// the +/- to show only one or hide it, and a cross on hover to take it out.
export function SourcesPane({
  filter,
  onAdd,
  onMode,
  onRemove,
  sources,
  statuses,
}: {
  filter: SourceFilter;
  onAdd: () => void;
  onMode: (key: string, mode: SourceMode) => void;
  onRemove: (key: string) => void;
  sources: SourceSpec[];
  statuses?: SourceStatus[];
}) {
  const t = useT();
  return (
    <div className="sources-pane">
      <div className="pane-header">
        <span className="pane-title">
          <KindIcon kind="sources" />
          {t("sources_heading")}
        </span>
      </div>
      <div className="sources-scroll">
        {sources.map((source) => {
          const status = statuses?.find((one) => one.key === source.key);
          const state = status?.state ?? (source.kind === "server" ? "connecting" : "loading");
          const where = source.kind === "server" ? (status?.prefix ?? source.target) : source.target;
          const stateText = t(`source_state_${state}`);
          const title = [source.name, where, stateText, status?.error && textOf(status.error)].filter(Boolean).join("\n");
          const mode = modeOf(filter, source.key);
          return (
            <div className="source-item" key={source.key} title={title}>
              <KindIcon kind={source.kind === "server" && isXbdmUrl(source.target) ? "console" : source.kind} />
              <span className="source-item-name">{source.name}</span>
              <span aria-label={stateText} className={`source-blip ${state}`} role="img" />
              <span className="source-item-target">{source.kind === "server" ? where.replace(/^(https?|xbdm):\/\//, "") : baseName(where)}</span>
              <span className="cat-count">{(status?.entries ?? 0).toLocaleString()}</span>
              <button
                aria-label={t("sources_include")}
                aria-pressed={mode === "include"}
                className={mode === "include" ? "cat-mode include on" : "cat-mode include"}
                onClick={() => onMode(source.key, "include")}
                title={t("sources_include")}
                type="button"
              >
                <PlusIcon />
              </button>
              <button
                aria-label={t("sources_exclude")}
                aria-pressed={mode === "exclude"}
                className={mode === "exclude" ? "cat-mode exclude on" : "cat-mode exclude"}
                onClick={() => onMode(source.key, "exclude")}
                title={t("sources_exclude")}
                type="button"
              >
                <MinusIcon />
              </button>
              <button
                aria-label={t("sources_remove", { name: source.name })}
                className="source-item-remove"
                onClick={() => onRemove(source.key)}
                title={t("sources_remove_title")}
                type="button"
              >
                ×
              </button>
            </div>
          );
        })}
        <button className="source-add" onClick={onAdd} type="button">
          <PlusIcon /> {t("sources_add")}
        </button>
      </div>
    </div>
  );
}
