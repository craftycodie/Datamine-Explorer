import { useState } from "react";
import { LEVEL_NAMES, type DetailResult } from "../lib/types";
import { dateTimeText, durationText, timeColumnText } from "../lib/format";
import { type MessageKey, useT } from "../localization";
import { Highlight } from "./Highlight";

function Field({ label, value }: { label: MessageKey; value: string | number | undefined }) {
  const t = useT();
  if (value === undefined || value === "") {
    return null;
  }
  return (
    <>
      <dt>{t(label)}</dt>
      <dd>{value}</dd>
    </>
  );
}

// Shown over the details of the focused row when more than one is selected.
function SelectionNote({ count }: { count: number }) {
  const t = useT();
  return count > 1 ? <div className="selection-note">{t("detail_selected", { count: count.toLocaleString() })}</div> : null;
}

function SessionDetail({ count, detail }: { count: number; detail: DetailResult }) {
  const t = useT();
  const { entry, sessionStats: stats } = detail;
  const duration = stats?.firstTime !== undefined && stats.lastTime !== undefined ? stats.lastTime - stats.firstTime : undefined;
  return (
    <div className="pane">
      <SelectionNote count={count} />
      <div className="pane-head detail-head">
        <span className="badge session">{t("detail_session_badge", { number: entry.session?.number ?? "" })}</span>
        <span className="detail-category">{entry.session?.version}</span>
      </div>
      <div className="pane-body detail">
      <dl className="fields">
        <Field label="field_source" value={entry.source} />
        <Field label="field_session_id" value={entry.session?.sessionId} />
        <Field label="field_starts" value={entry.time ? dateTimeText(entry.time) : undefined} />
        <Field label="field_events" value={stats?.count.toLocaleString()} />
        <Field label="field_first" value={stats?.firstTime === undefined ? undefined : dateTimeText(stats.firstTime)} />
        <Field label="field_last" value={stats?.lastTime === undefined ? undefined : dateTimeText(stats.lastTime)} />
        <Field label="field_duration" value={duration === undefined ? undefined : durationText(duration)} />
      </dl>
      {stats && (
        <div className="level-counts">
          {LEVEL_NAMES.map((name, level) => (
            <div className="level-count" key={name}>
              <span className={`badge level-${level}`}>{t(`level_${name}`)}</span>
              <span>{stats.levelCounts[level].toLocaleString()}</span>
            </div>
          ))}
          {stats.levelCounts[LEVEL_NAMES.length] > 0 && (
            <div className="level-count">
              <span className="badge level--1">{t("level_none")}</span>
              <span>{stats.levelCounts[LEVEL_NAMES.length].toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
      {entry.raw !== undefined && (
        <>
          <div className="detail-label">{t("detail_banner")}</div>
          <pre className="detail-block raw">{entry.raw}</pre>
        </>
      )}
      </div>
    </div>
  );
}

export function DetailPane({
  detail,
  highlight,
  onSelect,
  selected,
  selectedCount,
}: {
  detail?: DetailResult;
  highlight?: RegExp;
  onSelect: (entryIndex: number) => void;
  selected?: number;
  // how many rows are selected; the details are of the focused one
  selectedCount: number;
}) {
  const t = useT();
  const [rawOpen, setRawOpen] = useState(false);
  if (!detail || selected === undefined) {
    return <div className="empty">{t("detail_empty")}</div>;
  }
  const { entry, around, aroundFrom: from, aroundIds } = detail;
  if (entry.kind === "session") {
    return <SessionDetail count={selectedCount} detail={detail} />;
  }
  const levelName = entry.level >= 0 ? t(`level_${LEVEL_NAMES[entry.level]}`) : entry.levelText;
  return (
    <div className="pane">
      <SelectionNote count={selectedCount} />
      <div className="pane-head detail-head">
        <span className={`badge level-${entry.level}`}>{levelName || "?"}</span>
        <span className="detail-category">{entry.category}</span>
      </div>
      <div className="pane-body detail">
      <pre className="detail-message">
        <Highlight pattern={highlight} text={entry.message || entry.text} />
      </pre>
      {entry.text && !entry.text.endsWith(entry.message) && (
        <>
          <div className="detail-label">{t("detail_full_text")}</div>
          <pre className="detail-block">{entry.text}</pre>
        </>
      )}
      <dl className="fields">
        <Field label="field_source" value={entry.source} />
        <Field label="field_time" value={entry.timeText} />
        <Field label="field_entry" value={entry.ordinal} />
        <Field label="field_event_index" value={entry.eventIndex} />
        <Field label="field_session" value={entry.sessionNumber} />
        <Field label="field_game_time" value={entry.gameTime} />
        <Field label="field_frame" value={entry.frameIndex} />
        <Field label="field_thread" value={entry.threadId === undefined ? undefined : `0x${entry.threadId.toString(16)}`} />
        <Field label="field_definition_id" value={entry.definitionId} />
        <Field label="field_context" value={entry.context} />
        <Field label="field_custom_prefix" value={entry.customPrefix} />
      </dl>
      {entry.parameters && entry.parameters.length > 0 && (
        <>
          <div className="detail-label">{t("detail_parameters")}</div>
          <div className="params-scroll">
          <table className="params">
            <thead>
              <tr>
                <th>{t("detail_param_name")}</th>
                <th>{t("detail_param_type")}</th>
                <th>{t("detail_param_value")}</th>
              </tr>
            </thead>
            <tbody>
              {entry.parameters.map((p, i) => (
                <tr key={i}>
                  <td>{p.name || <span className="dim">{t("detail_unnamed")}</span>}</td>
                  <td className="dim">{p.type}</td>
                  <td className="param-value">{p.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
      {entry.raw !== undefined && (
        <>
          <div className="detail-label clickable" onClick={() => setRawOpen(!rawOpen)}>
            {rawOpen ? "▾" : "▸"} {t("detail_raw")}
          </div>
          {rawOpen && <pre className="detail-block raw">{entry.raw}</pre>}
        </>
      )}
      <div className="detail-label">{t("detail_context")}</div>
      <div className="context">
        {around.map((other, i) => {
          const index = aroundIds?.[i] ?? from + i;
          return (
            <div
              className={`context-row${index === selected ? " selected" : ""}`}
              key={index}
              onClick={() => onSelect(index)}
            >
              {other.kind === "session" ? (
                <span className="context-text dim">
                  {t("detail_context_session", { number: other.session?.number ?? "", version: other.session?.version ?? "" })}
                </span>
              ) : (
                <>
                  <span className="dim">{timeColumnText(other.timeText)}</span>
                  <span className={`level-text level-${other.level}`}>{other.level >= 0 ? LEVEL_NAMES[other.level][0] : "?"}</span>
                  <span className="context-text">{other.category ? `${other.category} ` : ""}{other.message}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
