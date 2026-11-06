/** A wiki page read from disk. */
export interface WikiPage {
  slug: string;
  title: string;
  content: string;
  path: string;
}

/** A single entry in wiki/index.md. */
export interface IndexEntry {
  slug: string;
  title: string;
  summary: string;
  /** Optional frontmatter-derived fields. Optional so legacy index entries
   * (and pages without frontmatter) still parse into a valid `IndexEntry`. */
  tags?: string[];
  /** ISO-ish string from the page's `updated` frontmatter field. */
  updated?: string;
  /** Number of raw sources this page was built from. */
  sourceCount?: number;
  /** Original source URL (from URL-based ingest). */
  sourceUrl?: string;
  /** Confidence score 0–1 from frontmatter. */
  confidence?: number;
  /** Owner (principal handle) from frontmatter, if any. */
  owner?: string;
  /** Page type from frontmatter (e.g. "agent-identity"). */
  type?: string;
  /** Visibility from frontmatter ("private" gates reads; absent/other = public). */
  visibility?: string;
  /** ISO date from the page's `expiry` frontmatter — past dates mean the page
   * is decaying (the Browse rows surface this as a rust receipt). */
  expiry?: string;
}

/** Result returned after ingesting a source document. */
export interface IngestResult {
  rawPath: string;
  /** Slug of the newly created/updated primary page. */
  primarySlug: string;
  /** Slugs of pre-existing pages that had cross-refs updated. Empty if none. */
  relatedUpdated: string[];
  /**
   * Flat list of every page this ingest touched: `[primarySlug, ...relatedUpdated]`.
   * Kept for backwards compatibility with the existing API consumers.
   */
  wikiPages: string[];
  indexUpdated: boolean;
  /** The original source URL, if the ingest was URL-based. */
  sourceUrl?: string;
  /**
   * True when this ingest matched an existing canonical page (same source URL
   * or identical content) and was attached to it instead of re-synthesizing —
   * no LLM/embedding tokens spent. The UI can say "added to your collection"
   * rather than "created".
   */
  deduped?: boolean;
  /**
   * When the source was long enough for MAP/REDUCE synthesis, how many MAP
   * chunks failed (LLM error) vs the total. Present only when at least one
   * chunk failed but the page was still produced from the surviving chunks.
   */
  chunksFailed?: number;
  chunksTotal?: number;
}

/** Result from a query against the wiki. */
export interface QueryResult {
  answer: string; // Markdown-formatted answer with citations
  sources: string[]; // slugs of wiki pages used as sources
}

/** A single issue found by the lint operation. */
export interface LintIssue {
  type: "orphan-page" | "stale-index" | "missing-crossref" | "empty-page" | "contradiction" | "missing-concept-page" | "broken-link" | "stale-page" | "low-confidence" | "unmigrated-page" | "duplicate-entity" | "uncited-claims" | "unresolved-discussions" | "disputed-page" | "supersedes-dangling" | "incomplete-coverage" | "dead-source";
  slug: string;
  /** Structured target slug for cross-ref, contradiction, broken-link, and duplicate-entity fixes.
   * Eliminates the need to parse human-readable messages to extract targets. */
  target?: string;
  message: string;
  severity: "error" | "warning" | "info";
  /** Actionable hint for resolving the issue — e.g. a search query to find
   * authoritative sources, or a suggestion to ingest new material. */
  suggestion?: string;
}

/** Options to configure which lint checks to run and filter results. */
export interface LintOptions {
  /** Which check types to run. Defaults to all if omitted. */
  checks?: LintIssue["type"][];
  /** Minimum severity to include in results. Defaults to "info". */
  minSeverity?: "error" | "warning" | "info";
}

/** Result returned by the lint operation. */
export interface LintResult {
  issues: LintIssue[];
  summary: string;
  checkedAt: string;
}

/** A single provenance entry in the structured `sources[]` array. */
export interface SourceEntry {
  /** Provenance type: how the source was acquired. */
  type: "url" | "text" | "x-mention" | "wiki-ref" | "image" | "pdf" | "youtube";
  /** Source URL or "text-paste" for pasted content. */
  url: string;
  /** ISO date string of when the source was fetched/ingested. */
  fetched: string;
  /** Who triggered the ingest (user handle or "system"). */
  triggered_by: string;
  /**
   * Identifier of this source's per-source raw snapshot at
   * `raw/<slug>/<raw_id>.md`. Absent on legacy pages ingested before per-source
   * raw existed (those keep only the single latest `raw/<slug>.md`).
   */
  raw_id?: string;
}

