import { useEffect, useState } from "react";
import { BUILD_INFO } from "../build-info";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function timestampText(date: Date): string {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// A faint note in the bottom right corner, above the status bar, of every build that is not a release: which
// build it is and the local time, so that a screenshot says where it came from. It takes no clicks. With the right
// pane hidden the corner is the table's, so it keeps clear of the table's scrollbar (`overTable`).
export function PreReleaseWatermark({ overTable = false }: { overTable?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div aria-hidden="true" className={overTable ? "pre-release-watermark over-table" : "pre-release-watermark"}>
      <div className="pre-release-watermark-title">PRE-RELEASE BUILD</div>
      <div className="pre-release-watermark-meta">{BUILD_INFO.buildString}</div>
      <div className="pre-release-watermark-meta">{timestampText(now)}</div>
    </div>
  );
}
