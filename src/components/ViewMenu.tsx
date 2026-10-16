import { useMemo } from "react";
import { Menu, type MenuEntry } from "./Menu";

export type Theme = "auto" | "dark" | "light";

const THEMES: { theme: Theme; label: string }[] = [
  { label: "Follow system", theme: "auto" },
  { label: "Dark", theme: "dark" },
  { label: "Light", theme: "light" },
];

// The panes, how messages are laid out, and the colours.
export function ViewMenu({
  leftShown,
  onLeftToggle,
  onResetColumns,
  onRightToggle,
  onTheme,
  onWrapToggle,
  rightShown,
  theme,
  wrap,
}: {
  leftShown: boolean;
  onLeftToggle: () => void;
  onResetColumns: () => void;
  onRightToggle: () => void;
  onTheme: (theme: Theme) => void;
  onWrapToggle: () => void;
  rightShown: boolean;
  theme: Theme;
  wrap: boolean;
}) {
  const entries = useMemo<MenuEntry[]>(
    () => [
      { action: { hint: "Ctrl+B", id: "left", label: `${leftShown ? "Hide" : "Show"} Left Pane`, run: onLeftToggle }, kind: "action" },
      { action: { hint: "Ctrl+Alt+B", id: "right", label: `${rightShown ? "Hide" : "Show"} Right Pane`, run: onRightToggle }, kind: "action" },
      { action: { checked: wrap, id: "wrap", label: "Wrap messages", run: onWrapToggle }, kind: "action" },
      { action: { id: "columns", label: "Reset column widths", run: onResetColumns }, kind: "action" },
      { id: "theme-separator", kind: "separator" },
      { id: "theme-heading", kind: "heading", label: "Theme" },
      ...THEMES.map<MenuEntry>((item) => ({
        action: { checked: theme === item.theme, id: `theme-${item.theme}`, label: item.label, radio: true, run: () => onTheme(item.theme) },
        kind: "action",
      })),
    ],
    [leftShown, onLeftToggle, onResetColumns, onRightToggle, onTheme, onWrapToggle, rightShown, theme, wrap]
  );
  return <Menu entries={entries} id="view" label="View" />;
}