// ---------------------------------------------------------------------------
// Talk pages — Phase 2 threaded discussion system
// ---------------------------------------------------------------------------

/** A single comment in a talk page thread. */
export interface TalkComment {
  /** Unique ID (timestamp-based, e.g. "1714600000000") */
  id: string;
  /** Who wrote this comment (user handle or agent ID) */
  author: string;
  /** ISO date string */
  created: string;
  /** Markdown content */
  body: string;
  /** ID of parent comment for threading, or null for top-level */
  parentId: string | null;
}

/** A talk page thread linked to a wiki page. */
export interface TalkThread {
  /** Slug of the wiki page this discussion is about */
  pageSlug: string;
  /** Thread title / topic */
  title: string;
  /** "open" | "resolved" | "wontfix" */
  status: "open" | "resolved" | "wontfix";
  /** ISO date of creation */
  created: string;
  /** ISO date of last activity */
  updated: string;
  /** Ordered list of comments */
  comments: TalkComment[];
}

// ---------------------------------------------------------------------------
// Contributor profiles — Phase 2 trust and attribution
// ---------------------------------------------------------------------------

/** Aggregated profile for a single contributor (human or agent). */
export interface ContributorProfile {
  /** Author handle (matches revision `author` and talk comment `author`) */
  handle: string;
  /** Total number of revisions authored */
  editCount: number;
  /** Number of distinct wiki pages edited */
  pagesEdited: number;
  /** Number of talk page comments authored */
  commentCount: number;
  /** Number of talk threads created */
  threadsCreated: number;
  /** ISO date of the author's first known activity */
  firstSeen: string;
  /** ISO date of the author's most recent activity */
  lastSeen: string;
  /** Number of revisions where this author's content was subsequently reverted
   *  (i.e., a later revision by a different author substantially reduced content). */
  revertCount: number;
  /** Trust score 0–1. Heuristic based on activity volume and revert rate.
   *  Formula: min(1, (editCount + commentCount) / 50) * (1 - min(0.5, revertCount * 0.1))
   *  Each revert reduces trust by 10%, capped at 50% reduction. */
  trustScore: number;
}

// ---------------------------------------------------------------------------
// Agent profiles — Phase 4 agent identity as yopedia pages
// ---------------------------------------------------------------------------

/** An agent registered in yopedia. */
export interface AgentProfile {
  /** Unique agent identifier. For owned agents this is the composite
   *  `slugify("<owner>-<name>")` (e.g. "yopedia-yoyo", "alice-yoyo"), so every
   *  owner can have their own "yoyo". Legacy/unowned agents may use a bare slug. */
  id: string;
  /** Display name */
  name: string;
  /** Short description of who this agent is */
  description: string;
  /** Accountable principal handle (the user who seeded/owns this agent).
   *  Set from the authenticated session, never from client input. Only the
   *  owner may re-seed, feed, update, or delete the agent. Optional for
   *  back-compat with any pre-ownership agent records (treated as unowned). */
  owner?: string;
  /** The id of the agent this one was forked from (its template), or undefined
   *  for a root agent (the synced base, e.g. "yopedia-yoyo"). A fork inherits
   *  the template's pages by reference — see resolveAgentPages() — so base
   *  updates keep flowing through until the fork overrides a page (future). */
  template?: string;
  /** Wiki page slugs that form this agent's identity context (its OWN pages;
   *  inherited pages come from the template via resolveAgentPages). */
  identityPages: string[];
  /** Wiki page slugs containing this agent's learnings */
  learningPages: string[];
  /** Wiki page slugs containing social wisdom */
  socialPages: string[];
  /** Optional vault id this agent's remote-MCP ingests are filed into (by
   *  reference). Set by the owner; must be a vault they own. Surfaced to the
   *  connecting agent via the MCP `initialize` instructions and the write-tool
   *  descriptions in `tools/list`. */
  defaultVault?: string;
  /** ISO date of when the agent was registered */
  registered: string;
  /** ISO date of last context update */
  lastUpdated: string;
}

// ---------------------------------------------------------------------------

/** Metadata about the currently configured LLM provider. */
export interface ProviderInfo {
  /** true if any provider key / config is set */
  configured: boolean;
  /** "anthropic" | "openai" | "google" | "ollama" | null */
  provider: string | null;
  /** resolved model name (including LLM_MODEL override) */
  model: string | null;
  /** true if the active provider supports embeddings */
  embeddingSupport: boolean;
}
