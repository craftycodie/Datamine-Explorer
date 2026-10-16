import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  title?: string;
  disabled?: boolean;
  // a toggle or a radio item that is on shows a tick
  checked?: boolean;
  // one of a group of which one is on
  radio?: boolean;
  run: () => void;
}

export type MenuEntry = { kind: "action"; action: MenuAction } | { kind: "separator"; id: string } | { kind: "heading"; id: string; label: string };

// Alt+F and Alt+V open a menu by its id.
export const MENU_OPEN_EVENT = "datamine-explorer:menu-open";

// A button in the menu bar that drops a list down: the arrow keys move, Enter chooses, Escape closes.
export function Menu({ entries, id, label }: { entries: MenuEntry[]; id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const actions = useMemo(() => entries.flatMap((entry) => (entry.kind === "action" ? [entry.action] : [])), [entries]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) {
        setActive(0);
        setOpen(true);
      }
    };
    window.addEventListener(MENU_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(MENU_OPEN_EVENT, onOpen);
  }, [id]);

  useEffect(() => {
    if (!open) {
      return;
    }
    menu.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    setActive(0);
    setOpen(!open);
  };

  // Close first: the action may open a dialog of its own.
  const choose = (action: MenuAction | undefined) => {
    if (action?.disabled) {
      return;
    }
    setOpen(false);
    action?.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = actions.length - 1;
    switch (event.key) {
      case "ArrowDown":
        setActive(active >= last ? 0 : active + 1);
        break;
      case "ArrowUp":
        setActive(active <= 0 ? last : active - 1);
        break;
      case "Home":
        setActive(0);
        break;
      case "End":
        setActive(last);
        break;
      case "Enter":
      case " ":
        choose(actions[active]);
        break;
      case "Escape":
        setOpen(false);
        button.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  let position = -1;
  return (
    <div className="menu-anchor" ref={anchor}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={open ? "menu-button open" : "menu-button"}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            toggle();
          }
        }}
        ref={button}
        type="button"
      >
        {label}
      </button>
      {open && (
        <div className="menu-pop" onKeyDown={onKeyDown} ref={menu} role="menu" tabIndex={-1}>
          {entries.map((entry) => {
            if (entry.kind === "separator") {
              return <div className="menu-sep" key={entry.id} />;
            }
            if (entry.kind === "heading") {
              return (
                <div className="menu-heading" key={entry.id}>
                  {entry.label}
                </div>
              );
            }
            const { action } = entry;
            const at = ++position;
            return (
              <div
                aria-checked={action.checked === undefined ? undefined : action.checked}
                className={`menu-item${at === active ? " active" : ""}${action.disabled ? " disabled" : ""}`}
                key={action.id}
                onClick={() => choose(action)}
                onMouseEnter={() => setActive(at)}
                role={action.radio ? "menuitemradio" : action.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                title={action.title}
              >
                <span className="menu-icon-slot">{action.checked ? "✓" : action.icon}</span>
                <span className="menu-label">{action.label}</span>
                {action.hint && <span className="menu-hint">{action.hint}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
