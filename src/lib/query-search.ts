/**
 * Search and ranking helpers for wiki queries.
 *
 * Extracted from `query.ts` to separate search/ranking concerns from
 * LLM prompt building and answer generation.
 */

import { readWikiPage, tryReadWikiPageWithFrontmatter } from "./wiki";
import { tokenize, buildCorpusStats, bm25Score } from "./bm25";
import { searchByVector } from "./embeddings";
import { callLLM, hasLLMKey } from "./llm";
import { MAX_CONTEXT_PAGES, RRF_K, BM25_FULLBODY_MAX_PAGES } from "./constants";
import { logger } from "./logger";
import { parseSources } from "./sources";
import { wrapUntrusted } from "./untrusted";
import type { IndexEntry } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** If the wiki has this many or fewer pages, load all of them (no filtering). */
export const SMALL_WIKI_THRESHOLD = 5;

/** Maximum number of fusion candidates fed into the LLM re-ranking step. */
export const RERANK_CANDIDATE_POOL = MAX_CONTEXT_PAGES * 2;

/** Maximum characters of page body included as a snippet for re-ranking. */
export const RERANK_SNIPPET_CHARS = 800;

export const RERANK_PROMPT = `You are a wiki search assistant. Given a user's question and a set of candidate wiki pages (with content snippets), re-rank them by relevance to the question.

Judge each page on these criteria:
1. **Direct topic match** — Does the page directly address the question's topic?
2. **Conceptual relevance** — Does it contain background or context needed to answer the question?
3. **Citation potential** — Does it contain specific facts, data, or examples the answer should cite?

Think briefly about which pages best match these criteria, then return a JSON array of slug strings, most relevant first. You may omit pages that are clearly irrelevant. Maximum {max} slugs.

Format your response as a brief reasoning section followed by the JSON array on its own line. Example:

The question asks about backpropagation, which is directly covered by the backpropagation page. Neural networks and machine learning provide relevant context.
["backpropagation", "neural-networks", "machine-learning"]

Candidate pages:
{candidates}`;

// ---------------------------------------------------------------------------
// Best-snippet extraction
// ---------------------------------------------------------------------------

/**
 * Extract the window of `maxChars` from `content` that has the highest token
 * overlap with `queryTokens`.  Falls back to the first `maxChars` characters
 * when the content is shorter than the window or when no query tokens match.
 *
 * The function slides a character window across the content, stepping by
 * ~100-char increments, and picks the window whose tokenised text shares the
 * most tokens with the query.  This gives the re-ranker the most
 * query-relevant portion of each page rather than always the intro.
 */
