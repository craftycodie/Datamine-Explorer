import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { backend } from "../lib/backend";
import { useT } from "../localization";

// Whether the desktop window is maximized and has focus. A browser tab is neither managed nor drawn, so it
// reads as focused and not maximized.
export function useWindowState(): { focused: boolean; maximized: boolean } {
  const [focused, setFocused] = useState(true);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (backend.kind !== "tauri") {
      return;
    }
    const win = getCurrentWindow();
    let gone = false;
    const offs: Array<() => void> = [];
    const keep = (off: () => void) => (gone ? off() : offs.push(off));
    const maximizedRead = () => {
      void win.isMaximized().then((on) => !gone && setMaximized(on), () => undefined);
    };
    maximizedRead();
    void win.isFocused().then((on) => !gone && setFocused(on), () => undefined);
    void win.onResized(maximizedRead).then(keep);
    void win.onFocusChanged((event) => setFocused(event.payload)).then(keep);
    return () => {
      gone = true;
      for (const off of offs) {
        off();
      }
    };
  }, []);
  return { focused, maximized };
}

// Windows 11 style caption glyphs, 10px on a 46px wide button.
function Glyph({ kind }: { kind: "close" | "maximize" | "minimize" | "restore" }) {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 1 };
  return (
    <svg aria-hidden="true" height="10" viewBox="0 0 10 10" width="10">
      {kind === "minimize" && <path d="M0 5.5h10" {...line} />}
      {kind === "maximize" && <rect height="9" rx="1.5" width="9" x="0.5" y="0.5" {...line} />}
      {kind === "restore" && (
        <>
          <path d="M2.5 2.5v-0.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-0.5" {...line} />
          <rect height="6.5" rx="1.5" width="6.5" x="0.5" y="3" {...line} />
        </>
      )}
      {kind === "close" && <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" {...line} />}
    </svg>
  );
}

export function WindowControls({ maximized }: { maximized: boolean }) {
  const t = useT();
  const win = getCurrentWindow();
  const resize = t(maximized ? "window_restore" : "window_maximize");
  return (
    <div className="window-controls">
      <button aria-label={t("window_minimize")} className="caption" onClick={() => void win.minimize()} tabIndex={-1} title={t("window_minimize")} type="button">
        <Glyph kind="minimize" />
      </button>
      <button
        aria-label={resize}
        className="caption"
        onClick={() => void win.toggleMaximize()}
        tabIndex={-1}
        title={resize}
        type="button"
      >
        <Glyph kind={maximized ? "restore" : "maximize"} />
      </button>
      <button aria-label={t("common_close")} className="caption close" onClick={() => void win.close()} tabIndex={-1} title={t("common_close")} type="button">
        <Glyph kind="close" />
      </button>
    </div>
  );
}
