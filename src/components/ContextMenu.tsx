import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

// A menu at the mouse, in the look of the File menu. It gives focus back to where it came from.
export function ContextMenu({ items, onClose, x, y }: { items: ContextMenuItem[]; onClose: () => void; x: number; y: number }) {
  const menu = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [at, setAt] = useState({ x, y });

  useLayoutEffect(() => {
    const element = menu.current;
    if (element) {
      // kept inside the window
      setAt({ x: Math.max(0, Math.min(x, window.innerWidth - element.offsetWidth - 4)), y: Math.max(0, Math.min(y, window.innerHeight - element.offsetHeight - 4)) });
    }
  }, [x, y]);

  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    menu.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      from?.focus?.();
    };
  }, [onClose]);

  const choose = (item: ContextMenuItem | undefined) => {
    if (item && !item.disabled) {
      onClose();
      item.run();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = items.length - 1;
    switch (event.key) {
      case "ArrowDown":
        setActive(active >= last ? 0 : active + 1);
        break;
      case "ArrowUp":
        setActive(active <= 0 ? last : active - 1);
        break;
      case "Enter":
      case " ":
        choose(items[active]);
        break;
      case "Escape":
        onClose();
        break;
      case "Tab":
        onClose();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="menu-pop context-menu" onContextMenu={(e) => e.preventDefault()} onKeyDown={onKeyDown} ref={menu} role="menu" style={{ left: at.x, top: at.y }} tabIndex={-1}>
      {items.map((item, k) => (
        <div
          className={`menu-item${k === active ? " active" : ""}${item.disabled ? " disabled" : ""}`}
          key={item.id}
          onClick={() => choose(item)}
          onMouseEnter={() => setActive(k)}
          role="menuitem"
        >
          <span className="menu-label">{item.label}</span>
          {item.hint && <span className="menu-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  );
}
