import {
  saveRawSource,
  saveRawSourceFor,
  writeWikiPageWithSideEffects,
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
  listWikiPages,
  isArtifactType,
  isAgentScopedType,
  type Frontmatter,
} from "./wiki";
import { buildCorpusStats, bm25Score, tokenize } from "./bm25";
import { ensureReconciliationThread } from "./talk";
import { callLLM, hasLLMKey } from "./llm";
import { fetchUrlContent, fetchImageBytes, storeImageBytes, pdfToText } from "./fetch";
import { describeImage } from "./vision";
import { isYouTubeUrl, fetchYouTubeContent } from "./youtube";
import { isXPostUrl, fetchXPostContent, isXArticleTeaser } from "./x-post";
import type { IngestResult, SourceEntry } from "./types";
import {
  serializeSources,
  parseSources,
  buildSourceEntry,
} from "./sources";
import { normalizeUrl } from "./source-index";

/**
 * Merge a provenance entry into a sources list. A real source URL supersedes a
 * stale `"text-paste"` placeholder of the same type (the placeholder just means
 * "no URL was known"), so once a real URL arrives the placeholder is dropped.
 * Updates an existing match in place; otherwise appends.
 */
export function mergeSourceEntry(sources: SourceEntry[], entry: SourceEntry): SourceEntry[] {
  const isRealUrl = entry.url !== "text-paste";
  const base = isRealUrl
    ? sources.filter((s) => !(s.type === entry.type && s.url === "text-paste"))
    : sources;
  // A real (non-text-paste) source is identified by its URL alone: the same URL
  // is the same source even if a re-ingest classified its type differently
  // (e.g. a PDF URL re-fetched as a plain "url"). Matching on URL+type here let
  // such a re-ingest append a duplicate entry. text-paste placeholders have no
  // real URL, so they still dedup on (url, type).
  // Normalize both sides so URL variants (http vs https, www vs bare, trailing
  // slash, etc.) are treated as the same source.
  const entryNorm = isRealUrl ? normalizeUrl(entry.url) : entry.url;
  const idx = isRealUrl
    ? base.findIndex((s) => normalizeUrl(s.url) === entryNorm)
    : base.findIndex((s) => s.url === entry.url && s.type === entry.type);
  if (idx >= 0) {
    base[idx] = {
      ...base[idx],
      fetched: entry.fetched,
      triggered_by: entry.triggered_by,
      // Carry the new snapshot id (same URL → same id; also upgrades a legacy
      // entry that predates per-source raw).
      ...(entry.raw_id ? { raw_id: entry.raw_id } : {}),
    };
  } else {
    base.push(entry);
  }
  return base;
}

/**
 * Authority baseline per source type for the confidence heuristic — higher for
 * documents/articles, lower for social/unverified provenance.
 */
const SOURCE_TYPE_WEIGHT: Record<SourceEntry["type"], number> = {
  pdf: 0.68,
  "wiki-ref": 0.65,
  url: 0.6,
  youtube: 0.55,
  image: 0.5,
  text: 0.5,
  "x-mention": 0.5,
};

/**
 * Heuristic page confidence from real provenance signals — replaces the old
 * constant 0.7. A lone source sits BELOW 0.7 so corroboration can earn its way
 * up (a single URL reads ~0.60, not the old default):
 *  - authority of the STRONGEST source type present,
 *  - corroboration: +0.05 per additional DISTINCT source URL (cap +0.15),
 *  - a `disputed` page is capped at 0.5.
 * Clamped to [0.3, 0.95], rounded to 2 decimals. An empty source set → 0.5.
 */
export function computeConfidence(
  sources: SourceEntry[],
  disputed: boolean,
): number {
  if (sources.length === 0) return 0.5;
  const base = Math.max(
    ...sources.map((s) => SOURCE_TYPE_WEIGHT[s.type] ?? 0.5),
  );
  const distinctUrls = new Set(
    sources.map((s) => (s.url === "text-paste" ? s.url : normalizeUrl(s.url))),
  ).size;
  const corroboration = Math.min(0.15, Math.max(0, distinctUrls - 1) * 0.05);
  let score = base + corroboration;
  if (disputed) score = Math.min(score, 0.5);
  return Math.round(Math.min(0.95, Math.max(0.3, score)) * 100) / 100;
}
import {
  MAX_LLM_INPUT_CHARS,
  INGEST_MAX_OUTPUT_TOKENS,
  INGEST_MAP_MAX_OUTPUT_TOKENS,
  INGEST_MAP_CONCURRENCY,
  MAX_CONTENT_LENGTH,
  MAX_PDF_SIZE,
  MAX_AUTO_TAGS,
  TAG_VOCAB_LIMIT,
} from "./constants";
import { ClientInputError } from "./errors";
import { slugify, SLUG_SEPARATOR_RE } from "./slugify";
import { loadPageConventions } from "./schema";
import { resolveAlias } from "./alias-index";
import {
  resolveSourceUrl,
  resolveContentHash,
  updateSourceIndexForPage,
} from "./source-index";
import { contentHash, searchByVector, hasEmbeddingSupport } from "./embeddings";
import { getStorage } from "./storage";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Ingest ledger — append-only JSONL record of each ingest operation
// ---------------------------------------------------------------------------

/** A single entry in the ingest ledger (data/ingest-ledger.jsonl). */
export interface LedgerEntry {
  ingest_id: string;
  source_type: string;
  source_url: string;
  primary_slug: string;
  related_slugs: string[];
  started_at: string;
  finished_at: string;
  status: string;
  /** True when the ingest was a dedup attach (no new synthesis). */
  deduped?: boolean;
}

/** Relative path to the ingest ledger within the StorageProvider root. */
const LEDGER_REL_PATH = "data/ingest-ledger.jsonl";

/**
 * Returns the relative storage path to the ingest ledger JSONL file.
 * Exported for testing.
 */
export function getLedgerPath(): string {
  return LEDGER_REL_PATH;
}

/**
 * Read the ingest ledger, returning entries most-recent-first.
 *
 * Gracefully returns an empty array if the file doesn't exist.
 * Malformed JSONL lines are silently skipped.
 *
 * @param limit  Maximum number of entries to return (default: all)
 */
export async function readLedger(limit?: number): Promise<LedgerEntry[]> {
  let raw: string;
  try {
    raw = await getStorage().readFile(LEDGER_REL_PATH);
  } catch {
    // File doesn't exist or is unreadable — return empty
    return [];
  }

  const lines = raw.trim().split("\n").filter(Boolean);
  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // Skip malformed lines
    }
  }

  // Most recent first (ledger is append-only, so reverse)
  entries.reverse();

  if (limit !== undefined && limit > 0) {
    return entries.slice(0, limit);
  }
  return entries;
}

/**
 * Append a single ledger entry to data/ingest-ledger.jsonl.
 *
 * StorageProvider.appendFile creates parent directories as needed.
 * Errors are caught and logged so a ledger I/O failure never breaks
 * the ingest pipeline.
 */
export async function persistToLedger(entry: LedgerEntry): Promise<void> {
  try {
    await getStorage().appendFile(LEDGER_REL_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    logger.error("ingest", "Failed to write ledger entry:", err);
  }
}

/**
 * Ingest a URL into the wiki.
 *
 * 1. Fetch and extract the page content
 * 2. Delegate to the standard `ingest()` pipeline
 */
export async function ingestUrl(
  url: string,
  options?: IngestOptions,
): Promise<IngestResult> {
  // Dedup: if this URL is already a canonical page, attach the triggerer and
  // skip the fetch + LLM + embedding entirely.
  {
    const dupSlug = await resolveSourceUrl(url);
    if (dupSlug) {
      // Exception: an X Article that previously landed as a truncated TEASER
      // (no X_BEARER_TOKEN at first ingest, or briefly out of the ~7-day window)
      // must NOT be frozen by dedup. Re-fetch — cheap: syndication + at most one
      // API call, no LLM yet — and ONLY if the full body is now available do we
      // re-synthesize it in place (pinSlug). A still-teaser result falls through
      // to a plain attach, so a perma-teaser (genuinely old article) spends no
      // extra LLM tokens. Net: a re-save self-heals a teaser the moment the token
      // / window allow the full body, with no manual reingest.
      if (isXPostUrl(url)) {
        const existing = await readWikiPageWithFrontmatter(dupSlug);
        if (existing && isXArticleTeaser(existing.body)) {
          const fresh = await fetchXPostContent(url);
          if (!isXArticleTeaser(fresh.content)) {
            return ingest(fresh.title, fresh.content, {
              ...options,
              sourceUrl: url,
              sourceType: options?.sourceType ?? "x-mention",
              pinSlug: dupSlug,
            });
          }
        }
      }
      const result = await attachIngestTrigger(dupSlug, {
        url,
        type: options?.sourceType ?? "url",
        triggeredBy: options?.triggeredBy,
        actorOwner: options?.owner ?? options?.author,
      });
      if (result) return result;
    }
  }

  if (isYouTubeUrl(url)) {
    return ingestYouTube(url, options);
  }

  // X.com serves a JS shell to plain fetches (the "Something went wrong" page),
  // so read the post via the syndication CDN instead. Default the provenance to
  // x-mention when the caller didn't already set one (e.g. a manual UI ingest).
  if (isXPostUrl(url)) {
    const { title, content } = await fetchXPostContent(url);
    return ingest(title, content, {
      ...options,
      sourceUrl: url,
      sourceType: options?.sourceType ?? "x-mention",
    });
  }

  const { title, content } = await fetchUrlContent(url);
  return ingest(title, content, { ...options, sourceUrl: url });
}

/**
 * Provisional title for a title-less pasted-text ingest: the first markdown H1,
 * else the first non-empty line (leading heading/list markers stripped), capped.
 * Returns `""` only when the content has no usable line. The synthesis CONCEPT
 * (or, for a prebuilt body, the body H1) overrides this for the final title.
 */
export function deriveTitleFromContent(content: string): string {
  const h1 = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (h1) return h1.slice(0, 120).trim();
  const firstLine = content
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\d.\s)]+/, "").trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  let t = firstLine;
  const end = t.search(/[.!?。！？]/);
  if (end >= 8 && end < 100) t = t.slice(0, end);
  return t.slice(0, 120).trim();
}

