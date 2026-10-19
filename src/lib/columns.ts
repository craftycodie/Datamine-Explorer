// The log table's column widths. The table is a CSS grid whose columns come from variables on its
// root (--col-time and so on), so the header and every row share one set of widths and a drag only
// has to change a variable. The message column takes what is left and has no width of its own.
import { useCallback, useState } from "react";
import { storedGet, storedSet } from "./stored";

export const COLUMN_IDS = ["time", "index", "level", "category"] as const;
// with several sources open, the source's nickname comes first
export const SOURCE_COLUMN_IDS = ["source", ...COLUMN_IDS] as const;
export type ColumnId = (typeof SOURCE_COLUMN_IDS)[number];
export type ColumnWidths = Record<ColumnId, number>;

// What each column needs to show its content and its header label: a whole timestamp, five digits,
// the level badge, a few characters of category.
export const COLUMN_MINIMUMS: ColumnWidths = { category: 80, index: 48, level: 46, source: 48, time: 92 };
export const COLUMN_MAXIMUM = 600;
// The table never gets narrower than its fixed columns plus this much message.
export const MESSAGE_MINIMUM = 240;
export const COLUMN_GAP = 8;
export const GRID_PADDING = 16;

// "dmv." is from the app's old name, Datamine Viewer; kept so saved widths survive the rename.
export const COLUMNS_KEY = "dmv.columns";

export const COLUMN_DEFAULTS: ColumnWidths = { category: 160, index: 64, level: 52, source: 90, time: 96 };

export function widthClamp(id: ColumnId, width: number): number {
  return Math.round(Math.min(COLUMN_MAXIMUM, Math.max(COLUMN_MINIMUMS[id], width)));
}

// Widths from storage; a missing or odd entry falls back to its default.
export function columnsParse(text: string | null): ColumnWidths {
  const widths = { ...COLUMN_DEFAULTS };
  try {
    const stored = JSON.parse(text ?? "{}") as Partial<Record<ColumnId, unknown>>;
    for (const id of SOURCE_COLUMN_IDS) {
      const value = stored[id];
      if (typeof value === "number" && Number.isFinite(value)) {
        widths[id] = widthClamp(id, value);
      }
    }
  } catch {
    // keep the defaults
  }
  return widths;
}

// The narrowest the grid may get: fixed columns, gaps, padding and a little message.
export function gridMinimum(widths: ColumnWidths, ids: readonly ColumnId[] = COLUMN_IDS): number {
  const fixed = ids.reduce((sum, id) => sum + widths[id], 0);
  return fixed + ids.length * COLUMN_GAP + MESSAGE_MINIMUM + GRID_PADDING;
}

// The variables the grid reads, for the columns shown.
export function columnVariables(widths: ColumnWidths, ids: readonly ColumnId[] = COLUMN_IDS): Record<string, string> {
  const fixed = ids.reduce((sum, id) => sum + widths[id], 0);
  const variables: Record<string, string> = {
    "--grid-min": `${gridMinimum(widths, ids)}px`,
    "--col-message-min": `${MESSAGE_MINIMUM}px`,
    // where the message column starts, for the scrollbar under it
    "--msg-left": `${GRID_PADDING / 2 + fixed + ids.length * COLUMN_GAP}px`,
  };
  for (const id of ids) {
    variables[`--col-${id}`] = `${widths[id]}px`;
  }
  return variables;
}

export interface Columns {
  widths: ColumnWidths;
  set(id: ColumnId, width: number): void;
  reset(): void;
}

export function useColumns(): Columns {
  const [widths, setWidths] = useState<ColumnWidths>(() => columnsParse(storedGet(COLUMNS_KEY)));
  const set = useCallback((id: ColumnId, width: number) => {
    setWidths((old) => {
      const next = { ...old, [id]: widthClamp(id, width) };
      storedSet(COLUMNS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setWidths({ ...COLUMN_DEFAULTS });
    storedSet(COLUMNS_KEY, JSON.stringify(COLUMN_DEFAULTS));
  }, []);
  return { reset, set, widths };
}
