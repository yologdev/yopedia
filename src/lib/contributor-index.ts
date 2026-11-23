/**
 * Precomputed **contributor** index (Phase 2 — precomputed KV indexes).
 *
 * Serializes the wiki-wide contributor scan ({@link computeScanData}) into a KV
 * blob so the homepage and `/wiki/contributors` can build profiles from an O(1)
 * read instead of re-scanning every page's revisions + every talk thread on
 * each render.
 *
 * Shape:
 * ```
 * {
 *   authors: Record<handle, {
 *     editCount; pagesEdited: string[]; commentCount; threadsCreated;
 *     firstSeen; lastSeen; revertCount
 *   }>,
 *   totals: { revisionCount; contributorCount }
 * }
 * ```
 * Note `pagesEdited` is stored as the SLUG LIST (not a count) so the index can
 * be maintained incrementally (add a slug on edit, recount distinct on read).
 *
 * --- Incremental-vs-rebuild split (this phase) ---
 * The lifecycle write hook maintains, for `op.author`, the cheap "edit" facts:
 *   editCount, pagesEdited, firstSeen, lastSeen   (and decrements on delete).
 * The talk hook maintains commentCount / threadsCreated for the commenter.
 * `revertCount` is LEFT to the daily rebuild: it's a pairwise diff over a page's
 * revision history (not a single-author fact), and it only feeds a capped trust
 * score, so up-to-24h lag is invisible. `totals` are recomputed cheaply on read
 * from the authors map, so they never drift. The daily rebuild reconciles
 * everything from ground truth.
 *
 * Behavior-preserving: the read site falls back to the live scan whenever the
 * index is empty/missing.
 */

import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import {
  computeScanData,
  computeTrustScore,
  type ContributorScanData,
} from "./contributors";
import type { ContributorProfile } from "./types";

/** KV/derived-index key (`_idx:contributors`). */
const CONTRIBUTOR_INDEX_KEY = "contributors";
/** Single global lock — the authors map is global. */
const CONTRIBUTOR_INDEX_LOCK = "contributors-index";

/** Per-author aggregate stored in the index. */
export interface ContributorIndexAuthor {
  editCount: number;
  /** Distinct slugs edited (stored as a list for incremental maintenance). */
  pagesEdited: string[];
  commentCount: number;
  threadsCreated: number;
  firstSeen: string;
  lastSeen: string;
  revertCount: number;
  /** Number of this author's edited pages that carry `disputed: true`.
   *  Set by the daily rebuild; incremental hooks leave it to reconcile. */
  disputedPageCount: number;
  /** Number of this author's edited pages that have at least one external
   *  (non-text) source. Set by the daily rebuild. */
  citedPageCount: number;
}

/** The full contributor index blob. */
export interface ContributorIndex {
  authors: Record<string, ContributorIndexAuthor>;
  totals: { revisionCount: number; contributorCount: number };
}

const EPOCH = new Date(0).toISOString();

function emptyIndexAuthor(): ContributorIndexAuthor {
  return {
    editCount: 0,
    pagesEdited: [],
    commentCount: 0,
    threadsCreated: 0,
    firstSeen: "",
    lastSeen: "",
    revertCount: 0,
    disputedPageCount: 0,
    citedPageCount: 0,
  };
}

/**
 * Read the contributor index, or `null` when absent/corrupt. Returns `null`
 * (not an empty index) so callers can distinguish "no index → fall back to the
 * live scan" from "index present but empty → genuinely no contributors".
 */
export async function getContributorIndex(): Promise<ContributorIndex | null> {
  try {
    const idx = await getStorage().getIndex<ContributorIndex>(CONTRIBUTOR_INDEX_KEY);
    if (!idx || typeof idx !== "object" || !idx.authors) return null;
    return idx;
  } catch (err) {
    logger.warn("contributor-index", "contributor index unreadable; treating as absent:", err);
    return null;
  }
}

async function putContributorIndex(idx: ContributorIndex): Promise<void> {
  await getStorage().putIndex(CONTRIBUTOR_INDEX_KEY, idx);
}

/** Recompute `totals` from the authors map (cheap; keeps totals from drifting). */
function computeTotals(
  authors: Record<string, ContributorIndexAuthor>,
): ContributorIndex["totals"] {
  let revisionCount = 0;
  let contributorCount = 0;
  for (const a of Object.values(authors)) {
    revisionCount += a.editCount;
    contributorCount += 1;
  }
  return { revisionCount, contributorCount };
}

/** Build a {@link ContributorProfile} from one stored author aggregate. */
function profileFromIndexAuthor(
  handle: string,
  a: ContributorIndexAuthor,
): ContributorProfile {
  const pagesEdited = new Set(a.pagesEdited).size;
  const disputedPageCount = a.disputedPageCount ?? 0;
  const disputedPageRate = pagesEdited > 0 ? disputedPageCount / pagesEdited : 0;
  const citedPageCount = a.citedPageCount ?? 0;
  const citedPageRate = pagesEdited > 0 ? citedPageCount / pagesEdited : 0;
  return {
    handle,
    editCount: a.editCount,
    pagesEdited,
    commentCount: a.commentCount,
    threadsCreated: a.threadsCreated,
    firstSeen: a.firstSeen || EPOCH,
    lastSeen: a.lastSeen || EPOCH,
    revertCount: a.revertCount,
    disputedPageCount,
    disputedPageRate,
    citedPageRate,
    trustScore: computeTrustScore(a.editCount, a.commentCount, a.revertCount, disputedPageRate, citedPageRate),
  };
}

