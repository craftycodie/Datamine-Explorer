import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { dateTimeText, isViewable, pathKey, sizeText } from "../lib/format";
import type { FileNode } from "../lib/types";
import { Chevron } from "./Chevron";
import { FilesIcon } from "./Icons";

interface Row {
  node: FileNode;
  depth: number;
}

// Drops files the explorer can't open, and folders left empty by that.
function prune(nodes: FileNode[]): FileNode[] {
  const kept: FileNode[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      const children = prune(node.children);
      if (children.length > 0) {
        kept.push({ ...node, children });
      }
    } else if (isViewable(node.name)) {
      kept.push(node);
    }
  }
  return kept;
}

function flatten(nodes: FileNode[], collapsed: Set<string>, depth = 0, into: Row[] = []): Row[] {
  for (const node of nodes) {
    into.push({ depth, node });
    if (node.isDir && !collapsed.has(node.path)) {
      flatten(node.children, collapsed, depth + 1, into);
    }
  }
  return into;
}

function allDirectories(nodes: FileNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.isDir) {
      into.push(node.path);
      allDirectories(node.children, into);
    }
  }
  return into;
}

export function FileTree({
  onSelect,
  onShowAll,
  root,
  selected,
  showAll,
  single,
  tree,
}: {
  onSelect: (path: string) => void;
  onShowAll: (showAll: boolean) => void;
  root?: string;
  selected?: string;
  showAll: boolean;
  // one file was opened on its own: it is listed whatever its type
  single?: boolean;
  tree: FileNode[];
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const visible = useMemo(() => (showAll || single ? tree : prune(tree)), [showAll, single, tree]);
  const rows = useMemo(() => flatten(visible, collapsed), [visible, collapsed]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 22,
    getScrollElement: () => scroller.current,
    overscan: 12,
  });
  const toggle = (path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };
  const selectedKey = selected ? pathKey(selected) : undefined;
  return (
    <div className="filetree">
      <div className="pane-header">
        <span className="pane-title">
          <FilesIcon />
          {single ? "File" : "Files"}
        </span>
        {!single && (
          <>
            <label className="check" title="Show files of any type">
              <input checked={showAll} onChange={(e) => onShowAll(e.target.checked)} type="checkbox" />
              all
            </label>
            <button onClick={() => setCollapsed(new Set(allDirectories(visible)))} title="Collapse all folders" type="button">
              -
            </button>
            <button onClick={() => setCollapsed(new Set())} title="Expand all folders" type="button">
              +
            </button>
          </>
        )}
      </div>
      <div className="filetree-scroll" ref={scroller}>
        {root && rows.length === 0 && <div className="empty">No {showAll ? "files" : "viewable files"} here.</div>}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const { depth, node } = rows[item.index];
            const isSelected = selectedKey === pathKey(node.path);
            return (
              <div
                className={`tree-row${isSelected ? " selected" : ""}`}
                key={node.path}
                onClick={() => (node.isDir ? toggle(node.path) : onSelect(node.path))}
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                title={`${node.path}\n${dateTimeText(node.modifiedMs)}`}
              >
                <span className="tree-name" style={{ paddingLeft: 6 + depth * 14 }}>
                  <Chevron leaf={!node.isDir} open={!collapsed.has(node.path)} />
                  <span className={node.isDir ? "tree-dir" : undefined}>{node.name}</span>
                </span>
                <span className="tree-size">{node.isDir ? "" : sizeText(node.size)}</span>
                <span className="tree-time">{node.isDir ? "" : dateTimeText(node.modifiedMs).slice(5, 16)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
