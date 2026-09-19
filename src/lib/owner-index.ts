/**
 * Precomputed **owner→slugs** index (Phase 2 — precomputed KV indexes).
 *
 * Mirrors {@link slugsForOwner}'s membership rule: a page belongs to its
 * owner's tenant AND to every contributor's tenant (keyed by
 * {@link tenantForOwner}). Replaces the per-render O(N) frontmatter scan in
 * `slugsForOwner` with an O(1) KV read, maintained incrementally on the write
 * path and rebuilt daily as self-heal.
 *
 * Behavior-preserving: the read site falls back to the live scan whenever the
 * index is ABSENT (reader returns `null`), so the index is purely an
 * accelerator. An empty-but-present index (`{}`) is a valid seeded state.
 */

import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import {
  listWikiPages,
  tryReadWikiPageWithFrontmatter,
  tenantForOwner,
} from "./wiki";
import { logger } from "./logger";

/** KV/derived-index key (`_idx:owner-slugs`). Shape: `Record<tenant, slug[]>`. */
const OWNER_INDEX_KEY = "owner-slugs";
/** Single global lock — owner buckets are cross-tenant. */
const OWNER_INDEX_LOCK = "owner-slugs-index";

/** `tenant → slugs that the tenant owns or contributed to`. */
export type OwnerIndex = Record<string, string[]>;

/**
 * Read the full owner index, or `null` when absent/corrupt. Returns `null` (not
 * an empty object) so callers can distinguish "no index → fall back to the live
 * scan" from "index present but empty → genuinely no owned pages". Fail-soft: a
 * missing or corrupt index returns `null` rather than crashing a page render.
 */
export async function getOwnerIndex(): Promise<OwnerIndex | null> {
  try {
    const idx = await getStorage().getIndex<OwnerIndex>(OWNER_INDEX_KEY);
    if (!idx || typeof idx !== "object") return null;
    return idx;
  } catch (err) {
    logger.warn("owner-index", "owner index unreadable; treating as absent:", err);
    return null;
  }
}

async function putOwnerIndex(idx: OwnerIndex): Promise<void> {
  await getStorage().putIndex(OWNER_INDEX_KEY, idx);
}

/**
 * Tenants a page belongs to: its owner's tenant + every contributor's tenant.
 * Exported so the recent-activity index fans a page's events out to the SAME
 * tenant set this index uses — keeping `slugsForOwner` (read) and the per-owner
 * trail (write) keyed identically, so a contributor's profile stays fresh too.
 */
export function tenantsForPage(owner?: string, contributors?: string[]): Set<string> {
  const tenants = new Set<string>();
  tenants.add(tenantForOwner(owner));
  for (const c of contributors ?? []) {
    if (typeof c === "string") tenants.add(tenantForOwner(c));
  }
  return tenants;
}

/**
 * Sync one page's owner-index membership after a write. Ensures the slug is in
 * each relevant tenant bucket and REMOVES it from any stale bucket (owner or
 * contributors changed). Fail-soft is the caller's responsibility (lifecycle
 * wraps this in try/catch).
 */
export async function syncOwnerIndexForPage(
  slug: string,
  owner?: string,
  contributors?: string[],
): Promise<void> {
  const wanted = tenantsForPage(owner, contributors);
  await withFileLock(OWNER_INDEX_LOCK, async () => {
    const idx = await getOwnerIndex();
    if (!idx) return; // No index yet → daily rebuild seeds it; don't fabricate one.
    let changed = false;

    // Add to every wanted bucket.
    for (const tenant of wanted) {
      const bucket = idx[tenant] ?? [];
      if (!bucket.includes(slug)) {
        bucket.push(slug);
        idx[tenant] = bucket;
        changed = true;
      }
    }

    // Remove from any stale bucket the slug no longer belongs to.
    for (const tenant of Object.keys(idx)) {
      if (wanted.has(tenant)) continue;
      const bucket = idx[tenant];
      const next = bucket.filter((s) => s !== slug);
      if (next.length !== bucket.length) {
        if (next.length > 0) idx[tenant] = next;
        else delete idx[tenant];
        changed = true;
      }
    }

    if (changed) await putOwnerIndex(idx);
  });
}

/** Remove a slug from every tenant bucket (page deleted). */
export async function removeOwnerIndexForSlug(slug: string): Promise<void> {
  await withFileLock(OWNER_INDEX_LOCK, async () => {
    const idx = await getOwnerIndex();
    if (!idx) return; // No index yet → daily rebuild seeds it; don't fabricate one.
    let changed = false;
    for (const tenant of Object.keys(idx)) {
      const bucket = idx[tenant];
      const next = bucket.filter((s) => s !== slug);
      if (next.length !== bucket.length) {
        if (next.length > 0) idx[tenant] = next;
        else delete idx[tenant];
        changed = true;
      }
    }
    if (changed) await putOwnerIndex(idx);
  });
}

/**
 * Rebuild the entire owner index from current frontmatter — one pass over every
 * page (the generalized `slugsForOwner` loop). Repair tool + daily self-heal.
 */
export async function rebuildOwnerIndex(): Promise<OwnerIndex> {
  const pages = await listWikiPages();
  const idx: OwnerIndex = {};
  for (const entry of pages) {
    if (entry.slug === "index" || entry.slug === "log") continue;
    const page = await tryReadWikiPageWithFrontmatter(entry.slug, "owner-index");
    if (!page) continue;
    const owner =
      typeof page.frontmatter.owner === "string" ? page.frontmatter.owner : "";
    const contributors = Array.isArray(page.frontmatter.contributors)
      ? (page.frontmatter.contributors as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : [];
    for (const tenant of tenantsForPage(owner, contributors)) {
      (idx[tenant] ??= []).push(entry.slug);
    }
  }
  await withFileLock(OWNER_INDEX_LOCK, async () => {
    await putOwnerIndex(idx);
  });
  return idx;
}
