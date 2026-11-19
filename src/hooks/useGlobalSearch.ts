"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSlugTenants } from "./useSlugTenants";

export interface SearchNode {
  id: string;
  label: string;
  /** If present, this is a content match with a snippet */
  snippet?: string;
  /** True when this result came from fuzzy matching */
  fuzzy?: boolean;
  /** Page confidence score (0–1), when present */
  confidence?: number;
  /** True when the page is marked as disputed */
  disputed?: boolean;
  /** ISO date string for page expiry/review-by, when present */
  expiry?: string;
}

const MAX_RESULTS = 8;
const CONTENT_SEARCH_DEBOUNCE_MS = 300;
const CONTENT_SEARCH_MIN_CHARS = 3;
const PAGES_CACHE_MS = 5000;

export interface UseGlobalSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  open: boolean;
  expanded: boolean;
  results: SearchNode[];
  highlighted: number;
  setHighlighted: (index: number) => void;
  showDropdown: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  navigate: (slug: string) => void;
  expand: () => void;
  collapse: () => void;
  handleInputChange: (value: string) => void;
  handleInputFocus: () => void;
}

export function useGlobalSearch(): UseGlobalSearchReturn {
  const router = useRouter();
  const { hrefForSlug } = useSlugTenants();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<SearchNode[]>([]);
  const [contentResults, setContentResults] = useState<SearchNode[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchRef = useRef<number>(0);

  // Fetch page list for title matching — cached with staleness guard
  const fetchPages = useCallback(async () => {
    const now = Date.now();
    if (pages.length > 0 && now - lastFetchRef.current < PAGES_CACHE_MS) {
      return;
    }
    try {
      const res = await fetch("/api/wiki");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.pages)) {
        setPages(
          data.pages.map((p: { slug: string; title: string }) => ({
            id: p.slug,
            label: p.title,
          })),
        );
        lastFetchRef.current = Date.now();
      }
    } catch {
      // silently fail — search just won't have results
    }
  }, [pages.length]);

  // Debounced content search
  const searchContent = useCallback((q: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    if (q.trim().length < CONTENT_SEARCH_MIN_CHARS) {
      setContentResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/wiki/search?q=${encodeURIComponent(q.trim())}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.results)) {
          setContentResults(
            data.results.map(
              (r: { slug: string; title: string; snippet: string; fuzzy?: boolean; confidence?: number; disputed?: boolean; expiry?: string }) => ({
                id: r.slug,
                label: r.title,
                snippet: r.snippet,
                fuzzy: r.fuzzy,
                ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
                ...(r.disputed ? { disputed: true } : {}),
                ...(r.expiry ? { expiry: r.expiry } : {}),
              }),
            ),
          );
        }
      } catch {
        // silently fail
      }
    }, CONTENT_SEARCH_DEBOUNCE_MS);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Keyboard shortcuts: "/" and Cmd/Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture if user is already in an input/textarea/contenteditable
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const isContentEditable = (e.target as HTMLElement)?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setExpanded(true);
        fetchPages();
        return;
      }

      if (e.key === "/" && !isEditable && !isContentEditable) {
        e.preventDefault();
        inputRef.current?.focus();
        setExpanded(true);
        fetchPages();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [fetchPages]);

  // Click outside to close
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setExpanded(false);
        setQuery("");
        setContentResults([]);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  // Filter results: title matches first, then content matches (deduplicated)
  const lowerQuery = query.toLowerCase().trim();
  const titleMatches =
    lowerQuery.length > 0
      ? pages
          .filter((p) => p.label.toLowerCase().includes(lowerQuery))
          .slice(0, MAX_RESULTS)
      : [];

  // Deduplicate content results against title matches
  const titleMatchSlugs = new Set(titleMatches.map((p) => p.id));
  const dedupedContentResults = contentResults.filter(
    (r) => !titleMatchSlugs.has(r.id),
  );

  // Merge: title matches first, then content matches
  const results = [
    ...titleMatches,
    ...dedupedContentResults.slice(0, MAX_RESULTS - titleMatches.length),
  ];

  const showDropdown = open && lowerQuery.length > 0 && results.length > 0;

  // Reset highlighted index when results change
  useEffect(() => {
    setHighlighted(0);
  }, [lowerQuery]);

  function navigate(slug: string) {
    setQuery("");
    setOpen(false);
    setExpanded(false);
    setContentResults([]);
    router.push(hrefForSlug(slug));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
      setExpanded(false);
      setContentResults([]);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter" && results.length > 0) {
      e.preventDefault();
      navigate(results[highlighted]?.id ?? results[0].id);
    }
  }

  function expand() {
    setExpanded(true);
    fetchPages();
    // Focus after render
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function collapse() {
    setExpanded(false);
    setQuery("");
    setOpen(false);
    setContentResults([]);
  }

  function handleInputChange(value: string) {
    setQuery(value);
    setOpen(true);
    searchContent(value);
  }

  function handleInputFocus() {
    setOpen(true);
    fetchPages();
  }

  return {
    query,
    setQuery,
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
  };
}
