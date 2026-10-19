import { recentLabel, recentTitle, type RecentItem } from "../lib/recent";
import { useT } from "../localization";
import { KindIcon } from "./FileMenu";

// The recent files, folders and servers as a list of buttons, each with a cross on the right that shows
// on hover and takes it off the list. `nicknames` shows what each was called among several sources.
export function RecentList({
  className,
  items,
  nicknames = false,
  onOpen,
  onRemove,
}: {
  className?: string;
  items: RecentItem[];
  nicknames?: boolean;
  onOpen: (item: RecentItem) => void;
  onRemove: (item: RecentItem) => void;
}) {
  const t = useT();
  if (items.length === 0) {
    return null;
  }
  return (
    <div className={`recent-list${className ? ` ${className}` : ""}`}>
      <div className="dim">{t("recent_heading")}</div>
      {items.map((item) => (
        <div className="recent-row" key={`${item.kind}-${item.target}`}>
          <button className="recent-open" onClick={() => onOpen(item)} title={recentTitle(item, nicknames)} type="button">
            <KindIcon kind={item.kind} />
            {nicknames && item.nickname && <span className="recent-nickname">{item.nickname}</span>}
            <span className="recent-label">{recentLabel(item)}</span>
          </button>
          <button aria-label={t("recent_remove")} className="item-remove" onClick={() => onRemove(item)} title={t("recent_remove")} type="button">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
