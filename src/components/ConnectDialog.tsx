import { useEffect, useRef, useState } from "react";
import { KindIcon } from "./FileMenu";

// Asks for an event server's address. The caller remembers the last one used.
export function ConnectDialog({
  initial,
  onCancel,
  onConnect,
}: {
  initial: string;
  onCancel: () => void;
  onConnect: (url: string, fresh: boolean) => void;
}) {
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
        aria-label="Connect to a server"
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
          <KindIcon kind="server" /> Connect to a datamine event server
        </div>
        <label className="dialog-field">
          Server URL
          <input onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:32557" ref={input} spellCheck={false} value={url} />
        </label>
        <div className="hint">The base URL, or the full prefix such as http://host:port/datamine.</div>
        <label className="dialog-check">
          <input checked={fresh} onChange={(e) => setFresh(e.target.checked)} type="checkbox" />
          Don't load earlier entries from this server
        </label>
        <div className="dialog-buttons">
          <button className="primary" disabled={!url.trim()} onClick={submit} type="button">
            Connect
          </button>
          <button onClick={onCancel} type="button">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
