// Small line icons in the style of the File menu's: 16 by 16, drawn in the current colour.
const LINE = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.2 };

function Icon({ children, size = 14 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg aria-hidden="true" className="pane-icon" height={size} viewBox="0 0 16 16" width={size}>
      {children}
    </svg>
  );
}

// a folder with a branch under it
export function FilesIcon() {
  return (
    <Icon>
      <path d="M1.5 2.5h4l1.2 1.3h4.8v3h-10z" {...LINE} />
      <path d="M3.5 6.8v5.7h3 M3.5 9.6h3" {...LINE} />
      <rect height="2.4" rx="0.6" width="4.5" x="8" y="8.4" {...LINE} />
      <rect height="2.4" rx="0.6" width="4.5" x="8" y="11.6" {...LINE} />
    </Icon>
  );
}

export function TagIcon() {
  return (
    <Icon>
      <path d="M1.8 2.2h5.4l7 7-5 5-7-7z" {...LINE} />
      <circle cx="5" cy="5.4" fill="currentColor" r="0.9" />
    </Icon>
  );
}

// a page with lines of text
export function DetailIcon() {
  return (
    <Icon>
      <path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" {...LINE} />
      <path d="M5.5 8h5 M5.5 10.5h5" {...LINE} />
    </Icon>
  );
}

// stacked bars: the sessions of a log
export function SessionIcon() {
  return (
    <Icon>
      <rect height="3" rx="0.7" width="12" x="2" y="2.5" {...LINE} />
      <rect height="3" rx="0.7" width="12" x="2" y="6.5" {...LINE} />
      <rect height="3" rx="0.7" width="12" x="2" y="10.5" {...LINE} />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <svg aria-hidden="true" className="search-icon" height="13" viewBox="0 0 16 16" width="13">
      <circle cx="6.8" cy="6.8" r="4.6" {...LINE} />
      <path d="M10.3 10.3 14 14" {...LINE} strokeWidth={1.5} />
    </svg>
  );
}

// the thick plus and minus of the category controls
export function PlusIcon() {
  return (
    <svg aria-hidden="true" height="10" viewBox="0 0 10 10" width="10">
      <path d="M5 1.5v7 M1.5 5h7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

export function MinusIcon() {
  return (
    <svg aria-hidden="true" height="10" viewBox="0 0 10 10" width="10">
      <path d="M1.5 5h7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}
