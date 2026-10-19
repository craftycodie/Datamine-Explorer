import { useEffect, useRef } from "react";
import { BUILD_INFO } from "../build-info";
import type { ReleaseInfo } from "../lib/update-check";
import { useT } from "../localization";

function dateText(publishedAt: string): string {
  const date = new Date(publishedAt);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

// Offers a newer build found on GitHub. The release notes are shown as plain text, never as HTML.
export function UpdateDialog({
  currentBuild = BUILD_INFO.buildString,
  onDownload,
  onLater,
  onSkip,
  release,
}: {
  currentBuild?: string;
  onDownload: () => void;
  onLater: () => void;
  onSkip: () => void;
  release: ReleaseInfo;
}) {
  const t = useT();
  const download = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    download.current?.focus();
  }, []);
  const date = dateText(release.publishedAt);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onLater()}>
      <div
        aria-label={t("update_title")}
        aria-modal="true"
        className="dialog update"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onLater();
          }
        }}
        role="dialog"
      >
        <div className="dialog-title">{t("update_title")}</div>
        <dl className="about-fields">
          <dt>{t("update_current")}</dt>
          <dd>{currentBuild}</dd>
          <dt>{t("update_new")}</dt>
          <dd>{release.tagName}</dd>
        </dl>
        <div className="update-release">
          {release.name}
          {date && <span className="dim"> · {date}</span>}
          {release.prerelease && <span className="dim"> · {t("update_prerelease")}</span>}
        </div>
        <pre className="update-notes">{release.body || t("update_no_notes")}</pre>
        <div className="dialog-buttons">
          <button className="primary" onClick={onDownload} ref={download} type="button">
            {t("update_download")}
          </button>
          <button onClick={onSkip} type="button">
            {t("update_skip")}
          </button>
          <button onClick={onLater} type="button">
            {t("update_later")}
          </button>
        </div>
      </div>
    </div>
  );
}
