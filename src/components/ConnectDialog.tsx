import { useEffect, useRef, useState } from "react";
import { useT } from "../localization";
import { KindIcon } from "./FileMenu";

// Asks for an event server's address, or an Xbox 360's. The caller remembers the last one used.
export function ConnectDialog({
  initial,
  kind,
  onCancel,
  onConnect,
}: {
  initial: string;
  kind: "server" | "console";
  onCancel: () => void;
  onConnect: (address: string, fresh: boolean) => void;
}) {
  const xbox = kind === "console";
  const t = useT();
  const [url, setUrl] = useState(initial);
  const [fresh, setFresh] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const submit = () => {
    if (url.trim()) {
      onConnect(url.trim(), fresh);
    }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        aria-label={t(xbox ? "connect_xbox_aria" : "connect_aria")}
        aria-modal="true"
        className="dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter") {
            submit();
          }
        }}
        role="dialog"
      >
        <div className="dialog-title">
          <KindIcon kind={kind} /> {t(xbox ? "connect_xbox_title" : "connect_title")}
        </div>
        <label className="dialog-field">
          {t(xbox ? "connect_xbox_address" : "connect_url")}
          <input
            onChange={(e) => setUrl(e.target.value)}
            placeholder={xbox ? "192.168.1.100" : "http://127.0.0.1:32557"}
            ref={input}
            spellCheck={false}
            value={url}
          />
        </label>
        <div className="hint">{t(xbox ? "connect_xbox_hint" : "connect_url_hint")}</div>
        <label className="dialog-check">
          <input checked={fresh} onChange={(e) => setFresh(e.target.checked)} type="checkbox" />
          {t(xbox ? "connect_xbox_fresh" : "connect_fresh")}
        </label>
        <div className="dialog-buttons">
          <button className="primary" disabled={!url.trim()} onClick={submit} type="button">
            {t("connect_button")}
          </button>
          <button onClick={onCancel} type="button">
            {t("common_cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
