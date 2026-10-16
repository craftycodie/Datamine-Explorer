import type { LiveStatus } from "../lib/types";

// The status bar's marker for a server connection.
export function LiveBadge({ live }: { live?: LiveStatus }) {
  const state = live?.state ?? "connecting";
  return (
    <span className={`live-badge ${state}`}>
      {state === "closed" ? "○" : "●"} {state}
    </span>
  );
}
