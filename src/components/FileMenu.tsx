import { useMemo } from "react";
import { recentLabel, recentTitle, type RecentItem, type RecentKind } from "../lib/recent";
import { Menu, type MenuEntry } from "./Menu";

const KIND_NAMES: Record<RecentKind, string> = { file: "file", folder: "folder", server: "server" };

export function KindIcon({ kind }: { kind: RecentKind }) {
  const common = { fill: "none", stroke: "currentColor", strokeLinejoin: "round" as const, strokeWidth: 1.2 };
  return (
    <svg aria-label={KIND_NAMES[kind]} className="menu-icon" height="14" role="img" viewBox="0 0 16 16" width="14">
      <title>{KIND_NAMES[kind]}</title>
      {kind === "file" && <path d="M3.5 1.5h5.5l3.5 3.5v9.5h-9z M9 1.5v3.5h3.5" {...common} />}
      {kind === "folder" && <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" {...common} />}
      {kind === "server" && (
        <>
          <circle cx="8" cy="8" r="6.2" {...common} />
          <ellipse cx="8" cy="8" rx="2.8" ry="6.2" {...common} />
          <path d="M1.8 8h12.4 M2.7 5h10.6 M2.7 11h10.6" {...common} />
        </>
      )}
    </svg>
  );
}

export function FileMenu({
  canClose,
  canReload,
  canSaveSession,
  connected,
  onClearRecent,
  onClose,
  onConnect,
  onDisconnect,
  onOpenFile,
  onOpenFolder,
  onRecent,
  onReload,
  onSaveSession,
  recents,
}: {
  canClose: boolean;
  canReload: boolean;
  canSaveSession: boolean;
  connected: boolean;
  onClearRecent: () => void;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onRecent: (item: RecentItem) => void;
  onReload: () => void;
  onSaveSession: () => void;
  recents: RecentItem[];
}) {
  const entries = useMemo(() => {
    const list: MenuEntry[] = [
      { action: { hint: "Ctrl+O", icon: <KindIcon kind="file" />, id: "file", label: "Open File...", run: onOpenFile }, kind: "action" },
      { action: { hint: "Ctrl+Shift+O", icon: <KindIcon kind="folder" />, id: "folder", label: "Open Folder...", run: onOpenFolder }, kind: "action" },
      { action: { hint: "Ctrl+K", icon: <KindIcon kind="server" />, id: "connect", label: "Connect...", run: onConnect }, kind: "action" },
    ];
    if (canSaveSession) {
      list.push({ action: { id: "save-session", label: "Save Session As...", run: onSaveSession }, kind: "action" });
    }
    if (connected) {
      list.push({ action: { id: "disconnect", label: "Disconnect", run: onDisconnect }, kind: "action" });
    }
    if (canReload) {
      list.push({ action: { hint: "F5", id: "reload", label: "Reload", run: onReload }, kind: "action" });
    }
    list.push({ action: { disabled: !canClose, hint: "Ctrl+W", id: "close", label: "Close", run: onClose }, kind: "action" });
    if (recents.length > 0) {
      list.push({ id: "recent-separator", kind: "separator" }, { id: "recent-heading", kind: "heading", label: "Recent" });
      for (const item of recents) {
        list.push({
          action: {
            icon: <KindIcon kind={item.kind} />,
            id: `recent-${item.kind}-${item.target}`,
            label: recentLabel(item),
            run: () => onRecent(item),
            title: recentTitle(item),
          },
          kind: "action",
        });
      }
      list.push({ id: "clear-separator", kind: "separator" }, { action: { id: "clear", label: "Clear recent", run: onClearRecent }, kind: "action" });
    }
    return list;
  }, [canClose, canReload, canSaveSession, connected, onClearRecent, onClose, onConnect, onDisconnect, onOpenFile, onOpenFolder, onRecent, onReload, onSaveSession, recents]);

  return <Menu entries={entries} id="file" label="File" />;
}
