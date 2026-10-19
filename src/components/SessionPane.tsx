import { LEVEL_NAMES } from "../lib/types";
import type { LogData } from "../lib/session";
import { baseName, dateTimeText, durationText, sizeText } from "../lib/format";
import type { LiveStatus, SessionInfo } from "../lib/types";
import { type MessageKey, textOf, useT } from "../localization";

const TOP_CATEGORIES = 15;

function Row({ label, value }: { label: MessageKey; value: string | number | undefined }) {
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

function ServerSection({ live }: { live: LiveStatus }) {
  const t = useT();
  return (
    <>
      <div className="detail-label">{t("session_pane_server")}</div>
      <dl className="fields">
        <Row label="field_url" value={live.url} />
        <Row label="field_prefix" value={live.prefix === live.url ? undefined : live.prefix} />
        <dt>{t("field_state")}</dt>
        <dd>
          <span className={`live-state ${live.state}`}>{"●"}</span> {t(`live_${live.state}`)}
        </dd>
        <Row label="field_name" value={live.name} />
        <Row label="field_version" value={live.version} />
        <Row label="field_session_id" value={live.sessionId} />
        <Row label="field_system_id" value={live.systemId} />
        <Row label="field_build" value={live.build} />
        <Row label="field_started" value={live.startedMs ? dateTimeText(live.startedMs) : undefined} />
      </dl>
      {live.error && <div className="note warn">{textOf(live.error)}</div>}
    </>
  );
}

export function SessionPane({ data, onJump }: { data: LogData; onJump: (session: SessionInfo) => void }) {
  const t = useT();
  const { file, live, meta, stats } = data;
  if (!file) {
    return <div className="empty">{t("session_pane_no_file")}</div>;
  }
  const top = [...stats.categoryCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_CATEGORIES);
  const duration = stats.firstTime !== undefined && stats.lastTime !== undefined ? stats.lastTime - stats.firstTime : undefined;
  const unleveled = stats.levelCounts[LEVEL_NAMES.length];
  return (
    <div className="pane">
      <div className="pane-head">
        <span className="pane-title">{t(live ? "session_pane_server" : data.sources ? "session_pane_sources" : "session_pane_file")}</span>
        <span className="dim">{live ? t(`live_${live.state}`) : data.sources ? data.sources.length.toLocaleString() : baseName(file.path)}</span>
      </div>
      <div className="pane-body detail session">
      {live ? (
        <ServerSection live={live} />
      ) : (
        <>
          <div className="detail-label">{t(data.sources ? "session_pane_sources" : "session_pane_file")}</div>
          <dl className="fields">
            <Row label="field_name" value={data.sources ? undefined : baseName(file.path)} />
            <Row label="field_size" value={t("field_size_value", { bytes: file.size.toLocaleString(), size: sizeText(file.size) })} />
            <Row label="field_modified" value={dateTimeText(file.modifiedMs)} />
            <Row label="field_format" value={meta?.format && textOf(meta.format)} />
            <Row label="field_banner_version" value={meta?.bannerVersion} />
            <Row label="field_session_id" value={meta?.header ? undefined : meta?.sessionId} />
          </dl>
        </>
      )}
      {meta?.notes.map((note) => {
        const text = note.source ? `${note.source}: ${textOf(note.text)}` : textOf(note.text);
        return (
          <div className="note warn" key={text}>
            {text}
          </div>
        );
      })}

      {!live && meta?.server && (
        <>
          <div className="detail-label">{t("session_pane_live_session")}</div>
          <dl className="fields">
            {meta.server.map(([label, value]) => (
              <Row key={label} label={label} value={value} />
            ))}
          </dl>
        </>
      )}

      {meta?.header && (
        <>
          <div className="detail-label">{t("session_pane_header")}</div>
          <dl className="fields">
            {meta.header.map(([label, value]) => (
              <Row key={label} label={label} value={value} />
            ))}
          </dl>
        </>
      )}

      {meta?.reportFolder && (
        <>
          <div className="detail-label">{t("session_pane_report_folder")}</div>
          <dl className="fields">
            <Row label="field_folder" value={meta.reportFolder.name} />
            <Row label="field_date" value={meta.reportFolder.date ? dateTimeText(meta.reportFolder.date) : meta.reportFolder.dateText} />
            <Row label="field_suffix" value={meta.reportFolder.suffix} />
          </dl>
        </>
      )}

      <div className="detail-label">{t("session_pane_entries")}</div>
      <dl className="fields">
        <Row label="field_count" value={stats.count.toLocaleString()} />
        <Row label="field_rate" value={live ? t("field_rate_value", { rate: live.rate.toFixed(live.rate >= 100 ? 0 : 1) }) : undefined} />
        <Row label="field_memory" value={live ? t("field_memory_value", { size: sizeText(live.memoryBytes) }) : undefined} />
        <Row label="field_sessions" value={stats.sessions.length.toLocaleString()} />
        <Row label="field_first" value={stats.firstTime === undefined ? undefined : dateTimeText(stats.firstTime)} />
        <Row label="field_last" value={stats.lastTime === undefined ? undefined : dateTimeText(stats.lastTime)} />
        <Row label="field_duration" value={duration === undefined ? undefined : durationText(duration)} />
      </dl>
      <div className="level-counts">
        {LEVEL_NAMES.map((name, level) => (
          <div className="level-count" key={name}>
            <span className={`badge level-${level}`}>{t(`level_${name}`)}</span>
            <span>{stats.levelCounts[level].toLocaleString()}</span>
          </div>
        ))}
        {unleveled > 0 && (
          <div className="level-count">
            <span className="badge level--1">{t("level_none")}</span>
            <span>{unleveled.toLocaleString()}</span>
          </div>
        )}
      </div>

      {stats.sessions.length > 1 && (
        <>
          <div className="detail-label">{t("session_pane_sessions")}</div>
          <div className="session-list">
            {stats.sessions.map((session) => (
              <div className="session-item" key={session.id} onClick={() => onJump(session)} title={t("session_pane_jump")}>
                <span className="session-number">{session.number}</span>
                {session.source && <span className="session-source">{session.source}</span>}
                <span className="session-time">{session.time ? dateTimeText(session.time) : ""}</span>
                <span className="dim">{session.version}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="detail-label">{t("session_pane_top_categories")}</div>
      <table className="params">
        <tbody>
          {top.map(([category, count]) => (
            <tr key={category}>
              <td>{category || <span className="dim">{t("category_none")}</span>}</td>
              <td className="param-value">{count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
