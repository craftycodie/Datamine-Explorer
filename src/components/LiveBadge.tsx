import type { LiveStatus } from "../lib/types";
import { useT } from "../localization";

// The status bar's marker for a server connection.
export function LiveBadge({ live }: { live?: LiveStatus }) {
  const t = useT();
  const state = live?.state ?? "connecting";
  return (
    <span className={`live-badge ${state}`}>
      {state === "closed" ? "○" : "●"} {t(`live_${state}`)}
    </span>
  );
}
