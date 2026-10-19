import type { RefObject } from "react";
import type { Filters, SearchSpec } from "../lib/filter";
import { LEVEL_NAMES, type LogStats, type SearchStatus } from "../lib/types";
import { type Text, textOf, translate, useT } from "../localization";
import { SearchIcon } from "./Icons";

const LEVEL_LETTERS = ["V", "S", "M", "W", "E", "C"];

function matchText(status: SearchStatus, current: number): string {
  const total = status.matches.toLocaleString();
  switch (status.state) {
    case "running":
      return translate("search_running", { percent: Math.floor(status.progress * 100), total });
    case "waiting":
      return status.matches > 0 ? `${total}+` : translate("search_waiting");
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
  searchError?: Text;
  searchRef: RefObject<HTMLInputElement | null>;
  searchStatus: SearchStatus;
  stats: LogStats;
}) {
  const t = useT();
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
          const named = { count, level: t(`level_${name}`) };
          return (
            <button
              aria-label={t(on ? "chip_aria_shown" : "chip_aria_hidden", named)}
              aria-pressed={on}
              className={`chip level-${level}${on ? " on" : ""}`}
              key={name}
              onClick={(e) => toggleLevel(level, e.ctrlKey || e.metaKey)}
              title={t(on ? "chip_title_shown" : "chip_title_hidden", named)}
              type="button"
            >
              {LEVEL_LETTERS[level]}
            </button>
          );
        })}
      </div>
      <div className="search">
        <label className="check" title={t("follow_tail_title")}>
          <input checked={follow} onChange={(e) => onFollow(e.target.checked)} type="checkbox" />
          {t("follow_tail")}
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
            placeholder={t("search_placeholder")}
            ref={searchRef}
            spellCheck={false}
            title={searchError && textOf(searchError)}
            value={search.text}
          />
        </div>
        <button
          className={search.caseSensitive ? "toggle on" : "toggle"}
          onClick={() => onSearch({ ...search, caseSensitive: !search.caseSensitive })}
          title={t("search_case")}
          type="button"
        >
          Aa
        </button>
        <button
          className={search.regex ? "toggle on" : "toggle"}
          onClick={() => onSearch({ ...search, regex: !search.regex })}
          title={t("search_regex")}
          type="button"
        >
          .*
        </button>
        <button
          className={onlyMatches ? "toggle on" : "toggle"}
          onClick={() => onOnlyMatches(!onlyMatches)}
          title={t("search_only_title")}
          type="button"
        >
          {t("search_only")}
        </button>
        <button disabled={searchStatus.matches === 0} onClick={() => onMatchStep(-1)} title={t("search_previous")} type="button">
          {"▲"}
        </button>
        <button disabled={searchStatus.matches === 0} onClick={() => onMatchStep(1)} title={t("search_next")} type="button">
          {"▼"}
        </button>
        <span className="match-count">
          {searchError ? t("search_bad_pattern") : search.text ? matchText(searchStatus, matchCurrent) : ""}
        </span>
      </div>
    </div>
  );
}
