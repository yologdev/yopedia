import { getWikiDir, wikiRelPath, validateSlug, tenantWikiRelPath } from "./wiki";
import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Revision history — store full-page snapshots before every overwrite
// ---------------------------------------------------------------------------
//
// Revisions live in `wiki/.revisions/<slug>/` as timestamped markdown files.
// Each file is the complete page content (including frontmatter) at that
// point in time — simple, no diffs, easy to reason about.
//
// The founding vision says "the wiki is just a git repo… you get version
// history for free." This module provides that version history without
// requiring git on the server.

/** Metadata about a single page revision (the content itself is on disk). */
export interface Revision {
  /** Unix timestamp in milliseconds — also the filename stem. */
  timestamp: number;
  /** ISO 8601 date string for display. */
  date: string;
  /** Page slug this revision belongs to. */
  slug: string;
  /** Byte length of the revision content. */
  sizeBytes: number;
  /** Who made this change — undefined for legacy revisions without attribution. */
  author?: string;
  /** Edit summary — why this change was made. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

const REVISIONS_DIR_NAME = ".revisions";

/** Return the revisions directory for a given slug. */
export function getRevisionsDir(slug: string): string {
  return `${getWikiDir()}/${REVISIONS_DIR_NAME}/${slug}`;
}

/**
 * Compute a storage-relative path for a revision file.
 *
 * All revision files live under `wiki/.revisions/<slug>/`. This helper
 * builds the relative path that the StorageProvider expects.
 */
function revisionsRelPath(...segments: string[]): string {
  return wikiRelPath([REVISIONS_DIR_NAME, ...segments].join("/"));
}

/**
 * Compute a storage-relative path for a revision file in a tenant silo.
 *
 * Mirrors {@link revisionsRelPath} but routes through `tenantWikiRelPath`
 * so revisions land under `tenants/<tenant>/wiki/.revisions/<slug>/`.
 */
function tenantRevisionsRelPath(tenant: string, ...segments: string[]): string {
  return tenantWikiRelPath(tenant, [REVISIONS_DIR_NAME, ...segments].join("/"));
}

/**
 * The revision roots for a slug, in read precedence order.
 *
 * Flat retirement (#869) moved PAGES into tenant silos, but the one-shot
 * migration only copied pages and raw sources — the `.revisions/` archive was
 * never moved. So a page edited before revisions became tenant-aware has its
 * history under the flat root, and everything written since lives in its silo.
 * Reads therefore consult BOTH: silo first (authoritative for anything recent),
 * then the un-migrated flat archive.
 *
 * This is deliberately NOT the flat fallback that flat retirement removes from
 * `readWikiPage`. That one existed because writes went to two places; this one
 * exists because historical data still sits in one place. It can go away once a
 * migration moves `.revisions/` into the silos.
 *
 * `tenant` short-circuits the lookup for callers that already know it (the
 * write path). Otherwise the tenant is resolved from the page index, the same
 * way `readWikiPage` resolves a page's location.
 */
async function revisionRootsFor(
  slug: string,
  tenant?: string,
): Promise<((...segments: string[]) => string)[]> {
  let effective = tenant;
  if (effective === undefined) {
    const { getPageIndex } = await import("./page-index");
    const { ownerToTenant } = await import("./links");
    const idx = await getPageIndex();
    effective = ownerToTenant(idx?.[slug]?.owner);
  }
  return [
    (...segments: string[]) => tenantRevisionsRelPath(effective, ...segments),
    (...segments: string[]) => revisionsRelPath(...segments),
  ];
}

// ---------------------------------------------------------------------------
// Monotonic timestamp — ensures unique filenames even when multiple
// revisions are saved within the same millisecond.
// ---------------------------------------------------------------------------

let lastTimestamp = 0;

function uniqueTimestamp(): number {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return lastTimestamp;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Save a snapshot of `content` as a revision for `slug`.
 *
 * Called by `writeWikiPage()` **before** the file is overwritten, so the
 * previous version is preserved. New pages (first write) skip this step
 * because there is no previous content to snapshot.
 *
 * When `author` or `reason` is provided, a JSON sidecar (`<timestamp>.meta.json`)
 * is written alongside the `.md` file to record attribution and edit summary
 * without changing the markdown file format.
 *
 * When `tenant` is provided, revisions are stored in the tenant silo path
 * (`tenants/<tenant>/wiki/.revisions/<slug>/`) instead of the flat path.
 */
export async function saveRevision(
  slug: string,
  content: string,
  author?: string,
  reason?: string,
  tenant?: string,
): Promise<void> {
  validateSlug(slug);
  const storage = getStorage();
  const timestamp = uniqueTimestamp();
  const relPath = tenant
    ? tenantRevisionsRelPath(tenant, slug, `${timestamp}.md`)
    : revisionsRelPath(slug, `${timestamp}.md`);
  await storage.writeFile(relPath, content);

  // Write attribution/reason as a JSON sidecar when provided.
  if (author !== undefined || reason !== undefined) {
    const meta: Record<string, string> = {};
    if (author !== undefined) meta.author = author;
    if (reason !== undefined) meta.reason = reason;
    const metaRelPath = tenant
      ? tenantRevisionsRelPath(tenant, slug, `${timestamp}.meta.json`)
      : revisionsRelPath(slug, `${timestamp}.meta.json`);
    await storage.writeFile(metaRelPath, JSON.stringify(meta));
  }
}

/**
 * Move a page's revision archive between tenant silos.
 *
 * History belongs to the page, so when an ownership change relocates the page
 * its revisions have to follow — otherwise the archive is orphaned under the
 * previous owner where nothing resolves it. Best-effort: a failure here leaves
 * history behind but never blocks the write.
 */
export async function moveRevisions(
  slug: string,
  fromTenant: string,
  toTenant: string,
): Promise<void> {
  if (fromTenant === toTenant) return;
  validateSlug(slug);
  const storage = getStorage();
  const fromDir = tenantRevisionsRelPath(fromTenant, slug);
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = await storage.listFiles(fromDir);
  } catch (err) {
    if (!isEnoent(err)) {
      logger.warn("revisions", `could not list revisions of "${slug}" for move:`, err);
    }
    return; // nothing to move
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    try {
      const body = await storage.readFile(tenantRevisionsRelPath(fromTenant, slug, entry.name));
      await storage.writeFile(tenantRevisionsRelPath(toTenant, slug, entry.name), body);
      await storage.deleteFile(tenantRevisionsRelPath(fromTenant, slug, entry.name));
    } catch (err) {
      logger.warn(
        "revisions",
        `could not move revision "${slug}/${entry.name}" to "${toTenant}":`,
        err,
      );
    }
  }
}

/**
 * List all revisions for a page, newest first.
 *
 * Returns an empty array when no revisions exist (new page or never edited).
 */
export async function listRevisions(slug: string, tenant?: string): Promise<Revision[]> {
  validateSlug(slug);
  const storage = getStorage();
  const roots = await revisionRootsFor(slug, tenant);

  // Union the silo and the un-migrated flat archive: a page edited either side
  // of the tenant switch has history in both, and the UI must show one
  // timeline. The first root to yield a timestamp wins, so a revision copied
  // into the silo shadows its flat original instead of double-listing.
  const seen = new Set<string>();
  const entries: { name: string; isDirectory: boolean; at: (...s: string[]) => string }[] = [];
  for (const at of roots) {
    let found: { name: string; isDirectory: boolean }[];
    try {
      found = await storage.listFiles(at(slug));
    } catch (err) {
      // Directory doesn't exist → nothing from this root.
      if (!isEnoent(err)) {
        logger.warn("revisions", `unexpected error reading revision dir for "${slug}":`, err);
      }
      continue;
    }
    for (const e of found) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      entries.push({ ...e, at });
    }
  }
  if (entries.length === 0) return [];

