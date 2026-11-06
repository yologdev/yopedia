// ---------------------------------------------------------------------------
// Shared tuning constants
// ---------------------------------------------------------------------------
// Centralised home for every "magic number" used across the app.  Keeping them
// in one file makes it easy to tune behaviour without hunting through modules.
// ---------------------------------------------------------------------------

// ---- Ingest / Fetch -------------------------------------------------------

/** Maximum HTTP response body size in bytes (5 MB). */
export const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

/**
 * Maximum PDF file size (bytes). PDFs are denser than HTML — allow up to 20 MB
 * for text-based PDFs while staying well within Workers memory limits.
 * Binary PDFs (scanned, image-heavy) will mostly be text-empty and handled
 * gracefully by the no-text-layer check.
 */
export const MAX_PDF_SIZE = 20 * 1024 * 1024;

/** Maximum extracted text content length passed downstream (100 K chars). */
export const MAX_CONTENT_LENGTH = 100_000;

/** URL fetch timeout in milliseconds (15 seconds). */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Maximum characters sent to the LLM in a single chunk during ingest.
 *
 * 12,000 chars ≈ 3,000 tokens — conservative enough for all providers and
 * leaves ample room for the system prompt and output tokens within even the
 * smallest context windows (8K tokens).
 */
export const MAX_LLM_INPUT_CHARS = 12_000;

/** Maximum number of images to download per source during ingest. */
export const MAX_IMAGES_PER_SOURCE = 20;

/** Maximum number of source images tokenized for inline placement during synthesis. */
export const MAX_APPENDED_IMAGES = 12;

/** Max auto-generated tags persisted per page during synthesis. */
export const MAX_AUTO_TAGS = 6;

/**
 * Max existing tags shown to the synthesis LLM as the reuse vocabulary. Bounds
 * prompt size on large wikis (most-used tags first).
 */
export const TAG_VOCAB_LIMIT = 60;

// ---- Batch ingest ---------------------------------------------------------

/** Maximum number of URLs accepted in a single batch-ingest request. */
export const MAX_BATCH_URLS = 20;

// ---- Query / Retrieval ----------------------------------------------------

/** Maximum number of wiki pages to include in query context. */
export const MAX_CONTEXT_PAGES = 10;

/**
 * Page-count ceiling for full-body BM25 at query time.
 *
 * At or below this many candidate pages, BM25 reads every page body from disk
 * for maximum keyword recall. Above it, BM25 scores index-level title+summary
 * only (zero disk reads) and the dense/vector half of the hybrid retrieval
 * carries body-level recall — keeping per-query cost flat as the wiki grows.
 * A scoped query (vault/owner) under this size still gets full-body recall.
 */
export const BM25_FULLBODY_MAX_PAGES = 200;

/**
 * Cap on the "other pages (not loaded in full)" listing in the query system
 * prompt. The full wiki index is helpful context on a small wiki, but listing
 * every title+summary makes the prompt grow O(pages) — and cost with it — on a
 * large one. At or below this many *other* pages the listing is exhaustive;
 * above it, only the first N are named (plus a "…and M more" count).
 */
export const LISTED_OTHER_PAGES = 30;

/**
 * BM25 term-frequency saturation parameter.
 *
 * Controls how quickly term frequency saturates. Higher values give more
 * weight to repeated terms. Standard default is 1.2–2.0.
 */
export const BM25_K1 = 1.5;

/**
 * BM25 length-normalisation parameter.
 *
 * Controls how much document length affects the score. 0 = no length
 * normalisation, 1 = fully relative to average document length.
 * Standard default is 0.75.
 */
export const BM25_B = 0.75;

/**
 * BM25 title-match boost factor.
 *
 * When a query term appears in a page's title, an additional IDF-weighted
 * bonus is added to the BM25 score. This implements a lightweight BM25F-style
 * field boost without changing the core scoring formula.
 */
export const TITLE_BOOST = 2.0;

/**
 * Reciprocal Rank Fusion (RRF) constant.
 *
 * Dampens the influence of high-rank positions when fusing BM25 and vector
 * search results. Standard value is 60.
 */
