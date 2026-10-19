// Severity and category filters and the search spec; the worker applies them to its columns.
import type { Text } from "../localization";
import { LEVEL_NAMES } from "./types";

export const NO_CATEGORY = "(none)";

export interface Filters {
  // one flag per LEVEL_NAMES entry
  levels: boolean[];
  // category prefixes such as "networking:"; a prefix covers its children
  include: string[];
  exclude: string[];
}

export function filtersDefault(): Filters {
  return { exclude: [], include: [], levels: LEVEL_NAMES.map(() => true) };
}

export function filtersActive(filters: Filters): boolean {
  return filters.include.length > 0 || filters.exclude.length > 0 || filters.levels.some((on) => !on);
}

export function categoryMatches(category: string, prefix: string): boolean {
  if (prefix === NO_CATEGORY) {
    return category === "";
  }
  return category.startsWith(prefix);
}

export interface SearchSpec {
  text: string;
  caseSensitive: boolean;
  regex: boolean;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The regex source of a search; throws when a regex search is not a valid pattern.
export function searchSource(spec: SearchSpec): string {
  const source = spec.regex ? spec.text : escapeRegex(spec.text);
  new RegExp(source);
  return source;
}

export interface Matcher {
  // for highlighting; global, so reset lastIndex before use
  highlight: RegExp;
}

// Undefined when there is nothing to search for; `error` set when the regex is bad.
export function matcherBuild(spec: SearchSpec): { matcher?: Matcher; error?: Text } {
  if (spec.text === "") {
    return {};
  }
  try {
    const highlight = new RegExp(searchSource(spec), spec.caseSensitive ? "g" : "gi");
    // an empty-matching regex would match everywhere and highlight nothing
    if (highlight.test("")) {
      return { error: { key: "search_empty_match" } };
    }
    return { matcher: { highlight } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CategoryNode {
  segment: string;
  // "networking:session:"
  path: string;
  own: number;
  total: number;
  children: CategoryNode[];
}

// Entries carry full paths like "networking:session:"; this folds their counts into a tree.
export function categoryTreeBuild(counts: Map<string, number>): CategoryNode[] {
  const roots: CategoryNode[] = [];
  const byPath = new Map<string, CategoryNode>();
  const nodeFor = (path: string, segment: string, parent?: CategoryNode): CategoryNode => {
    let node = byPath.get(path);
    if (!node) {
      node = { children: [], own: 0, path, segment, total: 0 };
      byPath.set(path, node);
      (parent ? parent.children : roots).push(node);
    }
    return node;
  };
  for (const [category, count] of counts) {
    if (category === "") {
      const node = nodeFor(NO_CATEGORY, NO_CATEGORY);
      node.own += count;
      node.total += count;
      continue;
    }
    const segments = category.split(":").filter(Boolean);
    let parent: CategoryNode | undefined;
    let path = "";
    for (const segment of segments) {
      path += `${segment}:`;
      const node = nodeFor(path, segment, parent);
      node.total += count;
      parent = node;
    }
    if (parent) {
      parent.own += count;
    }
  }
  const sort = (nodes: CategoryNode[]) => {
    nodes.sort((a, b) => a.segment.localeCompare(b.segment));
    for (const node of nodes) {
      sort(node.children);
    }
  };
  sort(roots);
  return roots;
}
