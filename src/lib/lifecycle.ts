import type { IndexEntry } from "./types";
import { upsertEmbedding, removeEmbedding } from "./embeddings";
import { deleteRevisions } from "./revisions";
import { deleteDiscussions } from "./talk";
import {
  validateSlug,
  writeWikiPage,
  readWikiPage,
  readWikiPageWithFrontmatter,
  listWikiPages,
  updateIndexUnsafe,
  findRelatedPages,
  updateRelatedPages,
  appendToLog,
  siloPathForSlug,
  tenantForOwner,
  tenantWikiRelPath,
  isArtifactType,
  enrichEntry,
} from "./wiki";
import { syncPageIndexForPage, removePageIndexForSlug } from "./page-index";
import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import { escapeRegex } from "./links";
import { getErrorMessage } from "./errors";
import { mapWithConcurrency } from "./concurrency";
import { removeAliasForPage, updateAliasIndexForPage } from "./alias-index";
import { removeSourceForPage } from "./source-index";
import { syncCommonsForPage, removeCommonsEntryBySlug, belongsInCommons } from "./commons";
import { syncOwnerIndexForPage, removeOwnerIndexForSlug, tenantsForPage } from "./owner-index";
import { syncBacklinksForPage, removeBacklinksForSlug } from "./backlink-index";
import { recordEditForAuthor, reverseEditForAuthor } from "./contributor-index";
import { pushRecentEvent, removeRecentForSlug } from "./recent-index";
import { isAgentHandle, removeSlugFromAgentPages } from "./agents";
import { removeSlugFromAllVaults } from "./vault";
import { normalizeActor } from "./agent-handle";
import { parseFrontmatter } from "./frontmatter";
import { parseSources, newestSourceType } from "./sources";
import type { LogOperation } from "./wiki";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// writeWikiPageWithSideEffects — the unified write pipeline
// ---------------------------------------------------------------------------
//
// Both `ingest()` and `saveAnswerToWiki()` need to perform the same 5-step
// sequence when materialising a wiki page: write file → upsert index entry →
// flush index → cross-reference related pages → append log line. Keeping that
// pipeline in one place is the durable fix for the "parallel write-paths
// drift" learning recorded in `.yoyo/learnings.md` — every future write path
// (edit, delete, re-ingest, import) should go through this function.

/** Options accepted by {@link writeWikiPageWithSideEffects}. */
export interface WritePageOptions {
  /** URL-safe slug — validated via {@link validateSlug}. */
  slug: string;
  /** Page title used in the index entry and (optionally) cross-ref links. */
  title: string;
  /** Full markdown to write to `wiki/<slug>.md`. */
  content: string;
  /** Index entry summary line (the bit after the em-dash). */
  summary: string;
  /** Append-only log operation — see {@link LogOperation}. */
  logOp: LogOperation;
  /** Optional callback that produces the log "details" body. */
  logDetails?: (ctx: { updatedSlugs: string[] }) => string;
  /**
   * Source text used for cross-ref discovery.
   *
   * - Defaults to `content` (the page markdown).
   * - `ingest()` passes the raw source text so the LLM sees the full document
   *   rather than the slimmed-down wiki page.
   * - Pass `null` to skip cross-referencing entirely (e.g. for tests or
   *   imports where you want to control linking yourself).
   */
  crossRefSource?: string | null;
  /** Who made this change — stored in the revision sidecar for attribution. */
  author?: string;
}

/** Result of a {@link writeWikiPageWithSideEffects} call. */
export interface WritePageResult {
  /** The slug of the page that was written. */
  slug: string;
  /** Slugs of related pages that received a backlink during cross-ref. */
  updatedSlugs: string[];
}

/** Result of a {@link deleteWikiPage} call. */
export interface DeletePageResult {
  /** The slug of the page that was deleted. */
  slug: string;
  /** Whether an index entry for this slug was actually removed. */
  removedFromIndex: boolean;
  /** Slugs of pages that had a backlink to the deleted page stripped out. */
  strippedBacklinksFrom: string[];
}