  // Read each revision's stat + optional meta sidecar CONCURRENTLY. The old
  // serial loop did 2 sequential storage round-trips (stat, then meta) per
  // revision, so a heavily-revised page cost O(revisions) round-trips — which
  // dominated the user-profile activity trail (it scans up to 30 pages, gated by
  // the worst one). Mapping in parallel collapses each page to ~2 round-trips
  // DEEP (all stats overlap, then all metas) — the op COUNT is unchanged, only
  // the latency.
  const built = await Promise.all(
    entries.map(async (entry): Promise<Revision | null> => {
      if (entry.isDirectory || !entry.name.endsWith(".md")) return null;
      const stem = entry.name.slice(0, -3); // strip ".md"
      const timestamp = Number(stem);
      if (Number.isNaN(timestamp) || timestamp <= 0) return null;

      try {
        const stat = await storage.stat(entry.at(slug, entry.name));

        // Read the optional author/reason sidecar.
        let author: string | undefined;
        let reason: string | undefined;
        try {
          const metaRaw = await storage.readFile(entry.at(slug, `${stem}.meta.json`));
          const meta = JSON.parse(metaRaw) as { author?: string; reason?: string };
          if (typeof meta.author === "string") {
            author = meta.author;
          }
          if (typeof meta.reason === "string") {
            reason = meta.reason;
          }
        } catch {
          // No sidecar → no author/reason attribution (backward compat).
        }

        return {
          timestamp,
          date: new Date(timestamp).toISOString(),
          slug,
          sizeBytes: stat.size,
          ...(author !== undefined && { author }),
          ...(reason !== undefined && { reason }),
        };
      } catch (err) {
        // File disappeared between listFiles and stat — skip.
        if (!isEnoent(err)) {
          logger.warn("revisions", `unexpected error stating revision file "${entry.name}":`, err);
        }
        return null;
      }
    }),
  );

