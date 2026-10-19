import { baseName } from "../lib/format";
import type { SourceSpec, SourceStatus } from "../lib/types";
import { KindIcon } from "./FileMenu";
import { PlusIcon } from "./Icons";

const STATE_TEXT: Record<SourceStatus["state"], string> = {
  closed: "disconnected",
  connecting: "connecting",
  failed: "could not be read",
  live: "live",
  loading: "reading",
  ready: "",
  reconnecting: "reconnecting",
};

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
  return (
    <div className="sources-pane">
      <div className="pane-header">
        <span className="pane-title">
          <KindIcon kind="sources" />
          Sources
        </span>
      </div>
      <div className="sources-scroll">
        {sources.map((source) => {
          const status = statuses?.find((one) => one.key === source.key);
          const state = status?.state ?? (source.kind === "server" ? "connecting" : "loading");
          const where = source.kind === "server" ? (status?.prefix ?? source.target) : source.target;
          return (
            <div className="source-item" key={source.key} title={`${source.name}\n${where}${status?.error ? `\n${status.error}` : ""}`}>
              <KindIcon kind={source.kind} />
              <span className="source-item-name">{source.name}</span>
              <span className="source-item-target">{source.kind === "server" ? where.replace(/^https?:\/\//, "") : baseName(where)}</span>
              {STATE_TEXT[state] && <span className={`source-state ${state}`}>{STATE_TEXT[state]}</span>}
              <button aria-label={`Remove ${source.name}`} className="source-item-remove" onClick={() => onRemove(source.key)} title="Remove this source" type="button">
                ×
              </button>
            </div>
          );
        })}
        <button className="source-add" onClick={onAdd} type="button">
          <PlusIcon /> Add Source
        </button>
      </div>
    </div>
  );
}
