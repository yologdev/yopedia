// ---------------------------------------------------------------------------
// Source Index — maps a source (URL or content hash) to its canonical slug
// ---------------------------------------------------------------------------
//
// Deduplication at ingest time. Before fetching + synthesizing a source, the
// ingest pipeline checks whether the same source has already been ingested:
//   - `source_url` frontmatter → canonical slug (URL ingests)
//   - `content_hash` frontmatter → canonical slug (text/identical-content ingests)
//
// On a hit, the ingest pipeline attaches the new triggerer to the existing
// canonical page instead of re-running the LLM + embedding — saving tokens and
// keeping the commons to one page per source. Mirrors the in-memory, rebuilt-
// from-frontmatter approach of `alias-index.ts`.

import { listWikiPages, tryReadWikiPageWithFrontmatter } from "./wiki";

// ---------------------------------------------------------------------------
// Types + singleton
// ---------------------------------------------------------------------------

export interface SourceIndex {
  /** Maps `source_url` → canonical slug */
  byUrl: Map<string, string>;
  /** Maps `content_hash` → canonical slug */
  byHash: Map<string, string>;
}

let cachedIndex: SourceIndex | null = null;

/** Reset the cached source index (for testing or after bulk writes). */
export function resetSourceIndex(): void {
  cachedIndex = null;
}

/**
 * Normalize a URL for stable dedup matching.
 *
 * Steps (order matters):
 *  1. Trim whitespace
 *  2. Parse via URL (fall back to trim + trailing-slash strip for non-URLs)
 *  3. Strip fragment
 *  4. Lowercase hostname (paths stay case-sensitive per RFC)
 *  5. Strip default ports (80 for http, 443 for https)
 *  6. Strip leading `www.` from hostname
 *  7. Sort query parameters
 *  8. Drop trailing slash from pathname
 *  9. Upgrade http → https so both variants match
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not a valid URL — fall back to the old trim + trailing-slash strip
    return trimmed.replace(/\/+$/, "");
  }

  // Only normalize http(s) URLs; leave others (data:, file:, etc.) alone
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return trimmed.replace(/\/+$/, "");
  }

  // Upgrade http → https so the two variants collapse
  parsed.protocol = "https:";

  // Strip fragment
  parsed.hash = "";

  // Hostname is already lowercased by the URL constructor, but be explicit
  parsed.hostname = parsed.hostname.toLowerCase();

  // Strip default ports (URL constructor leaves these empty for defaults,
  // but handle explicit :443 / :80 that survived)
  if (
    (parsed.port === "443" && parsed.protocol === "https:") ||
    (parsed.port === "80" && parsed.protocol === "http:")
  ) {
    parsed.port = "";
  }

  // Strip www. prefix
  if (parsed.hostname.startsWith("www.")) {
    parsed.hostname = parsed.hostname.slice(4);
  }

  // Sort query parameters for stable ordering
  const params = new URLSearchParams(parsed.search);
  const sortedParams = new URLSearchParams(
    [...params.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  parsed.search = sortedParams.toString() ? `?${sortedParams.toString()}` : "";

  // Strip trailing slash from pathname
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  // URL.toString() always appends a trailing slash for root paths.
  // Strip it so `https://react.dev/` → `https://react.dev`
  let result = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    result = result.replace(/\/+$/, "");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build / rebuild
// ---------------------------------------------------------------------------

/**
 * Build the source index by scanning all wiki pages' frontmatter for
 * `source_url` and `content_hash`. Cheap (one listing + frontmatter parse per
 * page) and small, like the alias index.
 */
export async function buildSourceIndex(): Promise<SourceIndex> {
  const index: SourceIndex = { byUrl: new Map(), byHash: new Map() };
  const pages = await listWikiPages();

  for (const entry of pages) {
    if (entry.slug === "index" || entry.slug === "log") continue;
    const page = await tryReadWikiPageWithFrontmatter(entry.slug, "source-index");
    if (!page) continue;

    const url = page.frontmatter.source_url;
    if (typeof url === "string" && url.trim() !== "" && url !== "text-paste") {
      index.byUrl.set(normalizeUrl(url), entry.slug);
    }
    const hash = page.frontmatter.content_hash;
    if (typeof hash === "string" && hash.trim() !== "") {
      index.byHash.set(hash, entry.slug);
    }
  }

  cachedIndex = index;
  return index;
}

/** Get the source index, building it if not cached. */
export async function getSourceIndex(): Promise<SourceIndex> {
  if (cachedIndex) return cachedIndex;
  return buildSourceIndex();
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Resolve a source URL to an existing canonical slug, or null. */
export async function resolveSourceUrl(url: string): Promise<string | null> {
  if (!url || url.trim() === "" || url === "text-paste") return null;
  const index = await getSourceIndex();
  return index.byUrl.get(normalizeUrl(url)) ?? null;
}

/** Resolve a content hash to an existing canonical slug, or null. */
export async function resolveContentHash(hash: string): Promise<string | null> {
  if (!hash || hash.trim() === "") return null;
  const index = await getSourceIndex();
  return index.byHash.get(hash) ?? null;
}

// ---------------------------------------------------------------------------
// Incremental update / removal
// ---------------------------------------------------------------------------

/**
 * Update the cached index after a page write. No-op if the index isn't cached
 * yet (it'll be picked up on the next build).
 */
export function updateSourceIndexForPage(
  slug: string,
  sourceUrl: string | undefined,
  contentHash: string | undefined,
): void {
  if (!cachedIndex) return;
  if (
    typeof sourceUrl === "string" &&
    sourceUrl.trim() !== "" &&
    sourceUrl !== "text-paste"
  ) {
    cachedIndex.byUrl.set(normalizeUrl(sourceUrl), slug);
  }
  if (typeof contentHash === "string" && contentHash.trim() !== "") {
    cachedIndex.byHash.set(contentHash, slug);
  }
}

/** Remove all source-index entries pointing to a slug (called on delete). */
export function removeSourceForPage(slug: string): void {
  if (!cachedIndex) return;
  for (const [key, value] of cachedIndex.byUrl) {
    if (value === slug) cachedIndex.byUrl.delete(key);
  }
  for (const [key, value] of cachedIndex.byHash) {
    if (value === slug) cachedIndex.byHash.delete(key);
  }
}
