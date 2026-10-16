// Finds the entries of a batch of text that a search matches.
import { type SearchSpec, searchSource } from "../lib/filter";
import type { SearchText } from "./stores";

export type BatchMatcher = (batch: SearchText) => number[];

// Case-insensitive plain search folds both sides to lower case; it needs the length to stay put
// so a position in the folded text is a position in the original.
function plainMatcher(query: string, caseSensitive: boolean, fallback: BatchMatcher): BatchMatcher {
  const needle = caseSensitive ? query : query.toLowerCase();
  return (batch) => {
    const haystack = caseSensitive ? batch.text : batch.text.toLowerCase();
    if (haystack.length !== batch.text.length) {
      return fallback(batch);
    }
    const { starts, ends } = batch;
    const found: number[] = [];
    let k = 0;
    let at = 0;
    while (k < starts.length) {
      const hit = haystack.indexOf(needle, at);
      if (hit < 0) {
        break;
      }
      while (k < ends.length && ends[k] <= hit) {
        k++;
      }
      if (k >= starts.length) {
        break;
      }
      if (hit < starts[k]) {
        // between entries
        at = starts[k];
      } else if (hit + needle.length <= ends[k]) {
        found.push(k);
        at = ends[k];
        k++;
      } else {
        at = hit + 1;
      }
    }
    return found;
  };
}

function regexMatcher(source: string, caseSensitive: boolean): BatchMatcher {
  const pattern = new RegExp(source, caseSensitive ? "" : "i");
  return (batch) => {
    const found: number[] = [];
    for (let k = 0; k < batch.starts.length; k++) {
      if (pattern.test(batch.text.slice(batch.starts[k], batch.ends[k]))) {
        found.push(k);
      }
    }
    return found;
  };
}

// Throws when a regex search is not a valid pattern.
export function matcherCreate(spec: SearchSpec): BatchMatcher {
  const source = searchSource(spec);
  const byPattern = regexMatcher(source, spec.caseSensitive);
  return spec.regex ? byPattern : plainMatcher(spec.text, spec.caseSensitive, byPattern);
}
