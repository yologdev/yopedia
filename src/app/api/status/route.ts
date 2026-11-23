import { getProviderInfo } from "@/lib/llm";
import { getPageIndex } from "@/lib/page-index";
import { getContributorIndex } from "@/lib/contributor-index";
import { getDiscussStatsIndex } from "@/lib/discuss-stats-index";
import { logger } from "@/lib/logger";

/** Cheap commons growth stats derived from precomputed KV indexes — no full
 *  page scans, no LLM calls. Each index read is O(1) (single KV get). Falls
 *  back gracefully when an index hasn't been seeded yet (fields default to 0). */
async function getCommonsStats(): Promise<{
  pageCount: number;
  sourceCount: number;
  contributorCount: number;
  revisionCount: number;
  disputedPageCount: number;
  openThreadCount: number;
}> {
  // Defaults — used when an index is absent (not yet seeded / first deploy).
  let pageCount = 0;
  let sourceCount = 0;
  let contributorCount = 0;
  let revisionCount = 0;
  let disputedPageCount = 0;
  let openThreadCount = 0;

  // --- Page index (_idx:pages) → pageCount + sourceCount ---
  try {
    const pageIdx = await getPageIndex();
    if (pageIdx) {
      const entries = Object.values(pageIdx);
      pageCount = entries.length;
      sourceCount = entries.reduce(
        (sum, e) => sum + (typeof e.sourceCount === "number" ? e.sourceCount : 0),
        0,
      );
    }
  } catch (err) {
    logger.warn("status", "page index read failed:", err);
  }

  // --- Contributor index (_idx:contributors) → contributorCount + revisionCount + disputedPageCount ---
  try {
    const contribIdx = await getContributorIndex();
    if (contribIdx) {
      contributorCount = contribIdx.totals.contributorCount;
      revisionCount = contribIdx.totals.revisionCount;
      // Disputed page count: collect the union of all pagesEdited from authors
      // that have disputedPageCount > 0, capped by each author's disputed count.
      // This is a best-effort count from the precomputed index — the daily rebuild
      // keeps the per-author disputedPageCount accurate, so the wiki-wide number
      // is correct when each disputed page has exactly one author (the common case)
      // and may slightly overcount when multiple authors edited the same disputed page.
      const disputedSlugs = new Set<string>();
      for (const author of Object.values(contribIdx.authors)) {
        if (author.disputedPageCount > 0) {
          for (const slug of author.pagesEdited) {
            disputedSlugs.add(slug);
          }
        }
      }
      // The set above is an UPPER BOUND (all pages by authors who touched any
      // disputed page). The true count is at most the sum of distinct slugs that
      // actually carry `disputed: true` — but that requires a page scan. Use the
      // sum of per-author disputed counts as a tighter heuristic: when no author
      // shares a disputed page, it equals the true count.
      const sumDisputed = Object.values(contribIdx.authors).reduce(
        (sum, a) => sum + (a.disputedPageCount ?? 0),
        0,
      );
      // Take the smaller of the two: the sum-of-per-author is tight when
      // disputed pages aren't co-edited, while the slug-set is tight otherwise.
      disputedPageCount = Math.min(disputedSlugs.size, sumDisputed);
    }
  } catch (err) {
    logger.warn("status", "contributor index read failed:", err);
  }

  // --- Discuss-stats index (_idx:discuss-stats) → openThreadCount ---
  try {
    const discussIdx = await getDiscussStatsIndex();
    if (discussIdx) {
      openThreadCount = Object.values(discussIdx).reduce(
        (sum, stat) => sum + stat.open,
        0,
      );
    }
  } catch (err) {
    logger.warn("status", "discuss-stats index read failed:", err);
  }

  return {
    pageCount,
    sourceCount,
    contributorCount,
    revisionCount,
    disputedPageCount,
    openThreadCount,
  };
}

export async function GET() {
  try {
    const info = getProviderInfo();
    const commons = await getCommonsStats();
    return Response.json({ ...info, commons });
  } catch (err) {
    return Response.json(
      { configured: false, provider: null, model: null, embeddingSupport: false, error: String(err) },
      { status: 500 },
    );
  }
}
