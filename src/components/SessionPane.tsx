import { LEVEL_NAMES } from "../lib/types";
import type { LogData } from "../lib/session";
import { baseName, dateTimeText, durationText, sizeText } from "../lib/format";
import type { LiveStatus, SessionInfo } from "../lib/types";

const TOP_CATEGORIES = 15;

function Row({ label, value }: { label: string; value: string | number | undefined }) {
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

function ServerSection({ live }: { live: LiveStatus }) {
  return (
    <>
      <div className="detail-label">Server</div>
      <dl className="fields">
        <Row label="url" value={live.url} />
        <Row label="prefix" value={live.prefix === live.url ? undefined : live.prefix} />
        <dt>state</dt>
        <dd>
          <span className={`live-state ${live.state}`}>{"●"}</span> {live.state}
        </dd>
        <Row label="name" value={live.name} />
        <Row label="version" value={live.version} />
        <Row label="session id" value={live.sessionId} />
        <Row label="system id" value={live.systemId} />
        <Row label="build" value={live.build} />
        <Row label="started" value={live.startedMs ? dateTimeText(live.startedMs) : undefined} />
      </dl>
      {live.error && <div className="note warn">{live.error}</div>}
    </>
  );
}

export function SessionPane({ data, onJump }: { data: LogData; onJump: (session: SessionInfo) => void }) {
  const { file, live, meta, stats } = data;
  if (!file) {
    return <div className="empty">No file open.</div>;
  }
  const top = [...stats.categoryCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_CATEGORIES);
  const duration = stats.firstTime !== undefined && stats.lastTime !== undefined ? stats.lastTime - stats.firstTime : undefined;
  const unleveled = stats.levelCounts[LEVEL_NAMES.length];
  return (
    <div className="pane">
      <div className="pane-head">
        <span className="pane-title">{live ? "Server" : "File"}</span>
        <span className="dim">{live ? live.state : baseName(file.path)}</span>
      </div>
      <div className="pane-body detail session">
      {live ? (
        <ServerSection live={live} />
      ) : (
        <>
          <div className="detail-label">File</div>
          <dl className="fields">
            <Row label="name" value={baseName(file.path)} />
            <Row label="size" value={`${sizeText(file.size)} (${file.size.toLocaleString()} bytes)`} />
            <Row label="modified" value={dateTimeText(file.modifiedMs)} />
            <Row label="format" value={meta?.format} />
            <Row label="banner version" value={meta?.bannerVersion} />
            <Row label="session id" value={meta?.header ? undefined : meta?.sessionId} />
          </dl>
        </>
      )}
      {meta?.notes.map((note) => (
        <div className="note warn" key={note}>
          {note}
        </div>
      ))}

      {!live && meta?.server && (
        <>
          <div className="detail-label">Live session</div>
          <dl className="fields">
            {meta.server.map(([label, value]) => (
              <Row key={label} label={label} value={value} />
            ))}
          </dl>
        </>
      )}

      {meta?.header && (
        <>
          <div className="detail-label">Datamine header</div>
          <dl className="fields">
            {meta.header.map(([label, value]) => (
              <Row key={label} label={label} value={value} />
            ))}
          </dl>
        </>
      )}

      {meta?.reportFolder && (
        <>
          <div className="detail-label">Report folder</div>
          <dl className="fields">
            <Row label="folder" value={meta.reportFolder.name} />
            <Row label="date" value={meta.reportFolder.date ? dateTimeText(meta.reportFolder.date) : meta.reportFolder.dateText} />
            <Row label="suffix" value={meta.reportFolder.suffix} />
          </dl>
        </>
      )}

      <div className="detail-label">Entries</div>
      <dl className="fields">
        <Row label="count" value={stats.count.toLocaleString()} />
        <Row label="rate" value={live ? `${live.rate.toFixed(live.rate >= 100 ? 0 : 1)} entries/s` : undefined} />
        <Row label="memory" value={live ? `about ${sizeText(live.memoryBytes)}` : undefined} />
        <Row label="sessions" value={stats.sessions.length.toLocaleString()} />
        <Row label="first" value={stats.firstTime === undefined ? undefined : dateTimeText(stats.firstTime)} />
        <Row label="last" value={stats.lastTime === undefined ? undefined : dateTimeText(stats.lastTime)} />
        <Row label="duration" value={duration === undefined ? undefined : durationText(duration)} />
      </dl>
      <div className="level-counts">
        {LEVEL_NAMES.map((name, level) => (
          <div className="level-count" key={name}>
            <span className={`badge level-${level}`}>{name}</span>
            <span>{stats.levelCounts[level].toLocaleString()}</span>
          </div>
        ))}
        {unleveled > 0 && (
          <div className="level-count">
            <span className="badge level--1">no level</span>
            <span>{unleveled.toLocaleString()}</span>
          </div>
        )}
      </div>

      {stats.sessions.length > 1 && (
        <>
          <div className="detail-label">Sessions</div>
          <div className="session-list">
            {stats.sessions.map((session) => (
              <div className="session-item" key={session.id} onClick={() => onJump(session)} title="Jump to this session">
                <span className="session-number">{session.number}</span>
                {session.source && <span className="session-source">{session.source}</span>}
                <span className="session-time">{session.time ? dateTimeText(session.time) : ""}</span>
                <span className="dim">{session.version}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="detail-label">Top categories</div>
      <table className="params">
        <tbody>
          {top.map(([category, count]) => (
            <tr key={category}>
              <td>{category || <span className="dim">(none)</span>}</td>
              <td className="param-value">{count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