export function extractBestSnippet(
  content: string,
  queryTokens: string[],
  maxChars: number,
): string {
  if (content.length <= maxChars || queryTokens.length === 0) {
    return content.slice(0, maxChars);
  }

  const querySet = new Set(queryTokens);
  const step = 100;
  let bestStart = 0;
  let bestScore = -1;

  for (let start = 0; start <= content.length - maxChars; start += step) {
    const window = content.slice(start, start + maxChars);
    const windowTokens = tokenize(window);
    let score = 0;
    for (const tok of windowTokens) {
      if (querySet.has(tok)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  return content.slice(bestStart, bestStart + maxChars);
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------

/**
 * Combine two ranked result lists using Reciprocal Rank Fusion.
 *
 * For each slug appearing in either list, computes:
 *   `rrf_score = 1/(k + bm25_rank) + 1/(k + vector_rank)`
 *
 * where rank is the 1-based position and missing entries get rank = Infinity.
 * This avoids needing to normalize scores that live on different scales (BM25
 * vs cosine similarity).
 */
export function reciprocalRankFusion(
  bm25Results: Array<{ slug: string; score: number }>,
  vectorResults: Array<{ slug: string; score: number }>,
  k: number = RRF_K,
): Array<{ slug: string; score: number }> {
  // Build rank maps (1-based)
  const bm25Rank = new Map<string, number>();
  bm25Results.forEach((r, i) => bm25Rank.set(r.slug, i + 1));

  const vectorRank = new Map<string, number>();
  vectorResults.forEach((r, i) => vectorRank.set(r.slug, i + 1));

  // Collect all slugs from both lists
  const allSlugs = new Set([
    ...bm25Results.map((r) => r.slug),
    ...vectorResults.map((r) => r.slug),
  ]);

  const fused: Array<{ slug: string; score: number }> = [];
  for (const slug of allSlugs) {
    const br = bm25Rank.get(slug) ?? Infinity;
    const vr = vectorRank.get(slug) ?? Infinity;
    const rrfScore = 1 / (k + br) + 1 / (k + vr);
    fused.push({ slug, score: rrfScore });
  }

  fused.sort((a, b) => b.score - a.score);
  return fused;
}

/**
 * Search the wiki index to find the most relevant page slugs for a question.
 *
 * Phase 1: BM25 sparse scoring (always runs)
 * Phase 1b: Vector search (when an embedding provider is configured)
 * Phase 1c: RRF fusion of BM25 + vector results (when vector results exist)
 * Phase 2: LLM re-ranking of fusion candidates (if available) — sends
 *          candidate slugs with content snippets to the LLM for re-ordering,
 *          falls back to fusion ranking on failure.
 *
 * When `fullBody` is true (the default), BM25 indexes the full page content
 * from disk rather than just the title + summary from the index. This gives
 * much better recall for queries whose keywords only appear in the body.
 * Performance note: reads all pages from disk — fine for tens to low hundreds
 * of pages; vector search will replace this path later.
 */
export async function searchIndex(
  question: string,
  entries: IndexEntry[],
  fullBody: boolean = true,
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }

  // Early return for empty/whitespace queries — BM25 would produce
  // meaningless zero-scores for every document.
  if (!question.trim()) {
    return [];
  }

  // Phase 1 — BM25 sparse scoring.
  // Full-body BM25 reads every page from disk, so above BM25_FULLBODY_MAX_PAGES
  // we drop to index-level (title+summary) scoring — zero disk reads — and let
  // the vector half of the fusion carry body-level recall. The gate only ever
  // downgrades, so a small or scoped corpus keeps full-body recall.
  const questionTokens = tokenize(question);
  const useFullBody = fullBody && entries.length <= BM25_FULLBODY_MAX_PAGES;
  const corpusStats = await buildCorpusStats(entries, { fullBody: useFullBody });

  const bm25Results = entries
    .map((entry) => ({
      slug: entry.slug,
      score: bm25Score(entry, questionTokens, corpusStats),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONTEXT_PAGES * 2); // Keep more candidates for fusion

  // Phase 1b — Vector search (if an embedding provider is configured).
  // CRITICAL: the vector store is global; it must be intersected with the
  // caller's `entries` (the readable + scoped set) or private pages would leak
  // into fusion → rerank → context → sources. `entries` is authoritative.
  const allowedSlugs = new Set(entries.map((e) => e.slug));
  let vectorResults: Array<{ slug: string; score: number }> = [];
  try {
    const raw = await searchByVector(question, MAX_CONTEXT_PAGES * 2);
    vectorResults = raw.filter((r) => allowedSlugs.has(r.slug));
  } catch (err) {
    logger.warn("query", "searchIndex vector search failed:", err);
    // Vector search failure is non-fatal — fall back to BM25 only
  }

  // Phase 1c — Combine via RRF if we have vector results, otherwise pure BM25
  // Keep a wider candidate pool for re-ranking input
  let fusedSlugs: string[];
  if (vectorResults.length > 0) {
    const fused = reciprocalRankFusion(bm25Results, vectorResults);
    fusedSlugs = fused.slice(0, RERANK_CANDIDATE_POOL).map((r) => r.slug);
  } else {
    fusedSlugs = bm25Results.slice(0, RERANK_CANDIDATE_POOL).map((r) => r.slug);
  }

  // Phase 2 — LLM re-ranking of fusion candidates (if available)
  // Instead of sending the full wiki index, we send only the fusion candidates
  // with content snippets so the LLM can make quality relevance judgments.
  if (hasLLMKey() && fusedSlugs.length > 0) {
    try {
      // Load content snippets for each candidate
      const candidateLines: string[] = [];
      for (const slug of fusedSlugs) {
        const page = await readWikiPage(slug);
        const entry = entries.find((e) => e.slug === slug);
        const title = entry?.title ?? page?.title ?? slug;
        const summary = entry?.summary ?? "";
        const snippet = page
          ? extractBestSnippet(page.content, questionTokens, RERANK_SNIPPET_CHARS).replace(/\n+/g, " ").trim()
          : summary;
        candidateLines.push(`- slug: ${slug} | title: ${title} | snippet: ${snippet}`);
      }

      const candidatesText = candidateLines.join("\n");
      const prompt = RERANK_PROMPT
        .replace("{candidates}", candidatesText)
        .replace("{max}", String(MAX_CONTEXT_PAGES));
      const response = await callLLM(prompt, question);

      // Extract JSON array from response
      const jsonMatch = response.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        if (Array.isArray(parsed)) {
          const validSlugs = new Set(fusedSlugs);
          const rerankedSlugs = parsed
            .filter((s): s is string => typeof s === "string" && validSlugs.has(s))
            .slice(0, MAX_CONTEXT_PAGES);

          if (rerankedSlugs.length > 0) {
            return rerankedSlugs;
          }
        }
      }
    } catch (err) {
      logger.warn("query", "searchIndex LLM re-ranking failed:", err);
      // Fall through to fusion results
    }
  }

  return fusedSlugs.slice(0, MAX_CONTEXT_PAGES);
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

/**
 * Build a context string from wiki pages.
 *
 * When `slugs` is provided, only those pages are loaded.
 * When omitted or empty, returns empty context.
 *
 * Each page header includes confidence and expiry metadata when available.
 * Expired, low-confidence, disputed, and superseded pages are annotated
 * with visible markers so the LLM can weight its citations accordingly.
 */
export async function buildContext(slugs?: string[]): Promise<{
  context: string;
  slugs: string[];
}> {
  if (!slugs || slugs.length === 0) {
    return { context: "", slugs: [] };
  }

  const LOW_CONFIDENCE_THRESHOLD = 0.5;

  // First pass: load all pages and build a supersedes reverse-lookup map.
  // If page B has `supersedes: page-a`, then page-a is superseded by page-b.
  const loadedPages: {
    slug: string;
    title: string;
    body: string;
    frontmatter: Record<string, string | string[] | number | boolean>;
  }[] = [];
  const supersededBy = new Map<string, string>();

  for (const slug of slugs) {
    const page = await tryReadWikiPageWithFrontmatter(slug, "query");
    if (page) {
      loadedPages.push(page);
      const supersedes = page.frontmatter.supersedes;
      if (typeof supersedes === "string" && supersedes) {
        supersededBy.set(supersedes, page.slug);
      }
    }
  }

  // Second pass: build context string with markers.
  const loadedSlugs: string[] = [];
  const parts: string[] = [];

  for (const page of loadedPages) {
    loadedSlugs.push(page.slug);

    // Build header with confidence, expiry, supersedes, verified, and sources metadata
    const headerParts = [`slug: ${page.slug}`];
    const confidence = page.frontmatter.confidence;
    if (typeof confidence === "number") {
      headerParts.push(`confidence: ${confidence}`);
    }
    const expiry = page.frontmatter.expiry;
    if (typeof expiry === "string" && expiry) {
      headerParts.push(`expires: ${expiry}`);
    }
    const supersedes = page.frontmatter.supersedes;
    if (typeof supersedes === "string" && supersedes) {
      headerParts.push(`supersedes: ${supersedes}`);
    }
    const validFrom = page.frontmatter.valid_from;
    if (typeof validFrom === "string" && validFrom) {
      headerParts.push(`verified: ${validFrom}`);
    }
    const sourceCountRaw = page.frontmatter.source_count;
    const sourceCount =
      typeof sourceCountRaw === "number"
        ? sourceCountRaw
        : typeof sourceCountRaw === "string"
          ? parseInt(sourceCountRaw, 10)
          : NaN;
    if (!isNaN(sourceCount) && sourceCount > 0) {
      headerParts.push(`sources: ${sourceCount}`);
    }

    let header = `=== Page: ${page.title} (${headerParts.join(", ")}) ===`;

    // Add markers for expired, low-confidence, disputed, superseded, and unsourced pages
    const markers: string[] = [];
    if (typeof expiry === "string" && expiry) {
      const expiryDate = new Date(expiry);
      if (!isNaN(expiryDate.getTime()) && expiryDate < new Date()) {
        markers.push("[EXPIRED — review before citing]");
      }
    }
    if (typeof confidence === "number" && confidence < LOW_CONFIDENCE_THRESHOLD) {
      markers.push("[LOW CONFIDENCE — treat as uncertain]");
    }
    if (page.frontmatter.disputed === true) {
      markers.push("[DISPUTED — claims under discussion]");
    }
    const replacementSlug = supersededBy.get(page.slug);
    if (replacementSlug) {
      markers.push(`[SUPERSEDED BY: ${replacementSlug}]`);
    }
    // Flag pages with no source provenance
    const hasSourceCount = !isNaN(sourceCount) && sourceCount > 0;
    const hasSourcesField =
      typeof page.frontmatter.sources === "string" &&
      page.frontmatter.sources.length > 0;
    if (!hasSourceCount && !hasSourcesField) {
      markers.push("[NO SOURCES — provenance unknown]");
    }
    if (markers.length > 0) {
      header += "\n" + markers.join("\n");
    }

    // The system-generated header + markers above are trusted; the page BODY is
    // collectively-editable, third-party-sourced content, so it's wrapped in an
    // untrusted-data boundary (see ./untrusted + UNTRUSTED_CONTENT_RULE in the
    // query system prompt) to contain indirect prompt injection. The `source`
    // label summarizes the page's provenance types for the model.
    const sourceTypes = Array.from(
      new Set(
        parseSources(
          page.frontmatter.sources as string | string[] | undefined,
        ).map((s) => s.type),
      ),
    );
    const wrappedBody = wrapUntrusted(page.body, {
      slug: page.slug,
      source: sourceTypes.length > 0 ? sourceTypes.join(", ") : undefined,
    });
    parts.push(`${header}\n${wrappedBody}`);
  }

  return { context: parts.join("\n\n"), slugs: loadedSlugs };
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

/**
 * Select which wiki pages to load for answering a question.
 *
 * For small wikis (<= {@link SMALL_WIKI_THRESHOLD}), returns all pages.
 * For larger wikis, uses BM25 + LLM-based index search.
 *
 * When `scopeSlugs` is provided, entries are pre-filtered to only those
 * slugs before any search or selection logic runs.
 *
 * Exported so the streaming endpoint can reuse the same selection logic.
 */
export async function selectPagesForQuery(
  question: string,
  entries: IndexEntry[],
  scopeSlugs?: string[],
): Promise<string[]> {
  // Pre-filter entries when a scope is provided
  const effective = scopeSlugs
    ? (() => {
        const allowed = new Set(scopeSlugs);
        return entries.filter((e) => allowed.has(e.slug));
      })()
    : entries;

  if (effective.length <= SMALL_WIKI_THRESHOLD) {
    return effective.map((e) => e.slug);
  }

  const selected = await searchIndex(question, effective);

  // If no matches found, fall back to first N pages
  if (selected.length === 0) {
    return effective.slice(0, MAX_CONTEXT_PAGES).map((e) => e.slug);
  }

  return selected;
}
