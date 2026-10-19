import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { COLUMN_IDS, COLUMN_MAXIMUM, COLUMN_MINIMUMS, type ColumnId, type Columns, columnVariables, gridMinimum, SOURCE_COLUMN_IDS, widthClamp } from "../lib/columns";
import { dateTimeText, timeColumnText } from "../lib/format";
import { RowHeights } from "../lib/row-heights";
import type { RowSource } from "../lib/rows";
import { rangesHas, type SelectModifiers, type Selection } from "../lib/selection";
import { LEVEL_NAMES, type LogEntry } from "../lib/types";
import type { DividerResult } from "../worker/protocol";
import { ContextMenu } from "./ContextMenu";
import { Highlight } from "./Highlight";
import { MessageScrollbar } from "./MessageScrollbar";
import { useT } from "../localization";

// One line of text; a row is this tall until it is measured to be taller.
const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 22;
const OVERSCAN = 12;
// How many rows beyond the window to fetch ahead of the scroll.
const FETCH_MARGIN = 60;
// Browsers stop growing an element somewhere past 30 million pixels, so a very long table scrolls
// a shorter spacer: the thumb position stands for a row instead of a pixel.
const SCROLL_HEIGHT_MAXIMUM = 8_000_000;
const LEVEL_SHORT = ["VERB", "STAT", "MSG", "WARN", "ERR", "CRIT"];
const TEXT_LIMIT = 1500;
// With wrapping off the message column scrolls sideways over the longest message shown, up to this wide.
const MESSAGE_WIDTH_MAXIMUM = 20_000;
// A jump to a row is repeated this many times as the rows around it are measured.
const JUMP_PASSES = 4;
// Scrolls this soon after a wheel turn are the wheel's (smooth scrolling spreads one turn out).
const WHEEL_SETTLE_MS = 500;


// The text a column shows for an entry, for fitting its width.
function cellText(id: ColumnId, entry: LogEntry): string {
  switch (id) {
    case "time":
      return timeColumnText(entry.timeText);
    case "index":
      return String(entry.eventIndex ?? entry.ordinal);
    case "level":
      return levelShort(entry);
    case "category":
      return entry.category;
    case "source":
      return entry.source ?? "";
  }
}

// The level badge's text.
function levelShort(entry: LogEntry): string {
  return LEVEL_SHORT[entry.level] ?? (entry.levelText || "?").slice(0, 4).toUpperCase();
}

// What a row shows as its message when it is not wrapped: one line, whole (a message cut short by the
// worker ends in an ellipsis).
function messageLine(entry: LogEntry): string {
  const line = entry.message.replace(/\r?\n/g, " ");
  return entry.truncated ? `${line}...` : line;
}

export interface ScrollRequest {
  // position in the filtered rows
  row: number;
  // changes on every request, so the same row can be asked for twice
  nonce: number;
}

function Divider({ entry }: { entry: LogEntry }) {
  const t = useT();
  const session = entry.session;
  return (
    <>
      {entry.source && <span className="divider-source">{entry.source}</span>}
      <span className="divider-title">{t("divider_session", { number: session?.number ?? "" })}</span>
      <span className="divider-version">{session?.version}</span>
      {session?.sessionId && <span className="divider-id">{session.sessionId}</span>}
      <span className="divider-time">{entry.time ? dateTimeText(entry.time) : ""}</span>
    </>
  );
}

// Dividers are drawn this tall; the pinned one is pushed up by the next as it comes under it.
const PIN_HEIGHT = ROW_HEIGHT;

function modifiersOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelectModifiers {
  return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
}

