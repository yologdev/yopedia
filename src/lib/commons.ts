/**
 * The public **commons** — a derived index of every PUBLIC page across all
 * tenants (tenant-silos groundwork; see yopedia-concept.md). In the per-tenant
 * model each page lives in its owner's silo and the commons is *not* separate
 * storage but this persisted index over the public ones.
 *
 * The index is maintained on the write/delete path and read by the homepage,
 * browse surface, and graph. Fail-soft on the write side — a commons error
 * must never break the page write/delete (see lifecycle.ts).
 */

import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import { listWikiPages, isAgentScopedType, isArtifactType, tenantForOwner } from "./wiki";
import { logger } from "./logger";
import type { IndexEntry } from "./types";

/** KV/derived-index key (resolves to `_idx:commons` on R2, a JSON file on fs). */
const COMMONS_KEY = "commons";
/** Single global lock — commons writes are cross-tenant. */
const COMMONS_LOCK = "commons-index";

/** One public page in the commons, addressed by `(tenant, slug)`. */
export interface CommonsEntry {
  /** Lowercased owner handle — the storage key + silo identity. */
  tenant: string;
  /** Original-case owner handle for display (`tenant` is the normalized key). */
  owner?: string;
  slug: string;
  title: string;
  summary: string;
  tags?: string[];
  updated?: string;
  sourceCount?: number;
  confidence?: number;
  type?: string;
}

/**
 * A page belongs in the commons iff it's public, not agent-scoped, and not a
 * rendered artifact (e.g. a saved `html` query output — a personal artifact, not
 * collective knowledge; see {@link isArtifactType}).
 */
export function belongsInCommons(meta: {
  visibility?: string;
  type?: string;
}): boolean {
  return (
    meta.visibility !== "private" &&
    !isAgentScopedType(meta.type) &&
    !isArtifactType(meta.type)
  );
}

/**
 * A page may be CURATED into a vault iff it's public and not agent-scoped.
 * Unlike {@link belongsInCommons}, artifacts (rendered `html`/`slides` outputs)
 * ARE eligible — a vault can collect them for Browse (they remain excluded from
 * Query/Graph retrieval, which is keyed on knowledge pages). Private pages stay
 * excluded: a vault references pages by slug, so a private one would leak.
 */
export function isVaultEligible(meta: {
  visibility?: string;
  type?: string;
}): boolean {
  return meta.visibility !== "private" && !isAgentScopedType(meta.type);
}

/**
 * Read the full commons index (empty array when absent). Fail-soft: a missing
 * or corrupt index returns `[]` so reads fall back to deriving the public set
 * rather than crashing a page render.
 */
export async function getCommonsIndex(): Promise<CommonsEntry[]> {
  try {
    const idx = await getStorage().getIndex<CommonsEntry[]>(COMMONS_KEY);
    return Array.isArray(idx) ? idx : [];
  } catch (err) {
    logger.warn("commons", "commons index unreadable; treating as empty:", err);
    return [];
  }
}

/**
 * The set of slugs that live in the PUBLIC commons. Used by link resolution to
 * decide whether a target resolves to the global `/wiki/<slug>` (public) vs the
 * owner-scoped `/u/<tenant>/<slug>`, and by the public route to gate which slugs
 * are even addressable globally. Fail-soft: a missing/corrupt index yields an
 * empty set (no slug is treated as commons), which is the SECURE default — link
 * resolution falls back to owner-scoped URLs rather than over-exposing.
 */
export async function getCommonsSlugSet(): Promise<Set<string>> {
  try {
    const entries = await getCommonsIndex();
    return new Set(entries.map((e) => e.slug));
  } catch (err) {
    logger.warn("commons", "commons slug set unreadable; treating as empty:", err);
    return new Set();
  }
}

/**
 * The public commons as {@link IndexEntry}[] — the source of truth for the
 * public listing surfaces (homepage, `/wiki` "All", graph). Reads the derived
 * commons index when populated; FALLS BACK to deriving it from the flat wiki
 * index (public, non-agent) when the commons is empty — so this stays correct
 * and behavior-preserving before/independent of the migration. `owner` is the
 * stored original-case handle when present, else the (lowercased) tenant — so
 * the index path matches the fallback's display case (the commons is all-public;
 * visibility is implicitly public).
 */
