import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

const THUMB_MINIMUM = 28;

// The scrollbar of the message column when messages are not wrapped. Only that column moves: the
// offset is a CSS variable on the table (--msg-offset) that each row's message text is shifted by, so
// scrolling it changes no React state and no row is drawn again. Shift+wheel and a sideways wheel over
// the table move it too. `total` is the width of the longest message seen.
export function MessageScrollbar({ resetKey, scroller, total }: { resetKey: string; scroller: RefObject<HTMLDivElement | null>; total: number }) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const totalRef = useRef(total);
  totalRef.current = total;

  // sets the variable and the thumb from `offset`, keeping it in range
  const paint = useCallback(() => {
    const element = track.current;
    const handle = thumb.current;
    const table = scroller.current;
    if (!(element && handle && table)) {
      return;
    }
    const visible = element.clientWidth;
    const max = Math.max(0, totalRef.current - visible);
    offset.current = Math.min(max, Math.max(0, offset.current));
    table.style.setProperty("--msg-offset", `${offset.current}px`);
    const width = max > 0 ? Math.min(visible, Math.max(THUMB_MINIMUM, (visible * visible) / totalRef.current)) : visible;
    handle.style.width = `${width}px`;
    handle.style.transform = `translateX(${max > 0 ? (offset.current / max) * (visible - width) : 0}px)`;
    // nothing to scroll to: no bar
    element.style.visibility = max > 0 ? "visible" : "hidden";
  }, [scroller]);

  // after every draw: the widest message or the column's width may have changed
  useLayoutEffect(paint);

  useEffect(() => {
    offset.current = 0;
    paint();
  }, [paint, resetKey]);

  useEffect(() => {
    const element = track.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    return () => observer.disconnect();
  }, [paint]);

  // leaving (wrapping is on again): the messages go back where they were
  useEffect(() => {
    const table = scroller.current;
    return () => {
      table?.style.removeProperty("--msg-offset");
    };
  }, [scroller]);

  // A wheel turned sideways, or turned with shift, scrolls the message column. This listener cannot be passive:
  // it has to stop the table from scrolling.
  useEffect(() => {
    const table = scroller.current;
    if (!table) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      const delta = e.shiftKey ? e.deltaX || e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (delta !== 0) {
        e.preventDefault();
        offset.current += delta;
        paint();
      }
    };
    table.addEventListener("wheel", onWheel, { passive: false });
    return () => table.removeEventListener("wheel", onWheel);
  }, [paint, scroller]);

  const dragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const element = track.current;
    const handle = thumb.current;
    if (!(element && handle)) {
      return;
    }
    const visible = element.clientWidth;
    const max = Math.max(0, totalRef.current - visible);
    if (e.target === handle) {
      // a drag of the thumb moves the text by the ratio of the column to the track
      const room = Math.max(1, visible - handle.offsetWidth);
      const from = offset.current;
      const origin = e.clientX;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      handle.onpointermove = (move) => {
        offset.current = from + ((move.clientX - origin) / room) * max;
        paint();
      };
      handle.onpointerup = handle.onpointercancel = () => {
        handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
        handle.classList.remove("dragging");
      };
      return;
    }
    // a click on the track pages towards it
    const at = e.clientX - element.getBoundingClientRect().left;
    const thumbStart = handle.getBoundingClientRect().left - element.getBoundingClientRect().left;
    offset.current += (at < thumbStart ? -1 : 1) * visible * 0.9;
    paint();
  };

  return (
    <div className="msg-scrollbar">
      <div className="msg-track" onPointerDown={dragStart} ref={track}>
        <div className="msg-thumb" ref={thumb} />
      </div>
    </div>
  );
}
