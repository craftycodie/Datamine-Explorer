import type { ReactNode } from "react";

// Wraps every match of `pattern` (a global regex) in <mark>.
export function Highlight({ pattern, text }: { pattern?: RegExp; text: string }): ReactNode {
  if (!pattern || text === "") {
    return text;
  }
  const parts: ReactNode[] = [];
  let last = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0] === "") {
      pattern.lastIndex++;
      continue;
    }
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    parts.push(<mark key={match.index}>{match[0]}</mark>);
    last = match.index + match[0].length;
  }
  if (parts.length === 0) {
    return text;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}