export async function listCommonsPages(): Promise<IndexEntry[]> {
  const idx = await getCommonsIndex();
  if (idx.length > 0) {
    return idx.map((e) => ({
      slug: e.slug,
      title: e.title,
      summary: e.summary,
      ...(e.tags ? { tags: e.tags } : {}),
      ...(e.updated ? { updated: e.updated } : {}),
      ...(e.sourceCount !== undefined ? { sourceCount: e.sourceCount } : {}),
      ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
      ...(e.type ? { type: e.type } : {}),
      owner: e.owner ?? e.tenant,
    }));
  }
  // Fallback: derive the public, non-agent set from the flat index.
  return (await listWikiPages()).filter((p) => belongsInCommons(p));
}

async function putCommonsIndex(entries: CommonsEntry[]): Promise<void> {
  await getStorage().putIndex(COMMONS_KEY, entries);
}

/** Insert or update a commons entry, keyed by `(tenant, slug)`. */
export async function upsertCommonsEntry(entry: CommonsEntry): Promise<void> {
  await withFileLock(COMMONS_LOCK, async () => {
    const entries = await getCommonsIndex();
    const i = entries.findIndex(
      (e) => e.tenant === entry.tenant && e.slug === entry.slug,
    );
    if (i === -1) entries.push(entry);
    else entries[i] = entry;
    await putCommonsIndex(entries);
  });
}

/** Remove a commons entry (no-op if absent). */
export async function removeCommonsEntry(
  tenant: string,
  slug: string,
): Promise<void> {
  await withFileLock(COMMONS_LOCK, async () => {
    const entries = await getCommonsIndex();
    const next = entries.filter(
      (e) => !(e.tenant === tenant && e.slug === slug),
    );
    if (next.length !== entries.length) await putCommonsIndex(next);
  });
}

/**
 * Remove any commons entry for a slug regardless of tenant. Safe while slugs
 * are globally unique (pre-migration); used by the delete path where the
 * owner may not be readily available.
 */
export async function removeCommonsEntryBySlug(slug: string): Promise<void> {
  await withFileLock(COMMONS_LOCK, async () => {
    const entries = await getCommonsIndex();
    const next = entries.filter((e) => e.slug !== slug);
    if (next.length !== entries.length) await putCommonsIndex(next);
  });
}

/**
 * Sync one page into/out of the commons after a write. Fail-soft: a commons
 * error must never break the underlying page write. `tenant` defaults to the
 * page owner (or {@link DEFAULT_TENANT} when ownerless).
 */
export async function syncCommonsForPage(
  slug: string,
  meta: {
    owner?: string;
    visibility?: string;
    type?: string;
    title: string;
    summary: string;
    tags?: string[];
    updated?: string;
    sourceCount?: number;
    confidence?: number;
  },
): Promise<void> {
  const tenant = tenantForOwner(meta.owner);
  if (belongsInCommons(meta)) {
    await upsertCommonsEntry({
      tenant,
      owner: meta.owner?.trim() || undefined,
      slug,
      title: meta.title,
      summary: meta.summary,
      tags: meta.tags,
      updated: meta.updated,
      sourceCount: meta.sourceCount,
      confidence: meta.confidence,
      type: meta.type,
    });
  } else {
    await removeCommonsEntry(tenant, slug);
  }
}

/**
 * Rebuild the entire commons index from the current (flat) wiki index. Used by
 * the migration and as a repair tool. Scans every page, keeps the public,
 * non-agent ones, and replaces the stored index in one write.
 */
export async function rebuildCommonsIndex(): Promise<number> {
  const pages = await listWikiPages();
  const entries: CommonsEntry[] = pages
    .filter((p) => belongsInCommons(p))
    .map((p) => ({
      tenant: tenantForOwner(p.owner),
      owner: p.owner?.trim() || undefined,
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      tags: p.tags,
      updated: p.updated,
      sourceCount: p.sourceCount,
      confidence: p.confidence,
      type: p.type,
    }));
  await withFileLock(COMMONS_LOCK, async () => {
    await putCommonsIndex(entries);
  });
  return entries.length;
}
