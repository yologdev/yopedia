import { listReadableWikiPages, readWikiPageWithFrontmatter, isAgentScopedType, ownerToTenant } from "./wiki";
import { listRevisionAuthors } from "./revisions";
import { parseSources } from "./sources";
import { isAgentHandle } from "./agents";
import { normalizeActor } from "./agent-handle";
import { belongsInCommons } from "./commons";
import { logger } from "./logger";
import type { SourceEntry } from "./types";
import type { Principal } from "./auth";

/** A single event in the public activity trail — the lab's running log. */
export interface TrailEvent {
  /** Sort key: epoch ms. */
  ts: number;
  /** ISO date string for display. */
  when: string;
  /** Who acted — a human handle or an agent id (automation actors like
   * `system`/`lint-fix` are folded to the agent via {@link normalizeActor}). */
  actor: string;
  /** True when the actor is an autonomous agent (e.g. `yoyo`). */
  isAgent: boolean;
  /** What happened. */
  action: "ingested" | "re-ingested" | "edited";
  /** For ingests, the kind of source. */
  sourceType?: SourceEntry["type"];
  slug: string;
  title: string;
  /** Canonical tenant for linking to `/u/<tenant>/<slug>`. */
  tenant: string;
  /**
   * True when the page is a public commons page (`/wiki/<slug>`); false for a
   * private / agent / artifact page that lives only at `/u/<tenant>/<slug>`.
   * Drives the Trail's link target so an owned/artifact page doesn't 404.
   * Optional like {@link sourceType}: absent on entries persisted before this
   * field existed — treat absent as false (owner-scoped, never 404s).
   */
  commons?: boolean;
}

// Bound the work: only scan the most-recently-updated public pages. The trail
// surfaces ~10-12 events and pages sort by `updated` (which every ingest/edit
// bumps), so the freshest 30 pages reliably over-fill the list — reading more
// is wasted I/O on the homepage path.
const MAX_PAGES_SCANNED = 30;

// Per-page revision cap for the trail. A feed only surfaces a page's most RECENT
// edits — older ones can't out-rank other pages' activity within the event cap —
// so reading every revision of every scanned page was the trail's dominant I/O
// (these pages are agent-maintained and accrue many revisions). Reading only the
// newest few per page bounds it; the dedup window collapses same-actor edit
// bursts (within ~2 min) anyway, and across MAX_PAGES_SCANNED pages this still
// over-fills the feed. Measured: the per-revision meta reads dominated the scan,
// so this cap (with the no-stat + skip-unattributed reads) is the main lever.
const MAX_REVISIONS_PER_PAGE = 8;

/**
 * The public activity trail. For anonymous reads (`principal == null` — the
 * homepage path) it serves the precomputed `_idx:recent` index in O(1), falling
 * back to {@link scanTrail} when the index isn't seeded yet. A signed-in caller
 * always scans, so its own private-page activity is included (the index is
 * built public-only — same anonymous-vs-scan split as the contributor index).
 */
export async function getTrail(
  limit = 12,
  principal: Principal | null = null,
): Promise<TrailEvent[]> {
  if (!principal) {
    const { getRecentIndex } = await import("./recent-index");
    const idx = await getRecentIndex();
    // The index stores each event's title as a SNAPSHOT from ingest time, so a
    // page re-ingested under a differently-cased concept ("Agentic systems" →
    // "agentic systems") shows up twice under two names. Resolve to the page's
    // CURRENT title so one page reads as one name. (scanTrail already uses the
    // live page title, so it needs no fixup.)
    if (idx !== null) return withCurrentTitles(idx.slice(0, limit), principal);
  }
  return scanTrail(limit, principal);
}

/** Overwrite each event's snapshot title with the page's current title. */
async function withCurrentTitles(
  events: TrailEvent[],
  principal: Principal | null,
): Promise<TrailEvent[]> {
  if (events.length === 0) return events;
  const titleBySlug = new Map(
    (await listReadableWikiPages(principal)).map((p) => [p.slug, p.title]),
  );
  return events.map((e) => {
    const current = titleBySlug.get(e.slug);
    return current && current !== e.title ? { ...e, title: current } : e;
  });
}

/**
 * The activity trail for ONE owner's profile (the pages a `tenant` owns). Serves
 * the per-owner `recent:<tenant>` index in O(1) when seeded, falling back to the
 * {@link trailEventsForPages} scan and lazily seeding the index from it. This is
 * the profile's analogue of {@link getTrail} for the homepage — it turns an
 * O(pages × revisions) scan into a single KV read once warm.
 *
 * `commonsPages` is the owner's CURRENT public commons pages (the caller already
 * has them). Index events are reconciled against it on every read: any whose page
 * is gone (deleted) or no longer a public commons page (turned private) is dropped
 * at the PAGE level, and snapshot titles are refreshed to the live title. So the
 * index only needs to be append-correct — the write path fans each event out to
 * every owner+contributor tenant, and reads handle page-level removal/renames. It
 * does NOT (and need not) heal a still-public page's events: events are only ever
 * appended, never individually invalidated, so there's nothing to reconcile there.
 */