// ---------------------------------------------------------------------------
// runPageLifecycleOp — the shared lifecycle-op pipeline
// ---------------------------------------------------------------------------
//
// Anything that touches `wiki/<slug>.md` + `index.md` + other pages + `log.md`
// is the same shape of operation regardless of whether it creates, updates, or
// deletes a page. Per the "Delete is a write-path too — lifecycle ops, not
// just writes" learning in `.yoyo/learnings.md`, every such op flows through
// this one function, which owns the 5-step side-effect orchestration:
//
//   1. Validate the slug.
//   2. Mutate the page file on disk (write / unlink).
//   3. Mutate `index.md` (upsert / remove).
//   4. Cross-reference other pages (add "See also" links / strip backlinks).
//   5. Append a structured entry to `log.md`.
//
// Per-op differences live on the `op` strategy object. `writeWikiPageWithSideEffects`
// and `deleteWikiPage` are thin wrappers that construct the appropriate op
// and pass it through.

type PageLifecycleOp =
  | {
      kind: "write";
      title: string;
      content: string;
      summary: string;
      /**
       * Source text used for cross-ref discovery.
       * - `undefined` → use the page content itself.
       * - `null` → explicit skip (no cross-ref pass at all).
       * - string → use that text (e.g. raw source in ingest).
       */
      crossRefSource?: string | null;
      /** Who made this change — stored in the revision sidecar. */
      author?: string;
    }
  | {
      kind: "delete";
      /** Title used in the log entry (captured before unlink). */
      title: string;
      /** Who performed the deletion — used for contributor-index cleanup. */
      author?: string;
    };

/** Internal result of a lifecycle op — a superset of Write/Delete result shapes. */
interface LifecycleOpResult {
  slug: string;
  /** Pages that gained a backlink (write) — empty for delete. */
  crossRefedSlugs: string[];
  /** Pages that had a backlink stripped (delete) — empty for write. */
  strippedBacklinksFrom: string[];
  /** Whether the index actually had a row removed (delete) — false for write. */
  removedFromIndex: boolean;
}

/**
 * Strip every markdown link to `${slug}.md` from `content` and tidy up any
 * `**See also:**` artefacts the removal leaves behind. Returns the rewritten
 * content (or the input unchanged if no links were present).
 */
function stripBacklinksTo(slug: string, content: string): string {
  const escapedSlug = escapeRegex(slug);
  // `g` flag: declared at narrowest scope to avoid cross-call `lastIndex` leaks.
  const linkRe = new RegExp(`\\[[^\\]]+\\]\\(${escapedSlug}\\.md\\)`, "g");

  // 1. Strip the actual link occurrences.
  let updated = content.replace(linkRe, "");

  // 2. Clean up See also artefacts left behind.
  //
  //    a) Drop empty See-also lines: `**See also:** ` (optionally with
  //       trailing whitespace) on its own line.
  updated = updated.replace(/^\*\*See also:\*\*\s*$/gm, "");
  //    b) Fix leading comma: `**See also:** , X` → `**See also:** X`
  updated = updated.replace(/(\*\*See also:\*\*)\s*,\s*/g, "$1 ");
  //    c) Collapse orphaned commas: "A, , C" → "A, C"
  updated = updated.replace(/,(\s*,)+/g, ",");
  //    d) Fix trailing comma at end-of-line: `..., \n` → `\n`
  updated = updated.replace(/,\s*$/gm, "");
  //    e) Collapse runs of 3+ blank lines that the empty-line removal may
  //       have produced into a single blank line, so we don't leave a hole.
  updated = updated.replace(/\n{3,}/g, "\n\n");

  return updated;
}

/**
 * Shared lifecycle-op pipeline for write and delete. See the block comment
 * above for the full 5-step shape.
 */
/** Max concurrent R2 reads/writes during a page lifecycle op. */
const LIFECYCLE_CONCURRENCY = 12;