  // Sort newest first.
  return built
    .filter((r): r is Revision => r !== null)
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** A revision's attribution, without the `stat`/`sizeBytes` an activity feed never shows. */
export interface RevisionAuthor {
  timestamp: number;
  date: string;
  author?: string;
  reason?: string;
}

/**
 * Lighter-weight revision lister for activity feeds (the trail). Unlike
 * {@link listRevisions} it does NOT `stat` each revision — feeds never show
 * `sizeBytes`, and that stat was a wasted round-trip per revision. The timestamp
 * is parsed from the filename, so ranking and the `max` cap need ZERO
 * per-revision reads (just the one directory listing). It then reads a
 * `.meta.json` sidecar ONLY for revisions whose sidecar appears in that same
 * listing (for author/reason) — an unattributed revision costs no read at all.
 *
 * Why it matters: the user-profile / recent trail scans many pages, each with
 * potentially many revisions. `listRevisions` cost O(total revisions × 2 reads);
 * this costs O(pages × min(ATTRIBUTED revisions, max)) reads — the dominant cost
 * of that scan. `max` bounds per-page work because a feed only surfaces a page's
 * most RECENT edits anyway (older ones can't out-rank other pages' in the cap).
 */
export async function listRevisionAuthors(
  slug: string,
  max: number,
  tenant?: string,
): Promise<RevisionAuthor[]> {
  validateSlug(slug);
  const storage = getStorage();
  const roots = await revisionRootsFor(slug, tenant);

  // Same silo + flat-archive union as listRevisions; `metaAt` remembers which
  // root a sidecar came from so the attribution read hits the right one.
  const metaAt = new Map<number, (...s: string[]) => string>();
  const entries: { name: string; isDirectory: boolean }[] = [];
  const seen = new Set<string>();
  for (const at of roots) {
    let found: { name: string; isDirectory: boolean }[];
    try {
      found = await storage.listFiles(at(slug));
    } catch (err) {
      if (!isEnoent(err)) {
        logger.warn("revisions", `unexpected error reading revision dir for "${slug}":`, err);
      }
      continue;
    }
    for (const e of found) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      entries.push(e);
      if (!e.isDirectory && e.name.endsWith(".meta.json")) {
        const ts = Number(e.name.slice(0, -".meta.json".length));
        if (Number.isFinite(ts) && ts > 0) metaAt.set(ts, at);
      }
    }
  }
  if (entries.length === 0) return [];

