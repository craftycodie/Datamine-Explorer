// The disclosure arrow of the trees: a small chevron in a fixed slot, so rows with and without
// children line up. It points right when closed and turns a quarter turn when open.
export function Chevron({ leaf = false, onClick, open }: { leaf?: boolean; onClick?: (event: React.MouseEvent) => void; open: boolean }) {
  return (
    <span aria-hidden="true" className={leaf ? "chev-slot leaf" : "chev-slot"} onClick={leaf ? undefined : onClick}>
      {!leaf && (
        <svg className={open ? "chev open" : "chev"} height="10" viewBox="0 0 10 10" width="10">
          <path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        </svg>
      )}
    </span>
  );
}