async function runPageLifecycleOp(
  slug: string,
  op: PageLifecycleOp,
  logOp: LogOperation,
  logDetails?: (ctx: {
    crossRefedSlugs: string[];
    strippedBacklinksFrom: string[];
  }) => string | undefined,
): Promise<LifecycleOpResult> {
  // 1. Validate — the per-step helpers also validate, but we want to fail
  //    fast before any filesystem mutation happens.
  validateSlug(slug);

  // --- Silo-primary: resolve the write tenant from content frontmatter ---
  let writeTenant: string | undefined;
  if (op.kind === "write") {
    try {
      const fm = parseFrontmatter(op.content).data;
      const owner = typeof fm.owner === "string" ? fm.owner : undefined;
      writeTenant = tenantForOwner(owner);
    } catch {
      writeTenant = tenantForOwner(undefined);
    }
  }

  // Capture the deleted page's owner BEFORE removing it, so the delete path
  // knows which tenant silo to target.
  let deletedOwner: string | undefined;
  let deletedContributors: string[] = [];

  // Capture the page's PREVIOUS content before overwrite so the backlink index
  // can diff outbound links (write path). undefined for a brand-new page.
  let prevContent: string | undefined;

  // 2. Mutate the page file.
  if (op.kind === "write") {
    try {
      const pre = await readWikiPage(slug);
      prevContent = pre?.content;
    } catch {
      // No prior page (new) or unreadable → treat as no previous links.
    }
    // Silo is the sole write target (#869): tenants/<tenant>/wiki/<slug>.md
    await writeWikiPage(slug, op.content, op.author, undefined, writeTenant);
  } else {
    try {
      const pre = await readWikiPageWithFrontmatter(slug);
      deletedOwner =
        typeof pre?.frontmatter.owner === "string"
          ? pre.frontmatter.owner
          : undefined;
      deletedContributors = Array.isArray(pre?.frontmatter.contributors)
        ? (pre.frontmatter.contributors as unknown[]).filter(
            (c): c is string => typeof c === "string",
          )
        : [];
    } catch {
      // Owner/contributors unknown → falls back to the default tenant in step 3c.
    }
    // Delete the page from where READS resolve it (the page index), not from a
    // path re-derived from frontmatter. The two can disagree — an ownership
    // change updates frontmatter before the index catches up — and deleting the
    // wrong one leaves the page live. The frontmatter-derived path is cleared
    // too when it differs, so a drifted copy can't outlive the delete.
    const deleteTenant = tenantForOwner(deletedOwner);
    const targets = new Set([
      await siloPathForSlug(slug),
      tenantWikiRelPath(deleteTenant, `${slug}.md`),
    ]);
    for (const target of targets) {
      try {
        await getStorage().deleteFile(target);
      } catch (err: unknown) {
        if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
          throw err;
        }
      }
    }
  }

  // 2b–2d. Secondary storage cleanup. All steps are failure-tolerant (logged +
  //        swallowed) so they never fail the op. On the delete path the three
  //        independent ops (embedding, revisions, discussions) run CONCURRENTLY
  //        instead of one-after-another to cut latency.
  if (op.kind === "write") {
    // Skip embedding rendered artifacts (e.g. saved `html` outputs): they're
    // excluded from the search/query corpus, and their raw markup would pollute
    // the vector store. Fail-open: a frontmatter parse error must NOT break the
    // (already-committed) write — fall back to attempting the embedding, which
    // is itself guarded below.
    let isArtifact = false;
    try {
      const fmType = parseFrontmatter(op.content).data.type;
      isArtifact = isArtifactType(typeof fmType === "string" ? fmType : undefined);
    } catch (err) {
      logger.warn(
        "wiki",
        `embedding-skip frontmatter parse failed for "${slug}":`,
        getErrorMessage(err, String(err)),
      );
    }
    if (!isArtifact) {
      try {
        await upsertEmbedding(slug, op.content);
      } catch (err) {
        logger.warn(
          "wiki",
          `embedding upsert failed for "${slug}":`,
          getErrorMessage(err, String(err)),
        );
      }
    }
  } else {
    const cleanups: { label: string; run: Promise<unknown> }[] = [
      { label: "embedding remove", run: removeEmbedding(slug) },
      { label: "deleteRevisions", run: deleteRevisions(slug) },
      { label: "deleteDiscussions", run: deleteDiscussions(slug) },
    ];
    const settled = await Promise.allSettled(cleanups.map((c) => c.run));
    settled.forEach((r, i) => {
      if (r.status === "rejected") {
        logger.warn(
          "wiki",
          `${cleanups[i].label} failed for "${slug}":`,
          getErrorMessage(r.reason, String(r.reason)),
        );
      }
    });
  }

  // 2e. Index maintenance (in-memory, fast).
  if (op.kind === "delete") {
    // Invalidate alias entries so resolveAlias(deletedTitle) no longer
    // ghost-resolves here; drop source-index (URL/content-hash) entries too.
    removeAliasForPage(slug);
    removeSourceForPage(slug);
  } else {
    // 2e. Update alias index for written page so resolveAlias() finds it
    //     immediately — no server restart needed. Parse the frontmatter to
    //     extract aliases[], mirroring how removeAliasForPage() is called
    //     on the delete path.
    try {
      const parsed = parseFrontmatter(op.content);
      const aliases = Array.isArray(parsed.data.aliases)
        ? (parsed.data.aliases as string[]).filter(
            (a) => typeof a === "string" && a.trim() !== "",
          )
        : [];
      updateAliasIndexForPage(slug, op.title, aliases);
    } catch {
      // Frontmatter parse failure should not fail the write — the page is
      // already on disk. The alias index will catch up on next full rebuild.
      logger.warn(
        "wiki",
        `alias index update skipped for "${slug}": could not parse frontmatter`,
      );
    }
  }

  // 3. Mutate the index. The read → mutate → write cycle is performed under
  //    a single withFileLock("index.md") so that concurrent lifecycle ops
  //    cannot clobber each other (TOCTOU race fix). We use updateIndexUnsafe
  //    since we already hold the lock.
  let postIndexEntries: IndexEntry[];
  let removedFromIndex = false;
  await withFileLock("index.md", async () => {
    const entries = await listWikiPages();
    if (op.kind === "write") {
      const existingIdx = entries.findIndex((e) => e.slug === slug);
      if (existingIdx !== -1) {
        entries[existingIdx].title = op.title;
        entries[existingIdx].summary = op.summary;
      } else {
        entries.push({ title: op.title, slug, summary: op.summary });
      }
      postIndexEntries = entries;
    } else {
      postIndexEntries = entries.filter((e) => e.slug !== slug);
      removedFromIndex = postIndexEntries.length !== entries.length;
    }
    await updateIndexUnsafe(postIndexEntries);
  });

  // 3b. Mirror into the commons index (tenant-silos groundwork). Maintained
  //     alongside the flat index; not yet read by any surface. Fail-soft — a
  //     commons error must never break the page write/delete.
  try {
    if (op.kind === "delete") {
      await removeCommonsEntryBySlug(slug);
    } else {
      const fm = parseFrontmatter(op.content).data;
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const num = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      // source_count is persisted as a string (see ingest.ts).
      const sc = fm.source_count;
      const sourceCount =
        typeof sc === "number"
          ? sc
          : typeof sc === "string" && /^\d+$/.test(sc.trim())
            ? Number.parseInt(sc, 10)
            : undefined;
      // confidence may be a number or a numeric string (mirror listWikiPages).
      const cf = fm.confidence;
      const confidence =
        num(cf) ??
        (typeof cf === "string" && /^-?\d+(\.\d+)?$/.test(cf.trim())
          ? Number.parseFloat(cf)
          : undefined);
      await syncCommonsForPage(slug, {
        owner: str(fm.owner),
        visibility: str(fm.visibility),
        type: str(fm.type),
        title: op.title,
        summary: op.summary,
        tags: Array.isArray(fm.tags)
          ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : undefined,
        updated: str(fm.updated),
        sourceCount,
        confidence,
      });
    }
  } catch (err) {
    logger.warn("commons", `commons sync skipped for "${slug}":`, err);
  }

  // 3b-ii. Owner→slugs index (Phase 2 precomputed indexes). Mirrors slugsForOwner's
  //        membership (owner tenant + every contributor tenant). Fail-soft.
  try {
    if (op.kind === "delete") {
      await removeOwnerIndexForSlug(slug);
    } else {
      const fm = parseFrontmatter(op.content).data;
      const owner = typeof fm.owner === "string" ? fm.owner : undefined;
      const contributors = Array.isArray(fm.contributors)
        ? (fm.contributors as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined;
      await syncOwnerIndexForPage(slug, owner, contributors);
    }
  } catch (err) {
    logger.warn("owner-index", `owner index sync skipped for "${slug}":`, err);
  }

  // 3b-iii. Backlink (reverse-link) index. On write, diff this page's outbound
  //         links against its previous content (captured before overwrite); on
  //         delete, drop the slug as both target and source. Fail-soft.
  try {
    if (op.kind === "delete") {
      await removeBacklinksForSlug(slug);
    } else {
      await syncBacklinksForPage(slug, op.content, prevContent);
    }
  } catch (err) {
    logger.warn("backlink-index", `backlink index sync skipped for "${slug}":`, err);
  }

  // 3b-iv. Contributor index — incremental edit facts only. We bump editCount /
  //         pagesEdited / firstSeen / lastSeen for op.author (decrement on
  //         delete); revertCount and talk counts are left to the daily rebuild
  //         (see contributor-index.ts header). No-op until the daily rebuild has
  //         seeded the index (recordEditForAuthor returns early when absent).
  //         Fail-soft.
  try {
    if (op.kind === "delete") {
      // Decrement per-author edit counts when the delete op carries an author.
      if (op.author) {
        await reverseEditForAuthor(op.author, slug);
      }
    } else if (op.author) {
      await recordEditForAuthor(op.author, slug);
    }
  } catch (err) {
    logger.warn("contributor-index", `contributor index sync skipped for "${slug}":`, err);
  }

  // 3b-v. Recent-activity index (the homepage Trail). PUBLIC, non-agent pages
  //        only — the public trail never surfaces private activity. No-op until
  //        the daily rebuild has seeded the index. Fail-soft.
  try {
    if (op.kind === "delete") {
      // Prune every per-tenant index the page's events were pushed to — its owner
      // AND every contributor (the SAME fan-out as the push and owner-index), so a
      // contributor's profile trail doesn't retain a deleted page. `deletedOwner`/
      // `deletedContributors` were captured before the file was removed.
      await removeRecentForSlug(slug, [
        ...tenantsForPage(deletedOwner, deletedContributors),
      ]);
    } else if (op.author) {
      const fm = parseFrontmatter(op.content).data;
      const isCommons = belongsInCommons({
        visibility: typeof fm.visibility === "string" ? fm.visibility : undefined,
        type: typeof fm.type === "string" ? fm.type : undefined,
      });
      if (isCommons) {
        const now = Date.now();
        // For ingests, carry the source type so the trail shows its chip
        // (URL/PDF/…) immediately — the full-scan rebuild sets it too, but the
        // incremental push must match or a fresh ingest shows a chip-less row
        // until the next daily rebuild. Use the newest source entry.
        const sourceType =
          logOp === "ingest"
            ? newestSourceType(
                parseSources(fm.sources as string | string[] | undefined),
              )
            : undefined;
        // Fold automation actors (system / lint-fix / yopedia) into the agent so
        // the incrementally-pushed event matches the scan/index normalization.
        const actor = normalizeActor(op.author);
        const owner = typeof fm.owner === "string" ? fm.owner : undefined;
        const contributors = Array.isArray(fm.contributors)
          ? (fm.contributors as unknown[]).filter((c): c is string => typeof c === "string")
          : undefined;
        await pushRecentEvent(
          {
            ts: now,
            when: new Date(now).toISOString(),
            actor,
            isAgent: isAgentHandle(actor),
            // An ingest onto a page that already existed is a re-ingest — label
            // it distinctly (prevContent is undefined only for a brand-new page).
            action:
              logOp === "ingest"
                ? prevContent
                  ? "re-ingested"
                  : "ingested"
                : "edited",
            ...(sourceType ? { sourceType } : {}),
            slug,
            title: op.title,
            // The event's tenant is the OWNER's (the canonical /wiki/<slug> link).
            tenant: tenantForOwner(owner),
            // This push is gated by `isCommons` above, so the page is, by
            // construction, a public commons page → links at `/wiki/<slug>`.
            commons: true,
          },
          // …but route it into EVERY relevant profile index: owner + contributors,
          // so a contributor's trail stays fresh too (mirrors the owner-index).
          [...tenantsForPage(owner, contributors)],
        );
      }
    }
  } catch (err) {
    logger.warn("recent-index", `recent index sync skipped for "${slug}":`, err);
  }

  // 3b-vi. Page-metadata index (_idx:pages) — the enriched IndexEntry per slug,
  //         so listWikiPages enriches with one KV read instead of reading every
  //         page file. Holds ALL pages (visibility filtering is on the read side).
  //         No-op until the daily rebuild has seeded it. Fail-soft.
  try {
    if (op.kind === "delete") {
      await removePageIndexForSlug(slug);
    } else {
      const fm = parseFrontmatter(op.content).data;
      await syncPageIndexForPage(
        enrichEntry({ title: op.title, slug, summary: op.summary }, fm),
      );
    }
  } catch (err) {
    logger.warn("page-index", `page index sync skipped for "${slug}":`, err);
  }

  // 3c. (Retired) Silo writes now happen directly at step 2 — the lifecycle
  //     write targets tenants/<tenant>/wiki/ via writeWikiPage(…, tenant), and
  //     the delete targets the silo path explicitly. The redundant syncSiloForPage
  //     / removeSiloForPage mirror is no longer needed here.

  // 3d. (removed) Pages no longer auto-join a vault. In the multi-vault model
  //     vault membership is EXPLICIT — a page joins a vault only via an
  //     ingest-into-vault or curate-into-vault action. Plain ingest lands in the
  //     commons only.

  // 3e. Agent page cleanup — remove the slug from any agent profile that
  //     references it in identityPages, learningPages, or socialPages. Mirrors
  //     the vault orphan cleanup (#538). Delete-only; fail-soft.
  if (op.kind === "delete") {
    try {
      await removeSlugFromAgentPages(slug);
    } catch (err) {
      logger.warn("agents", `agent page cleanup skipped for "${slug}":`, err);
    }
  }

  // 3f. Vault membership cleanup — remove the deleted slug from every vault
  //     that curated it, so `vaultSlugs()` / `vaultsContaining()` never return
  //     ghost references. The function discovers vault tenants from storage and
  //     also accepts owner hints for the deleted page (already absent from the
  //     index). Delete-only; fail-soft.
  if (op.kind === "delete") {
    try {
      await removeSlugFromAllVaults(
        slug,
        deletedOwner ? [deletedOwner] : undefined,
      );
    } catch (err) {
      logger.warn("vault", `vault cleanup skipped for "${slug}":`, err);
    }
  }

  // 4. Cross-reference other pages.
  //    - write: discover related pages and add backlinks TO this slug.
  //    - delete: rewrite every remaining page to strip links to this slug.
  let crossRefedSlugs: string[] = [];
  const strippedBacklinksFrom: string[] = [];
  if (op.kind === "write") {
    if (op.crossRefSource !== null) {
      const sourceForCrossRef = op.crossRefSource ?? op.content;
      // Use entries captured inside the lock to avoid TOCTOU — a concurrent
      // ingest between the lock release and a fresh read could produce stale data.
      const refreshedEntries = postIndexEntries!;
      const relatedSlugs = await findRelatedPages(
        slug,
        sourceForCrossRef,
        refreshedEntries,
      );
      crossRefedSlugs = await updateRelatedPages(slug, op.title, relatedSlugs);
    }
  } else {
    // Strip links to the deleted page from every other page. Read all pages
    // CONCURRENTLY (bounded) — this was the main sequential bottleneck and the
    // part that scaled badly with page count. Then rewrite only the linkers.
    const pages = await mapWithConcurrency(
      postIndexEntries!,
      LIFECYCLE_CONCURRENCY,
      async (entry) => ({ entry, page: await readWikiPage(entry.slug) }),
    );
    const linkers = pages.filter(
      ({ page }) => page && page.content.includes(`${slug}.md`),
    );
    await mapWithConcurrency(linkers, LIFECYCLE_CONCURRENCY, async ({ entry, page }) => {
      const updated = stripBacklinksTo(slug, page!.content);
      if (updated !== page!.content) {
        // Resolve the stripped page's tenant so writeWikiPage targets the silo directly.
        let stripTenant: string | undefined;
        try {
          const ownerVal = parseFrontmatter(updated).data.owner;
          stripTenant = tenantForOwner(typeof ownerVal === "string" ? ownerVal : undefined);
        } catch {
          stripTenant = tenantForOwner(undefined);
        }
        // Silo write for the stripped page.
        await writeWikiPage(entry.slug, updated, "system", "backlink strip", stripTenant);
        strippedBacklinksFrom.push(entry.slug);
      }
    });
  }

  // 5. Log.
  const details = logDetails?.({ crossRefedSlugs, strippedBacklinksFrom });
  await appendToLog(logOp, op.title, details);

  return { slug, crossRefedSlugs, strippedBacklinksFrom, removedFromIndex };
}

