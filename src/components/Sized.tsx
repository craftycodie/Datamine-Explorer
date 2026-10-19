import { useEffect, useRef, useState, type ReactNode } from "react";

function stored(key: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// A pane with a drag handle on one side; its size is remembered. With `initial` "fit" it is as tall as its
// content (up to `fitMaximum` of what holds it) until it is dragged, and a double click on the handle
// makes it fit again.
export function Sized({
  axis,
  children,
  fitMaximum = "60%",
  hidden = false,
  initial,
  side,
  storageKey,
}: {
  axis: "x" | "y";
  children: ReactNode;
  fitMaximum?: string;
  // a hidden pane stays mounted and keeps its size for when it comes back
  hidden?: boolean;
  initial: number | "fit";
  // which edge the pane sits on; the handle is on the other one
  side: "end" | "start";
  storageKey: string;
}) {
  const fits = initial === "fit";
  const [size, setSize] = useState<number | undefined>(() => stored(storageKey) ?? (fits ? undefined : (initial as number)));
  const pane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; size: number } | undefined>(undefined);
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const from = size ?? (axis === "x" ? pane.current?.offsetWidth : pane.current?.offsetHeight) ?? 0;
    drag.current = { from: axis === "x" ? e.clientX : e.clientY, size: from };
    const move = (m: MouseEvent) => {
      if (!drag.current) {
        return;
      }
      const delta = (axis === "x" ? m.clientX : m.clientY) - drag.current.from;
      const next = drag.current.size + (side === "end" ? delta : -delta);
      setSize(Math.max(fits ? 60 : 120, Math.min(next, (axis === "x" ? window.innerWidth : window.innerHeight) - 160)));
    };
    const up = () => {
      drag.current = undefined;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("dragging");
    };
    document.body.classList.add("dragging");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  useEffect(() => {
    try {
      if (size === undefined) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, String(size));
      }
    } catch {
      // not kept
    }
  }, [size, storageKey]);
  const divider = hidden ? null : (
    <div className={`divider divider-${axis}`} onDoubleClick={fits ? () => setSize(undefined) : undefined} onMouseDown={onDown} />
  );
  const extent = size === undefined ? { [axis === "x" ? "maxWidth" : "maxHeight"]: fitMaximum } : { [axis === "x" ? "width" : "height"]: size };
  return (
    <>
      {side === "start" && divider}
      <div className={`sized sized-${axis}`} ref={pane} style={{ ...extent, ...(hidden ? { display: "none" } : {}) }}>
        {children}
      </div>
      {side === "end" && divider}
    </>
  );
}