/** Derive a concise page title from the vision description's first meaningful
 *  line (e.g. a transcribed headline). Returns undefined if nothing usable. */
function deriveImageTitle(visionText?: string): string | undefined {
  if (!visionText) return undefined;
  const firstLine = visionText
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\d.\s)]+/, "").trim())
    .find((l) => l.length > 0);
  if (!firstLine) return undefined;
  let title = firstLine;
  const sentenceEnd = title.search(/[.!?。！？\n]/);
  if (sentenceEnd >= 8 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
  title = title.slice(0, 80).trim();
  return title || undefined;
}

/** Derive a human-ish title from a filename or URL (e.g. "diagram-2.png" →
 *  "diagram 2"). Falls back to "Image". */
function humanizeFilename(nameOrUrl: string): string {
  let base = nameOrUrl;
  try {
    base = new URL(nameOrUrl).pathname.split("/").pop() || nameOrUrl;
  } catch {
    // not a URL — use as-is
  }
  base = base.split("?")[0].split("#")[0].replace(/\.[a-z0-9]+$/i, "");
  return base.replace(/[-_]+/g, " ").trim() || "Image";
}

/**
 * Ingest a single image. Stores the image as an asset, runs a vision model to
 * extract a description (fail-soft), and writes a wiki page that embeds the
 * image followed by the description. The LLM re-distillation is skipped (the
 * body is already small and correct) but frontmatter/dedup/embedding all reuse
 * the normal {@link ingest} pipeline.
 *
 * Accepts either an `imageUrl` (fetched + SSRF-guarded) or raw `bytes` (upload).
 */
export async function ingestImage(
  input: { imageUrl?: string; bytes?: ArrayBuffer; filename?: string; contentType?: string },
  options?: IngestOptions & { title?: string },
): Promise<IngestResult> {
  const { imageUrl, bytes: uploadedBytes, filename: uploadName } = input;

  // Dedup by URL first — cheapest path (no fetch, no vision, no LLM).
  if (imageUrl) {
    const dupSlug = await resolveSourceUrl(imageUrl);
    if (dupSlug) {
      const result = await attachIngestTrigger(dupSlug, {
        url: imageUrl,
        type: "image",
        triggeredBy: options?.triggeredBy,
        actorOwner: options?.owner ?? options?.author,
      });
      if (result) return result;
    }
  }

  // 1. Obtain the bytes + metadata WITHOUT storing yet — we may title the page
  //    (and thus the slug) from the vision text, so the slug isn't known yet.
  let bytes: ArrayBuffer;
  let filename: string;
  let mediaType: string | undefined;
  if (imageUrl) {
    const fetched = await fetchImageBytes(imageUrl);
    bytes = fetched.bytes;
    filename = fetched.filename;
    mediaType = fetched.contentType;
  } else if (uploadedBytes) {
    bytes = uploadedBytes;
    filename = uploadName || "image";
    mediaType = input.contentType;
  } else {
    throw new Error("ingestImage requires either imageUrl or bytes");
  }

  // 2. Vision description — fail-soft (null → image-only page).
  const vision = await describeImage(bytes, { mediaType });

  // 3. Title: explicit → derived from the vision text → humanized filename.
  const title =
    options?.title?.trim() ||
    deriveImageTitle(vision?.text) ||
    humanizeFilename(filename || imageUrl || "image");
  const slug = slugify(title);

  // 4. Store the asset under the final slug.
  const { localPath } = await storeImageBytes(bytes, slug, filename);

  const body =
    `# ${title}\n\n![${title}](${localPath})` + (vision ? `\n\n${vision.text}` : "");

  // The image body (embed + vision text) is already final, so pass it as the
  // internal `prebuiltContent` to write it as-is (skip the wiki-editor LLM) while
  // still reusing frontmatter, dedup, embedding, cross-refs, and the ledger.
  return ingest(
    title,
    body,
    { ...options, sourceUrl: imageUrl ?? "upload", sourceType: "image" },
    { prebuiltContent: body },
  );
}

/**
 * Ingest a PDF — either from a URL or uploaded bytes.
 *
 * URL path: dedup check → fetchUrlContent (which handles application/pdf) → ingest().
 * Upload path: extract text via unpdf → ingest() with sourceType "pdf".
 */
export async function ingestPdf(
  input: { pdfUrl: string } | { bytes: ArrayBuffer; filename: string },
  options?: Omit<IngestOptions, "sourceType"> & { title?: string; tags?: string[] },
): Promise<IngestResult> {
  // URL path: delegate to ingestUrl which already handles PDF content-type
  if ("pdfUrl" in input) {
    const url = input.pdfUrl;
    // Dedup check
    {
      const dupSlug = await resolveSourceUrl(url);
      if (dupSlug) {
        const result = await attachIngestTrigger(dupSlug, {
          url,
          type: "pdf",
          triggeredBy: options?.triggeredBy,
          actorOwner: options?.owner ?? options?.author,
        });
        if (result) return result;
      }
    }
    // fetchUrlContent now handles application/pdf natively
    const { title, content } = await fetchUrlContent(url);
    return ingest(options?.title ?? title, content, {
      ...options,
      sourceUrl: url,
      sourceType: "pdf",
    });
  }

  // Upload path: extract text from bytes directly
  const { bytes, filename } = input;
  if (bytes.byteLength > MAX_PDF_SIZE) {
    throw new ClientInputError(
      `PDF too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum: ${MAX_PDF_SIZE / 1024 / 1024} MB.`,
    );
  }

  // Layout-aware extraction (preserves line/paragraph structure) — shared with
  // the URL PDF path so the raw stays readable and synthesis gets better input.
  const trimmed = (await pdfToText(bytes)).trim();
  if (!trimmed) {
    throw new ClientInputError(
      "PDF has no extractable text layer. Scanned/image-only PDFs are not supported yet.",
    );
  }
  const content =
    trimmed.length > MAX_CONTENT_LENGTH
      ? trimmed.slice(0, MAX_CONTENT_LENGTH)
      : trimmed;

  // Derive title from first line or filename.
  const firstLine =
    trimmed.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const derivedTitle =
    firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;
  const title =
    options?.title || derivedTitle || filename.replace(/\.pdf$/i, "") || "PDF Document";

  return ingest(title, content, {
    ...options,
    sourceType: "pdf",
  });
}

/**
 * Re-ingest a previously ingested wiki page by re-fetching its `source_url`.
 *
 * Reads the page's frontmatter to find the original URL, fetches fresh content,
 * and runs the standard ingest pipeline to update the page.
 *
 * @throws {Error} When the page doesn't exist or has no `source_url` in its frontmatter.
 */
export async function reingest(
  slug: string,
  opts?: {
    author?: string;
    owner?: string;
    triggeredBy?: string;
  },
): Promise<IngestResult> {
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) {
    throw new Error(`Cannot re-ingest: page "${slug}" not found`);
  }

  const sourceUrl = page.frontmatter.source_url;
  if (typeof sourceUrl !== "string" || sourceUrl.trim() === "") {
    throw new Error("Cannot re-ingest: no source URL recorded");
  }

  // Re-fetch via the SAME routing as ingestUrl (YouTube transcript, X
  // syndication, else plain fetch) — otherwise an X post re-fetches the JS
  // shell ("Something went wrong") and a tweet page rebuilds from the error
  // page. `pinSlug` keeps the result on this page instead of forking to a new
  // concept-derived slug.
  if (isYouTubeUrl(sourceUrl)) {
    const { title, content } = await fetchYouTubeContent(sourceUrl);
    return ingest(title, content, {
      sourceUrl,
      sourceType: "youtube",
      pinSlug: slug,
      ...opts,
    });
  }

  if (isXPostUrl(sourceUrl)) {
    const { title, content } = await fetchXPostContent(sourceUrl);
    return ingest(title, content, {
      sourceUrl,
      sourceType: "x-mention",
      pinSlug: slug,
      ...opts,
    });
  }

  const { title, content } = await fetchUrlContent(sourceUrl);
  return ingest(title, content, { sourceUrl, pinSlug: slug, ...opts });
}

/**
 * Ingest an X (Twitter) post into the wiki.
 *
 * Delegates to {@link ingestUrl}, which reads the post via the syndication CDN
 * (X serves a JS shell to plain fetches), tagged with `x-mention` provenance so
 * the source is correctly attributed.
 *
 * @param url         - Full URL to the X/Twitter post.
 * @param triggeredBy - Handle of the user or agent that triggered the ingest.
 */
export async function ingestXMention(
  url: string,
  triggeredBy: string,
  opts?: { author?: string; owner?: string; tags?: string[] },
): Promise<IngestResult> {
  return ingestUrl(url, {
    sourceType: "x-mention",
    triggeredBy,
    ...opts,
  });
}

