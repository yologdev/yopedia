// ---------------------------------------------------------------------------
// Alias Index — maps alternative names to canonical wiki page slugs
// ---------------------------------------------------------------------------
//
// The alias index provides deduplication at ingest time. Before creating a new
// page, the ingest pipeline checks whether the title (or a close variant)
// already exists under a different slug. The index maps:
//   - Each page's title (slugified) → canonical slug
//   - Each alias in the page's `aliases[]` frontmatter → canonical slug
//   - Each alias slugified → canonical slug (for fuzzy slug matching)
//
// The index is rebuilt from frontmatter on demand and updated incrementally
// when pages are written.

import { listWikiPages, tryReadWikiPageWithFrontmatter } from "./wiki";
import { slugify } from "./slugify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The in-memory alias index: maps normalized names/slugs to canonical page slugs. */
export interface AliasIndex {
  /** Maps lowercase alias string → canonical slug */
  byAlias: Map<string, string>;
  /** Maps slugified alias → canonical slug (for fuzzy slug matching) */
  bySlug: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let cachedIndex: AliasIndex | null = null;

/**
 * Reset the cached alias index (for testing or after bulk writes).
 */
export function resetAliasIndex(): void {
  cachedIndex = null;
}

// ---------------------------------------------------------------------------
// Build / rebuild
// ---------------------------------------------------------------------------

/**
 * Build the alias index by scanning all wiki pages' frontmatter.
 *
 * For each page:
 *   - The page's own title (from the index entry) is mapped to its slug
 *   - Each entry in `aliases[]` is mapped (both as-is lowercase and slugified)
 *
 * The index is purely in-memory and rebuilt on demand. It's cheap to build
 * (one readdir + frontmatter parse per page) and small (a few hundred entries
 * at most for a typical wiki).
 */
export async function buildAliasIndex(): Promise<AliasIndex> {
  const index: AliasIndex = {
    byAlias: new Map(),
    bySlug: new Map(),
  };

  const pages = await listWikiPages();

  for (const entry of pages) {
    // Skip infrastructure pages
    if (entry.slug === "index" || entry.slug === "log") continue;

    // Map the page's own title (lowercase) → slug
    const titleLower = entry.title.toLowerCase();
    index.byAlias.set(titleLower, entry.slug);
    index.bySlug.set(entry.slug, entry.slug);

    // Also map the slugified title → slug (handles variant slug forms)
    const titleSlug = slugify(entry.title);
    if (titleSlug && titleSlug !== entry.slug) {
      index.bySlug.set(titleSlug, entry.slug);
    }

    // Read aliases from frontmatter
    const page = await tryReadWikiPageWithFrontmatter(entry.slug, "alias-index");
    if (!page) continue;

    const aliases = page.frontmatter.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias !== "string" || alias.trim() === "") continue;
        const aliasLower = alias.toLowerCase().trim();
        index.byAlias.set(aliasLower, entry.slug);

        const aliasSlug = slugify(alias);
        if (aliasSlug) {
          index.bySlug.set(aliasSlug, entry.slug);
        }
      }
    }
  }

  cachedIndex = index;
  return index;
}

/**
 * Get the alias index, building it if not cached.
 */
