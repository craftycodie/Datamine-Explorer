import { useEffect, useRef, useState } from "react";
import { BUILD_INFO } from "../build-info";
import { clipboardWrite } from "../lib/clipboard";
import { DESKTOP_BUILD } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { manualCheckMessage, type UpdateOutcome } from "../lib/update-check";
import { DATAMINE_VERSION, ISSUES_URL, REPOSITORY_URL } from "../lib/versions";
import { useT } from "../localization";

function builtText(builtAt: string): string | undefined {
  const date = new Date(builtAt);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

// What this build is, and where to find the project.
// `onCheckUpdates` is only given in the desktop app; the web build is always current.
export function AboutDialog({ onCheckUpdates, onClose }: { onCheckUpdates?: () => Promise<UpdateOutcome>; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{ checking: boolean; text: string }>();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    clipboardWrite(BUILD_INFO.buildString).then(
      () => setCopied(true),
      () => undefined
    );
  };
  const checkUpdates = async () => {
    if (!onCheckUpdates) {
      return;
    }
    setUpdateStatus({ checking: true, text: t("about_checking") });
    const outcome = await onCheckUpdates();
    setUpdateStatus({ checking: false, text: manualCheckMessage(outcome) });
  };
  // links are buttons, so the webview never navigates away from the app
  const link = (url: string, label: string) => (
    <button className="link" onClick={() => void openExternal(url)} type="button">
      {label}
    </button>
  );

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        aria-label={t("about_title")}
        aria-modal="true"
        className="dialog about"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        role="dialog"
      >
        <div className="about-head">
          <img alt="" className="about-icon" draggable={false} height="64" src={`${import.meta.env.BASE_URL}app-icon.svg`} width="64" />
          <div>
            <div className="about-name">Datamine Explorer</div>
            <button className="about-build" onClick={copy} title={t("about_copy_build")} type="button">
              {BUILD_INFO.buildString}
              <span className="about-copied">{copied ? t("about_copied") : ""}</span>
            </button>
          </div>
        </div>
        <dl className="about-fields">
          <dt>{t("about_branch")}</dt>
          <dd>{BUILD_INFO.branch}</dd>
          <dt>{t("about_commit")}</dt>
          <dd>{BUILD_INFO.commit ? BUILD_INFO.commit.slice(0, 7) : t("common_unknown")}</dd>
          <dt>{t("about_built")}</dt>
          <dd>{(BUILD_INFO.builtAt && builtText(BUILD_INFO.builtAt)) || t("common_unknown")}</dd>
          <dt>@blamnetwork/datamine</dt>
          <dd>{DATAMINE_VERSION}</dd>
        </dl>
        <div className="about-links">
          {link(REPOSITORY_URL, "GitHub")}
          {link(ISSUES_URL, t("about_report_bug"))}
        </div>
        {DESKTOP_BUILD && onCheckUpdates && (
          <div className="about-update">
            <button disabled={updateStatus?.checking} onClick={() => void checkUpdates()} type="button">
              {t("about_check_updates")}
            </button>
            {updateStatus && <span className="dim">{updateStatus.text}</span>}
          </div>
        )}
        <div className="about-foot">
          <span className="dim">{t("about_made_by", { author: "@craftycodie" })}</span>
          <button className="primary" onClick={onClose} ref={close} type="button">
            {t("common_close")}
          </button>
        </div>
      </div>
    </div>
  );
}