export async function getOwnerTrail(
  tenant: string,
  commonsPages: { slug: string; title: string; owner?: string }[],
  limit: number,
): Promise<TrailEvent[]> {
  const { getRecentIndex, seedRecentIndexIfAbsent } = await import("./recent-index");
  const idx = await getRecentIndex(tenant);
  if (idx !== null) {
    const titleBySlug = new Map(commonsPages.map((p) => [p.slug, p.title]));
    return idx
      .filter((e) => titleBySlug.has(e.slug)) // drop deleted / now-private pages
      .map((e) => {
        const current = titleBySlug.get(e.slug);
        return current && current !== e.title ? { ...e, title: current } : e;
      })
      .slice(0, limit);
  }
  // Cold: scan, then lazily seed the per-owner index for next time (under the
  // tenant lock + only-if-absent, so a racing push isn't clobbered; fail-soft —
  // a seed failure just means the next view scans again).
  const events = await trailEventsForPages(commonsPages, limit);
  try {
    await seedRecentIndexIfAbsent(events, tenant);
  } catch (err) {
    logger.warn("recent-index", `owner trail seed skipped for "${tenant}":`, err);
  }
  return events;
}

/**
 * Build the activity trail by merging recent ingests (from each page's
 * `sources[]` provenance) and edits (from revision metadata) into one
 * time-sorted feed. Agent-scoped pages are excluded; agent *actors* are kept
 * and flagged via {@link isAgentHandle} so the UI can mark them distinctly.
 *
 * This is the O(pages) scan — the fallback and the source for the `_idx:recent`
 * rebuild. {@link getTrail} serves the index for anonymous reads.
 */
export async function scanTrail(
  limit = 12,
  principal: Principal | null = null,
): Promise<TrailEvent[]> {
  const pages = (await listReadableWikiPages(principal))
    .filter((p) => !isAgentScopedType(p.type))
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""))
    .slice(0, MAX_PAGES_SCANNED);
  return trailEventsForPages(pages, limit);
}

/**
 * Build a time-sorted activity feed (ingests + edits) for a SPECIFIC set of
 * pages — the per-page scan shared by {@link scanTrail} (recent public pages)
 * and the user profile (a handle's own commons pages). Caps the page reads so a
 * large set can't blow up I/O; pass already-sorted/sliced pages for control.
 */
export async function trailEventsForPages(
  pages: { slug: string; title: string; owner?: string }[],
  limit = 12,
): Promise<TrailEvent[]> {
  // Gather each page's events concurrently — the per-page work is independent,
  // so this avoids serializing the (bounded) page-read + revision-list I/O.
  const perPage = await Promise.all(
    pages.slice(0, MAX_PAGES_SCANNED).map(async (page): Promise<TrailEvent[]> => {
      const evs: TrailEvent[] = [];

      // Read the page once: it feeds the ingest provenance AND the commons flag
      // that decides the link target (a private/artifact page 404s at /wiki/).
      let full: Awaited<ReturnType<typeof readWikiPageWithFrontmatter>> = null;
      try {
        full = await readWikiPageWithFrontmatter(page.slug);
      } catch (err) {
        // A missing page returns null (not a throw), so reaching here is an
        // UNEXPECTED read failure (storage I/O, corrupt frontmatter). Log it
        // (house convention) and fall through with no frontmatter.
        logger.warn("trail", `unexpected error reading page "${page.slug}":`, err);
      }
      // An unreadable page defaults to the OWNER-scoped path (commons=false),
      // not /wiki/ — that link resolves for a public page (served/redirected at
      // the owner path) and doesn't 404 a private one, matching the project's
      // secure-default stance.
      const commons = full
        ? belongsInCommons({
            visibility:
              typeof full.frontmatter.visibility === "string"
                ? full.frontmatter.visibility
                : undefined,
            type:
              typeof full.frontmatter.type === "string"
                ? full.frontmatter.type
                : undefined,
          })
        : false;

      // Ingests — structured provenance entries.
      try {
        const sources = parseSources(
          full?.frontmatter.sources as string | string[] | undefined,
        );
        for (const s of sources) {
          const ts = Date.parse(s.fetched);
          if (Number.isNaN(ts)) continue;
          // Fold automation actors (system / lint-fix / yopedia) into the agent
          // so the trail reads as one yoyo, matching the (rebuilt) contributor index.
          const actor = normalizeActor(s.triggered_by || "system");
          evs.push({
            ts,
            when: s.fetched,
            actor,
            isAgent: isAgentHandle(actor),
            action: "ingested",
            sourceType: s.type,
            slug: page.slug,
            title: page.title,
            tenant: ownerToTenant(page.owner),
            commons,
          });
        }
      } catch {
        // Page unreadable — skip its ingests.
      }

      // Edits — attributed revisions. Lighter than listRevisions: no per-revision
      // stat, and capped to the most recent MAX_REVISIONS_PER_PAGE per page (the
      // trail's dominant cost was reading every revision of every scanned page).
      try {
        const revisions = await listRevisionAuthors(page.slug, MAX_REVISIONS_PER_PAGE, ownerToTenant(page.owner));
        for (const r of revisions) {
          if (!r.author) continue;
          const actor = normalizeActor(r.author);
          evs.push({
            ts: r.timestamp,
            when: r.date,
            actor,
            isAgent: isAgentHandle(actor),
            action: "edited",
            slug: page.slug,
            title: page.title,
            tenant: ownerToTenant(page.owner),
            commons,
          });
        }
      } catch {
        // Defensive only: listRevisionAuthors is fail-soft (returns [] on a read
        // error), so this guards a pathological storage throw — skip these edits.
      }

      return evs;
    }),
  );

  const events = perPage.flat();
  events.sort((a, b) => b.ts - a.ts);

  // Collapse near-duplicate events (same actor+action+page within ~2 min).
  const deduped: TrailEvent[] = [];
  for (const e of events) {
    const dup = deduped.find(
      (d) =>
        d.slug === e.slug &&
        d.actor === e.actor &&
        d.action === e.action &&
        Math.abs(d.ts - e.ts) < 120_000,
    );
    if (!dup) deduped.push(e);
  }

  return deduped.slice(0, limit);
}