export async function getAliasIndex(): Promise<AliasIndex> {
  if (cachedIndex) return cachedIndex;
  return buildAliasIndex();
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a title to an existing canonical slug via the alias index.
 *
 * Checks (in order):
 *   1. Exact slug match (the title slugified matches an existing page slug)
 *   2. Exact alias match (the title lowercase matches a registered alias)
 *   3. Fuzzy slug match (the title slugified matches a registered alias slug)
 *
 * Returns the canonical slug if found, or `null` if no match exists.
 */
export async function resolveAlias(title: string): Promise<string | null> {
  const index = await getAliasIndex();
  const titleSlug = slugify(title);
  const titleLower = title.toLowerCase().trim();

  // 1. Exact slug match — the slugified title already exists as a page
  if (index.bySlug.has(titleSlug)) {
    return index.bySlug.get(titleSlug)!;
  }

  // 2. Exact alias match — the full title (lowercased) matches a registered alias
  if (index.byAlias.has(titleLower)) {
    return index.byAlias.get(titleLower)!;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Incremental update
// ---------------------------------------------------------------------------

/**
 * Update the alias index after a page write. Call this after writing a page
 * to keep the index fresh without a full rebuild.
 *
 * @param slug - The page slug that was written
 * @param title - The page title
 * @param aliases - The page's aliases array
 */
export function updateAliasIndexForPage(
  slug: string,
  title: string,
  aliases: string[],
): void {
  if (!cachedIndex) return; // No cached index to update

  const index = cachedIndex;

  // Map title → slug
  const titleLower = title.toLowerCase();
  index.byAlias.set(titleLower, slug);
  index.bySlug.set(slug, slug);

  const titleSlug = slugify(title);
  if (titleSlug && titleSlug !== slug) {
    index.bySlug.set(titleSlug, slug);
  }

  // Map each alias → slug
  for (const alias of aliases) {
    if (typeof alias !== "string" || alias.trim() === "") continue;
    const aliasLower = alias.toLowerCase().trim();
    index.byAlias.set(aliasLower, slug);

    const aliasSlug = slugify(alias);
    if (aliasSlug) {
      index.bySlug.set(aliasSlug, slug);
    }
  }
}

// ---------------------------------------------------------------------------
// Removal (for delete)
// ---------------------------------------------------------------------------

/**
 * Remove all alias index entries pointing to the given slug.
 *
 * Called during page deletion to prevent stale aliases from resolving to
 * a page that no longer exists. Without this, `resolveAlias(deletedTitle)`
 * would still return the deleted slug until the server restarts and the
 * index is rebuilt from disk.
 *
 * No-op if the cached index hasn't been built yet (nothing to clean up).
 */
export function removeAliasForPage(slug: string): void {
  if (!cachedIndex) return; // No cached index to update

  const index = cachedIndex;

  // Remove all byAlias entries pointing to this slug
  for (const [key, value] of index.byAlias) {
    if (value === slug) {
      index.byAlias.delete(key);
    }
  }

  // Remove all bySlug entries pointing to this slug
  for (const [key, value] of index.bySlug) {
    if (value === slug) {
      index.bySlug.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Duplicate detection (for lint)
// ---------------------------------------------------------------------------

export interface DuplicateEntity {
  /** The slug of one page */
  slugA: string;
  /** The slug of the other page that overlaps */
  slugB: string;
  /** The overlapping alias or title */
  overlappingName: string;
}

/**
 * Find pages whose titles or aliases overlap, suggesting potential duplicates.
 *
 * Checks:
 *   - Title of page A matches an alias of page B (or vice versa)
 *   - Slug of page A matches slug derived from alias of page B (or vice versa)
 *   - Two different pages share the same alias
 *
 * Returns pairs of potentially duplicate pages with the overlapping name.
 */
export async function findDuplicateEntities(): Promise<DuplicateEntity[]> {
  const pages = await listWikiPages();
  const duplicates: DuplicateEntity[] = [];
  const seen = new Set<string>(); // "slugA:slugB" dedup key

  // Build per-page data: title, aliases, derived slugs
  interface PageData {
    slug: string;
    title: string;
    titleLower: string;
    titleSlug: string;
    aliases: string[];
    aliasLowers: string[];
    aliasSlugs: string[];
  }

  const pageDataList: PageData[] = [];

  for (const entry of pages) {
    if (entry.slug === "index" || entry.slug === "log") continue;

    const page = await tryReadWikiPageWithFrontmatter(entry.slug, "alias-index");
    const aliases: string[] = [];
    if (page && Array.isArray(page.frontmatter.aliases)) {
      for (const a of page.frontmatter.aliases) {
        if (typeof a === "string" && a.trim() !== "") {
          aliases.push(a.trim());
        }
      }
    }

    pageDataList.push({
      slug: entry.slug,
      title: entry.title,
      titleLower: entry.title.toLowerCase(),
      titleSlug: slugify(entry.title),
      aliases,
      aliasLowers: aliases.map((a) => a.toLowerCase()),
      aliasSlugs: aliases.map((a) => slugify(a)).filter((s) => s !== ""),
    });
  }

  // Compare all pairs
  for (let i = 0; i < pageDataList.length; i++) {
    const a = pageDataList[i];
    for (let j = i + 1; j < pageDataList.length; j++) {
      const b = pageDataList[j];
      const pairKey = `${a.slug}:${b.slug}`;
      if (seen.has(pairKey)) continue;

      let overlap: string | null = null;

      // Check if A's title matches any of B's aliases
      if (b.aliasLowers.includes(a.titleLower)) {
        overlap = a.title;
      }
      // Check if B's title matches any of A's aliases
      else if (a.aliasLowers.includes(b.titleLower)) {
        overlap = b.title;
      }
      // Check if A's title slug matches B's slug or any of B's alias slugs
      else if (a.titleSlug === b.slug || b.aliasSlugs.includes(a.titleSlug)) {
        overlap = a.title;
      }
      // Check if B's title slug matches A's slug or any of A's alias slugs
      else if (b.titleSlug === a.slug || a.aliasSlugs.includes(b.titleSlug)) {
        overlap = b.title;
      }
      // Check if any aliases overlap between A and B
      else {
        for (const aAlias of a.aliasLowers) {
          if (b.aliasLowers.includes(aAlias)) {
            overlap = aAlias;
            break;
          }
        }
        if (!overlap) {
          for (const aAliasSlug of a.aliasSlugs) {
            if (b.aliasSlugs.includes(aAliasSlug)) {
              overlap = a.aliases[a.aliasSlugs.indexOf(aAliasSlug)];
              break;
            }
          }
        }
      }

      if (overlap) {
        seen.add(pairKey);
        duplicates.push({
          slugA: a.slug,
          slugB: b.slug,
          overlappingName: overlap,
        });
      }
    }
  }

  return duplicates;
}
