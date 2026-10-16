import { useState } from "react";
import { LEVEL_NAMES, type DetailResult } from "../lib/types";
import { dateTimeText, durationText, timeColumnText } from "../lib/format";
import { Highlight } from "./Highlight";

function Field({ label, value }: { label: string; value: string | number | undefined }) {
  if (value === undefined || value === "") {
    return null;
  }
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

// Shown over the details of the focused row when more than one is selected.
function SelectionNote({ count }: { count: number }) {
  return count > 1 ? <div className="selection-note">{count.toLocaleString()} selected. Showing the focused row.</div> : null;
}

function SessionDetail({ count, detail }: { count: number; detail: DetailResult }) {
  const { entry, sessionStats: stats } = detail;
  const duration = stats?.firstTime !== undefined && stats.lastTime !== undefined ? stats.lastTime - stats.firstTime : undefined;
  return (
    <div className="pane">
      <SelectionNote count={count} />
      <div className="pane-head detail-head">
        <span className="badge session">session {entry.session?.number}</span>
        <span className="detail-category">{entry.session?.version}</span>
      </div>
      <div className="pane-body detail">
      <dl className="fields">
        <Field label="session id" value={entry.session?.sessionId} />
        <Field label="starts" value={entry.time ? dateTimeText(entry.time) : undefined} />
        <Field label="events" value={stats?.count.toLocaleString()} />
        <Field label="first" value={stats?.firstTime === undefined ? undefined : dateTimeText(stats.firstTime)} />
        <Field label="last" value={stats?.lastTime === undefined ? undefined : dateTimeText(stats.lastTime)} />
        <Field label="duration" value={duration === undefined ? undefined : durationText(duration)} />
      </dl>
      {stats && (
        <div className="level-counts">
          {LEVEL_NAMES.map((name, level) => (
            <div className="level-count" key={name}>
              <span className={`badge level-${level}`}>{name}</span>
              <span>{stats.levelCounts[level].toLocaleString()}</span>
            </div>
          ))}
          {stats.levelCounts[LEVEL_NAMES.length] > 0 && (
            <div className="level-count">
              <span className="badge level--1">no level</span>
              <span>{stats.levelCounts[LEVEL_NAMES.length].toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
      {entry.raw !== undefined && (
        <>
          <div className="detail-label">Banner</div>
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
  const [rawOpen, setRawOpen] = useState(false);
  if (!detail || selected === undefined) {
    return <div className="empty">Select a row to see its details.</div>;
  }
  const { entry, around, aroundFrom: from } = detail;
  if (entry.kind === "session") {
    return <SessionDetail count={selectedCount} detail={detail} />;
  }
  const levelName = entry.level >= 0 ? LEVEL_NAMES[entry.level] : entry.levelText;
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
          <div className="detail-label">Full text</div>
          <pre className="detail-block">{entry.text}</pre>
        </>
      )}
      <dl className="fields">
        <Field label="time" value={entry.timeText} />
        <Field label="entry" value={entry.ordinal} />
        <Field label="event index" value={entry.eventIndex} />
        <Field label="session" value={entry.sessionNumber} />
        <Field label="game time" value={entry.gameTime} />
        <Field label="frame" value={entry.frameIndex} />
        <Field label="thread" value={entry.threadId === undefined ? undefined : `0x${entry.threadId.toString(16)}`} />
        <Field label="definition id" value={entry.definitionId} />
        <Field label="context" value={entry.context} />
        <Field label="prefix" value={entry.customPrefix} />
      </dl>
      {entry.parameters && entry.parameters.length > 0 && (
        <>
          <div className="detail-label">Parameters</div>
          <div className="params-scroll">
          <table className="params">
            <thead>
              <tr>
                <th>name</th>
                <th>type</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {entry.parameters.map((p, i) => (
                <tr key={i}>
                  <td>{p.name || <span className="dim">(unnamed)</span>}</td>
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
            {rawOpen ? "▾" : "▸"} Raw
          </div>
          {rawOpen && <pre className="detail-block raw">{entry.raw}</pre>}
        </>
      )}
      <div className="detail-label">Context</div>
      <div className="context">
        {around.map((other, i) => {
          const index = from + i;
          return (
            <div
              className={`context-row${index === selected ? " selected" : ""}`}
              key={index}
              onClick={() => onSelect(index)}
            >
              {other.kind === "session" ? (
                <span className="context-text dim">
                  {`session ${other.session?.number} · ${other.session?.version}`}
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
