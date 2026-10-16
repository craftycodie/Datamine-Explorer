import type { RefObject } from "react";
import type { Filters, SearchSpec } from "../lib/filter";
import { LEVEL_NAMES, type LogStats, type SearchStatus } from "../lib/types";

import { SearchIcon } from "./Icons";

const LEVEL_LETTERS = ["V", "S", "M", "W", "E", "C"];

function matchText(status: SearchStatus, current: number): string {
  const total = status.matches.toLocaleString();
  switch (status.state) {
    case "running":
      return `searching... ${Math.floor(status.progress * 100)}% · ${total}`;
    case "waiting":
      return status.matches > 0 ? `${total}+` : "waiting for the index...";
    case "done":
      return `${current.toLocaleString()} / ${total}`;
    default:
      return "";
  }
}

export function FilterBar({
  filters,
  follow,
  matchCurrent,
  onFilters,
  onFollow,
  onMatchStep,
  onOnlyMatches,
  onSearch,
  onlyMatches,
  search,
  searchError,
  searchRef,
  searchStatus,
  stats,
}: {
  filters: Filters;
  follow: boolean;
  // 1-based position of the current match, 0 for none
  matchCurrent: number;
  onFilters: (filters: Filters) => void;
  onFollow: (follow: boolean) => void;
  onMatchStep: (direction: 1 | -1) => void;
  onOnlyMatches: (only: boolean) => void;
  onSearch: (search: SearchSpec) => void;
  onlyMatches: boolean;
  search: SearchSpec;
  searchError?: string;
  searchRef: RefObject<HTMLInputElement | null>;
  searchStatus: SearchStatus;
  stats: LogStats;
}) {
  const toggleLevel = (level: number, only: boolean) => {
    const levels = only ? filters.levels.map((_, i) => i === level) : filters.levels.map((on, i) => (i === level ? !on : on));
    onFilters({ ...filters, levels });
  };
  return (
    <div className="filterbar">
      <div className="chips">
        {LEVEL_NAMES.map((name, level) => {
          const on = filters.levels[level];
          const count = stats.levelCounts[level].toLocaleString();
          return (
            <button
              aria-label={`${name}, ${count} entries, ${on ? "shown" : "hidden"}`}
              aria-pressed={on}
              className={`chip level-${level}${on ? " on" : ""}`}
              key={name}
              onClick={(e) => toggleLevel(level, e.ctrlKey || e.metaKey)}
              title={`${name}: ${count} entries${on ? "" : " (hidden)"} (Ctrl+click shows only this level)`}
              type="button"
            >
              {LEVEL_LETTERS[level]}
            </button>
          );
        })}
      </div>
      <div className="search">
        <label className="check" title="Keep the newest row in view as entries arrive (End)">
          <input checked={follow} onChange={(e) => onFollow(e.target.checked)} type="checkbox" />
          follow tail
        </label>
        <div className="search-field">
          <SearchIcon />
          <input
            className={searchError ? "invalid" : undefined}
            onChange={(e) => onSearch({ ...search, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onMatchStep(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                onSearch({ ...search, text: "" });
              }
            }}
            placeholder="Search (Ctrl+F)"
            ref={searchRef}
            spellCheck={false}
            title={searchError}
            value={search.text}
          />
        </div>
        <button
          className={search.caseSensitive ? "toggle on" : "toggle"}
          onClick={() => onSearch({ ...search, caseSensitive: !search.caseSensitive })}
          title="Match case"
          type="button"
        >
          Aa
        </button>
        <button
          className={search.regex ? "toggle on" : "toggle"}
          onClick={() => onSearch({ ...search, regex: !search.regex })}
          title="Regular expression"
          type="button"
        >
          .*
        </button>
        <button
          className={onlyMatches ? "toggle on" : "toggle"}
          onClick={() => onOnlyMatches(!onlyMatches)}
          title="Show only matching rows"
          type="button"
        >
          only
        </button>
        <button disabled={searchStatus.matches === 0} onClick={() => onMatchStep(-1)} title="Previous match (Shift+F3)" type="button">
          {"▲"}
        </button>
        <button disabled={searchStatus.matches === 0} onClick={() => onMatchStep(1)} title="Next match (F3)" type="button">
          {"▼"}
        </button>
        <span className="match-count">
          {searchError ? "bad pattern" : search.text ? matchText(searchStatus, matchCurrent) : ""}
        </span>
      </div>
    </div>
  );
}
