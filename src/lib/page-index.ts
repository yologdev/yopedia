/**
 * `_idx:pages` — a precomputed map of every page's enriched {@link IndexEntry}
 * metadata (tags / owner / type / visibility / updated / sourceCount / …). It
 * lets {@link listWikiPages} enrich entries with ONE KV read instead of reading
 * every page file (the O(pages) loop that dominated the article + silo pages).
 *
 * Same hardened pattern as the other derived indexes (`commons.ts`): fail-soft
 * reader that returns `null` when the key is ABSENT (callers fall back to the
 * per-page scan), incremental sync that NO-OPS until a rebuild seeds it (never
 * fabricate a partial map from one write), and a `rebuildPageIndex()` that
 * reconstructs from the authoritative {@link scanWikiPagesUncached}.
 *
 * This index holds ALL pages (public, private, agent-scoped) — it's the raw
 * metadata layer; visibility filtering happens in `listReadableWikiPages`.
 */
import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import type { IndexEntry } from "./types";

const PAGE_INDEX_KEY = "pages";
const PAGE_INDEX_LOCK = "page-index";

export type PageMetaIndex = Record<string, IndexEntry>;

/** The metadata map, or `null` when the index has never been seeded (caller
 *  should fall back to {@link scanWikiPagesUncached}). */
export async function getPageIndex(): Promise<PageMetaIndex | null> {
  try {
    const idx = await getStorage().getIndex<PageMetaIndex>(PAGE_INDEX_KEY);
    // Presence check only — per-entry shape is TRUSTED, not validated. Safe
    // because `listWikiPages` drives membership + title/slug/summary from
    // index.md and only pulls enriched (optional) fields from here, so a
    // malformed entry can at worst mis-enrich, never drop or leak a page; the
    // daily rebuild overwrites it.
    if (!idx || typeof idx !== "object") return null;
    return idx;
  } catch (err) {
    logger.warn("page-index", "read failed; falling back to scan", err);
    return null;
  }
}

/**
 * Upsert one page's enriched entry, seeding the index on first write.
 *
 * This used to no-op until a rebuild seeded the map. Once reads are silo-only
 * (#889) that gap is no longer survivable: the read path derives a page's
 * tenant from its index entry, so a page written before the first rebuild
 * would resolve to {@link DEFAULT_TENANT} and read as missing. Seeding here
 * keeps write and read agreeing from the very first page.
 */
export async function syncPageIndexForPage(entry: IndexEntry): Promise<void> {
  await withFileLock(PAGE_INDEX_LOCK, async () => {
    const idx = (await getPageIndex()) ?? {};
    idx[entry.slug] = entry;
    await getStorage().putIndex(PAGE_INDEX_KEY, idx);
  });
}

/** Drop one page's entry (page deleted). NO-OP until seeded. */
export async function removePageIndexForSlug(slug: string): Promise<void> {
  await withFileLock(PAGE_INDEX_LOCK, async () => {
    const idx = await getPageIndex();
    if (idx === null) return;
    if (slug in idx) {
      delete idx[slug];
      await getStorage().putIndex(PAGE_INDEX_KEY, idx);
    }
  });
}

/** Rebuild the whole map from the authoritative per-page scan (daily self-heal). */
export async function rebuildPageIndex(): Promise<number> {
  const { scanWikiPagesUncached } = await import("./wiki");
  const all = await scanWikiPagesUncached();
  const map: PageMetaIndex = {};
  for (const entry of all) map[entry.slug] = entry;
  await withFileLock(PAGE_INDEX_LOCK, async () => {
    await getStorage().putIndex(PAGE_INDEX_KEY, map);
  });
  return all.length;
}
