"use client";

import { useGlobalSearch } from "@/hooks/useGlobalSearch";
import { SearchResultItem } from "./SearchResultItem";

export function GlobalSearch() {
  const {
    query,
    open,
    expanded,
    results,
    highlighted,
    setHighlighted,
    showDropdown,
    inputRef,
    containerRef,
    handleKeyDown,
    navigate,
    expand,
    collapse,
    handleInputChange,
    handleInputFocus,
  } = useGlobalSearch();

  // Search icon SVG
  const searchIcon = (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
      />
    </svg>
  );

  const lowerQuery = query.toLowerCase().trim();

  return (
    <div ref={containerRef} className="relative">
      {/* Mobile: icon button to expand */}
      {!expanded && (
        <button
          type="button"
          className="sm:hidden text-foreground/50 hover:text-foreground transition-colors p-1.5 rounded-md hover:bg-foreground/5"
          onClick={expand}
          aria-label="Search wiki"
        >
          {searchIcon}
        </button>
      )}

      {/* Desktop: always visible input. Mobile: visible only when expanded */}
      <div
        className={`${expanded ? "flex" : "hidden"} sm:flex items-center gap-1.5`}
      >
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2 text-foreground/40">
            {searchIcon}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={handleInputFocus}
            onKeyDown={handleKeyDown}
            placeholder="Search… ( / )"
            className="w-40 lg:w-56 rounded-md border border-foreground/10 bg-foreground/5 py-1 pl-7 pr-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-foreground/30 focus:outline-none focus:ring-1 focus:ring-foreground/20 transition-colors"
            aria-label="Search wiki pages"
            aria-expanded={showDropdown}
            aria-haspopup="listbox"
            role="combobox"
            aria-controls={showDropdown ? "global-search-results" : undefined}
            aria-activedescendant={
              showDropdown ? `search-result-${highlighted}` : undefined
            }
          />

          {/* Dropdown results */}
          {showDropdown && (
            <ul
              id="global-search-results"
              role="listbox"
              className="absolute top-full left-0 right-0 mt-1 max-h-80 overflow-y-auto rounded-md border border-foreground/10 bg-background shadow-lg z-[60]"
            >
              {results.map((page, i) => (
                <SearchResultItem
                  key={page.id}
                  id={page.id}
                  index={i}
                  label={page.label}
                  snippet={page.snippet}
                  fuzzy={page.fuzzy}
                  confidence={page.confidence}
                  disputed={page.disputed}
                  expiry={page.expiry}
                  highlighted={i === highlighted}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent blur before navigate
                    navigate(page.id);
                  }}
                />
              ))}
            </ul>
          )}

          {/* No results message */}
          {open && lowerQuery.length > 0 && results.length === 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 rounded-md border border-foreground/10 bg-background shadow-lg z-[60] px-3 py-2 text-sm text-foreground/50">
              No pages found
            </div>
          )}
        </div>

        {/* Close button on mobile */}
        {expanded && (
          <button
            type="button"
            className="sm:hidden text-foreground/50 hover:text-foreground transition-colors p-1"
            onClick={collapse}
            aria-label="Close search"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18 18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
