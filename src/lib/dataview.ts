// ---------------------------------------------------------------------------
// Dataview-style frontmatter query engine
// ---------------------------------------------------------------------------
//
// Lets users filter and sort wiki pages by their YAML frontmatter fields
// (created, updated, tags, source_count, source_url, etc.). Inspired by
// the Obsidian Dataview plugin pattern mentioned in the founding vision.

import { listReadableWikiPages, tryReadWikiPageWithFrontmatter, withPageCache } from "./wiki";
import type { Principal } from "./auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported comparison operators. */
export type DataviewOp =
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "exists";

/** A single filter predicate against a frontmatter field. */
export interface DataviewFilter {
  /** Frontmatter field name, e.g. "tags", "created". */
  field: string;
  /** Comparison operator. */
  op: DataviewOp;
  /** Comparison value (not needed for "exists"). */
  value?: string;
}

/** Query specification. */
export interface DataviewQuery {
  filters?: DataviewFilter[];
  /** Frontmatter field to sort by. */
  sortBy?: string;
  /** Sort direction (default "asc"). */
  sortOrder?: "asc" | "desc";
  /** Maximum number of results (default 50, hard max 200). */
  limit?: number;
}

/** A single result row. */
export interface DataviewResult {
  slug: string;
  title: string;
  frontmatter: Record<string, string | string[] | number | boolean>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_OPS = new Set<string>([
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "contains",
  "exists",
]);

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Validate a query, throwing a descriptive error on invalid input. */
export function validateQuery(query: DataviewQuery): void {
  if (query.filters) {
    if (!Array.isArray(query.filters)) {
      throw new Error("filters must be an array");
    }
    for (const f of query.filters) {
      if (typeof f.field !== "string" || f.field.trim().length === 0) {
        throw new Error("each filter must have a non-empty field name");
      }
      if (!VALID_OPS.has(f.op)) {
        throw new Error(`unknown filter op: "${f.op}"`);
      }
      if (f.op !== "exists" && (f.value === undefined || f.value === null)) {
        throw new Error(
          `filter op "${f.op}" on field "${f.field}" requires a value`,
        );
      }
    }
  }
  if (query.sortOrder && query.sortOrder !== "asc" && query.sortOrder !== "desc") {
    throw new Error(`invalid sortOrder: "${query.sortOrder}"`);
  }
  if (query.limit !== undefined) {
    if (typeof query.limit !== "number" || !Number.isFinite(query.limit) || query.limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    if (query.limit > MAX_LIMIT) {
      throw new Error(`limit exceeds maximum of ${MAX_LIMIT}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** ISO-date pattern (YYYY-MM-DD with optional time suffix). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Try to parse a string as a number. Returns NaN on failure. */
function tryNumber(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Compare two string values, using numeric comparison when both are numbers
 * and date comparison when both look like ISO dates, otherwise plain string
 * comparison.
 *
 * Returns negative / zero / positive like a standard comparator.
 */
function smartCompare(a: string, b: string): number {
  // Numeric comparison
  const na = tryNumber(a);
  const nb = tryNumber(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb;
  }

  // ISO date comparison — lexicographic works for ISO dates
  if (ISO_DATE_RE.test(a) && ISO_DATE_RE.test(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // Plain string comparison
  return a.localeCompare(b);
}

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

/**
 * Check whether a single filter matches a frontmatter value.
 * `fmValue` is `undefined` when the field does not exist in the page.
 */
function matchesFilter(
  filter: DataviewFilter,
  fmValue: string | string[] | number | boolean | undefined,
): boolean {
  const { op, value } = filter;

  // "exists" — check presence
  if (op === "exists") {
    return fmValue !== undefined;
  }

  // For all other ops, a missing field means no match.
  if (fmValue === undefined) return false;

  // "contains" — check if array includes the value, or if string contains it.
  if (op === "contains") {
    if (Array.isArray(fmValue)) {
      return fmValue.includes(value!);
    }
    // For scalar strings/numbers/booleans, treat as substring check
    return String(fmValue).includes(value!);
  }

  // For relational/equality ops, coerce to a scalar string.
  const scalar = Array.isArray(fmValue) ? fmValue.join(", ") : String(fmValue);
  const cmp = smartCompare(scalar, value!);

  switch (op) {
    case "eq":
      return cmp === 0;
    case "neq":
      return cmp !== 0;
    case "gt":
      return cmp > 0;
    case "lt":
      return cmp < 0;
    case "gte":
      return cmp >= 0;
    case "lte":
      return cmp <= 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main query function
// ---------------------------------------------------------------------------

/**
 * Query wiki pages by their frontmatter fields.
 *
 * Lists all wiki pages, reads their frontmatter, applies the given filters,
 * sorts by the requested field, and returns up to `limit` results.
 */
export async function queryByFrontmatter(
  query: DataviewQuery,
  principal: Principal | null = null,
): Promise<DataviewResult[]> {
  validateQuery(query);

  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filters = query.filters ?? [];
  const sortBy = query.sortBy;
  const sortOrder = query.sortOrder ?? "asc";

  // Gather readable pages with frontmatter, using the page cache for efficiency
  const entries = await withPageCache(async () => {
    const pages = await listReadableWikiPages(principal);
    const results: DataviewResult[] = [];

    for (const entry of pages) {
      // Skip the index entry itself (not a real content page)
      if (entry.slug === "index") continue;

      const page = await tryReadWikiPageWithFrontmatter(entry.slug, "dataview");
      if (!page) continue;

      const fm = page.frontmatter;

      // Apply all filters — all must match (AND semantics)
      let passes = true;
      for (const f of filters) {
        if (!matchesFilter(f, fm[f.field])) {
          passes = false;
          break;
        }
      }
      if (!passes) continue;

      results.push({
        slug: entry.slug,
        title: page.title,
        frontmatter: fm,
      });
    }

    return results;
  });

  // Sort
  if (sortBy) {
    entries.sort((a, b) => {
      const aVal = a.frontmatter[sortBy];
      const bVal = b.frontmatter[sortBy];

      // Missing values sort last
      if (aVal === undefined && bVal === undefined) return 0;
      if (aVal === undefined) return 1;
      if (bVal === undefined) return -1;

      const aStr = Array.isArray(aVal) ? aVal.join(", ") : String(aVal);
      const bStr = Array.isArray(bVal) ? bVal.join(", ") : String(bVal);

      const cmp = smartCompare(aStr, bStr);
      return sortOrder === "desc" ? -cmp : cmp;
    });
  }

  // Apply limit
  return entries.slice(0, limit);
}