/**
 * Build ONE handle's profile from the index, or `null` when the index is ABSENT
 * (the caller should then fall back to the live scan). A handle missing from a
 * PRESENT index has no recorded public contributions → an empty profile, so the
 * caller still avoids the scan. This is the O(1) read behind the `/u/<handle>`
 * profile + `/api/contributors/<handle>` (mirrors {@link profilesFromIndex} for
 * a single handle).
 */
export async function contributorProfileFromIndex(
  handle: string,
): Promise<ContributorProfile | null> {
  const idx = await getContributorIndex();
  if (!idx) return null;
  return profileFromIndexAuthor(handle, idx.authors[handle] ?? emptyIndexAuthor());
}

/** Build the full sorted profile list from the index (homepage / contributors page). */
export function profilesFromIndex(idx: ContributorIndex): ContributorProfile[] {
  const profiles = Object.entries(idx.authors).map(([handle, a]) =>
    profileFromIndexAuthor(handle, a),
  );
  profiles.sort(
    (x, y) => y.editCount - x.editCount || x.handle.localeCompare(y.handle),
  );
  return profiles;
}

// ---------------------------------------------------------------------------
// Incremental maintenance — write path (edits) + talk path (comments/threads)
// ---------------------------------------------------------------------------

/**
 * Record one edit by `author` on `slug` (lifecycle write hook). Bumps editCount,
 * adds the slug to pagesEdited, and advances firstSeen/lastSeen. `date` defaults
 * to now. Leaves revertCount to the daily rebuild.
 */
export async function recordEditForAuthor(
  author: string,
  slug: string,
  date: string = new Date().toISOString(),
): Promise<void> {
  if (!author) return;
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    const idx = await getContributorIndex();
    if (!idx) return; // No index yet → daily rebuild seeds it; don't fabricate one.
    const a = idx.authors[author] ?? emptyIndexAuthor();
    a.editCount += 1;
    if (!a.pagesEdited.includes(slug)) a.pagesEdited.push(slug);
    if (!a.firstSeen || date < a.firstSeen) a.firstSeen = date;
    if (!a.lastSeen || date > a.lastSeen) a.lastSeen = date;
    idx.authors[author] = a;
    idx.totals = computeTotals(idx.authors);
    await putContributorIndex(idx);
  });
}

/**
 * Reverse one edit by `author` on `slug` (lifecycle delete hook). Decrements
 * editCount and drops the slug from pagesEdited. firstSeen/lastSeen and
 * revertCount are reconciled by the daily rebuild (cheap to leave stale).
 */
export async function reverseEditForAuthor(
  author: string,
  slug: string,
): Promise<void> {
  if (!author) return;
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    const idx = await getContributorIndex();
    if (!idx) return;
    const a = idx.authors[author];
    if (!a) return;
    a.editCount = Math.max(0, a.editCount - 1);
    a.pagesEdited = a.pagesEdited.filter((s) => s !== slug);
    idx.authors[author] = a;
    idx.totals = computeTotals(idx.authors);
    await putContributorIndex(idx);
  });
}

/**
 * Record talk activity for `author` (talk hook): one comment, and optionally a
 * new thread. Advances firstSeen/lastSeen. Idempotency is not guaranteed — call
 * exactly once per new comment/thread; the daily rebuild reconciles drift.
 */
export async function recordTalkForAuthor(
  author: string,
  opts: { comment?: boolean; thread?: boolean; date?: string } = {},
): Promise<void> {
  if (!author) return;
  const date = opts.date ?? new Date().toISOString();
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    const idx = await getContributorIndex();
    if (!idx) return;
    const a = idx.authors[author] ?? emptyIndexAuthor();
    if (opts.comment) a.commentCount += 1;
    if (opts.thread) a.threadsCreated += 1;
    if (!a.firstSeen || date < a.firstSeen) a.firstSeen = date;
    if (!a.lastSeen || date > a.lastSeen) a.lastSeen = date;
    idx.authors[author] = a;
    idx.totals = computeTotals(idx.authors);
    await putContributorIndex(idx);
  });
}

// ---------------------------------------------------------------------------
// Rebuild — serialize a full scan into the index shape
// ---------------------------------------------------------------------------

/** Serialize {@link ContributorScanData} into the persisted index shape. */
export function scanDataToIndex(data: ContributorScanData): ContributorIndex {
  const authors: Record<string, ContributorIndexAuthor> = {};
  for (const [handle, act] of data.activityMap) {
    const sorted = act.dates.slice().sort();
    // Count how many of this author's edited pages are disputed / cited.
    let disputedPageCount = 0;
    let citedPageCount = 0;
    for (const slug of act.pagesEdited) {
      if (data.disputedSlugs.has(slug)) disputedPageCount++;
      if (data.citedSlugs.has(slug)) citedPageCount++;
    }
    authors[handle] = {
      editCount: act.editCount,
      pagesEdited: [...act.pagesEdited],
      commentCount: act.commentCount,
      threadsCreated: act.threadsCreated,
      firstSeen: sorted.length > 0 ? sorted[0] : EPOCH,
      lastSeen: sorted.length > 0 ? sorted[sorted.length - 1] : EPOCH,
      revertCount: data.revertCounts.get(handle) ?? 0,
      disputedPageCount,
      citedPageCount,
    };
  }
  return { authors, totals: computeTotals(authors) };
}

/**
 * Rebuild the contributor index from a full wiki scan. Repair tool + daily
 * self-heal. Uses the same scan (`computeScanData`) the live read path uses, so
 * the index is byte-for-byte consistent with the fallback.
 */
export async function rebuildContributorIndex(): Promise<ContributorIndex> {
  const data = await computeScanData(null);
  const idx = scanDataToIndex(data);
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    await putContributorIndex(idx);
  });
  return idx;
}