/**
 * Delete a wiki page and clean up references to it.
 *
 * Thin wrapper over {@link runPageLifecycleOp} — the actual 5-step dance
 * (unlink → remove index entry → strip backlinks across pages → log) lives
 * in the shared pipeline. See the block comment above `runPageLifecycleOp`
 * for details.
 *
 * Hard delete only — no trash, no undo. Raw source files in `raw/` are
 * intentionally NOT touched (the raw layer is immutable per the founding
 * vision).
 */
export async function deleteWikiPage(
  slug: string,
  author?: string,
): Promise<DeletePageResult> {
  validateSlug(slug);

  // Capture the title BEFORE unlinking so the log entry is human-readable.
  const page = await readWikiPage(slug);
  if (!page) {
    throw new Error(`page not found: ${slug}`);
  }
  const title = page.title ?? slug;

  const result = await runPageLifecycleOp(
    slug,
    { kind: "delete", title, author },
    "delete",
    ({ strippedBacklinksFrom }) =>
      `deleted · stripped backlinks from ${strippedBacklinksFrom.length} page(s)`,
  );

  return {
    slug: result.slug,
    removedFromIndex: result.removedFromIndex,
    strippedBacklinksFrom: result.strippedBacklinksFrom,
  };
}

/**
 * Write a wiki page and run the full set of side effects every write-path
 * in this codebase needs:
 *
 * 1. Validate the slug.
 * 2. Write `wiki/<slug>.md`.
 * 3. Upsert an `{ title, slug, summary }` entry into `wiki/index.md`
 *    (re-uses an existing entry's row if the slug already exists, so
 *    re-writes don't produce duplicates).
 * 4. Cross-reference related pages via {@link findRelatedPages} +
 *    {@link updateRelatedPages}, unless `crossRefSource` is `null`.
 * 5. Append a structured entry to `wiki/log.md`.
 *
 * Thin wrapper over {@link runPageLifecycleOp} — the actual 5 steps live in
 * the shared pipeline, which `deleteWikiPage` also flows through.
 */
export async function writeWikiPageWithSideEffects(
  opts: WritePageOptions,
): Promise<WritePageResult> {
  const { slug, title, content, summary, logOp, logDetails } = opts;

  const result = await runPageLifecycleOp(
    slug,
    {
      kind: "write",
      title,
      content,
      summary,
      crossRefSource: opts.crossRefSource,
      author: opts.author,
    },
    logOp,
    ({ crossRefedSlugs }) => logDetails?.({ updatedSlugs: crossRefedSlugs }),
  );

  return { slug: result.slug, updatedSlugs: result.crossRefedSlugs };
}
