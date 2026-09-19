import type { IndexEntry } from "./types";
import { callLLM, hasLLMKey } from "./llm";
import { withFileLock } from "./lock";
import { hasLinkTo } from "./links";
import { tryParseFrontmatter } from "./frontmatter";
import { logger } from "./logger";
import {
  readWikiPage,
  readWikiPageWithFrontmatter,
  tryReadWikiPageWithFrontmatter,
  listWikiPages,
  listReadableWikiPages,
  withPageCache,
  isAgentScopedType,
  isArtifactType,
  tenantForOwner,
} from "./wiki";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { mapWithConcurrency, READ_CONCURRENCY } from "./concurrency";
import { canReadFrontmatter } from "./authz";
import type { Principal } from "./auth";
import { getAgent, resolveAgentPages } from "./agents";
import { getVault } from "./vault";
import { getOwnerIndex } from "./owner-index";
import { getBacklinkIndex } from "./backlink-index";
import { relatedByVector, searchByVector } from "./embeddings";
import { RELATED_PAGES_LIMIT, RELATED_MIN_SCORE, RELATED_CANDIDATE_POOL } from "./constants";

// ---------------------------------------------------------------------------
// Cross-referencing helpers
// ---------------------------------------------------------------------------

const RELATED_PAGES_PROMPT = `Given this new wiki page and the existing wiki index, return a JSON array of slugs for pages that are related and should cross-reference this new page. Return at most 5 slugs. Return only the JSON array, nothing else.`;

/**
 * Identify existing wiki pages that are related to a newly written page.
 *
 * Sends the index entries + a summary of the new content to the LLM and asks
 * it to return a JSON array of related slugs. Falls back to an empty array
 * when there is no LLM key, no existing pages, or any error occurs.
 */
export async function findRelatedPages(
  newSlug: string,
  newContent: string,
  existingEntries: IndexEntry[],
): Promise<string[]> {
  // Nothing to cross-reference when there's no LLM or no existing pages
  if (!hasLLMKey() || existingEntries.length === 0) {
    return [];
  }

  let candidates = existingEntries.filter((e) => e.slug !== newSlug);

  // On a large wiki, narrow the candidate list to the nearest pages by vector
  // similarity BEFORE asking the LLM, so the classify prompt stays bounded
  // (~RELATED_CANDIDATE_POOL lines) instead of listing every page. Fail-soft:
  // if the vector store is empty or errors, fall back to the full list (so small
  // wikis and no-embedding setups behave exactly as before).
  if (candidates.length > RELATED_CANDIDATE_POOL) {
    try {
      const allowed = new Set(candidates.map((e) => e.slug));
      const hits = (await searchByVector(newContent, RELATED_CANDIDATE_POOL))
        .filter((h) => allowed.has(h.slug));
      if (hits.length > 0) {
        const bySlug = new Map(candidates.map((e) => [e.slug, e]));
        candidates = hits
          .map((h) => bySlug.get(h.slug))
          .filter((e): e is IndexEntry => e !== undefined);
      }
    } catch (err) {
      logger.warn(
        "wiki",
        "findRelatedPages vector prefilter failed; using the full index:",
        err,
      );
    }
  }

  // Build a user message with the (possibly narrowed) index and the new page.
  const indexList = candidates
    .map((e) => `- ${e.slug}: ${e.title} — ${e.summary}`)
    .join("\n");

  if (!indexList) {
    return [];
  }

  const userMessage = `## New page (slug: ${newSlug})\n\n${newContent.slice(0, 2000)}\n\n## Existing wiki index\n\n${indexList}`;

  try {
    const response = await callLLM(RELATED_PAGES_PROMPT, userMessage);

    // Extract JSON array from response — allow surrounding whitespace/text
    const match = response.match(/\[[\s\S]*?\]/);
    if (!match) return [];

    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    // Validate: only keep slugs that actually exist in the index (and aren't the new page)
    const validSlugs = new Set(
      existingEntries.filter((e) => e.slug !== newSlug).map((e) => e.slug),
    );
    return parsed
      .filter((s): s is string => typeof s === "string" && validSlugs.has(s))
      .slice(0, 5);
  } catch (err) {
    logger.warn("wiki", "findRelatedPages LLM call failed:", err);
    return [];
  }
}

