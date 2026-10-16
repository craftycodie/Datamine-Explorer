import { useLayoutEffect, useRef, type ReactNode } from "react";
import { backend } from "../lib/backend";
import type { RecentKind } from "../lib/recent";
import { KindIcon } from "./FileMenu";
import { WindowControls, useWindowState } from "./WindowControls";

// A button that shows or hides a side pane; pressed while the pane is shown.
function PaneToggle({ onToggle, shortcut, shown, side }: { onToggle: () => void; shortcut: string; shown: boolean; side: "left" | "right" }) {
  return (
    <button
      aria-label={`${side} pane`}
      aria-pressed={shown}
      className={shown ? "icon-toggle on" : "icon-toggle"}
      onClick={onToggle}
      title={`${shown ? "Hide" : "Show"} the ${side} pane (${shortcut})`}
      type="button"
    >
      <svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
        <rect fill="none" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" width="13" x="1.5" y="2.5" />
        <rect fill={shown ? "currentColor" : "none"} height="11" stroke="currentColor" strokeWidth="1.2" width="4.5" x={side === "left" ? 1.5 : 10} y="2.5" />
      </svg>
    </button>
  );
}

function InfoIcon() {
  return (
    <svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
      <circle cx="8" cy="8" fill="none" r="6.3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 7.2v4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <circle cx="8" cy="4.9" fill="currentColor" r="0.95" />
    </svg>
  );
}

export function Toolbar({
  canSave,
  connected,
  label,
  leftShown,
  menus,
  onAbout,
  onDisconnect,
  onLeftToggle,
  onRightToggle,
  onSave,
  rightShown,
}: {
  // a session can be saved
  canSave: boolean;
  // a server is connected
  connected: boolean;
  // what is open, by name; the full path or URL is its tooltip
  label?: { kind: RecentKind; name: string; title: string };
  leftShown: boolean;
  // the File and View menus, after the app's name
  menus: ReactNode;
  onAbout: () => void;
  onDisconnect: () => void;
  onLeftToggle: () => void;
  onRightToggle: () => void;
  onSave: () => void;
  rightShown: boolean;
}) {
  // In the desktop app the window has no frame of its own: this bar is its title bar.
  const desktop = backend.kind === "tauri";
  // macOS keeps its own traffic lights (tauri.macos.conf.json), drawn over the left of this bar
  const mac = desktop && navigator.userAgent.includes("Macintosh");
  const { focused, maximized } = useWindowState();
  // Where the attribute is clicked itself it drags the window, and a double click maximizes it. "deep" also
  // takes the clicks on what is inside, which the title needs.
  const drag = desktop ? { "data-tauri-drag-region": "" } : {};
  const dragDeep = desktop ? { "data-tauri-drag-region": "deep" } : {};
  const bar = useRef<HTMLDivElement>(null);
  const leftGroup = useRef<HTMLDivElement>(null);
  const rightGroup = useRef<HTMLDivElement>(null);
  // The two outer cells are as wide as the wider of the two groups, so the title between them is
  // centred in the window whatever each side holds, and gives way before it touches either.
  useLayoutEffect(() => {
    const set = () => {
      const side = Math.max(leftGroup.current?.offsetWidth ?? 0, rightGroup.current?.offsetWidth ?? 0);
      bar.current?.style.setProperty("--toolbar-side", `${side}px`);
    };
    set();
    const observer = new ResizeObserver(set);
    for (const group of [leftGroup.current, rightGroup.current]) {
      if (group) {
        observer.observe(group);
      }
    }
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`toolbar${desktop ? " desktop" : ""}${mac ? " mac" : ""}${desktop && !focused ? " inactive" : ""}`} ref={bar} {...drag}>
      <div className="toolbar-left" {...drag}>
        <div className="toolbar-group" ref={leftGroup} {...drag}>
        <button aria-label="About Datamine Explorer" className="toolbar-brand" onClick={onAbout} title="About Datamine Explorer" type="button">
          <img alt="" className="app-icon" draggable={false} height="22" src={`${import.meta.env.BASE_URL}app-icon.svg`} width="22" />
        </button>
        {menus}
        {connected && (
          <button onClick={onDisconnect} type="button">
            Disconnect
          </button>
        )}
        {canSave && (
          <button onClick={onSave} type="button">
            Save as...
          </button>
        )}
        </div>
      </div>
      {label ? (
        <div className="toolbar-title" title={label.title} {...dragDeep}>
          <KindIcon kind={label.kind} />
          <span>{label.name}</span>
        </div>
      ) : (
        // nothing open: the app's own name takes the middle
        <div className="toolbar-title" {...dragDeep}>
          <span>Datamine Explorer</span>
        </div>
      )}
      <div className="toolbar-right" {...drag}>
      <div className="toolbar-group" ref={rightGroup} {...drag}>
      <button aria-label="About" className="icon-toggle" onClick={onAbout} title="About Datamine Explorer" type="button">
        <InfoIcon />
      </button>
      <PaneToggle onToggle={onLeftToggle} shortcut="Ctrl+B" shown={leftShown} side="left" />
      <PaneToggle onToggle={onRightToggle} shortcut="Ctrl+Alt+B" shown={rightShown} side="right" />
      {desktop && !mac && <WindowControls maximized={maximized} />}
      </div>
      </div>
    </div>
  );
}
