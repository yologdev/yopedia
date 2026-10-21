// ---------------------------------------------------------------------------
// Contributor profiles — Phase 2 trust and attribution (data layer)
// ---------------------------------------------------------------------------
//
// Aggregates activity from two data sources:
//   1. Revision history — edits and page counts
//   2. Talk page discussions — comments and threads created
//
// Scan data (revisions + reverts + threads) can be computed once and shared
// across multiple profile builds, avoiding the N+1 problem when rendering
// badges for several authors on a single page.
// ---------------------------------------------------------------------------

import { getStorage } from "./storage";
import { listReadableWikiPages, isAgentScopedType, tenantForOwner } from "./wiki";
import type { Principal } from "./auth";
import { listRevisions, type Revision } from "./revisions";
import { getDiscussRelPrefix } from "./talk";
import { isEnoent } from "./errors";
import { logger } from "./logger";
import { normalizeActor, isAutomationActor } from "./agent-handle";
import type { ContributorProfile, TalkThread } from "./types";

// ---------------------------------------------------------------------------
// Internal: scan discuss directory for all thread files
// ---------------------------------------------------------------------------

/** Read and parse all discuss JSON files. Returns an array of TalkThread[]. */
async function loadAllThreads(): Promise<TalkThread[]> {
  const prefix = getDiscussRelPrefix();
  const storage = getStorage();
  let files: string[];
  try {
    const entries = await storage.listFiles(prefix);
    files = entries.map((e) => e.name);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const all: TalkThread[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await storage.readFile(`${prefix}/${file}`);
      const threads = JSON.parse(raw) as TalkThread[];
      if (Array.isArray(threads)) {
        all.push(...threads);
      }
    } catch {
      // Malformed file — skip silently.
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Internal: aggregate raw activity data
// ---------------------------------------------------------------------------

export interface AuthorActivity {
  editCount: number;
  pagesEdited: Set<string>;
  commentCount: number;
  threadsCreated: number;
  dates: string[];
}

export function emptyActivity(): AuthorActivity {
  return {
    editCount: 0,
    pagesEdited: new Set(),
    commentCount: 0,
    threadsCreated: 0,
    dates: [],
  };
}

/** Reduce per-page revision lists into activity keyed by author handle. Pure —
 *  the storage reads happen once in {@link computeScanData}. */
export function reduceActivity(
  revisionsPerPage: Revision[][],
): Map<string, AuthorActivity> {
  const map = new Map<string, AuthorActivity>();
  for (const revisions of revisionsPerPage) {
    for (const rev of revisions) {
      if (!rev.author) continue;
      const author = normalizeActor(rev.author);
      let act = map.get(author);
      if (!act) {
        act = emptyActivity();
        map.set(author, act);
      }
      act.editCount++;
      act.pagesEdited.add(rev.slug);
      act.dates.push(rev.date);
    }
  }
  return map;
}

/** Merge talk-page activity into an existing activity map. */
export function mergeTalkActivity(
  map: Map<string, AuthorActivity>,
  threads: TalkThread[],
): void {
  for (const thread of threads) {
    for (let i = 0; i < thread.comments.length; i++) {
      const comment = thread.comments[i];
      const author = normalizeActor(comment.author);
      let act = map.get(author);
      if (!act) {
        act = emptyActivity();
        map.set(author, act);
      }
      act.commentCount++;
      act.dates.push(comment.created);

      // The first comment (index 0) is the thread creator.
      if (i === 0) {
        act.threadsCreated++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Revert detection
// ---------------------------------------------------------------------------

/** Size reduction threshold — a revision must shrink the previous content by
 *  more than this fraction to count as a revert. */
const REVERT_SIZE_REDUCTION_THRESHOLD = 0.5;

/**
 * Detect "reverts" from per-page revision lists — cases where revision N+1 by
 * author B substantially reduces the content of revision N by author A (>50%
 * size reduction). Pure; storage reads happen once in {@link computeScanData}.
 *
 * Returns a map from author handle → number of times their content was reverted.
 */
export function reduceReverts(revisionsPerPage: Revision[][]): Map<string, number> {
  const revertCounts = new Map<string, number>();

  for (const revisions of revisionsPerPage) {
    if (revisions.length < 2) continue;

    // listRevisions returns newest-first; we need chronological order.
    const chronological = revisions.slice().reverse();

    for (let i = 0; i < chronological.length - 1; i++) {
      const current = chronological[i];
      const next = chronological[i + 1];

      // Both revisions must have authors, and they must be different.
      if (!current.author || !next.author) continue;
      const currentAuthor = normalizeActor(current.author);
      const nextAuthor = normalizeActor(next.author);
      if (currentAuthor === nextAuthor) continue;

      // Check if the next revision substantially reduced the content size.
      if (current.sizeBytes === 0) continue;
      const reduction = (current.sizeBytes - next.sizeBytes) / current.sizeBytes;
      if (reduction > REVERT_SIZE_REDUCTION_THRESHOLD) {
        const count = revertCounts.get(currentAuthor) ?? 0;
        revertCounts.set(currentAuthor, count + 1);
      }
    }
  }

  return revertCounts;
}

// ---------------------------------------------------------------------------
// Trust score
// ---------------------------------------------------------------------------

/** Compute trust score from activity counts and revert rate.
 *  Formula: min(1, (editCount + commentCount) / 50) * (1 - min(0.5, revertCount * 0.1))
 *  Each revert reduces trust by 10%, capped at 50% reduction. */
export function computeTrustScore(editCount: number, commentCount: number, revertCount: number): number {
  const activityScore = Math.min(1, (editCount + commentCount) / 50);
  const revertPenalty = 1 - Math.min(0.5, revertCount * 0.1);
  return activityScore * revertPenalty;
}

// ---------------------------------------------------------------------------
// Shared scan data — compute once, reuse for multiple profile builds
// ---------------------------------------------------------------------------

/** Pre-computed wiki-wide scan data shared across profile builds. */
export interface ContributorScanData {
  /** Revision activity per author handle. */
  activityMap: Map<string, AuthorActivity>;
  /** Revert counts per author handle. */
  revertCounts: Map<string, number>;
}

/**
 * Perform a single wiki-wide scan: revision activity, talk threads, and
 * revert detection. Returns data that can be passed to profile builders
 * to avoid redundant scans.
 */
export async function computeScanData(
  principal: Principal | null = null,
): Promise<ContributorScanData> {
  // Human pages only — agent-scoped pages are authored by the agent itself
  // (e.g. "yuanhao--yoyo"), not a human contributor, so their revisions never
  // factor in. Filtering here also means we never read them.
  const pages = (await listReadableWikiPages(principal)).filter(
    (p) => !isAgentScopedType(p.type),
  );

  // Read every page's revisions ONCE, in parallel, and reuse the result for
  // both the activity scan and revert detection. Previously each of those
  // re-read all revisions in a serial await-in-loop — N pages turned into N
  // sequential storage round-trips, twice, the dominant cost on the homepage.
  // Threads load concurrently in the same barrier.
  const [revisionsPerPage, threads] = await Promise.all([
    Promise.all(pages.map((p) => listRevisions(p.slug, tenantForOwner(p.owner)))),
    loadAllThreads(),
  ]);

  const activityMap = reduceActivity(revisionsPerPage);
  mergeTalkActivity(activityMap, threads);
  const revertCounts = reduceReverts(revisionsPerPage);
  return { activityMap, revertCounts };
}

// ---------------------------------------------------------------------------
// Profile builder
// ---------------------------------------------------------------------------

function buildProfileFromActivity(
  handle: string,
  act: AuthorActivity,
  revertCount: number,
): ContributorProfile {
  // Sort dates chronologically to find first/last.
  const sorted = act.dates.slice().sort();
  const firstSeen = sorted.length > 0 ? sorted[0] : new Date(0).toISOString();
  const lastSeen =
    sorted.length > 0 ? sorted[sorted.length - 1] : new Date(0).toISOString();

  return {
    handle,
    editCount: act.editCount,
    pagesEdited: act.pagesEdited.size,
    commentCount: act.commentCount,
    threadsCreated: act.threadsCreated,
    firstSeen,
    lastSeen,
    revertCount,
    trustScore: computeTrustScore(act.editCount, act.commentCount, revertCount),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a contributor profile for a specific handle.
 *
 * When `scanData` is provided, the function skips the expensive wiki-wide
 * scan and uses the pre-computed data. This is the recommended path when
 * building profiles for multiple handles (e.g. batch badge rendering).
 *
 * Otherwise it reads the precomputed contributor index (the handle's public
 * edit/comment/thread/trust tallies) — an O(1) read instead of scanning every
 * page's revisions + every discuss file. Only a MISSING index falls through to
 * the live scan (which still honors `principal`). Because the index reflects
 * PUBLIC contributions, the profile shows public-contribution stats — the right
 * thing for this public surface, and consistent with `listContributors`.
 *
 * Returns a zeroed-out profile (not an error) when the handle has no activity.
 */
export async function buildContributorProfile(
  handle: string,
  scanData?: ContributorScanData,
  principal: Principal | null = null,
): Promise<ContributorProfile> {
  if (!scanData) {
    try {
      const { contributorProfileFromIndex } = await import("./contributor-index");
      const fromIndex = await contributorProfileFromIndex(handle);
      if (fromIndex) return fromIndex;
    } catch (err) {
      // The index is purely an accelerator — a module-load or build error here
      // must degrade to the live scan, never crash the profile page awaiting
      // this. Log it (don't swallow silently) so a broken index is visible.
      logger.warn(
        "contributors",
        `contributor-index fast-path failed for "${handle}"; falling back to the live scan:`,
        err,
      );
    }
  }
  const data = scanData ?? (await computeScanData(principal));
  const act = data.activityMap.get(handle) ?? emptyActivity();
  const revertCount = data.revertCounts.get(handle) ?? 0;
  return buildProfileFromActivity(handle, act, revertCount);
}

/**
 * Build contributor profiles for multiple handles in one pass.
 *
 * Scans the wiki once, then builds a profile for each requested handle.
 * Handles with no activity get zeroed-out profiles (included in result).
 *
 * When `scanData` is provided, skips the scan entirely.
 */
export async function buildContributorProfiles(
  handles: string[],
  scanData?: ContributorScanData,
  principal: Principal | null = null,
): Promise<ContributorProfile[]> {
  const data = scanData ?? await computeScanData(principal);
  return handles.map((handle) => {
    const act = data.activityMap.get(handle) ?? emptyActivity();
    const revertCount = data.revertCounts.get(handle) ?? 0;
    return buildProfileFromActivity(handle, act, revertCount);
  });
}

/**
 * Discover all contributors and build a profile for each.
 *
 * Returns profiles sorted by `editCount` descending.
 */
export async function listContributors(
  principal: Principal | null = null,
): Promise<ContributorProfile[]> {
  // Fast path: build profiles from the precomputed contributor index (O(1) read)
  // instead of re-scanning every page's revisions + every talk thread. The index
  // is built from `computeScanData(null)` (ANONYMOUS visibility), so it is only
  // valid for an anonymous viewer. A non-null principal can see its own private
  // pages, so it MUST use the per-principal scan below to match the fallback;
  // taking the anonymous fast path would under-count the viewer's activity.
  // Falls back to the full scan when the index is absent — behavior-preserving.
  if (principal == null) {
    try {
      const { getContributorIndex, profilesFromIndex } = await import(
        "./contributor-index"
      );
      const idx = await getContributorIndex();
      if (idx) return profilesFromIndex(idx).filter(isRealContributor);
    } catch {
      // Fall through to the live scan — the index is purely an accelerator.
    }
  }

  const data = await computeScanData(principal);

  const profiles: ContributorProfile[] = [];
  for (const [handle, act] of data.activityMap) {
    const revertCount = data.revertCounts.get(handle) ?? 0;
    profiles.push(buildProfileFromActivity(handle, act, revertCount));
  }

  // Sort by editCount descending, then handle ascending for stability.
  profiles.sort((a, b) => b.editCount - a.editCount || a.handle.localeCompare(b.handle));
  return profiles.filter(isRealContributor);
}

/** Keep only real contributors. Automation actors (system/lint-fix/yopedia) are
 *  normally folded into the agent by {@link normalizeActor}, but a stale
 *  precomputed index may still carry their raw handles, so exclude them here too.
 *  An empty/whitespace handle is a real data defect (an edit attributed to a
 *  blank author); drop it but log so the upstream bug stays debuggable. */
function isRealContributor(p: ContributorProfile): boolean {
  if (isAutomationActor(p.handle)) return false;
  if (p.handle.trim() === "") {
    logger.warn(
      "contributors",
      `dropping a profile with an empty handle (editCount=${p.editCount}) — upstream attribution defect`,
    );
    return false;
  }
  return true;
}