/**
 * Append cross-reference links to related wiki pages.
 *
 * For each related slug:
 * - Reads the existing wiki page
 * - Skips if it already contains a link to the new slug
 * - Appends a "See also" link (or extends an existing "See also" section)
 *
 * Returns the slugs that were actually modified.
 */
export async function updateRelatedPages(
  newSlug: string,
  newTitle: string,
  relatedSlugs: string[],
): Promise<string[]> {
  return withFileLock("cross-ref", async () => {
    const updatedSlugs: string[] = [];

    for (const slug of relatedSlugs) {
      // Never append markdown cross-references to an HTML artifact — its body is
      // a self-contained document, and the "See also" markdown would render as
      // literal text below it. (Read frontmatter only for this type check.)
      const meta = await readWikiPageWithFrontmatter(slug);
      if (!meta) continue;
      if (
        isArtifactType(
          typeof meta.frontmatter.type === "string"
            ? meta.frontmatter.type
            : undefined,
        )
      ) {
        continue;
      }

      // Operate on the FULL file content (frontmatter + body) so the write-back
      // preserves the frontmatter block — writeWikiPageWithSideEffects writes
      // verbatim, and `readWikiPageWithFrontmatter.body` would have stripped
      // the frontmatter.
      const page = await readWikiPage(slug);
      if (!page) continue;

      // Skip if already links to the new page (use proper link detection
      // rather than substring matching to avoid false positives when the slug
      // appears in prose without being a wiki link).
      if (hasLinkTo(page.content, newSlug)) continue;

      const link = `[${newTitle}](${newSlug}.md)`;
      let updatedContent: string;

      // Check if there's already a "See also" section
      const seeAlsoPattern = /^(\*\*See also:\*\*.*)$/m;
      const seeAlsoMatch = page.content.match(seeAlsoPattern);

      if (seeAlsoMatch) {
        // Append to existing "See also" line
        updatedContent = page.content.replace(
          seeAlsoPattern,
          `${seeAlsoMatch[1]}, ${link}`,
        );
      } else {
        // Add a new "See also" section at the end
        updatedContent = `${page.content.trimEnd()}\n\n**See also:** ${link}\n`;
      }

      await writeWikiPageWithSideEffects({
        slug,
        title: meta.frontmatter.title as string || slug,
        content: updatedContent,
        summary: (() => {
          const m = meta.body.match(/^#\s+.+\n+(.+)/m);
          return m ? m[1].slice(0, 120) : slug;
        })(),
        logOp: "edit",
        logDetails: () => `cross-reference update from "${newSlug}"`,
        crossRefSource: null,
        author: "system",
      });
      updatedSlugs.push(slug);
    }

    return updatedSlugs;
  });
}

// ---------------------------------------------------------------------------
// Backlinks — "What links here"
// ---------------------------------------------------------------------------

/**
 * Find all wiki pages that link to the given slug.
 * Returns an array of { slug, title } for pages containing a markdown link
 * to `targetSlug.md`.
 */
export async function findBacklinks(
  targetSlug: string,
  principal: Principal | null = null,
): Promise<Array<{ slug: string; title: string }>> {
  return withPageCache(async () => {
    // Readable pages only — a private page must not surface as a backlink to
    // viewers who can't see it. Visibility is ALWAYS enforced here on READ; the
    // backlink index never encodes it. Scope-match too: agent <-> wiki content
    // never cross-relate, so a wiki page never shows an agent page (and vice
    // versa) under "what links here".
    const allReadable = await listReadableWikiPages(principal);
    const anchorIsAgent = isAgentScopedType(
      allReadable.find((p) => p.slug === targetSlug)?.type,
    );
    const pages = allReadable.filter(
      (p) => isAgentScopedType(p.type) === anchorIsAgent,
    );

    // Fast path: the precomputed reverse-link index gives the source slugs that
    // link TO targetSlug in O(1). We then intersect with the readable set (the
    // SAME filter the scan applies) and resolve titles from it. Falls back to
    // the O(pages²) scan below only when the index is ABSENT (reader → null);
    // an empty-but-present index is authoritative.
    const backlinkIdx = await getBacklinkIndex();
    if (backlinkIdx !== null) {
      const sources = backlinkIdx[targetSlug];
      if (!sources || sources.length === 0) return [];
      const readable = new Map(pages.map((p) => [p.slug, p.title]));
      const backlinks: Array<{ slug: string; title: string }> = [];
      for (const slug of sources) {
        if (slug === targetSlug || slug === "index" || slug === "log") continue;
        const title = readable.get(slug);
        if (title !== undefined) backlinks.push({ slug, title });
      }
      return backlinks;
    }

    const backlinks: Array<{ slug: string; title: string }> = [];

    for (const page of pages) {
      if (page.slug === targetSlug || page.slug === "index" || page.slug === "log")
        continue;
      const wikiPage = await readWikiPage(page.slug);
      if (wikiPage && hasLinkTo(wikiPage.content, targetSlug)) {
        backlinks.push({ slug: page.slug, title: page.title });
      }
    }

    return backlinks;
  });
}

// ---------------------------------------------------------------------------
// Related pages — semantic "see also"
// ---------------------------------------------------------------------------

/**
 * Find pages semantically related to `slug` via vector similarity, for the
 * "Related pages" section. Unlike backlinks (explicit links), this surfaces
 * topically-similar pages even when nothing links to the page.
 *
 * Visibility is enforced on READ (a private page never leaks to a viewer who
 * can't see it). Below-threshold matches are dropped so weakly-related pages
 * don't appear. Returns `{ slug, title, score }`, highest score first.
 */
export async function findSimilarPages(
  slug: string,
  principal: Principal | null = null,
  limit: number = RELATED_PAGES_LIMIT,
  minScore: number = RELATED_MIN_SCORE,
): Promise<Array<{ slug: string; title: string; score: number }>> {
  return withPageCache(async () => {
    // Over-fetch so visibility/threshold filtering still leaves up to `limit`.
    const scored = await relatedByVector(slug, limit + 10);
    if (scored.length === 0) return [];

    // Scope-match: relate only within the same scope — a wiki page never shows
    // agent-scoped pages as related, and an agent page never shows wiki pages.
    const pages = await listReadableWikiPages(principal);
    const anchorIsAgent = isAgentScopedType(
      pages.find((p) => p.slug === slug)?.type,
    );
    const readable = new Map(
      pages
        .filter((p) => isAgentScopedType(p.type) === anchorIsAgent)
        .map((p) => [p.slug, p.title]),
    );

    const related: Array<{ slug: string; title: string; score: number }> = [];
    for (const { slug: s, score } of scored) {
      if (score < minScore) break; // sorted desc — nothing further qualifies
      if (s === slug || s === "index" || s === "log") continue;
      const title = readable.get(s);
      if (title === undefined) continue; // not readable by this viewer
      related.push({ slug: s, title, score });
      if (related.length >= limit) break;
    }
    return related;
  });
}

// ---------------------------------------------------------------------------
// Full-text content search
// ---------------------------------------------------------------------------

/** A search result with snippet context. */
export interface ContentSearchResult {
  slug: string;
  title: string;
  summary: string;
  /** Short snippet showing the match context */
  snippet: string;
  /** Relevance score — number of matching query terms */
  score: number;
  /** True when this result came from fuzzy (typo-tolerant) matching */
  fuzzy?: boolean;
}

/** Strip a leading markdown heading marker (`#`/`>`/list bullets) from a line. */
function stripLeadingMarkdown(text: string): string {
  return text.replace(/^[#>\-*\s]+/, "");
}

/**
 * Truncate to `max` chars on a WORD boundary (never mid-word), appending an
 * ellipsis when the text was actually cut. Avoids fragments like "…es across".
 */
function truncateAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Keep the word-boundary cut unless it would throw away most of the budget.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.trimEnd() + "…";
}

/**
 * Build a match-context snippet from a page BODY (frontmatter already removed)
 * centred on `matchIndex`, trimmed to whole words so neither end lands
 * mid-word, with leading/trailing ellipses when the window is interior. Pass a
 * body — never the raw file — so YAML frontmatter can't leak into the snippet.
 */
function contextSnippet(body: string, matchIndex: number, radius = 70): string {
  const rawStart = Math.max(0, matchIndex - radius);
  const rawEnd = Math.min(body.length, matchIndex + radius);
  let chunk = body.slice(rawStart, rawEnd);
  // Drop the partial words the window may have clipped at each interior edge.
  if (rawStart > 0) chunk = chunk.replace(/^\S*\s+/, "");
  if (rawEnd < body.length) chunk = chunk.replace(/\s+\S*$/, "");
  chunk = stripLeadingMarkdown(chunk).replace(/\s+/g, " ").trim();
  return (rawStart > 0 ? "…" : "") + chunk + (rawEnd < body.length ? "…" : "");
}

/**
 * Scope filter for search — restricts results to a set of known slugs.
 * The caller resolves agent IDs (or other scope sources) to slug lists
 * before calling search, keeping search.ts decoupled from agents.ts.
 */
export interface SearchScope {
  agentId: string;
  slugs: string[];
}

// ---------------------------------------------------------------------------
// Fuzzy matching — Levenshtein-based typo tolerance
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses a simple iterative two-row approach — no dependencies.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use two rows instead of full matrix for O(n) space
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    // Swap rows
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Get the maximum allowed edit distance for a word based on its length.
 * - Words ≤ 2 chars: 0 (exact only)
 * - Words 3–4 chars: 1
 * - Words ≥ 5 chars: 2
 */
function maxDistanceForWord(word: string): number {
  if (word.length <= 2) return 0;
  if (word.length <= 4) return 1;
  return 2;
}

/**
 * Check if a query fuzzy-matches the given text.
 *
 * For each word in the query, checks if any word in the text is within
 * the allowed edit distance. All query words must match for the overall
 * result to be true.
 *
 * @param query - The search query (may contain multiple words)
 * @param text - The text to search in
 * @param maxDistance - Override the per-word distance threshold (optional)
 * @returns true if every query word fuzzy-matches at least one text word
 */
export function fuzzyMatch(
  query: string,
  text: string,
  maxDistance?: number,
): boolean {
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const textWords = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (queryWords.length === 0) return false;
  if (textWords.length === 0) return false;

  for (const qw of queryWords) {
    const threshold = maxDistance ?? maxDistanceForWord(qw);
    // If threshold is 0, we need exact match
    if (threshold === 0) {
      if (!textWords.some((tw) => tw === qw)) return false;
    } else {
      if (!textWords.some((tw) => levenshteinDistance(qw, tw) <= threshold)) return false;
    }
  }

  return true;
}

/**
 * Search wiki page content for a query string.
 *
 * Simple case-insensitive term matching across all wiki pages.
 * Designed for the real-time search bar — uses OR semantics (any term matches)
 * and scores by number of matching terms.
 *
 * When `scope` is provided, only pages whose slug appears in `scope.slugs`
 * are searched.
 */
/**
 * Slugs excluded from search. Artifacts (e.g. `html`/`slides` rendered outputs)
 * are ALWAYS excluded — their markup is not knowledge and must never surface as a
 * hit or enter the LLM context, even within a scope (e.g. a vault that curated
 * one, or a user's own "Mine"/owner scope). Agent-scoped pages (`agent-*`) are
 * excluded only from GENERAL (unscoped) search — they surface via an `agent:`
 * scope — so pass `includeAgentScoped: false` when a scope is active.
 */
async function searchExcludedSlugSet(
  includeAgentScoped: boolean,
): Promise<Set<string>> {
  const pages = await listWikiPages();
  return new Set(
    pages
      .filter(
        (p) =>
          isArtifactType(p.type) ||
          (includeAgentScoped && isAgentScopedType(p.type)),
      )
      .map((p) => p.slug),
  );
}

export async function searchWikiContent(
  query: string,
  maxResults = 10,
  scope?: SearchScope,
  principal: Principal | null = null,
): Promise<ContentSearchResult[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  // Use the page index instead of a raw directory listing.
  const allPages = await listWikiPages();

  const SKIP = new Set(["index", "log"]);
  const scopeSlugs = scope ? new Set(scope.slugs) : null;
  // Always excludes artifacts; agent-scoped pages too when UNSCOPED (they surface
  // only via an `agent:` scope).
  const excludedSlugs = await searchExcludedSlugSet(/* includeAgentScoped */ !scope);

  const scored: Array<{
    slug: string;
    title: string;
    summary: string;
    snippet: string;
    score: number;
  }> = [];

  // Cheap index-only filters first (skip-list, scope, artifacts/agent-scoped),
  // then read the surviving candidates' bodies in parallel (bounded). The read
  // used to run serially inside this loop — the dominant cost of content search.
  const candidates = allPages.filter(
    (entry) =>
      !SKIP.has(entry.slug) &&
      !(scopeSlugs && !scopeSlugs.has(entry.slug)) &&
      !excludedSlugs.has(entry.slug),
  );
  const candidatePages = await mapWithConcurrency(
    candidates,
    READ_CONCURRENCY,
    // Read via readWikiPage (silo-primary after #749)
    (entry) => readWikiPage(entry.slug),
  );

  for (let i = 0; i < candidates.length; i++) {
    const slug = candidates[i].slug;
    const page = candidatePages[i];
    if (!page) continue;
    const content = page.content;

    const lower = content.toLowerCase();

    // Score = how many query terms appear anywhere in the raw file (title,
    // frontmatter tags, or body) — keeps recall wide; the snippet is drawn from
    // the body separately below.
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score++;
    }

    if (score === 0) continue;

    // Extract title from first heading or slug
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : slug;

    // Extract summary from index-style content (first paragraph after heading)
    // A page whose frontmatter won't parse drops out of the results — it must
    // never take the whole search down with it.
    const parsed = tryParseFrontmatter(content, slug, "search");
    if (!parsed) continue;
    // Read-gate: never return snippets from a private page the caller can't read.
    if (!canReadFrontmatter(parsed.data, principal)) continue;
    const body = parsed.body;
    const summaryLine = body
      .replace(/^#\s+.+$/m, "")
      .trim()
      .split("\n")
      .find((l) => l.trim().length > 0);
    const summary = summaryLine ? truncateAtWord(summaryLine, 120) : "";

    // Snippet = match context from the BODY (frontmatter already stripped), cut
    // on word boundaries. The match index is recomputed against the body so a
    // term that matched only in the YAML frontmatter (tags, source_count, dates)
    // can't drag the window into it; when the query matched only the
    // frontmatter/title, fall back to the clean summary.
    const lowerBody = body.toLowerCase();
    let bodyMatchIndex = -1;
    for (const term of terms) {
      const idx = lowerBody.indexOf(term);
      if (idx !== -1 && (bodyMatchIndex === -1 || idx < bodyMatchIndex)) {
        bodyMatchIndex = idx;
      }
    }
    const snippet =
      bodyMatchIndex !== -1 ? contextSnippet(body, bodyMatchIndex) : summary;

    scored.push({ slug, title, summary, snippet, score });
  }

  // Sort by score descending, then alphabetically by title
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  return scored.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Fuzzy content search — falls back to fuzzy when exact returns few results
// ---------------------------------------------------------------------------

/** Minimum exact results before fuzzy fallback kicks in */
const FUZZY_FALLBACK_THRESHOLD = 3;

/**
 * Search wiki page content, falling back to fuzzy matching when exact
 * matching returns fewer than 3 results.
 *
 * Exact matches are returned first (without the fuzzy flag). Fuzzy matches
 * are appended after with `fuzzy: true`. Duplicates are removed.
 *
 * When `scope` is provided, only pages whose slug appears in `scope.slugs`
 * are searched (both exact and fuzzy phases).
 */
export async function fuzzySearchWikiContent(
  query: string,
  maxResults = 10,
  scope?: SearchScope,
  principal: Principal | null = null,
): Promise<ContentSearchResult[]> {
  // Start with exact search
  const exactResults = await searchWikiContent(query, maxResults, scope, principal);

  // If we have enough exact results, just return them
  if (exactResults.length >= FUZZY_FALLBACK_THRESHOLD) {
    return exactResults;
  }

  // Fall back to fuzzy matching for additional results
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return exactResults;

  // Don't bother with fuzzy if all terms are too short
  if (terms.every((t) => t.length <= 2)) return exactResults;

  // Use the page index instead of a raw directory listing.
  const allPages = await listWikiPages();

  const SKIP = new Set(["index", "log"]);
  const exactSlugs = new Set(exactResults.map((r) => r.slug));
  const scopeSlugs = scope ? new Set(scope.slugs) : null;
  const excludedSlugs = await searchExcludedSlugSet(/* includeAgentScoped */ !scope);

  const fuzzyResults: ContentSearchResult[] = [];

  // Cheap index-only filters first (skip-list, scope, artifacts/agent-scoped,
  // already-exact), then read the survivors' bodies in parallel (bounded). The
  // read used to run serially inside this loop.
  const candidates = allPages.filter(
    (entry) =>
      !SKIP.has(entry.slug) &&
      !(scopeSlugs && !scopeSlugs.has(entry.slug)) &&
      !excludedSlugs.has(entry.slug) &&
      !exactSlugs.has(entry.slug),
  );
  const candidatePages = await mapWithConcurrency(
    candidates,
    READ_CONCURRENCY,
    // Read via readWikiPage (silo-primary after #749)
    (entry) => readWikiPage(entry.slug),
  );

  for (let i = 0; i < candidates.length; i++) {
    const slug = candidates[i].slug;
    const page = candidatePages[i];
    if (!page) continue;
    const content = page.content;

    if (!fuzzyMatch(query, content)) continue;

    // Extract title from first heading or slug
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : slug;

    // Extract summary (same skip-on-malformed rule as the exact pass above).
    const parsed = tryParseFrontmatter(content, slug, "search");
    if (!parsed) continue;
    // Read-gate: never return snippets from a private page the caller can't read.
    if (!canReadFrontmatter(parsed.data, principal)) continue;
    const body = parsed.body;
    const summaryLine = body
      .replace(/^#\s+.+$/m, "")
      .trim()
      .split("\n")
      .find((l) => l.trim().length > 0);
    const summary = summaryLine ? truncateAtWord(summaryLine, 120) : "";

    // Fuzzy matches have no exact term to centre on — use the page's opening
    // prose (heading + frontmatter stripped, word-boundary cut) as the preview.
    const snippet = truncateAtWord(
      stripLeadingMarkdown(body.replace(/^#\s+.+$/m, "").trim()),
      140,
    );

    fuzzyResults.push({ slug, title, summary, snippet, score: 0, fuzzy: true });
  }

  // Sort fuzzy results alphabetically by title
  fuzzyResults.sort((a, b) => a.title.localeCompare(b.title));

  // Combine: exact first, then fuzzy to fill up to maxResults
  const remaining = maxResults - exactResults.length;
  return [...exactResults, ...fuzzyResults.slice(0, remaining)];
}

// ---------------------------------------------------------------------------
// Scope resolution — parse a scope string and resolve to a SearchScope
// ---------------------------------------------------------------------------

/**
 * Parse a scope parameter string and resolve it to a {@link SearchScope}.
 *
 * Currently supports:
 *   - `"agent:<id>"` — looks up the agent via {@link getAgent} and returns all
 *     page slugs from `identityPages + learningPages + socialPages`.
 *
 * Returns `null` if the scope string format is invalid or the referenced
 * entity doesn't exist.
 */
/**
 * Slugs a handle "owns" for the Mine lens: pages where `owner === handle` OR
 * the handle appears in `contributors`. Scans frontmatter (O(n), small scale).
 */
export async function slugsForOwner(handle: string): Promise<string[]> {
  // Compare by TENANT, not raw handle: owner matching is case-insensitive and,
  // crucially, ownerless/seed pages (no `owner` field → DEFAULT_TENANT) belong
  // to the `yopedia` silo. So `/u/yopedia` and `owner:yopedia` include them.
  const wantTenant = tenantForOwner(handle);

  // Fast path: read the precomputed owner→slugs index (O(1)). Falls through to
  // the live frontmatter scan below only when the index is ABSENT (reader →
  // null); an empty-but-present index is authoritative. Behavior-preserving.
  const ownerIdx = await getOwnerIndex();
  if (ownerIdx !== null) {
    return ownerIdx[wantTenant] ?? [];
  }

  const pages = await listWikiPages();
  const out: string[] = [];
  for (const entry of pages) {
    if (entry.slug === "index" || entry.slug === "log") continue;
    const page = await tryReadWikiPageWithFrontmatter(entry.slug, "search");
    if (!page) continue;
    const owner =
      typeof page.frontmatter.owner === "string" ? page.frontmatter.owner : "";
    const contributors = Array.isArray(page.frontmatter.contributors)
      ? (page.frontmatter.contributors as string[])
      : [];
    const matchesOwner = tenantForOwner(owner) === wantTenant;
    const matchesContributor = contributors.some(
      (c) => typeof c === "string" && tenantForOwner(c) === wantTenant,
    );
    if (matchesOwner || matchesContributor) out.push(entry.slug);
  }
  return out;
}

/**
 * Expand the client-facing `"mine"` scope to the concrete `owner:<handle>` of
 * the signed-in principal (the Mine|All lens — see [[yopedia-tenant-silos]]).
 * Signed-out callers asking for "mine" fall through to the unscoped commons.
 * Any other scope string passes through unchanged. Pure — called at the route
 * boundary before `query()`/`fuzzySearchWikiContent`/the graph route.
 */
export function expandMineScope(
  scope: string | undefined | null,
  principal: Principal | null,
): string | undefined {
  if (scope === "mine") {
    return principal ? `owner:${principal.handle}` : undefined;
  }
  return scope || undefined;
}

/**
 * Resolve a request's raw scope (incl. the `"mine"` convenience) to a concrete
 * slug set, or an error. One source of truth for query + stream. Semantics:
 * - no scope (or signed-out "mine") → `{}` (unscoped = full commons)
 * - `"mine"` for a signed-in user with NO own pages → `{}` (fall back to the
 *   commons rather than erroring — good first-run UX)
 * - explicit `owner:`/`agent:` with no pages, or an unresolvable scope → error
 */
export async function resolveScopeSlugs(
  rawScope: string | undefined | null,
  principal: Principal | null,
): Promise<{ scopeSlugs?: string[]; error?: string }> {
  const scope = expandMineScope(rawScope, principal);
  if (!scope) return {};
  const resolved = await resolveScope(scope);
  if (!resolved) {
    return { error: `Invalid scope or agent not found: '${rawScope}'` };
  }
  if (resolved.slugs.length === 0) {
    if (rawScope === "mine") return {}; // no own pages yet → full commons
    return { error: `No pages found for scope '${rawScope}'` };
  }
  return { scopeSlugs: resolved.slugs };
}

export async function resolveScope(
  scopeParam: string,
): Promise<SearchScope | null> {
  if (!scopeParam || typeof scopeParam !== "string") return null;

  // owner:<handle> — the personal "Mine" lens (a public view filter, not access
  // control). Resolves to pages the handle owns OR has contributed to.
  const ownerMatch = scopeParam.match(/^owner:(.+)$/);
  if (ownerMatch) {
    const handle = ownerMatch[1]?.trim();
    if (!handle) return null;
    return { agentId: handle, slugs: await slugsForOwner(handle) };
  }

  // vault:<id> — a curated reference lens over the commons. Only PUBLIC vaults
  // resolve via scope (a public view filter); PRIVATE vaults are owner-only
  // (V2) and return null here so they're never exposed through a scope param.
  const vaultMatch = scopeParam.match(/^vault:(.+)$/);
  if (vaultMatch) {
    const vaultId = vaultMatch[1]?.trim();
    if (!vaultId) return null;
    const vault = await getVault(vaultId);
    if (!vault) return null;
    if (vault.visibility !== "public") return null;
    return { agentId: vaultId, slugs: vault.slugs };
  }

  const match = scopeParam.match(/^agent:(.+)$/);
  if (!match) return null;

  const agentId = match[1];
  if (!agentId) return null;

  try {
    const agent = await getAgent(agentId);
    if (!agent) return null;

    // Effective pages = own + inherited from the template chain, so an
    // `agent:<fork>` scope also searches the base content the fork inherits.
    const pages = await resolveAgentPages(agent);
    const slugs = [
      ...new Set([
        ...pages.identityPages,
        ...pages.learningPages,
        ...pages.socialPages,
      ]),
    ];

    return { agentId: agent.id, slugs };
  } catch (err) {
    // A malformed agent id is genuinely unresolvable → null is correct. Any
    // other error (storage outage, corrupt agent JSON in the template chain)
    // must NOT be masked as an empty scope — that would silently mis-scope
    // search during an outage. Log and rethrow those.
    if (err instanceof Error && err.message.includes("Invalid agent ID")) {
      return null;
    }
    logger.warn("search", `resolveScope failed for "${scopeParam}":`, err);
    throw err;
  }
}
