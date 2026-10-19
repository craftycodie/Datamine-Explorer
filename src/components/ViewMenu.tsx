import { useMemo } from "react";
import { type Columns, OPTIONAL_COLUMN_IDS } from "../lib/columns";
import { EXPLORER_LOCALES, LOCALE_NAMES, useLocale } from "../localization";
import { Menu, type MenuEntry } from "./Menu";

export type Theme = "auto" | "dark" | "light";

const THEMES: Theme[] = ["auto", "dark", "light"];

// The panes, how messages are laid out, the colours and the language.
export function ViewMenu({
  columns,
  leftShown,
  onLeftToggle,
  onResetColumns,
  onRightToggle,
  onTheme,
  onWrapToggle,
  rightShown,
  sourceColumn,
  theme,
  wrap,
}: {
  columns: Columns;
  leftShown: boolean;
  onLeftToggle: () => void;
  onResetColumns: () => void;
  onRightToggle: () => void;
  onTheme: (theme: Theme) => void;
  onWrapToggle: () => void;
  rightShown: boolean;
  // several sources are open, so there is a source column to show or hide
  sourceColumn: boolean;
  theme: Theme;
  wrap: boolean;
}) {
  const { locale, setLocale, t } = useLocale();
  const entries = useMemo<MenuEntry[]>(
    () => [
      { action: { hint: "Ctrl+B", id: "left", label: t(leftShown ? "view_left_hide" : "view_left_show"), run: onLeftToggle }, kind: "action" },
      { action: { hint: "Ctrl+Alt+B", id: "right", label: t(rightShown ? "view_right_hide" : "view_right_show"), run: onRightToggle }, kind: "action" },
      { action: { checked: wrap, id: "wrap", label: t("view_wrap"), run: onWrapToggle }, kind: "action" },
      { id: "columns-separator", kind: "separator" },
      { id: "columns-heading", kind: "heading", label: t("view_columns") },
      ...OPTIONAL_COLUMN_IDS.map<MenuEntry>((id) => ({
        action: {
          checked: columns.shown(id),
          disabled: id === "source" && !sourceColumn,
          id: `column-${id}`,
          label: t(`view_column_${id}`),
          run: () => columns.toggle(id),
          title: id === "source" ? t("view_column_source_hint") : undefined,
        },
        kind: "action",
      })),
      { action: { id: "columns", label: t("view_reset_columns"), run: onResetColumns }, kind: "action" },
      { id: "theme-separator", kind: "separator" },
      { id: "theme-heading", kind: "heading", label: t("view_theme") },
      ...THEMES.map<MenuEntry>((item) => ({
        action: { checked: theme === item, id: `theme-${item}`, label: t(`view_theme_${item}`), radio: true, run: () => onTheme(item) },
        kind: "action",
      })),
      { id: "language-separator", kind: "separator" },
      { id: "language-heading", kind: "heading", label: t("view_language") },
      // each language by its own name, so it can be found whatever is shown
      ...EXPLORER_LOCALES.map<MenuEntry>((item) => ({
        action: { checked: locale === item, id: `language-${item}`, label: LOCALE_NAMES[item], radio: true, run: () => setLocale(item) },
        kind: "action",
      })),
    ],
    [columns, leftShown, locale, onLeftToggle, onResetColumns, onRightToggle, onTheme, onWrapToggle, rightShown, setLocale, sourceColumn, t, theme, wrap]
  );
  return <Menu entries={entries} id="view" label={t("view_menu")} />;
}