export function LogTable({
  columns,
  count,
  follow,
  highlight,
  onCopy,
  onFollowBreak,
  onFollowResume,
  onSelectAll,
  onSelectRow,
  rows,
  scrollRequest,
  selected,
  selectedRow,
  selection,
  sessionKey,
  showSource,
  viewVersion,
  wrap,
}: {
  columns: Columns;
  count: number;
  follow: boolean;
  highlight?: RegExp;
  // copy what is selected: the original lines, or just the messages
  onCopy: (mode: "raw" | "message") => void;
  onFollowBreak: () => void;
  // the user scrolled back down to the end
  onFollowResume: () => void;
  onSelectAll: () => void;
  // a row was clicked or moved to with the keys; `entry` is its content when it is loaded
  onSelectRow: (row: number, entry: LogEntry | undefined, modifiers: SelectModifiers) => void;
  rows: RowSource;
  scrollRequest?: ScrollRequest;
  // the focused entry's id, and the view row it is on (-1 when the filters hide it)
  selected?: number;
  selectedRow: number;
  // every selected entry, which includes the focused one
  selection: Selection;
  // changes when another file or connection is shown; what was learned of its widest message is dropped
  sessionKey: string;
  // several sources are open: each row says which it came from
  showSource: boolean;
  // changes when the rows move (filters, search), which makes every measured height stale
  viewVersion: number;
  // long messages take several lines
  wrap: boolean;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const columnIds = (showSource ? SOURCE_COLUMN_IDS : COLUMN_IDS).filter((id) => columns.shown(id));
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  // the widest message seen since the file was opened, which only grows
  const [messageWidth, setMessageWidth] = useState(0);
  const widest = useRef(0);
  const measureContext = useRef<CanvasRenderingContext2D | null>(null);
  // measured heights, by view row; bumped when they change so the rows are laid out again
  const heights = useRef(new RowHeights(ROW_HEIGHT));
  const [, setLayout] = useState(0);
  const stateKey = useRef({ viewVersion, wrap });
  // a jump that is still settling while the rows around its target are measured
  const jump = useRef<{ row: number; align: "center" | "nearest"; passes: number } | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  // the divider pinned under the header, worked out for the row `asked` of the view `version`
  const [pin, setPin] = useState<(DividerResult & { asked: number; version: number }) | undefined>();

  if (stateKey.current.viewVersion !== viewVersion || stateKey.current.wrap !== wrap) {
    stateKey.current = { viewVersion, wrap };
    heights.current.clear();
  }
  const model = wrap ? heights.current : undefined;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const measure = () => setHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // rows are measured again when the table or a column changes width, as their text wraps differently
  const relayoutQueued = useRef(false);
  const rowObserver = useRef<ResizeObserver | undefined>(undefined);
  if (!rowObserver.current && typeof ResizeObserver !== "undefined") {
    rowObserver.current = new ResizeObserver(() => {
      if (!relayoutQueued.current) {
        relayoutQueued.current = true;
        requestAnimationFrame(() => {
          relayoutQueued.current = false;
          setLayout((n) => n + 1);
        });
      }
    });
  }
  useEffect(() => () => rowObserver.current?.disconnect(), []);
  const rowRef = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      rowObserver.current?.observe(element);
      return () => rowObserver.current?.unobserve(element);
    }
  }, []);

  const bodyHeight = Math.max(ROW_HEIGHT, height - HEADER_HEIGHT);
  const visible = Math.max(1, Math.floor(bodyHeight / ROW_HEIGHT));
  const scaled = count * ROW_HEIGHT > SCROLL_HEIGHT_MAXIMUM;
  const naturalHeight = model ? model.total(count) : count * ROW_HEIGHT;
  const spacer = scaled ? SCROLL_HEIGHT_MAXIMUM : naturalHeight;
  const scrollable = Math.max(1, spacer - bodyHeight);
  const lastFirst = Math.max(0, count - visible);
  const atEnd = scaled && scrollTop >= scrollable - 1;

  // --- which rows are drawn, and where

  let first: number;
  if (scaled) {
    first = Math.min(lastFirst, Math.round((scrollTop / scrollable) * lastFirst));
  } else {
    first = model ? model.rowAt(scrollTop, count) : Math.floor(scrollTop / ROW_HEIGHT);
  }
  // in a scaled table the rows are laid out from an anchor row: the first one shown, or the end of the table
  let anchorRow = first;
  let anchorTop = scrollTop;
  if (atEnd && model) {
    let sum = 0;
    let at = count;
    while (at > 0 && sum < bodyHeight) {
      at--;
      sum += model.get(at);
    }
    anchorRow = at;
    anchorTop = scrollTop + bodyHeight - sum;
    first = at;
  }
  const heightOf = (row: number) => (model ? model.get(row) : ROW_HEIGHT);
  const topOf = (row: number): number => {
    if (!scaled) {
      return model ? model.top(row) : row * ROW_HEIGHT;
    }
    let top = anchorTop;
    if (row >= anchorRow) {
      for (let at = anchorRow; at < row; at++) {
        top += heightOf(at);
      }
    } else {
      for (let at = row; at < anchorRow; at++) {
        top -= heightOf(at);
      }
    }
    return top;
  };
  const start = Math.max(0, first - OVERSCAN);
  let end = first;
  for (let y = topOf(first); end < count && y < scrollTop + bodyHeight; end++) {
    y += heightOf(end);
  }
  end = Math.min(count, end + OVERSCAN + 1);

  // the scroll position at which `row` is the first one shown
  const scrollFor = (row: number) => (scaled ? (Math.min(row, lastFirst) / Math.max(1, lastFirst)) * scrollable : topOf(row));

  const scrollSet = (top: number) => {
    const element = scroller.current;
    if (element) {
      element.scrollTop = Math.max(0, top);
    }
  };

  const scrollToRow = (row: number, align: "center" | "nearest") => {
    if (scaled) {
      if (align === "center") {
        // the first row to show is the one that puts the target's middle in the middle of the view
        let reach = heightOf(row) / 2;
        let at = row;
        while (at > 0 && reach < bodyHeight / 2) {
          at--;
          reach += heightOf(at);
        }
        scrollSet(scrollFor(at));
      } else if (row < first) {
        scrollSet(scrollFor(row));
      } else if (row >= first + visible - 1) {
        scrollSet(scrollFor(row - visible + 2));
      }
      return;
    }
    const top = topOf(row);
    const rowHeight = heightOf(row);
    if (align === "center") {
      scrollSet(top - bodyHeight / 2 + rowHeight / 2);
    } else if (top < scrollTop) {
      scrollSet(top);
    } else if (top + rowHeight > scrollTop + bodyHeight) {
      scrollSet(top + rowHeight - bodyHeight);
    }
  };

  // --- measuring: after every draw the rows on screen are read, and what differs from the model is
  // corrected before the browser paints. Rows that grew above the top of the view push the scroll
  // position by as much, so what is on screen stays where it is.

  useLayoutEffect(() => {
    const element = scroller.current;
    const container = body.current;
    if (!(model && element && container)) {
      return;
    }
    const measured: { row: number; height: number }[] = [];
    for (const child of container.children) {
      const row = Number((child as HTMLElement).dataset.row);
      if (Number.isFinite(row) && row < count) {
        measured.push({ height: (child as HTMLElement).offsetHeight, row });
      }
    }
    // where the rows were, before anything is corrected
    const before = measured.map(({ row }) => ({ bottom: topOf(row) + model.get(row), row }));
    let shift = 0;
    let changed = false;
    measured.forEach(({ height: measuredHeight, row }, k) => {
      const delta = model.set(row, measuredHeight);
      if (delta !== 0) {
        changed = true;
        if (!scaled && before[k].bottom <= scrollTop) {
          shift += delta;
        }
      }
    });
    if (changed) {
      if (shift !== 0 && !follow) {
        element.scrollTop = scrollTop + shift;
        setScrollTop(element.scrollTop);
      }
      setLayout((n) => n + 1);
      return;
    }
    // a jump that has not settled yet is made again now that the rows around it are known
    const pending = jump.current;
    if (pending && pending.passes > 0) {
      pending.passes--;
      scrollToRow(pending.row, pending.align);
    } else {
      jump.current = undefined;
    }
  });

  useEffect(() => {
    rows.ensure(start - FETCH_MARGIN, end + FETCH_MARGIN);
  }, [rows, rows.version, start, end]);

  useEffect(() => {
    widest.current = 0;
    setMessageWidth(0);
  }, [sessionKey]);

  // With wrapping off, the rows on screen are measured with the table's own font; the widest so far is how far
  // the message column scrolls (the scrollbar under it, shift+wheel).
  useLayoutEffect(() => {
    const element = scroller.current;
    if (wrap || !element) {
      return;
    }
    measureContext.current ??= document.createElement("canvas").getContext("2d");
    const context = measureContext.current;
    if (!context) {
      return;
    }
    context.font = getComputedStyle(element).font;
    let needed = widest.current;
    for (let row = start; row < end; row++) {
      const entry = rows.get(row);
      if (entry && entry.kind !== "session") {
        needed = Math.max(needed, Math.ceil(context.measureText(messageLine(entry)).width) + 2);
      }
    }
    needed = Math.min(MESSAGE_WIDTH_MAXIMUM, needed);
    if (needed > widest.current) {
      widest.current = needed;
      setMessageWidth(needed);
    }
  });

  // The pinned divider is asked for when the first row leaves the span the last answer covers. Several
  // sources have sessions of their own side by side, so none is pinned then.
  useEffect(() => {
    if (count === 0 || showSource) {
      setPin(undefined);
      return;
    }
    const same = pin && pin.version === viewVersion && pin.count === count && pin.asked === first;
    const inside =
      pin && pin.version === viewVersion && first >= Math.max(0, pin.row) && first < pin.next && !(pin.next >= pin.count && pin.count !== count);
    if (same || inside) {
      return;
    }
    let current = true;
    void rows.divider(first).then((answer) => current && answer && setPin({ ...answer, asked: first, version: viewVersion }));
    return () => {
      current = false;
    };
  }, [count, first, pin, rows, showSource, viewVersion]);

  useEffect(() => {
    if (pin && pin.row >= 0) {
      rows.ensure(pin.row, pin.row + 1);
    }
  }, [pin, rows, rows.version]);

  const spacerHeight = model ? model.total(count) : count * ROW_HEIGHT;
  useLayoutEffect(() => {
    if (follow && count > 0) {
      const element = scroller.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }
    // rows above the end that grow (or are measured) keep it pinned to the bottom
  }, [follow, count, spacerHeight]);

  useEffect(() => {
    if (scrollRequest) {
      const request = { align: "center" as const, passes: JUMP_PASSES, row: scrollRequest.row };
      jump.current = request;
      scrollToRow(request.row, request.align);
    }
    // only a new request should scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  const closeMenu = useCallback(() => setMenu(undefined), []);

  // --- following: scrolling up lets go of the tail, a wheel or a scrollbar drag back down to the end picks it up

  const wheelAt = useRef(0);
  const scrollbarHeld = useRef(false);
  useEffect(() => {
    const release = () => {
      scrollbarHeld.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("blur", release);
    };
  }, []);

  const atBottom = (element: HTMLElement) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    scrollbarHeld.current = e.target === element && e.nativeEvent.offsetX >= element.clientWidth;
    onFollowBreak();
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      onFollowBreak();
    } else if (e.deltaY > 0) {
      wheelAt.current = performance.now();
      // already at the end, there is no scroll to wait for
      if (!follow && atBottom(e.currentTarget)) {
        onFollowResume();
      }
    }
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    setScrollTop(element.scrollTop);
    // only the user's own scrolling counts; jumps and row measuring scroll too
    const byUser = scrollbarHeld.current || performance.now() - wheelAt.current < WHEEL_SETTLE_MS;
    if (byUser && follow !== atBottom(element)) {
      // a drag can reach the end and go back up again before it lets go
      (follow ? onFollowBreak : onFollowResume)();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: visible - 1, PageUp: 1 - visible }[e.key];
    let target: number | undefined;
    if (step !== undefined) {
      target = Math.max(0, Math.min(count - 1, (selectedRow < 0 ? first : selectedRow) + (selectedRow < 0 ? 0 : step)));
    } else if (e.key === "Home") {
      target = 0;
    } else if (e.key === "End") {
      // End is also the global "jump to tail"; the app handles it. With shift it extends the selection to the last row.
      if (!e.shiftKey) {
        return;
      }
      target = count - 1;
    }
    if (target !== undefined && count > 0) {
      e.preventDefault();
      onFollowBreak();
      // an arrow key is a click on the row moved to; shift extends from the anchor
      onSelectRow(target, rows.get(target), { ctrl: false, shift: e.shiftKey });
      scrollToRow(target, "nearest");
    }
  };

  // --- column widths: a drag sets the variables on the root, the mouse-up keeps the width

  const dragStart = (id: ColumnId, e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const element = scroller.current;
    const handle = e.currentTarget;
    if (!element) {
      return;
    }
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const origin = e.clientX;
    const from = columns.widths[id];
    let width = from;
    handle.onpointermove = (move) => {
      width = widthClamp(id, from + move.clientX - origin);
      element.style.setProperty(`--col-${id}`, `${width}px`);
      element.style.setProperty("--grid-min", `${gridMinimum({ ...columns.widths, [id]: width }, columnIds)}px`);
    };
    handle.onpointerup = handle.onpointercancel = () => {
      handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
      handle.classList.remove("dragging");
      columns.set(id, width);
    };
  };

  // The widest cell in view, measured with the table's own font.
  const fit = (id: ColumnId) => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    const context = document.createElement("canvas").getContext("2d");
    if (!context) {
      return;
    }
    context.font = getComputedStyle(element).font;
    let widest = context.measureText(t(`column_${id}`)).width;
    for (let row = first; row < Math.min(count, first + visible + 1); row++) {
      const entry = rows.get(row);
      if (entry && entry.kind !== "session") {
        widest = Math.max(widest, context.measureText(cellText(id, entry)).width);
      }
    }
    // the level badge has its own padding and a minimum width
    const padding = id === "level" ? 12 : 4;
    columns.set(id, Math.min(COLUMN_MAXIMUM, Math.max(COLUMN_MINIMUMS[id], Math.ceil(widest) + padding)));
  };

  // a click selects, a right click selects what is not selected yet and opens the menu
  const rowEvents = (row: number, entry: LogEntry) => ({
    onClick: (e: React.MouseEvent) => onSelectRow(row, entry, modifiersOf(e)),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      if (!rangesHas(selection.ranges, entry.ordinal)) {
        onSelectRow(row, entry, { ctrl: false, shift: false });
      }
      setMenu({ x: e.clientX, y: e.clientY });
    },
  });
  const classesOf = (entry: LogEntry): string[] => {
    const classes = ["log-row", "log-grid"];
    if (entry.kind === "session") {
      classes.push("divider");
    }
    const picked = rangesHas(selection.ranges, entry.ordinal);
    if (entry.ordinal === selected) {
      classes.push(picked ? "selected" : "focused");
    } else if (picked) {
      classes.push("picked");
    }
    return classes;
  };

  const items = [];
  for (let row = start; row < end; row++) {
    const entry = rows.get(row);
    const style: React.CSSProperties = { transform: `translateY(${topOf(row)}px)` };
    const fixed = !model || !entry || entry.kind === "session";
    if (fixed) {
      style.height = ROW_HEIGHT;
    }
    if (!entry) {
      items.push(<div className="log-row log-grid loading" data-row={row} key={row} ref={rowRef} style={style} />);
      continue;
    }
    const classes = classesOf(entry);
    if (entry.matched) {
      classes.push("matched");
    }
    if (entry.level >= 4) {
      classes.push("severe");
    }
    if (entry.kind === "session") {
      items.push(
        <div className={classes.join(" ")} data-row={row} key={row} {...rowEvents(row, entry)} ref={rowRef} style={style}>
          <Divider entry={entry} />
        </div>
      );
      continue;
    }
    const message = wrap ? (entry.message.length > TEXT_LIMIT ? `${entry.message.slice(0, TEXT_LIMIT)}...` : entry.message) : messageLine(entry);
    items.push(
      <div className={classes.join(" ")} data-row={row} key={row} {...rowEvents(row, entry)} ref={rowRef} style={style}>
        {showSource && columns.shown("source") && (
          <span className="cell-source" title={entry.source}>
            {entry.source}
          </span>
        )}
        {columns.shown("time") && <span className="cell-time">{timeColumnText(entry.timeText)}</span>}
        {columns.shown("index") && <span className="cell-index">{entry.eventIndex ?? entry.ordinal}</span>}
        <span>
          <span className={`badge level-${entry.level}`} title={entry.level >= 0 ? t(`level_${LEVEL_NAMES[entry.level]}`) : entry.levelText}>
            {levelShort(entry)}
          </span>
        </span>
        <span className="cell-category" title={entry.category}>
          <Highlight pattern={highlight} text={entry.category} />
        </span>
        <span className="cell-message">
          <span className="msg-text">
            <Highlight pattern={highlight} text={message} />
          </span>
        </span>
      </div>
    );
  }

  // the divider of the session scrolled into, once its real one is above the top
  let pinned: React.ReactNode = null;
  if (pin && pin.version === viewVersion && pin.row >= 0 && first >= pin.row && first < pin.next) {
    const entry = rows.get(pin.row);
    const realAtTop = pin.row === first && topOf(first) >= scrollTop;
    // the next divider coming up under the header pushes it out
    const push = pin.next < end ? Math.min(0, topOf(pin.next) - scrollTop - PIN_HEIGHT) : 0;
    if (entry && !realAtTop && push > -PIN_HEIGHT) {
      pinned = (
        <div className="log-pin">
          <div
            className={`${classesOf(entry).join(" ")} pinned`}
            {...rowEvents(pin.row, entry)}
            style={{ height: PIN_HEIGHT, transform: `translateY(${push}px)` }}
          >
            <Divider entry={entry} />
          </div>
        </div>
      );
    }
  }

  return (
    <div
      className={wrap ? "logtable wrap" : "logtable"}
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onMouseDown={() => window.getSelection()?.removeAllRanges()}
      onPointerDown={onPointerDown}
      onScroll={onScroll}
      onWheel={onWheel}
      ref={scroller}
      style={columnVariables(columns.widths, columnIds)}
      tabIndex={0}
    >
      <div className="log-header log-grid">
        {columnIds.map((id) => (
          <span key={id}>
            {t(`column_${id}`)}
            <span
              aria-label={t("column_resize", { column: t(`column_${id}`) })}
              className="col-handle"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={() => fit(id)}
              onPointerDown={(e) => dragStart(id, e)}
              role="separator"
              title={t("column_resize_title")}
            />
          </span>
        ))}
        <span>{t("column_message")}</span>
      </div>
      {pinned}
      <div className="log-body" ref={body} style={{ height: spacer }}>
        {items}
      </div>
      {!wrap && <MessageScrollbar resetKey={sessionKey} scroller={scroller} total={messageWidth} />}
      {menu && (
        <ContextMenu
          items={[
            { hint: "Ctrl+C", id: "copy", label: t("table_copy"), run: () => onCopy("raw") },
            { id: "message", label: t("table_copy_message"), run: () => onCopy("message") },
            { hint: "Ctrl+A", id: "all", label: t("table_select_all"), run: onSelectAll },
          ]}
          onClose={closeMenu}
          x={menu.x}
          y={menu.y}
        />
      )}
    </div>
  );
}
