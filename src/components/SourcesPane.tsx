import { baseName } from "../lib/format";
import type { SourceSpec, SourceStatus } from "../lib/types";
import { textOf, useT } from "../localization";
import { KindIcon } from "./FileMenu";
import { PlusIcon } from "./Icons";

// The sources shown together: their nicknames, how each is doing, and a way to take one out or add one.
export function SourcesPane({
  onAdd,
  onRemove,
  sources,
  statuses,
}: {
  onAdd: () => void;
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
          const title = [source.name, where, status?.error && textOf(status.error)].filter(Boolean).join("\n");
          return (
            <div className="source-item" key={source.key} title={title}>
              <KindIcon kind={source.kind} />
              <span className="source-item-name">{source.name}</span>
              <span className="source-item-target">{source.kind === "server" ? where.replace(/^https?:\/\//, "") : baseName(where)}</span>
              {state !== "ready" && <span className={`source-state ${state}`}>{t(`source_state_${state}`)}</span>}
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
