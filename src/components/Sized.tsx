import { useEffect, useRef, useState, type ReactNode } from "react";

function stored(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

// A pane with a drag handle on one side; its size is remembered.
export function Sized({
  axis,
  children,
  hidden = false,
  initial,
  side,
  storageKey,
}: {
  axis: "x" | "y";
  children: ReactNode;
  // a hidden pane stays mounted and keeps its size for when it comes back
  hidden?: boolean;
  initial: number;
  // which edge the pane sits on; the handle is on the other one
  side: "end" | "start";
  storageKey: string;
}) {
  const [size, setSize] = useState(() => stored(storageKey, initial));
  const drag = useRef<{ from: number; size: number } | undefined>(undefined);
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { from: axis === "x" ? e.clientX : e.clientY, size };
    const move = (m: MouseEvent) => {
      if (!drag.current) {
        return;
      }
      const delta = (axis === "x" ? m.clientX : m.clientY) - drag.current.from;
      const next = drag.current.size + (side === "end" ? delta : -delta);
      setSize(Math.max(120, Math.min(next, (axis === "x" ? window.innerWidth : window.innerHeight) - 160)));
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
      localStorage.setItem(storageKey, String(size));
    } catch {
      // not kept
    }
  }, [size, storageKey]);
  const divider = hidden ? null : <div className={`divider divider-${axis}`} onMouseDown={onDown} />;
  return (
    <>
      {side === "start" && divider}
      <div className="sized" style={{ ...(axis === "x" ? { width: size } : { height: size }), ...(hidden ? { display: "none" } : {}) }}>
        {children}
      </div>
      {side === "end" && divider}
    </>
  );
}
