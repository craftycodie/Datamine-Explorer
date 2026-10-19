import { useEffect, useMemo, useRef, useState } from "react";
import { type CategoryNode, categoryTreeBuild, type Filters, NO_CATEGORY } from "../lib/filter";
import { useT } from "../localization";
import { Chevron } from "./Chevron";
import { MinusIcon, PlusIcon, SearchIcon, TagIcon } from "./Icons";

type Mode = "include" | "exclude";
const INDENT = 14;

function modeOf(filters: Filters, path: string): Mode | undefined {
  if (filters.include.includes(path)) {
    return "include";
  }
  return filters.exclude.includes(path) ? "exclude" : undefined;
}

// Keeps nodes whose path contains the query, or that have a descendant which does.
function nodesMatching(nodes: CategoryNode[], query: string): CategoryNode[] {
  const kept: CategoryNode[] = [];
  for (const node of nodes) {
    const children = nodesMatching(node.children, query);
    if (node.path.includes(query) || children.length > 0) {
      kept.push({ ...node, children: node.path.includes(query) && children.length === 0 ? node.children : children });
    }
  }
  return kept;
}

interface Row {
  node: CategoryNode;
  depth: number;
  parent?: string;
}

function Highlighted({ needle, text }: { needle: string; text: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export function CategoryFilter({
  counts,
  filters,
  onFilters,
  version,
}: {
  counts: Map<string, number>;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  version: number;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // the row the keys act on
  const [focused, setFocused] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  // `counts` is mutated as entries arrive, so `version` is the dependency that matters
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const tree = useMemo(() => categoryTreeBuild(counts), [counts, version]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (needle ? nodesMatching(tree, needle) : tree), [tree, needle]);

  // the rows in view: a search opens every ancestor of a match
  const rows = useMemo(() => {
    const into: Row[] = [];
    const walk = (nodes: CategoryNode[], depth: number, parent?: string) => {
      for (const node of nodes) {
        into.push({ depth, node, parent });
        if (needle !== "" || open.has(node.path)) {
          walk(node.children, depth + 1, node.path);
        }
      }
    };
    walk(shown, 0);
    return into;
  }, [shown, open, needle]);

  const setMode = (path: string, mode: Mode) => {
    const current = modeOf(filters, path);
    const include = filters.include.filter((p) => p !== path);
    const exclude = filters.exclude.filter((p) => p !== path);
    if (current !== mode) {
      (mode === "include" ? include : exclude).push(path);
    }
    onFilters({ ...filters, exclude, include });
  };
  const setOpenState = (path: string, on: boolean) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (on) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };
  const active = filters.include.length + filters.exclude.length;

  const focusedAt = rows.findIndex((row) => row.node.path === focused);
  useEffect(() => {
    scroller.current?.querySelector(".cat-row.focused")?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0 || (e.target as HTMLElement).tagName === "INPUT") {
      return;
    }
    const at = focusedAt < 0 ? 0 : focusedAt;
    const row = rows[at];
    const expanded = needle !== "" || open.has(row.node.path);
    const go = (index: number) => setFocused(rows[Math.max(0, Math.min(rows.length - 1, index))].node.path);
    switch (e.key) {
      case "ArrowDown":
        go(focusedAt < 0 ? 0 : at + 1);
        break;
      case "ArrowUp":
        go(at - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.node.children.length > 0 && !expanded) {
          setOpenState(row.node.path, true);
        } else if (row.node.children.length > 0) {
          go(at + 1);
        }
        break;
      case "ArrowLeft":
        if (row.node.children.length > 0 && expanded && needle === "") {
          setOpenState(row.node.path, false);
        } else if (row.parent) {
          setFocused(row.parent);
        }
        break;
      case "Enter":
        if (row.node.children.length > 0 && needle === "") {
          setOpenState(row.node.path, !expanded);
        }
        break;
      case " ": {
        // none, then show only, then hide, then none again
        setMode(row.node.path, modeOf(filters, row.node.path) ? "exclude" : "include");
        break;
      }
      case "-":
      case "Delete":
        setMode(row.node.path, "exclude");
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="categories">
      <div className="pane-header">
        <span className="pane-title">
          <TagIcon />
          {t("categories_heading")}
        </span>
        <button
          disabled={active === 0}
          onClick={() => onFilters({ ...filters, exclude: [], include: [] })}
          title={t("categories_clear_title")}
          type="button"
        >
          {t("categories_clear")}
        </button>
      </div>
      <div className="cat-search">
        <SearchIcon />
        <input
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder={t("categories_find")}
          spellCheck={false}
          value={query}
        />
        {query && (
          <button aria-label={t("categories_find_clear")} className="cat-search-clear" onClick={() => setQuery("")} title={t("categories_find_clear_title")} type="button">
            <svg aria-hidden="true" height="10" viewBox="0 0 10 10" width="10">
              <path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
            </svg>
          </button>
        )}
      </div>
      <div className="categories-scroll" onKeyDown={onKeyDown} ref={scroller} role="tree" tabIndex={0}>
        {rows.length === 0 && <div className="empty">{t("categories_empty")}</div>}
        {rows.map(({ depth, node }) => {
          const mode = modeOf(filters, node.path);
          const expanded = needle !== "" || open.has(node.path);
          const hasChildren = node.children.length > 0;
          const classes = ["cat-row"];
          if (mode) {
            classes.push(mode);
          }
          if (node.path === focused) {
            classes.push("focused");
          }
          return (
            <div
              aria-expanded={hasChildren ? expanded : undefined}
              aria-level={depth + 1}
              className={classes.join(" ")}
              key={node.path}
              onClick={() => setFocused(node.path)}
              onDoubleClick={() => hasChildren && needle === "" && setOpenState(node.path, !expanded)}
              role="treeitem"
              aria-selected={node.path === focused}
            >
              {Array.from({ length: depth }, (_, level) => (
                <span className="cat-guide" key={level} style={{ width: INDENT }} />
              ))}
              <Chevron
                leaf={!hasChildren}
                onClick={(e) => {
                  e.stopPropagation();
                  if (needle === "") {
                    setOpenState(node.path, !expanded);
                  }
                }}
                open={expanded}
              />
              <span className="cat-name" title={node.path}>
                <Highlighted needle={needle} text={node.path === NO_CATEGORY ? t("category_none") : node.segment} />
              </span>
              <span className="cat-count">{node.total.toLocaleString()}</span>
              <button
                aria-label={t("categories_include")}
                aria-pressed={mode === "include"}
                className={mode === "include" ? "cat-mode include on" : "cat-mode include"}
                onClick={(e) => {
                  e.stopPropagation();
                  setMode(node.path, "include");
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                tabIndex={-1}
                title={t("categories_include_title")}
                type="button"
              >
                <PlusIcon />
              </button>
              <button
                aria-label={t("categories_exclude")}
                aria-pressed={mode === "exclude"}
                className={mode === "exclude" ? "cat-mode exclude on" : "cat-mode exclude"}
                onClick={(e) => {
                  e.stopPropagation();
                  setMode(node.path, "exclude");
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                tabIndex={-1}
                title={t("categories_exclude_title")}
                type="button"
              >
                <MinusIcon />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
