import { Confidence, Freshness } from "./folio/primitives";

interface SearchResultItemProps {
  id: string;
  index: number;
  label: string;
  snippet?: string;
  fuzzy?: boolean;
  confidence?: number;
  disputed?: boolean;
  expiry?: string;
  highlighted: boolean;
  onMouseEnter: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
}

export function SearchResultItem({
  index,
  label,
  snippet,
  fuzzy,
  confidence,
  disputed,
  expiry,
  highlighted,
  onMouseEnter,
  onMouseDown,
}: SearchResultItemProps) {
  return (
    <li
      id={`search-result-${index}`}
      role="option"
      aria-selected={highlighted}
      className={`cursor-pointer px-3 py-2 text-sm transition-colors ${
        highlighted
          ? "bg-foreground/10 text-foreground"
          : "text-foreground/70 hover:bg-foreground/5 hover:text-foreground"
      }`}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
    >
      <div className="flex items-center gap-1.5">
        <span>{label}</span>
        {confidence !== undefined && <Confidence value={confidence} />}
        {disputed && (
          <span
            className="text-[10px] font-medium whitespace-nowrap"
            style={{ color: "var(--rust, #b44)" }}
          >
            disputed
          </span>
        )}
        {expiry && <Freshness expiry={expiry} />}
        {fuzzy && (
          <span className="text-[10px] text-foreground/30 italic whitespace-nowrap">
            (fuzzy match)
          </span>
        )}
      </div>
      {snippet && (
        <div className="text-xs text-foreground/40 mt-0.5 truncate">
          {snippet}
        </div>
      )}
    </li>
  );
}