/**
 * Ingest a YouTube video into the wiki.
 *
 * Fetches the video transcript and metadata via the youtube module,
 * then delegates to the standard ingest pipeline with `youtube` provenance.
 */
export async function ingestYouTube(
  url: string,
  options?: IngestOptions,
): Promise<IngestResult> {
  const { title, content } = await fetchYouTubeContent(url);
  return ingest(title, content, {
    ...options,
    sourceUrl: url,
    sourceType: "youtube",
  });
}

// ---------------------------------------------------------------------------
// Fallback stub (no API key)
// ---------------------------------------------------------------------------

function generateFallbackPage(title: string, content: string): string {
  const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
  return `# ${title}\n\n## Summary\n\n${preview}\n\n## Raw Content\n\n${content}`;
}

// ---------------------------------------------------------------------------
// Image handling
// ---------------------------------------------------------------------------

/** Strip all markdown image syntax so the synthesis LLM gets image-free text.
 *  Source images are DROPPED from ingested pages — no inline images, no
 *  `## Figures` gallery, and no re-hosting to R2 (clean prose for index/query,
 *  and less storage). Single-image ingests (`ingestImage`) are unaffected. */
export function stripImageMarkdown(content: string): string {
  return content.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

/**
 * Extract a short summary from content by finding the first sentence.
 *
 * Uses sentence-ending punctuation followed by whitespace (`[.!?]\s`) or
 * paragraph breaks (`\n\n`) as boundaries — avoids splitting on abbreviations
 * like "Dr." or "U.S." where the period is not followed by a space that starts
 * a new sentence (though it's a heuristic, not perfect).
 *
 * Returns at most `maxLen` characters.
 */
export function extractSummary(content: string, maxLen = 200): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  // Look for a sentence boundary: period/exclamation/question followed by a space
  const sentenceEnd = trimmed.search(/[.!?]\s/);
  // Look for a paragraph break
  const paraBreak = trimmed.indexOf("\n\n");

  // Pick the earliest valid boundary
  let cutoff = -1;
  if (sentenceEnd !== -1 && paraBreak !== -1) {
    cutoff = Math.min(sentenceEnd + 1, paraBreak); // +1 to include the punctuation
  } else if (sentenceEnd !== -1) {
    cutoff = sentenceEnd + 1;
  } else if (paraBreak !== -1) {
    cutoff = paraBreak;
  }

  let summary: string;
  if (cutoff !== -1 && cutoff <= maxLen) {
    summary = trimmed.slice(0, cutoff).trim();
  } else {
    // No sentence boundary found or it's too far — just truncate
    summary =
      trimmed.length > maxLen
        ? trimmed.slice(0, maxLen).trim() + "..."
        : trimmed.trim();
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Content chunking
// ---------------------------------------------------------------------------

/**
 * Split text into chunks of at most `maxChars` characters.
 *
 * Strategy:
 * 1. Split on paragraph boundaries (`\n\n`).
 * 2. Greedily combine paragraphs into chunks up to `maxChars`.
 * 3. If a single paragraph exceeds `maxChars`, split it on sentence
 *    boundaries (`. `, `! `, `? ` followed by whitespace or end-of-string).
 * 4. If a single sentence still exceeds `maxChars`, hard-split at `maxChars`.
 *
 * Returns an array of chunks, each ≤ `maxChars`.
 */
export function chunkText(text: string, maxChars: number = MAX_LLM_INPUT_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // If this single paragraph fits in the current chunk, append it
    if (current.length === 0 && para.length <= maxChars) {
      current = para;
      continue;
    }

    if (current.length > 0 && current.length + 2 + para.length <= maxChars) {
      current += "\n\n" + para;
      continue;
    }

    // Flush current chunk if non-empty
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }

    // If the paragraph itself fits in a chunk, start a new chunk with it
    if (para.length <= maxChars) {
      current = para;
      continue;
    }

    // Oversized paragraph — split on sentence boundaries
    const sentences = splitSentences(para);
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        // Hard-split an oversized sentence
        for (let i = 0; i < sentence.length; i += maxChars) {
          const piece = sentence.slice(i, i + maxChars);
          if (current.length === 0) {
            chunks.push(piece);
          } else if (current.length + 1 + piece.length <= maxChars) {
            current += " " + piece;
          } else {
            chunks.push(current);
            chunks.push(piece);
            current = "";
          }
        }
        continue;
      }

      if (current.length === 0) {
        current = sentence;
      } else if (current.length + 1 + sentence.length <= maxChars) {
        current += " " + sentence;
      } else {
        chunks.push(current);
        current = sentence;
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Split a paragraph into sentences. Uses sentence-ending punctuation
 * followed by whitespace as the delimiter. Keeps the punctuation attached
 * to the sentence.
 */
function splitSentences(text: string): string[] {
  // Temporarily replace markdown image/link references so their internal
  // dots (e.g. "image.jpg") don't trigger sentence-boundary splits.
  const placeholders: string[] = [];
  const shielded = text.replace(/!?\[[^\]]*\]\([^)]*\)/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00MDREF${idx}\x00`;
  });

  // Split after sentence-ending punctuation followed by whitespace
  const parts = shielded.split(/(?<=[.!?])\s+/);

  // Restore placeholders
  return parts
    .map((s) =>
      s.replace(/\x00MDREF(\d+)\x00/g, (_, idx) => placeholders[Number(idx)]),
    )
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Ingest pipeline
// ---------------------------------------------------------------------------

// Conventions are documented in SCHEMA.md at the repo root.
const INGEST_SYSTEM_PROMPT_BASE = `You are a wiki editor. Given a source document, generate a wiki article in markdown format.

Begin your output with these three header lines in EXACTLY this form:
CONCEPT: <canonical concept name>
ALIASES: <comma-separated alternative names / synonyms for the concept, or "none">
TAGS: <3-6 lowercase, hyphenated topic tags, comma-separated>
CONCEPT names the one CANONICAL CONCEPT the document is about — the established term other writers on the same topic would also use (a concept, NOT the article's headline). Pick a granularity that is one coherent topic: general enough that other articles on the same subject would share it, specific enough not to lump distinct topics together.
ALIASES lists other names the SAME concept is known by (acronyms, expansions, common synonyms) so future sources under those names converge here — not narrower sub-topics or related concepts. Use "none" if there are no real synonyms.
TAGS are 3-6 broad topical labels for browsing/filtering (e.g. \`machine-learning\`, \`distributed-systems\`) — lowercase, hyphenated, no \`#\`. Tags are coarser than the CONCEPT: they group MANY pages, so reuse shared themes rather than coining a unique tag per page.

Then, on the following lines, the wiki article. Include:
- A title as a level-1 heading (# Title) — use the SAME canonical concept
- A brief summary section (## Summary)
- Key points or takeaways (## Key Points)
- Notable entities, concepts, or terms worth remembering (## Concepts)
- A detailed section (## Details) that DISTILLS the source's essential substance
  — the key explanations, definitions, mechanisms, steps, and notable specifics
  a reader needs to understand the concept — as readable prose and lists. Be
  concise: omit boilerplate, marketing, repetition, and tangents; summarize
  rather than transcribe. The full raw source is preserved separately and one
  click away ("View raw"), so do NOT try to reproduce it. Invent nothing not
  supported by the source.

Diagrams: when the concept has a clear STRUCTURE (a flow, pipeline, architecture, hierarchy, sequence, or relationship), you MAY include ONE concise Mermaid diagram in a fenced \`\`\`mermaid code block (e.g. flowchart LR, graph TD, sequenceDiagram); it renders as a diagram. Use it only where it genuinely clarifies, base it strictly on the source, and keep node labels short. Most pages need none.

Write a focused, distilled page, not a transcript of the source. Output the CONCEPT, ALIASES, and TAGS lines, then pure markdown, and nothing else. Do not wrap in code fences.`;

/**
 * MAP step of the long-source synthesis. Each chunk is distilled DIRECTLY from
 * the source (not from a running summary), so coverage stays faithful and
 * specifics don't drift — the accuracy property the old append path had. The
 * partials carry no CONCEPT marker and no fixed section scaffold; the reduce
 * step imposes the final structure. Bullets are reined in here so the merged
 * page reads as prose, not a wall of fragments.
 */
const MAP_SYSTEM_PROMPT = `You are a wiki editor distilling ONE part of a long source document into faithful notes that will later be merged with the other parts.

From THIS part of the source, capture the substantive material a reader needs: the explanations, definitions, mechanisms, claims, examples, names, and numbers actually present. Be FAITHFUL — preserve concrete specifics exactly; do not generalize them away, and invent nothing not in this part.

Write mostly in concise prose. Use a bullet only for genuinely list-like material — do not turn every sentence into a bullet. Omit boilerplate, marketing, repetition, and tangents. Do NOT add a title, a "Summary", or section headings — output only the distilled notes for this part.

Output pure markdown and nothing else. Do not wrap in code fences.`;

/**
 * REDUCE step: merge the per-chunk notes into ONE coherent article with the
 * standard structure. This is a MERGE/REORGANISE, not a re-summary — it must
 * keep the concrete substance the map step preserved (so a long source stays as
 * accurate as the old append path) while collapsing the parts into a single set
 * of sections (fixing the "(additional)" pileup the refine approach replaced).
 */
const REDUCE_SYSTEM_PROMPT = `You are a wiki editor. You are given faithful NOTES distilled from consecutive parts of ONE source document (delimited as "Part 1", "Part 2", ...). Combine them into a single coherent wiki article.

This is a MERGE, not a new summary: keep the concrete substance from the notes — specifics, names, numbers, claims, examples — and drop only true duplication. Do not compress the material down to generic bullet points or lose detail that the notes preserved.

Begin your output with these three header lines in EXACTLY this form:
CONCEPT: <canonical concept name>
ALIASES: <comma-separated alternative names / synonyms for the concept, or "none">
TAGS: <3-6 lowercase, hyphenated topic tags, comma-separated>

Then the article: one \`# Title\` (the canonical concept), then EXACTLY ONE of each \`## Summary\`, \`## Key Points\`, \`## Concepts\`, \`## Details\`. Reorganise the merged notes into these sections — never emit a section twice or an "(additional)" variant. Prefer readable prose; use bullets only where the material is genuinely list-like. The \`## Details\` section should carry the substance in prose and lists, not a flat dump of every bullet.

Diagrams: when the concept has a clear STRUCTURE (a flow, pipeline, architecture, hierarchy, sequence, or relationship), you MAY include ONE concise Mermaid diagram in a fenced \`\`\`mermaid code block (e.g. flowchart LR, graph TD, sequenceDiagram). Use it only where it genuinely clarifies, base it strictly on the notes, and keep node labels short. Most pages need none.

Output the CONCEPT, ALIASES, and TAGS lines, then pure markdown, and nothing else. Do not wrap in code fences.`;

/**
 * System prompt for reconciling an existing page with a newly ingested source
 * on the SAME concept (the accumulate-and-reconcile step). The LLM merges both
 * into one canonical article rather than the new ingest overwriting the page,
 * and surfaces contradictions instead of silently picking a side.
 */
const RECONCILE_SYSTEM_PROMPT = `You are a wiki editor maintaining a single canonical page about one concept. You are given the page's CURRENT content and a NEWLY INGESTED article about the same concept. Merge them into one cohesive, up-to-date wiki article.

Rules:
- Preserve all substantive information from BOTH versions; integrate the new material rather than discarding what's already on the page.
- Remove redundancy; keep the existing section structure (## Summary, ## Key Points, ## Concepts, ## Details) and any image markdown or Mermaid (\`\`\`mermaid) diagram blocks, without duplicating images or diagrams.
- Do NOT invent anything not supported by either source.
- If the new article CONTRADICTS the current page on any material fact, do not silently pick one side: keep both positions (attributing each) and begin your ENTIRE output with a single line, exactly:
DISPUTED: yes
  Otherwise do not emit a DISPUTED line.

Output the optional DISPUTED line, then pure markdown, and nothing else. Do not wrap in code fences.`;

/**
 * The ingest synthesis prompt asks the LLM to begin its output with two header
 * lines naming the canonical concept and its synonyms:
 *
 *     CONCEPT: <canonical concept name>
 *     ALIASES: <comma/semicolon-separated synonyms, or "none">
 *
 * Parse those out and return the concept, the alias list, and the body with
 * both header lines removed.
 *
 * Two articles about the same concept under different headlines (e.g. "Intro
 * to Transformers" and "The Transformer Architecture Explained") both emit
 * `CONCEPT: Transformer`, so they converge onto one content-derived slug
 * instead of forking by title. The aliases widen the exact-match net (acronyms,
 * expansions) so future sources under those names also converge.
 *
 * Returns `concept: ""` (and no aliases) when the marker is absent — the
 * deterministic fallback page, a prebuilt image body (no marker), older pages,
 * or test mocks — so callers keep the title-derived slug unchanged.
 * The `ALIASES` line is optional even when `CONCEPT` is present.
 */
export function parseConceptMarker(raw: string): {
  concept: string;
  aliases: string[];
  tags: string[];
  body: string;
} {
  const conceptM = raw.match(/^\uFEFF?\s*CONCEPT:[ \t]*(.+?)[ \t]*(?:\r?\n|$)/i);
  if (!conceptM) return { concept: "", aliases: [], tags: [], body: raw };

  let rest = raw.slice(conceptM[0].length);
  let aliases: string[] = [];
  let tags: string[] = [];
  const splitList = (s: string) =>
    s
      .split(/[;,]/)
      .map((x) => x.trim())
      .filter((x) => x !== "" && x.toLowerCase() !== "none");

  // Consume the optional ALIASES / TAGS header lines in either order.
  for (let i = 0; i < 2; i++) {
    const aliasM = rest.match(/^\s*ALIASES:[ \t]*(.*?)[ \t]*(?:\r?\n|$)/i);
    if (aliasM && aliases.length === 0) {
      rest = rest.slice(aliasM[0].length);
      aliases = splitList(aliasM[1]);
      continue;
    }
    const tagM = rest.match(/^\s*TAGS:[ \t]*(.*?)[ \t]*(?:\r?\n|$)/i);
    if (tagM && tags.length === 0) {
      rest = rest.slice(tagM[0].length);
      tags = normalizeTags(splitList(tagM[1]));
      continue;
    }
    break;
  }

  return {
    concept: conceptM[1].trim(),
    aliases,
    tags,
    body: rest.replace(/^\s+/, ""),
  };
}

/**
 * Normalize free-text tags to the wiki's canonical form: lowercase,
 * hyphen-separated, no leading `#`, deduped, capped at {@link MAX_AUTO_TAGS}.
 * Keeps tags consistent regardless of how the LLM (or a caller) cased/spaced them.
 *
 * Uses the SAME separator class as {@link slugify} (`SLUG_SEPARATOR_RE`), so a
 * slugified concept survives normalization unchanged and CJK tags are PRESERVED
 * (not stripped) — Chinese/Japanese/Korean pages get a real concept tag, the way
 * their slugs already keep CJK. For ASCII input this is identical to the old
 * `[^a-z0-9]+` strip. (The leading-`#` strip is kept for the `#tag` convention.)
 */
export function normalizeTags(raw: string[], max: number = MAX_AUTO_TAGS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const tag = t
      .toLowerCase()
      .trim()
      .replace(/^#+/, "")
      .replace(SLUG_SEPARATOR_RE, "-")
      .replace(/^-+|-+$/g, "");
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** Recall floor for RETRIEVING merge candidates by embedding similarity — low on
 *  purpose. It only gates which existing pages the LLM gets to judge; the LLM is
 *  the accept arbiter. (Replaces the old conservative cosine-only 0.86 accept
 *  gate, which forked whenever two sources worded the same concept apart.) */
export const CONCEPT_ADJUDICATE_FLOOR = 0.6;

/** Most existing pages shown to the merge adjudicator per ingest (prompt/cost guard). */
const MAX_MERGE_CANDIDATES = 5;

const MERGE_ADJUDICATION_SYSTEM_PROMPT = `You decide whether a newly written wiki page describes the SAME underlying concept as one of a few existing pages — so they are merged into ONE page instead of creating a duplicate.

Merge ONLY when the new page and an existing page are about the SAME concept / topic / entity (the same thing — possibly worded differently or drawn from a different source). Do NOT merge pages that are merely related, adjacent, complementary, or in the same broad domain.

Reply with ONLY the slug of the matching existing page, copied exactly from the list — or the single word "none" if no existing page is the same concept. When unsure, answer "none".`;

/**
 * Find existing pages that might be the SAME concept as a freshly-synthesized
 * one, for {@link adjudicateMerge}. Uses embedding similarity when available (a
 * wide recall net at {@link CONCEPT_ADJUDICATE_FLOOR}); otherwise a title+summary
 * BM25 pass over the index (`fullBody:false` → no disk reads, no LLM) so merge
 * still works before the vector store is backfilled. Returns candidate slugs,
 * best-first.
 */
async function findMergeCandidates(
  concept: string,
  embedBody: string,
): Promise<string[]> {
  const query = `${concept}\n\n${embedBody}`;
  if (hasEmbeddingSupport()) {
    const hits = await searchByVector(query, MAX_MERGE_CANDIDATES + 3);
    return hits
      .filter((h) => h.score >= CONCEPT_ADJUDICATE_FLOOR)
      .map((h) => h.slug);
  }
  const entries = await listWikiPages();
  if (entries.length === 0) return [];
  const stats = await buildCorpusStats(entries, { fullBody: false });
  const qTokens = tokenize(query);
  return entries
    .map((e) => ({ slug: e.slug, score: bm25Score(e, qTokens, stats) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MERGE_CANDIDATES + 3)
    .map((s) => s.slug);
}

/**
 * Ask the LLM which (if any) candidate page is the SAME concept as the new page.
 * Returns the chosen slug — validated to be one we actually offered (a
 * hallucination guard), matched as a whole TOKEN, never a loose substring, so
 * the "none" sentinel or a short slug inside a word can't trigger a merge; if
 * the answer names several candidates, the longest wins. Returns `null` (→ fork)
 * on no LLM key, an empty / "none" / unrecognized answer, or an LLM error.
 */
async function adjudicateMerge(
  concept: string,
  embedBody: string,
  candidates: { slug: string; title: string; snippet: string }[],
): Promise<string | null> {
  if (!hasLLMKey()) return null;
  const list = candidates
    .map((c) => `- slug: ${c.slug}\n  title: ${c.title}\n  snippet: ${c.snippet}`)
    .join("\n");
  const user = `NEW page concept: "${concept}"\n\nNEW page (excerpt):\n${embedBody.slice(
    0,
    800,
  )}\n\nEXISTING pages that might be the same concept:\n${list}\n\nWhich existing page is the SAME concept as the NEW page? Reply with its slug, or "none".`;
  let out: string;
  try {
    out = await callLLM(MERGE_ADJUDICATION_SYSTEM_PROMPT, user, {
      maxOutputTokens: 24,
    });
  } catch (err) {
    logger.warn("ingest", "merge adjudication failed; forking to a new page", err);
    return null;
  }
  // Match whole tokens (slugs keep hyphens, so "transformer" and
  // "transformer-architecture" are distinct tokens) — never a loose substring,
  // which could match the "none" sentinel or a short slug inside a word.
  const answerTokens = new Set(
    out.trim().toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean),
  );
  const matches = candidates
    .filter((c) => answerTokens.has(c.slug.toLowerCase()))
    .sort((a, b) => b.slug.length - a.slug.length);
  return matches[0]?.slug ?? null;
}

/**
 * Resolve the slug an ingest should land on, given a content-derived concept.
 * Convergence ladder — each step only redirects to an EXISTING page; otherwise
 * the candidate concept slug is used and a new page is forked:
 *
 *   1. Exact — the candidate concept slug is already a page.
 *   2. Alias — the concept or one of its synonyms resolves (via the alias
 *      index) to an existing page.
 *   3. Adjudicated merge — retrieve nearby existing pages (embedding similarity,
 *      or a title+summary BM25 fallback) and let the LLM decide which, if any,
 *      is the SAME concept. Scoped to the SAME owner + scope, never an artifact /
 *      agent-scoped (`agent-*`) page, so a fuzzy match can't cross silos or
 *      corrupt an artifact's markup.
 *
 * `embedBody` is the synthesized page body used for retrieval + adjudication.
 * Returns the candidate concept slug unchanged when no confident match is found
 * (and whenever there's no LLM key — adjudication is conservative by default).
 */
async function resolveConceptSlug(
  candidateSlug: string,
  concept: string,
  aliases: string[],
  embedBody: string,
  owner: string,
  pageType: string | undefined,
): Promise<string> {
  // 1. Exact concept-slug hit.
  if (await readWikiPageWithFrontmatter(candidateSlug)) return candidateSlug;

  // 2. Alias / slug index over the concept and its synonyms.
  for (const term of [concept, ...aliases]) {
    const hit = await resolveAlias(term);
    if (
      hit &&
      hit !== candidateSlug &&
      (await readWikiPageWithFrontmatter(hit))
    ) {
      return hit;
    }
  }

  // 3. Adjudicated merge (the robust catch for LLM concept-wording drift across
  //    sources). Retrieve nearby existing pages, keep only same-owner/same-scope
  //    non-artifact candidates, then let the LLM decide which — if any — is the
  //    same concept. Wrapped fail-soft: dedup is advisory, so ANY retrieval /
  //    read / adjudication error forks a new page rather than breaking the ingest
  //    (this path now runs on every ingest, incl. the embeddings-off BM25 case).
  try {
    const candidates: { slug: string; title: string; snippet: string }[] = [];
    for (const hitSlug of await findMergeCandidates(concept, embedBody)) {
      if (candidates.length >= MAX_MERGE_CANDIDATES) break;
      if (hitSlug === candidateSlug) continue;
      const page = await readWikiPageWithFrontmatter(hitSlug);
      if (!page) continue;
      const hitType =
        typeof page.frontmatter.type === "string" ? page.frontmatter.type : "";
      // Never fold into an artifact (slides/html) or an agent-scoped (`agent-*`)
      // page; only within the same owner's silo + same scope. Err toward fork.
      if (isArtifactType(hitType) || isAgentScopedType(hitType)) continue;
      if ((page.frontmatter.owner ?? "system") !== owner) continue;
      if (hitType !== (pageType ?? "")) continue;
      candidates.push({
        slug: hitSlug,
        title: page.title,
        snippet: page.body.replace(/\s+/g, " ").trim().slice(0, 240),
      });
    }
    if (candidates.length > 0) {
      const chosen = await adjudicateMerge(concept, embedBody, candidates);
      // Re-read post-adjudication (defensive: fork if it vanished concurrently).
      if (chosen && (await readWikiPageWithFrontmatter(chosen))) return chosen;
    }
  } catch (err) {
    logger.warn(
      "ingest",
      "concept-merge resolution failed; forking to a new page",
      err,
    );
  }

  // 4. No confident match — fork onto the candidate concept slug.
  return candidateSlug;
}

/**
 * Parse a leading `DISPUTED: yes` line the reconcile prompt emits when the new
 * source contradicts the existing page. Returns whether the page is disputed
 * plus the body with the marker line stripped. Absent / "no" → not disputed.
 */
export function parseDisputedMarker(raw: string): {
  disputed: boolean;
  body: string;
} {
  const m = raw.match(/^﻿?\s*DISPUTED:[ \t]*(yes|true)[ \t]*(?:\r?\n|$)/i);
  if (!m) return { disputed: false, body: raw };
  return { disputed: true, body: raw.slice(m[0].length).replace(/^\s+/, "") };
}

/**
 * Reconcile an existing page body with a newly ingested article on the same
 * concept via a single LLM call (the accumulate-and-reconcile step). Returns
 * the merged body and whether the new source contradicts the existing page
 * (→ `disputed`).
 *
 * Defensive about the model's output: strips a `DISPUTED:` marker, then any
 * echoed `CONCEPT:`/`ALIASES:` synthesis headers. Falls back to the new body on
 * an empty/failed response so a reconcile hiccup never blanks the page.
 */
export async function reconcilePage(
  existingBody: string,
  newBody: string,
): Promise<{ body: string; disputed: boolean }> {
  const user = `# Current page\n\n${existingBody}\n\n# Newly ingested article (same concept)\n\n${newBody}`;
  const out = await callLLM(RECONCILE_SYSTEM_PROMPT, user, {
    maxOutputTokens: INGEST_MAX_OUTPUT_TOKENS,
  });
  if (!out || out.trim() === "") {
    return { body: newBody, disputed: false };
  }
  const { disputed, body: afterDisputed } = parseDisputedMarker(out);
  // Guard against the model echoing the synthesis headers into the merged body.
  const { body } = parseConceptMarker(afterDisputed);
  return { body, disputed };
}

/**
 * Build the ingest system prompt by composing the base prompt with the
 * "Page conventions" slice of SCHEMA.md loaded at runtime. Read on every
 * call (no caching) so live edits to SCHEMA.md take effect immediately —
 * the whole point is to keep prompt and schema co-evolving.
 */
/**
 * The wiki's existing tag vocabulary (most-used first), so the synthesis LLM can
 * PREFER reusing established tags over coining near-duplicates ("llm" vs "llms").
 * Capped at {@link TAG_VOCAB_LIMIT} to bound prompt size. Best-effort: returns
 * `[]` if the index can't be read.
 */
export async function collectTagVocabulary(
  limit: number = TAG_VOCAB_LIMIT,
): Promise<string[]> {
  try {
    const counts = new Map<string, number>();
    for (const entry of await listWikiPages()) {
      for (const t of entry.tags ?? []) {
        if (typeof t === "string" && t.trim() !== "") {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([tag]) => tag);
  } catch {
    return [];
  }
}

export async function buildIngestSystemPrompt(): Promise<string> {
  const conventions = await loadPageConventions();
  const vocab = await collectTagVocabulary();

  let prompt = INGEST_SYSTEM_PROMPT_BASE;
  if (conventions !== "") {
    prompt += `

The wiki you are editing follows these conventions (from SCHEMA.md):

${conventions}

Follow these conventions when generating the page.`;
  }
  if (vocab.length > 0) {
    prompt += `

Tags already used across this wiki (PREFER reusing an existing tag when it fits; only coin a new one when none apply):
${vocab.join(", ")}`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Ingest options
// ---------------------------------------------------------------------------

/** Options for the ingest pipeline. */
export interface IngestOptions {
  /**
   * Original source URL. Set automatically by `ingestUrl()` so the URL is
   * persisted in the wiki page's frontmatter as `source_url`.
   */
  sourceUrl?: string;
  /**
   * Provenance type override. When set, this type is used instead of the
   * default `"url"` / `"text"` heuristic when building the `sources[]` entry.
   * Used by `ingestXMention()` to set `"x-mention"` provenance.
   */
  sourceType?: "url" | "text" | "x-mention" | "image" | "pdf" | "youtube";
  /**
   * Who triggered the ingest (user handle or agent ID). Defaults to `"system"`.
   * Passed through to the `triggered_by` field on the `SourceEntry`.
   */
  triggeredBy?: string;
  /**
   * Tags to apply to the created/updated page. Merged with any existing tags
   * when re-ingesting an existing page.
   */
  tags?: string[];
  /**
   * The acting identity that performed this ingest (a user handle, or `yoyo`
   * when mediated). Becomes `authors` on a new page and is appended to
   * `contributors` on re-ingest. Set from the authenticated session by the
   * route — never from client input. Falls back to `"system"`.
   */
  author?: string;
  /**
   * The principal who owns the resulting page (accountable party). For manual
   * ingests this equals `author`; for mediated ingests it's the triggering
   * user. Defaults to `author`.
   */
  owner?: string;
  /**
   * Optional page `type` frontmatter. When set on a NEW page, marks it as
   * agent-scoped so it is excluded from the public browse feed and general
   * search, surfacing only via an `agent:` scope. A union (not open string) so
   * a typo can't silently produce an unscoped page. Ignored on re-ingest of an
   * existing page (its scope is preserved — see below).
   */
  pageType?: "agent-knowledge" | "agent-identity";
  /**
   * Pin the result to this exact slug, bypassing concept/alias slug derivation.
   * Used by `reingest()` so re-synthesizing a page updates it IN PLACE rather
   * than forking to a new concept-derived slug (e.g. `agentic-system` →
   * `agentic-systems`). Only honored on the direct synthesis path.
   */
  pinSlug?: string;
}

/**
 * Attach a new ingest trigger to an existing canonical page **without
 * re-synthesizing** — the token-saving dedup path. Used when a source (same URL
 * or identical content) was already ingested: append a provenance entry + the
 * triggerer, bump `updated`, increment `source_count`, but skip the LLM and (the
 * body is unchanged) any new embedding. Returns `null` if the page is missing
 * (stale index) so the caller can fall through to a normal ingest.
 */
/**
 * Reduce a handle to its human identity: an agent id `<user>--<name>` collapses
 * to `<user>` (slugified), a plain handle slugifies as-is. Mirrors the
 * owner-equivalence `canReadPage`/`canWritePage` use, at the handle level.
 */
function humanOf(handle: string): string {
  const i = handle.indexOf("--");
  return slugify(i >= 0 ? handle.slice(0, i) : handle);
}

/**
 * True iff ingest actor `actorOwner` belongs to the same human-owner class as a
 * page owned by `pageOwner` — i.e. the actor (or their agent) owns it. Used to
 * decide whether an ingest may converge onto a PRIVATE page: private content is
 * owner-only, so a non-owner must never dedup/merge into it.
 */
export function sameHumanOwner(actorOwner: string | undefined, pageOwner: unknown): boolean {
  if (typeof pageOwner !== "string" || pageOwner.trim() === "") return false;
  if (!actorOwner || actorOwner.trim() === "") return false;
  return humanOf(actorOwner) === humanOf(pageOwner);
}

/** Find a slug not taken by any existing page (`base`, `base-2`, `base-3`, …). */
async function findFreeSlug(base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await readWikiPageWithFrontmatter(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

async function attachIngestTrigger(
  slug: string,
  source: {
    url: string;
    type: SourceEntry["type"];
    triggeredBy?: string;
    /** The ingest's acting owner — used to gate dedup into a PRIVATE page. */
    actorOwner?: string;
  },
): Promise<IngestResult | null> {
  const existing = await readWikiPageWithFrontmatter(slug);
  if (!existing) return null; // index drifted — let the caller ingest normally

  // Realm-aware dedup: private content is owner-only, so a caller who isn't the
  // owner (or their agent) must NOT dedup into a private page — no write, no
  // slug leak. Return null so the caller falls through to a normal ingest that
  // creates the actor's OWN page.
  if (
    existing.frontmatter.visibility === "private" &&
    !sameHumanOwner(source.actorOwner, existing.frontmatter.owner)
  ) {
    return null;
  }

  const frontmatter: Frontmatter = { ...existing.frontmatter };
  frontmatter.updated = new Date().toISOString().slice(0, 10);

  // Merge the new provenance entry into sources[] (update fetched/triggered_by
  // if the same source already has an entry, else append).
  const entry = buildSourceEntry(source.url, source.type, source.triggeredBy);
  const existingSourcesRaw = existing.frontmatter.sources;
  const sources = parseSources(
    typeof existingSourcesRaw === "string"
      ? existingSourcesRaw
      : Array.isArray(existingSourcesRaw)
        ? existingSourcesRaw
        : undefined,
  );
  const merged = mergeSourceEntry(sources, entry);
  frontmatter.sources = serializeSources(merged);
  frontmatter.source_count = String(merged.length);

  // Record the triggerer as a contributor (deduped) — drives the "Mine" lens.
  const triggeredBy = source.triggeredBy?.trim();
  if (triggeredBy) {
    const contribs = Array.isArray(existing.frontmatter.contributors)
      ? (existing.frontmatter.contributors as string[])
      : [];
    if (!contribs.includes(triggeredBy)) {
      frontmatter.contributors = [...contribs, triggeredBy];
    }
  }

  const mergedContent = serializeFrontmatter(frontmatter, existing.body);
  await writeWikiPageWithSideEffects({
    slug,
    title: existing.title,
    content: mergedContent,
    summary: extractSummary(existing.body.replace(/^#\s+.+$/m, "").trim()),
    logOp: "ingest",
    crossRefSource: null, // skip the cross-ref LLM — pure dedup attach
    author: triggeredBy,
    logDetails: () => `dedup: attached trigger to existing page "${slug}"`,
  });

  const url =
    typeof frontmatter.source_url === "string" ? frontmatter.source_url : undefined;
  const hash =
    typeof frontmatter.content_hash === "string"
      ? frontmatter.content_hash
      : undefined;
  updateSourceIndexForPage(slug, url, hash);

  // Record a ledger entry so dedup'd ingests appear in /api/ingest/history.
  const now = new Date().toISOString();
  await persistToLedger({
    ingest_id: `${now}/${slug}`,
    source_type: source.type,
    source_url: source.url,
    primary_slug: slug,
    related_slugs: [],
    started_at: now,
    finished_at: now,
    status: "completed",
    deduped: true,
  });

  return {
    rawPath: "",
    primarySlug: slug,
    relatedUpdated: [],
    wikiPages: [slug],
    indexUpdated: true,
    deduped: true,
    ...(url ? { sourceUrl: url } : {}),
  };
}

/**
 * Synthesize the wiki body from IMAGE-FREE source text: a single LLM call for
 * short content, MAP/REDUCE for long content (parallel map in bounded-concurrency
 * batches → merge), or a deterministic fallback page when there's no LLM key.
 * Returns the raw synthesized body (still carrying the leading CONCEPT marker on
 * the LLM path); the caller strips that marker.
 *
 * When MAP/REDUCE is used, also returns `chunksFailed`/`chunksTotal` so the
 * caller can surface partial coverage loss in the result and frontmatter.
 */
interface SynthesisResult {
  body: string;
  chunksFailed: number;
  chunksTotal: number;
}
async function synthesizeBody(title: string, content: string): Promise<SynthesisResult> {
  if (!hasLLMKey()) {
    // Derived title so a title-less paste doesn't emit an empty `# ` H1.
    return { body: await generateFallbackPage(title, content), chunksFailed: 0, chunksTotal: 0 };
  }
  const systemPrompt = await buildIngestSystemPrompt();
  const chunks = chunkText(content, MAX_LLM_INPUT_CHARS);
  // Larger output budget so the ## Details section can preserve substantive
  // source content instead of being truncated.
  const llmOptions = { maxOutputTokens: INGEST_MAX_OUTPUT_TOKENS };

  if (chunks.length === 1) {
    return { body: await callLLM(systemPrompt, chunks[0], llmOptions), chunksFailed: 0, chunksTotal: 1 };
  }

  // Long content — MAP/REDUCE. Distil each chunk straight from the SOURCE (in
  // bounded-concurrency batches), then merge the partials into one article.
  // Mapping from source keeps coverage faithful and stops cross-chunk drift;
  // the parallel map keeps a long transcript well under the request budget.
  const mapOptions = { maxOutputTokens: INGEST_MAP_MAX_OUTPUT_TOKENS };
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i += INGEST_MAP_CONCURRENCY) {
    const batch = chunks.slice(i, i + INGEST_MAP_CONCURRENCY);
    const mapped = await Promise.all(
      batch.map(async (chunk, j) => {
        const chunkIndex = i + j + 1;
        try {
          return await callLLM(
            MAP_SYSTEM_PROMPT,
            `Part ${chunkIndex} of ${chunks.length} of the source:\n\n${chunk}`,
            mapOptions,
          );
        } catch (err) {
          logger.warn(
            "ingest",
            `map chunk ${chunkIndex}/${chunks.length} failed, skipping:`,
            err,
          );
          return "";
        }
      }),
    );
    partials.push(...mapped);
  }

  const notes = partials
    .map((p, i) => ({ part: i + 1, text: p.trim() }))
    .filter((p) => p.text)
    .map((p) => `# Part ${p.part}\n\n${p.text}`)
    .join("\n\n");
  if (!notes) {
    // Every map call came back blank — surface a real failure rather than
    // reducing nothing into a hallucinated page.
    throw new Error("synthesis produced no content from the source");
  }
  const failed = partials.filter((p) => !p.trim()).length;
  const body = await callLLM(REDUCE_SYSTEM_PROMPT, notes, llmOptions);
  return { body, chunksFailed: failed, chunksTotal: chunks.length };
}

/**
 * Ingest a source document into the wiki: synthesize the page (LLM) and write it
 * directly. There is no preview/commit two-step — every ingest runs synthesis
 * and writes.
 *
 * `internal.prebuiltContent` skips the LLM and writes the supplied body as-is.
 * It's a 4th INTERNAL parameter (not part of the public `IngestOptions`, which
 * routes import) precisely so an API/UI caller can never set a "write this body
 * verbatim" payload. The sole caller is `ingestImage()` — the image body (embed
 * + vision text) is already final, so re-synthesizing it would be wasteful.
 */
export async function ingest(
  title: string,
  content: string,
  options?: IngestOptions,
  internal?: { prebuiltContent?: string },
): Promise<IngestResult> {
  const startedAt = new Date().toISOString();
  // Title is optional for pasted text — derive a provisional one from the
  // content (the synthesis CONCEPT/H1 still drives the final slug + title below).
  const effectiveTitle = title.trim() || deriveTitleFromContent(content);
  const rawSlug = slugify(effectiveTitle);

  if (rawSlug === "") {
    throw new Error(
      "Cannot ingest: no title was given and none could be derived from the content",
    );
  }

  // --- Alias resolution: check if title matches an existing page's aliases ---
  // This prevents duplicate pages when the same concept appears under different
  // names (e.g. "React.js" vs a page with aliases: ["React.js"]).
  const resolvedSlug = await resolveAlias(effectiveTitle);
  // Provisional slug from the title. On the direct ingest path this is later
  // replaced by a content-derived *concept* slug (see the CONCEPT marker below),
  // so the same concept under different headlines converges onto one page.
  // `pinSlug` (re-ingest) overrides everything: stay on the known page.
  let slug = options?.pinSlug ?? resolvedSlug ?? rawSlug;
  // The page title written to the index/log. Becomes the canonical concept name
  // when one is derived; otherwise stays the (derived) source title.
  let pageTitle = effectiveTitle;

  const prebuiltContent = internal?.prebuiltContent;

  // Acting identity + owner come from the authenticated session (set by the
  // route), never from client input. Fall back to "system" for legacy/bootstrap.
  // Resolved here (not just at frontmatter-build time) so the concept resolver
  // can scope a semantic merge to the same owner's silo.
  const actor = options?.author?.trim() || "system";
  const owner = options?.owner?.trim() || actor;

  // Dedup by content: if identical content was already ingested (any slug),
  // attach the triggerer and skip the LLM + embedding.
  const hash = contentHash(content);
  if (!prebuiltContent) {
    const dupSlug = await resolveContentHash(hash);
    if (dupSlug) {
      const result = await attachIngestTrigger(dupSlug, {
        url: options?.sourceUrl ?? "text-paste",
        type: options?.sourceType ?? (options?.sourceUrl ? "url" : "text"),
        triggeredBy: options?.triggeredBy,
        actorOwner: owner,
      });
      if (result) return result;
    }
  }

  // 1. Generate wiki page content (or use a prebuilt body — image path)
  let wikiContent: string;
  let chunksFailed = 0;
  let chunksTotal = 0;
  if (prebuiltContent) {
    // Image ingest: skip the LLM, write the already-final body as-is.
    wikiContent = prebuiltContent;
  } else {
    // Source images are dropped — strip them so the synthesizer gets image-free
    // text and the body is clean prose (no inline images, no `## Figures`
    // gallery, no re-hosting).
    const cleanContent = stripImageMarkdown(content);
    const synthesis = await synthesizeBody(effectiveTitle, cleanContent);
    wikiContent = synthesis.body;
    chunksFailed = synthesis.chunksFailed;
    chunksTotal = synthesis.chunksTotal;
  }

  // Pull the leading `CONCEPT:` / `ALIASES:` header lines the synthesis prompt
  // asks for (and strip them from the body so they never leak into the page).
  // Absent for the fallback page / a prebuilt image body / test mocks →
  // concept "" and no aliases.
  const {
    concept,
    aliases: conceptSynonyms,
    tags: conceptTags,
    body: conceptStrippedBody,
  } = parseConceptMarker(wikiContent);
  wikiContent = conceptStrippedBody;

  // Converge onto the content-derived concept slug so re-ingests of the same
  // concept (under any headline) land on one page. A prebuilt image body carries
  // no CONCEPT marker, so this is naturally skipped for it.
  // `pinSlug` (re-ingest) keeps the page on its known slug, so skip concept-slug
  // convergence — but still adopt the concept as the title and record aliases.
  let conceptAliases: string[] = [];
  if (!prebuiltContent && concept) {
    if (options?.pinSlug) {
      pageTitle = concept;
      conceptAliases = conceptSynonyms;
    } else {
      const conceptSlug = slugify(concept);
      if (conceptSlug !== "") {
        slug = await resolveConceptSlug(
          conceptSlug,
          concept,
          conceptSynonyms,
          wikiContent,
          owner,
          options?.pageType,
        );
        pageTitle = concept;
        conceptAliases = conceptSynonyms;
      }
    }
  }

  // A prebuilt body (image path) carries no CONCEPT marker, so the canonical
  // slug would otherwise stay the source-TITLE slug. Re-derive slug + title from
  // the body's first H1 so they match what the reader sees, only when the H1
  // slug is FREE — never clobber a different existing page.
  if (prebuiltContent) {
    const h1 = wikiContent.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
    if (options?.pinSlug) {
      // Pinned: keep the page on its slug, but let the TITLE follow the H1.
      if (h1) {
        pageTitle = h1;
      } else {
        const existingPage = await readWikiPageWithFrontmatter(slug);
        const existingTitle = existingPage?.body
          ?.match(/^#\s+(.+?)\s*$/m)?.[1]
          ?.trim();
        if (existingTitle) pageTitle = existingTitle;
      }
    } else {
      const conceptSlug = h1 ? slugify(h1) : "";
      if (h1 && conceptSlug && conceptSlug !== slug) {
        const taken = await readWikiPageWithFrontmatter(conceptSlug);
        if (!taken) {
          slug = conceptSlug;
          pageTitle = h1;
        }
      }
    }
  }

  // 2. Compute the index summary from the *raw* source so the index reflects
  // the original document, not the LLM's reformatting.
  const summary = extractSummary(content);

  // Realm guard: never converge onto a PRIVATE page this actor can't write
  // (private = owner-only). If the resolved slug landed on someone else's
  // private page — via the concept resolver, an alias, or a slug collision —
  // FORK to a fresh slug so the ingest produces the actor's OWN page and never
  // writes to (or leaks the slug of) the private one.
  const resolvedExisting = await readWikiPageWithFrontmatter(slug);
  if (
    resolvedExisting &&
    resolvedExisting.frontmatter.visibility === "private" &&
    !sameHumanOwner(owner, resolvedExisting.frontmatter.owner)
  ) {
    slug = await findFreeSlug(slug);
  }

  // --- Write path ---

  // 3. Save raw source
  const rawPath = await saveRawSource(slug, content);

  // 4. Build / refresh the YAML frontmatter block. New pages get
  // created = updated = today and source_count = 1. Re-ingesting the same
  // slug preserves `created`, advances `updated`, increments `source_count`,
  // and preserves any user-edited tags.
  const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 90);
  const expiryDate = expiry.toISOString().slice(0, 10);
  // `actor`/`owner` are resolved near the top of ingest() (the concept resolver
  // needs `owner` for its same-silo guard).
  const frontmatter: Frontmatter = {
    created: now,
    updated: now,
    source_count: "1",
    tags: [],
    confidence: 0.7,
    expiry: expiryDate,
    valid_from: now,
    owner,
    visibility: "public",
    authors: [actor],
    contributors: [],
    disputed: false,
    supersedes: "",
    aliases: [],
    content_hash: hash,
  };

  // Agent-scoped pages carry a `type` (e.g. "agent-knowledge") so they're
  // filtered from the public browse feed and general search.
  if (options?.pageType) {
    frontmatter.type = options.pageType;
  }

  // Persist the original source URL when provided (URL-based ingest).
  if (options?.sourceUrl) {
    frontmatter.source_url = options.sourceUrl;
  }

  // Surface partial MAP/REDUCE chunk failures so the page carries a visible
  // signal that some source material was lost during synthesis.
  if (chunksFailed > 0) {
    frontmatter.synthesis_gaps = `${chunksFailed} of ${chunksTotal} chunks failed`;
  }

  // Build the structured sources[] provenance entry for this ingest, and keep a
  // per-source raw snapshot so a multi-source page can show each source's raw.
  // The id is keyed on the source URL (so re-ingesting a URL refreshes that
  // snapshot, matching how mergeSourceEntry dedups by url); paste/upload key on
  // content instead, since they share the "text-paste" placeholder url.
  const sourceType = options?.sourceType
    ?? (options?.sourceUrl ? "url" : "text");
  const sourceUrl = options?.sourceUrl ?? "text-paste";
  const rawId = contentHash(
    sourceUrl !== "text-paste" && sourceUrl !== "upload" ? sourceUrl : content,
  );
  await saveRawSourceFor(slug, rawId, content);
  const sourceEntry = buildSourceEntry(sourceUrl, sourceType, options?.triggeredBy, rawId);
  frontmatter.sources = serializeSources([sourceEntry]);

  // Tags = the page's own CONCEPT as a topic tag (deterministic) + caller tags +
  // the synthesized COARSE facets (conceptTags). The LLM is TOLD to keep facets
  // coarser than the concept (they group many pages), so it usually won't coin the
  // concept itself — we add it here so a page is always tagged with its own topic
  // (e.g. "Agent Harness" → `agent-harness`), which is what readers expect. We put
  // it FIRST, so even if the LLM does emit the concept, normalizeTags dedups it to
  // one copy that leads. slugify keeps CJK, and normalizeTags now does too, so a
  // CJK concept (e.g. "知识库") becomes a real tag instead of being stripped away.
  // Capped at MAX_AUTO_TAGS — the prompt's "3-6" is only a request; this cap is
  // what actually bounds the set. Merged below for re-ingests.
  const conceptTag = concept ? slugify(concept) : "";
  const newTags = normalizeTags(
    [...(conceptTag ? [conceptTag] : []), ...(options?.tags ?? []), ...conceptTags],
    MAX_AUTO_TAGS,
  );
  if (newTags.length > 0) {
    frontmatter.tags = newTags;
  }

  const existing = await readWikiPageWithFrontmatter(slug);
  if (existing) {
    const existingCreated = existing.frontmatter.created;
    if (typeof existingCreated === "string" && existingCreated !== "") {
      frontmatter.created = existingCreated;
    }
    const prevCountRaw = existing.frontmatter.source_count;
    const prevCount =
      typeof prevCountRaw === "number"
        ? prevCountRaw
        : typeof prevCountRaw === "string"
          ? Number(prevCountRaw)
          : NaN;
    frontmatter.source_count = String(
      (Number.isFinite(prevCount) ? prevCount : 0) + 1,
    );
    if (Array.isArray(existing.frontmatter.tags)) {
      const existingTags = existing.frontmatter.tags.filter(
        (t): t is string => typeof t === "string",
      );
      // Cap the union at MAX_AUTO_TAGS (the old `Infinity` let it sprawl every
      // re-ingest). The concept tag leads; then the page's ESTABLISHED tags are
      // preserved ahead of freshly-synthesized facets, which fill only the
      // leftover slots. Existing-first on purpose: a re-ingest should stabilize
      // the tag set, not churn it — and it must not silently evict a tag a human
      // edited in (`tags` is user-patchable). Fresh facets that don't fit wait
      // for a slot to free up (e.g. an old tag dropping on a future synthesis).
      const merged = normalizeTags(
        [...(conceptTag ? [conceptTag] : []), ...existingTags, ...newTags],
        MAX_AUTO_TAGS,
      );
      frontmatter.tags = merged;
    }
    // Preserve existing source_url if the new ingest doesn't provide one.
    if (
      !frontmatter.source_url &&
      typeof existing.frontmatter.source_url === "string" &&
      existing.frontmatter.source_url !== ""
    ) {
      frontmatter.source_url = existing.frontmatter.source_url;
    }

    // Merge structured sources[]: parse existing, update or append new entry.
    const existingSourcesRaw = existing.frontmatter.sources;
    const existingSources = parseSources(
      typeof existingSourcesRaw === "string"
        ? existingSourcesRaw
        : Array.isArray(existingSourcesRaw)
          ? existingSourcesRaw
          : undefined,
    );
    // Merge the new entry, superseding a stale "text-paste" placeholder.
    // (source_count is the ingest counter, set above — not the array length.)
    frontmatter.sources = serializeSources(mergeSourceEntry(existingSources, sourceEntry));

    // --- Phase 1 fields: preserve on re-ingest ---
    // Preserve authors from existing page (don't reset).
    if (Array.isArray(existing.frontmatter.authors)) {
      frontmatter.authors = existing.frontmatter.authors;
    }
    // Preserve owner (the original owner stays accountable).
    if (typeof existing.frontmatter.owner === "string" && existing.frontmatter.owner !== "") {
      frontmatter.owner = existing.frontmatter.owner;
    }
    // Preserve visibility (don't silently re-publish a private page).
    if (existing.frontmatter.visibility === "private") {
      frontmatter.visibility = "private";
    }
    // Don't change an existing page's scope on re-ingest: preserve its `type`
    // (or lack of one), so an agent ingest can't flip a public page into
    // agent-scope (out of the feed/search) by colliding on a slug.
    if (typeof existing.frontmatter.type === "string") {
      frontmatter.type = existing.frontmatter.type;
    } else {
      delete frontmatter.type;
    }
    // Append the acting identity to contributors if not already present.
    const existingContribs = Array.isArray(existing.frontmatter.contributors)
      ? existing.frontmatter.contributors
      : [];
    if (!existingContribs.includes(actor)) {
      frontmatter.contributors = [...existingContribs, actor];
    } else {
      frontmatter.contributors = existingContribs;
    }
    // Preserve disputed flag from existing.
    if (typeof existing.frontmatter.disputed === "boolean") {
      frontmatter.disputed = existing.frontmatter.disputed;
    }
    // Preserve supersedes from existing.
    if (typeof existing.frontmatter.supersedes === "string") {
      frontmatter.supersedes = existing.frontmatter.supersedes;
    }
    // Preserve aliases from existing.
    if (Array.isArray(existing.frontmatter.aliases)) {
      frontmatter.aliases = existing.frontmatter.aliases;
    }
    // Expiry resets to 90 days from now (re-ingest refreshes the page).
    // valid_from also resets to now (the page's information is re-verified).
    // (both already set above — no need to change)
    // Confidence is recomputed from signals below (not preserved), so adding a
    // corroborating source raises it on re-ingest.
  }

  // Re-synthesize on merge (accumulate-and-reconcile): when this ingest lands on
  // an EXISTING page, fold the existing body and the new article into one
  // canonical page instead of overwriting — and escalate to `disputed` if the
  // new source contradicts what's there. Skipped without an LLM key (fall back
  // to the prior overwrite behaviour) and for a prebuilt image body (already
  // final). The page summary is computed from the raw source, so it is unaffected.
  if (existing && hasLLMKey() && !prebuiltContent) {
    try {
      // Reconcile against the frontmatter-STRIPPED body (existing.content still
      // carries the YAML block; existing.body is the markdown) so page metadata
      // never bleeds into the merged prose.
      const reconciled = await reconcilePage(existing.body, wikiContent);
      wikiContent = reconciled.body;
      // Only escalate — never clear a disputed flag preserved from the existing
      // page above.
      if (reconciled.disputed) frontmatter.disputed = true;
    } catch (err) {
      // A reconcile hiccup (LLM API error / empty response) must not fail an
      // ingest whose synthesis already succeeded — degrade to the prior
      // overwrite behaviour (keep the freshly synthesized body, disputed
      // untouched).
      logger.warn("ingest", "reconcile-on-merge failed; using new body", err);
    }
  }

  // When the page converged onto a concept slug, record the source title AND
  // the LLM-supplied concept synonyms as aliases so a later ingest arriving
  // under any of those names resolves here (extends convergence beyond the
  // content hash to the title/synonym routes). Merges with any existing
  // aliases; deduped case-insensitively; never aliases the concept to itself.
  if (pageTitle !== effectiveTitle) {
    const aliasList = Array.isArray(frontmatter.aliases)
      ? [...frontmatter.aliases]
      : [];
    const seen = new Set(aliasList.map((a) => a.toLowerCase()));
    for (const candidate of [effectiveTitle, ...conceptAliases]) {
      const trimmed = candidate.trim();
      const key = trimmed.toLowerCase();
      if (trimmed === "" || key === pageTitle.toLowerCase() || seen.has(key)) {
        continue;
      }
      seen.add(key);
      aliasList.push(trimmed);
    }
    frontmatter.aliases = aliasList;
  }

  // Confidence from provenance signals — computed last, when sources[] and the
  // disputed flag are final (after the re-ingest merge and reconcile).
  const finalSources = parseSources(
    typeof frontmatter.sources === "string" ? frontmatter.sources : undefined,
  );
  // Defensive: sources[] was just serialized from ≥1 entry, so an empty parse
  // means a serialize/parse round-trip lost it — confidence would silently fall
  // to the 0.6 default. Surface it rather than flatlining invisibly.
  if (
    finalSources.length === 0 &&
    typeof frontmatter.sources === "string" &&
    frontmatter.sources !== "[]"
  ) {
    logger.warn(
      "ingest",
      `sources[] failed to round-trip for "${slug}"; confidence falls back to the default`,
    );
  }
  frontmatter.confidence = computeConfidence(finalSources, frontmatter.disputed === true);

  const contentWithFm = serializeFrontmatter(frontmatter, wikiContent);

  // 5. Hand off to the unified write pipeline. We pass the raw `content` as
  // `crossRefSource` so the LLM sees the full document when picking related
  // pages, matching the previous behaviour.
  const { updatedSlugs } = await writeWikiPageWithSideEffects({
    slug,
    title: pageTitle,
    content: contentWithFm,
    summary,
    logOp: "ingest",
    crossRefSource: content,
    author: actor,
    logDetails: ({ updatedSlugs }) =>
      `slug: ${slug} · updated ${updatedSlugs.length} related page(s)`,
  });

  // 6. Alias index is updated automatically by the lifecycle pipeline
  //    (writeWikiPageWithSideEffects → runPageLifecycleOp) — no caller-side
  //    call needed. The source index (URL/content-hash → slug) is caller-owned,
  //    so refresh it here for future dedup hits.
  updateSourceIndexForPage(
    slug,
    typeof frontmatter.source_url === "string" ? frontmatter.source_url : undefined,
    hash,
  );

  // When this ingest left the page disputed (a source contradicts it), open a
  // reconciliation discussion thread so the dispute is actionable — by a human,
  // by "ask yoyo", or by the maintenance scan. Idempotent (skips if one's open)
  // + fail-soft; `ensureReconciliationThread` keeps the thread's author non-agent
  // (coercing an agent actor to "system") so the scan can pick it up.
  if (frontmatter.disputed === true) {
    await ensureReconciliationThread(slug, actor);
  }

  const result: IngestResult = {
    rawPath,
    primarySlug: slug,
    relatedUpdated: updatedSlugs,
    wikiPages: [slug, ...updatedSlugs],
    indexUpdated: true,
    ...(options?.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    ...(chunksFailed > 0 ? { chunksFailed, chunksTotal } : {}),
  };

  // 7. Persist a ledger entry recording this ingest operation.
  await persistToLedger({
    ingest_id: `${startedAt}/${slug}`,
    source_type: sourceType,
    source_url: sourceUrl,
    primary_slug: slug,
    related_slugs: updatedSlugs,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: "completed",
  });

  return result;
}
