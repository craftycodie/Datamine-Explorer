import { useMemo } from "react";
import { backend } from "../lib/backend";
import { recentLabel, recentTitle, type RecentItem, type RecentKind } from "../lib/recent";
import { useT } from "../localization";
import { Menu, type MenuEntry } from "./Menu";

// what can be open: the recent kinds, and several sources together
export type IconKind = RecentKind | "sources";

export function KindIcon({ kind }: { kind: IconKind }) {
  const t = useT();
  const common = { fill: "none", stroke: "currentColor", strokeLinejoin: "round" as const, strokeWidth: 1.2 };
  const name = t(`kind_${kind}`);
  return (
    <svg aria-label={name} className="menu-icon" height="14" role="img" viewBox="0 0 16 16" width="14">
      <title>{name}</title>
      {kind === "file" && <path d="M3.5 1.5h5.5l3.5 3.5v9.5h-9z M9 1.5v3.5h3.5" {...common} />}
      {kind === "folder" && <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" {...common} />}
      {kind === "sources" && <path d="M5.5 1.5h5l2.5 2.5v7.5h-7.5z M3 4v10.5h7.5" {...common} />}
      {kind === "console" && (
        // an Xbox 360 standing up: the tower with its pinched sides, the ring of light and the disc slot
        <>
          <path d="M4.3 1.5h7.4q-1.2 6.5 0 13h-7.4q1.2-6.5 0-13z" {...common} />
          <circle cx="8" cy="4.2" r="1.25" {...common} />
          <path d="M6.6 7v5.6" {...common} />
        </>
      )}
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
  onConnectXbox,
  onDisconnect,
  onOpenFile,
  onOpenFolder,
  onOpenMultiple,
  onRecent,
  onRecentRemove,
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
  onConnectXbox: () => void;
  onDisconnect: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenMultiple: () => void;
  onRecent: (item: RecentItem) => void;
  onRecentRemove: (item: RecentItem) => void;
  onReload: () => void;
  onSaveSession: () => void;
  recents: RecentItem[];
}) {
  const t = useT();
  const entries = useMemo(() => {
    const list: MenuEntry[] = [
      { action: { hint: "Ctrl+O", icon: <KindIcon kind="file" />, id: "file", label: t("file_open_file"), run: onOpenFile }, kind: "action" },
      { action: { hint: "Ctrl+Shift+O", icon: <KindIcon kind="folder" />, id: "folder", label: t("file_open_folder"), run: onOpenFolder }, kind: "action" },
      { action: { hint: "Ctrl+K", icon: <KindIcon kind="server" />, id: "connect", label: t("file_connect"), run: onConnect }, kind: "action" },
      {
        action: {
          // the console's debug connection is a raw socket, which only the desktop app can open
          disabled: backend.kind !== "tauri",
          hint: "Ctrl+Shift+K",
          icon: <KindIcon kind="console" />,
          id: "connect-xbox",
          label: t("file_connect_xbox"),
          run: onConnectXbox,
          title: backend.kind === "tauri" ? undefined : t("xbox_desktop_only"),
        },
        kind: "action",
      },
      { action: { icon: <KindIcon kind="sources" />, id: "multiple", label: t("file_open_multiple"), run: onOpenMultiple }, kind: "action" },
    ];
    if (canSaveSession) {
      list.push({ action: { id: "save-session", label: t("file_save_session"), run: onSaveSession }, kind: "action" });
    }
    if (connected) {
      list.push({ action: { id: "disconnect", label: t("file_disconnect"), run: onDisconnect }, kind: "action" });
    }
    if (canReload) {
      list.push({ action: { hint: "F5", id: "reload", label: t("file_reload"), run: onReload }, kind: "action" });
    }
    list.push({ action: { disabled: !canClose, hint: "Ctrl+W", id: "close", label: t("file_close"), run: onClose }, kind: "action" });
    if (recents.length > 0) {
      list.push({ id: "recent-separator", kind: "separator" }, { id: "recent-heading", kind: "heading", label: t("recent_heading") });
      for (const item of recents) {
        list.push({
          action: {
            icon: <KindIcon kind={item.kind} />,
            id: `recent-${item.kind}-${item.target}`,
            label: recentLabel(item),
            remove: { label: t("recent_remove"), run: () => onRecentRemove(item) },
            run: () => onRecent(item),
            title: recentTitle(item),
          },
          kind: "action",
        });
      }
      list.push({ id: "clear-separator", kind: "separator" }, { action: { id: "clear", label: t("file_clear_recent"), run: onClearRecent }, kind: "action" });
    }
    return list;
  }, [canClose, canReload, canSaveSession, connected, onClearRecent, onClose, onConnect, onConnectXbox, onDisconnect, onOpenFile, onOpenFolder, onOpenMultiple, onRecent, onRecentRemove, onReload, onSaveSession, recents, t]);

  return <Menu entries={entries} id="file" label={t("file_menu")} />;
}