export const RRF_K = 60;

// ---- LLM Retry ------------------------------------------------------------

/** Maximum number of retry attempts for transient LLM errors. */
export const LLM_MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff (1s → 2s → 4s). */
export const LLM_RETRY_BASE_MS = 1_000;

/** Maximum backoff delay cap in ms. */
export const LLM_RETRY_MAX_MS = 10_000;

// ---- LLM Output -----------------------------------------------------------

/** Default maximum output tokens for LLM generation calls. */
export const LLM_MAX_OUTPUT_TOKENS = 4096;

/**
 * Output-token cap for ingest synthesis. Higher than the default so the
 * `## Details` section can faithfully preserve substantive source content
 * rather than being truncated into a thin summary.
 */
export const INGEST_MAX_OUTPUT_TOKENS = 8192;

/**
 * Output-token cap for a single MAP partial when long-source synthesis distils
 * one chunk. Smaller than {@link INGEST_MAX_OUTPUT_TOKENS}: a chunk is only
 * ~{@link MAX_LLM_INPUT_CHARS} of source, and bounding each partial keeps the
 * combined notes fed to the REDUCE step well within one input.
 */
export const INGEST_MAP_MAX_OUTPUT_TOKENS = 2400;

/**
 * Max MAP chunks distilled concurrently. Parallelism cuts the wall-clock of a
 * long transcript from the sum of all chunks to a few batches, while the cap
 * keeps us within the LLM provider's burst/rate limits.
 */
export const INGEST_MAP_CONCURRENCY = 4;

/**
 * Output-token cap for query answers. Higher than the default so multi-section
 * answers, tables, and longer syntheses aren't truncated mid-response.
 */
export const QUERY_MAX_OUTPUT_TOKENS = 8192;

// ---- Related pages --------------------------------------------------------

/** Max pages shown in an article's "Related pages" (semantic see-also) section. */
export const RELATED_PAGES_LIMIT = 6;

/**
 * Candidate pool size for the ingest-time cross-reference (`findRelatedPages`).
 * On a wiki larger than this, the candidate list handed to the LLM is first
 * narrowed to the nearest pages by vector similarity, so the classify prompt
 * stays bounded (O(K)) instead of listing every page (O(all pages)). Comfortably
 * larger than RELATED_PAGES_LIMIT so the LLM still has room to choose.
 */
export const RELATED_CANDIDATE_POOL = 30;

/**
 * Minimum cosine similarity for a page to count as "related". Tuned for
 * bge-m3: distinct-but-related pages sit well above this, while unrelated
 * pages fall below — so weak matches don't pad the section.
 */
export const RELATED_MIN_SCORE = 0.45;

// ---- Graph ----------------------------------------------------------------

/** Default canvas height (px) for the wiki graph visualisation. */
export const GRAPH_CANVAS_HEIGHT = 560;

// ---- Streaming sentinels --------------------------------------------------

/**
 * Trailing sentinel appended to a streaming query response when the LLM stream
 * completes successfully. The client checks for this marker when `reader.read()`
 * returns `done: true` — its absence means the stream was truncated.
 *
 * The marker is a newline-wrapped tag unlikely to appear in natural LLM output,
 * keeping it invisible in rendered markdown while remaining easy to detect.
 */
export const STREAM_DONE_SENTINEL = "\n<!-- STREAM_COMPLETE -->\n";

/**
 * Sentinel appended when the LLM stream errors mid-response. The server catches
 * the error and writes this marker before closing, so the client can distinguish
 * "provider dropped the connection" from "completed normally".
 */
export const STREAM_ERROR_SENTINEL = "\n<!-- STREAM_ERROR -->\n";

// ---- Embeddings -----------------------------------------------------------

/**
 * Maximum characters sent to the embedding model per text.
 *
 * 24,000 chars ≈ ~6,000 tokens — safely under the 8,191-token limit of
 * OpenAI's text-embedding-3-small and comparable limits of other providers.
 * Text exceeding this length is truncated before being sent to the model.
 */
export const MAX_EMBED_CHARS = 24_000;