  // One `listFiles` gives us BOTH the revisions (`<ts>.md`) and which of them
  // carry an attribution sidecar (`<ts>.meta.json`). Build the sidecar set here
  // so we read attribution ONLY where it exists — never paying an ENOENT
  // round-trip for an unattributed (legacy/human) revision. Timestamps come from
  // the filenames, so ranking + the `max` cap need no reads at all.
  const sidecars = new Set<number>();
  const mdStems: number[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.name.endsWith(".meta.json")) {
      const ts = Number(entry.name.slice(0, -".meta.json".length));
      if (Number.isFinite(ts) && ts > 0) sidecars.add(ts);
    } else if (entry.name.endsWith(".md")) {
      const ts = Number(entry.name.slice(0, -3));
      if (Number.isFinite(ts) && ts > 0) mdStems.push(ts);
    }
  }
  const stems = mdStems.sort((a, b) => b - a).slice(0, Math.max(0, max));

  return Promise.all(
    stems.map(async (timestamp): Promise<RevisionAuthor> => {
      const base: RevisionAuthor = { timestamp, date: new Date(timestamp).toISOString() };
      // No sidecar in the listing → unattributed; a valid event, but no read.
      if (!sidecars.has(timestamp)) return base;
      try {
        const at = metaAt.get(timestamp) ?? roots[0];
        const raw = await storage.readFile(at(slug, `${timestamp}.meta.json`));
        const meta = JSON.parse(raw) as { author?: string; reason?: string };
        if (typeof meta.author === "string") base.author = meta.author;
        if (typeof meta.reason === "string") base.reason = meta.reason;
      } catch (err) {
        // The sidecar was in the listing but is unreadable/corrupt — NOT expected
        // (we just saw it): surface it (matching readRevisionMeta and this file's
        // convention) rather than silently dropping the attribution.
        if (!isEnoent(err)) {
          logger.warn(
            "revisions",
            `unexpected error reading revision meta "${slug}@${timestamp}":`,
            err,
          );
        }
      }
      return base;
    }),
  );
}

/**
 * Read a specific revision's content.
 *
 * Returns `null` when the revision does not exist.
 */
export async function readRevision(
  slug: string,
  timestamp: number,
  tenant?: string,
): Promise<string | null> {
  validateSlug(slug);
  for (const at of await revisionRootsFor(slug, tenant)) {
    try {
      return await getStorage().readFile(at(slug, `${timestamp}.md`));
    } catch (err) {
      if (!isEnoent(err)) {
        logger.warn("revisions", `unexpected error reading revision "${slug}@${timestamp}":`, err);
        return null;
      }
      // Not in this root — try the next (silo, then the flat archive).
    }
  }
  return null;
}

/** Metadata from a revision's `.meta.json` sidecar file. */
export interface RevisionMeta {
  author?: string;
  reason?: string;
}

/**
 * Read the metadata sidecar for a specific revision.
 *
 * Returns the parsed `{ author?, reason? }` when the sidecar exists,
 * or `null` when there is no sidecar (legacy revisions without attribution).
 */
export async function readRevisionMeta(
  slug: string,
  timestamp: number,
  tenant?: string,
): Promise<RevisionMeta | null> {
  validateSlug(slug);
  for (const at of await revisionRootsFor(slug, tenant)) {
    let raw: string;
    try {
      raw = await getStorage().readFile(at(slug, `${timestamp}.meta.json`));
    } catch (err) {
      if (!isEnoent(err)) {
        logger.warn("revisions", `unexpected error reading revision meta "${slug}@${timestamp}":`, err);
        return null;
      }
      continue; // no sidecar in this root — try the flat archive
    }
    try {
      const meta = JSON.parse(raw) as Record<string, unknown>;
      const result: RevisionMeta = {};
      if (typeof meta.author === "string") result.author = meta.author;
      if (typeof meta.reason === "string") result.reason = meta.reason;
      return result;
    } catch (err) {
      logger.warn("revisions", `malformed revision meta "${slug}@${timestamp}":`, err);
      return null;
    }
  }
  return null;
}

/**
 * Delete all revisions for a page.
 *
 * Called when a page is permanently deleted so we don't leave orphaned
 * revision data on disk.
 */
export async function deleteRevisions(slug: string, tenant?: string): Promise<void> {
  validateSlug(slug);
  // Clear BOTH roots — a page deleted today may still have flat-archive history.
  for (const at of await revisionRootsFor(slug, tenant)) {
    try {
      await getStorage().deleteDirectory(at(slug));
    } catch (err) {
      // Already gone — nothing to do.
      if (!isEnoent(err)) {
        logger.warn("revisions", `unexpected error deleting revisions for "${slug}":`, err);
      }
    }
  }
}
