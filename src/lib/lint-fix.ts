import { readWikiPage, readWikiPageWithFrontmatter, listWikiPages, updateIndex, appendToLog, isArtifactType } from "./wiki";
import { writeWikiPageWithSideEffects, deleteWikiPage } from "./lifecycle";
import { callLLM, hasLLMKey } from "./llm";
import { slugify } from "./slugify";
import { serializeFrontmatter } from "./frontmatter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a lint-fix operation. */
export interface FixResult {
  success: boolean;
  slug: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a required field is missing from the fix request. */
export class FixValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixValidationError";
  }
}

/** Thrown when a page required by the fix doesn't exist. */
export class FixNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Individual fix functions
// ---------------------------------------------------------------------------

/**
 * Fix an orphan-page lint issue by adding the page to the wiki index.
 *
 * Reads the page, extracts a summary, and writes it through the lifecycle
 * pipeline so that the index entry is created.
 */
export async function fixOrphanPage(slug: string, author = "lint-fix"): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  const page = await readWikiPage(slug);
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  // Extract summary from the first paragraph
  const summaryMatch = page.content.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: page.content,
    summary,
    logOp: "edit",
    logDetails: () => "auto-fix: added orphan page to index",
    crossRefSource: null,
    author,
  });

  return {
    success: true,
    slug,
    message: `Added ${slug} to index`,
  };
}

/**
 * Fix a stale-index lint issue by removing the stale entry from the index.
 *
 * If the slug is not found in the index, returns a no-op success result.
 */
export async function fixStaleIndex(slug: string, _author = "lint-fix"): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  // Re-verify the page file is genuinely missing before dropping its index
  // entry — never remove a valid entry on a transient read miss or a retry
  // after the page was (re)created.
  if (await readWikiPage(slug)) {
    return {
      success: false,
      slug,
      message: `Page "${slug}" exists — index entry is not stale`,
    };
  }

  const entries = await listWikiPages();
  const filtered = entries.filter((e) => e.slug !== slug);

  if (filtered.length === entries.length) {
    return {
      success: true,
      slug,
      message: `Entry for ${slug} not found in index — no changes needed`,
    };
  }

  await updateIndex(filtered);
  // Keep the page-metadata index in sync (this removes index.md membership
  // outside the lifecycle op). Harmless if absent — the entry is just dropped.
  await (await import("./page-index")).removePageIndexForSlug(slug);
  await appendToLog(
    "edit",
    slug,
    `auto-fix: removed stale index entry for ${slug}`,
  );

  return {
    success: true,
    slug,
    message: `Removed stale entry for ${slug} from index`,
  };
}

/**
 * Fix an empty-page lint issue by deleting the page entirely.
 */
export async function fixEmptyPage(slug: string, author = "lint-fix"): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  await deleteWikiPage(slug, author);

  return {
    success: true,
    slug,
    message: `Deleted empty page ${slug}`,
  };
}

/**
 * Fix a missing-crossref lint issue by inserting a cross-reference link
 * from `slug` to `targetSlug`.
 *
 * If the link already exists, returns a no-op success result.
 * If no `## Related` section exists, creates one at the end of the page.
 */
export async function fixMissingCrossRef(
  slug: string,
  targetSlug: string,
  author = "lint-fix",
): Promise<FixResult> {
  if (!slug || !targetSlug) {
    throw new FixValidationError(
      "Missing required fields: slug and targetSlug",
    );
  }

  // Read the source page
  const sourcePage = await readWikiPage(slug);
  if (!sourcePage) {
    throw new FixNotFoundError(`Source page not found: ${slug}`);
  }

  // Never append a markdown "## Related" section to an HTML artifact — its body
  // is a self-contained document and the markdown would render as literal text.
  const sourceFm = await readWikiPageWithFrontmatter(slug);
  if (
    sourceFm &&
    isArtifactType(
      typeof sourceFm.frontmatter.type === "string"
        ? sourceFm.frontmatter.type
        : undefined,
    )
  ) {
    return {
      success: true,
      slug,
      message: `Skipped ${slug}: HTML artifacts don't take markdown cross-references`,
    };
  }

  // Read the target page to get its title
  const targetPage = await readWikiPage(targetSlug);
  if (!targetPage) {
    throw new FixNotFoundError(`Target page not found: ${targetSlug}`);
  }

  // Build the cross-reference link
  const link = `[${targetPage.title}](${targetSlug}.md)`;

  // Check if the link already exists (avoid duplicates)
  if (sourcePage.content.includes(`(${targetSlug}.md)`)) {
    return {
      success: true,
      slug,
      message: `Page already links to ${targetSlug}.md — no changes needed`,
    };
  }

  // Append the link to a ## Related section
  let updatedContent: string;
  const relatedHeadingRe = /^## Related\b.*$/m;
  const relatedMatch = relatedHeadingRe.exec(sourcePage.content);

  if (relatedMatch) {
    // Insert the link on the line after the heading.
    // Find the end of the Related section: either the next heading or EOF.
    const afterHeading = relatedMatch.index! + relatedMatch[0].length;
    const restAfterHeading = sourcePage.content.slice(afterHeading);

    // Find next heading (## or #) after the Related section
    const nextHeadingMatch = restAfterHeading.match(/\n(?=## )/);
    const insertPos = nextHeadingMatch
      ? afterHeading + nextHeadingMatch.index!
      : sourcePage.content.length;

    // Insert just before the next heading (or at EOF), with a blank line guard
    const before = sourcePage.content.slice(0, insertPos).trimEnd();
    const after = sourcePage.content.slice(insertPos);
    updatedContent = `${before}\n- ${link}${after ? `\n${after}` : "\n"}`;
  } else {
    // No Related section yet — append one at the end
    updatedContent = `${sourcePage.content.trimEnd()}\n\n## Related\n\n- ${link}\n`;
  }

  // Extract summary from the source page for the index entry
  const summaryMatch = sourcePage.content.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  // Write via the lifecycle pipeline (handles index, log, embeddings)
  await writeWikiPageWithSideEffects({
    slug,
    title: sourcePage.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () => `auto-fix: added cross-reference to ${targetSlug}.md`,
    crossRefSource: null, // skip cross-ref discovery — we're adding a specific link
    author,
  });

  return {
    success: true,
    slug,
    message: `Added cross-reference from ${slug}.md to ${targetSlug}.md`,
  };
}

/**
 * Fix a contradiction lint issue by calling the LLM to rewrite the first page
 * so it no longer conflicts with the second page.
 *
 * @param slug - The slug of the page to rewrite
 * @param targetSlug - The slug of the other page involved in the contradiction
 * @param message - The contradiction description from the linter
 */
export async function fixContradiction(
  slug: string,
  targetSlug: string,
  message: string,
  author = "lint-fix",
): Promise<FixResult> {
  if (!slug || !targetSlug) {
    throw new FixValidationError(
      "Missing required fields: slug and targetSlug",
    );
  }

  if (!hasLLMKey()) {
    throw new FixValidationError(
      "Cannot fix contradictions without an LLM provider configured",
    );
  }

  const sourcePage = await readWikiPage(slug);
  if (!sourcePage) {
    throw new FixNotFoundError(`Source page not found: ${slug}`);
  }

  const otherPage = await readWikiPage(targetSlug);
  if (!otherPage) {
    throw new FixNotFoundError(`Target page not found: ${targetSlug}`);
  }

  const systemPrompt = `You are a wiki editor resolving contradictions between pages. You will be given two wiki pages and a description of the contradiction. Rewrite ONLY the first page to resolve the contradiction while preserving as much of its original content and structure as possible. Output only the full rewritten markdown for the first page — no explanation, no wrapping.`;

  const userMessage = `## Contradiction\n${message}\n\n## Page to rewrite: ${slug}.md\n\n${sourcePage.content}\n\n## Other page (do not rewrite): ${targetSlug}.md\n\n${otherPage.content}`;

  const rewritten = await callLLM(systemPrompt, userMessage);

  // Extract summary from the rewritten page for the index entry
  const summaryMatch = rewritten.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: sourcePage.title,
    content: rewritten,
    summary,
    logOp: "edit",
    logDetails: () =>
      `auto-fix: resolved contradiction with ${targetSlug}.md`,
    crossRefSource: null,
    author,
  });

  return {
    success: true,
    slug,
    message: `Rewrote ${slug}.md to resolve contradiction with ${targetSlug}.md`,
  };
}

/**
 * Fix a missing-concept-page lint issue by generating a stub wiki page for the
 * concept.
 *
 * - Parses the concept name from the lint message (pattern: `Concept "X" is mentioned in ...`)
 * - If the slug already exists on disk, returns a no-op success (race guard)
 * - With an LLM key: asks the LLM to produce a concise wiki page for the concept
 * - Without an LLM key: creates a minimal stub page
 * - Writes via `writeWikiPageWithSideEffects` so index + cross-refs are updated
 */
export async function fixMissingConceptPage(
  message: string,
  author = "lint-fix",
): Promise<FixResult> {
  // Extract concept name from the lint message format:
  //   Concept "X" is mentioned in slug-a, slug-b but has no dedicated page. <reason>
  const conceptMatch = message.match(/^Concept "([^"]+)" is mentioned in/);
  if (!conceptMatch) {
    throw new FixValidationError(
      "Could not parse concept name from lint message",
    );
  }

  const concept = conceptMatch[1];
  const slug = slugify(concept);

  if (!slug) {
    throw new FixValidationError(
      `Could not generate a valid slug for concept "${concept}"`,
    );
  }

  // Guard: if the page already exists, there's nothing to do
  const existing = await readWikiPage(slug);
  if (existing) {
    return {
      success: true,
      slug,
      message: `Page ${slug}.md already exists — no changes needed`,
    };
  }

  let content: string;

  if (hasLLMKey()) {
    const systemPrompt =
      "You are a wiki editor. Create a concise wiki page for the given concept. " +
      "Start with a level-1 heading using the concept name, then provide a brief " +
      "definition and overview. Note at the end that this page was auto-generated " +
      "from a lint suggestion and may need expansion. Output only the markdown — " +
      "no wrapping, no explanation.";
    const userMessage = `Create a wiki page for the concept: "${concept}"`;
    content = await callLLM(systemPrompt, userMessage);
  } else {
    content =
      `# ${concept}\n\n` +
      `*This page was auto-generated by lint. Expand it with real content by ingesting sources about this topic.*\n`;
  }

  // Extract summary from generated content
  const summaryMatch = content.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : concept;

  await writeWikiPageWithSideEffects({
    slug,
    title: concept,
    content,
    summary,
    logOp: "ingest",
    logDetails: () =>
      `auto-fix: created stub page for missing concept "${concept}"`,
    crossRefSource: content,
    author,
  });

  return {
    success: true,
    slug,
    message: `Created stub page ${slug}.md for concept "${concept}"`,
  };
}

/**
 * Fix a broken-link lint issue by removing the broken link from the page.
 *
 * Replaces all occurrences of `[text](targetSlug.md)` with just `text`.
 */
export async function fixBrokenLink(
  slug: string,
  targetSlug: string,
  author = "lint-fix",
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }
  if (!targetSlug) {
    throw new FixValidationError("Missing required field: targetSlug");
  }

  const page = await readWikiPage(slug);
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  // Escape the target slug for use in regex
  const escaped = targetSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linkRe = new RegExp(
    `\\[([^\\]]*)\\]\\(${escaped}\\.md\\)`,
    "g",
  );

  const updatedContent = page.content.replace(linkRe, "$1");

  if (updatedContent === page.content) {
    return {
      success: true,
      slug,
      message: `No broken links to ${targetSlug}.md found in ${slug}.md — no changes needed`,
    };
  }

  // Extract summary from the first paragraph
  const summaryMatch = updatedContent.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () =>
      `auto-fix: removed broken link(s) to "${targetSlug}.md"`,
    crossRefSource: null,
    author,
  });

  return {
    success: true,
    slug,
    message: `Removed broken link(s) to ${targetSlug}.md from ${slug}.md`,
  };
}

/**
 * Fix a stale-page lint issue by bumping the expiry date forward by 90 days
 * and refreshing the `valid_from` timestamp to today.
 *
 * Reads the page, updates the `expiry` and `valid_from` frontmatter fields,
 * and writes back.
 */
export async function fixStalePage(slug: string, author = "lint-fix"): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  const now = new Date();
  const newExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const expiryStr = newExpiry.toISOString().split("T")[0];
  const validFromStr = now.toISOString().split("T")[0];

  page.frontmatter.expiry = expiryStr;
  page.frontmatter.valid_from = validFromStr;

  const updatedContent = serializeFrontmatter(page.frontmatter, page.body);
  const summaryMatch = page.body.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () =>
      `auto-fix: extended expiry to ${expiryStr}, verified as of ${validFromStr}`,
    crossRefSource: null,
    author,
  });

  return {
    success: true,
    slug,
    message: `Expiry extended to ${expiryStr}, verified as of ${validFromStr}`,
  };
}

// ---------------------------------------------------------------------------
// Unmigrated-page fix — adds sensible yopedia defaults to pre-Phase-1 pages.
// ---------------------------------------------------------------------------

/**
 * Fix an unmigrated-page lint issue by adding sensible yopedia defaults.
 *
 * Adds only missing fields — never overwrites existing ones:
 * - `confidence: 0.5` (moderate default)
 * - `expiry: <90 days from now>` (reasonable review interval)
 * - `authors: ["system"]` (migrated by automation)
 * - `contributors: []` (empty)
 * - `disputed: false`
 *
 * Does NOT add `supersedes` or `aliases` — those are page-specific with no
 * sensible default.
 */
export async function fixUnmigratedPage(slug: string, author = "lint-fix"): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  const fm = page.frontmatter;
  const added: string[] = [];

  // 90 days from now as ISO date
  const now = new Date();
  const defaultExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  if (!("confidence" in fm)) {
    fm.confidence = 0.5;
    added.push("confidence");
  }
  if (!("expiry" in fm)) {
    fm.expiry = defaultExpiry;
    added.push("expiry");
  }
  if (!("authors" in fm)) {
    fm.authors = ["system"];
    added.push("authors");
  }
  if (!("contributors" in fm)) {
    fm.contributors = [];
    added.push("contributors");
  }
  if (!("disputed" in fm)) {
    fm.disputed = false;
    added.push("disputed");
  }
  if (!("valid_from" in fm)) {
    // For unmigrated pages, use the page's created/updated date as a best guess
    // for when the content was last verified. Falls back to today.
    const createdRaw = fm.created;
    const updatedRaw = fm.updated;
    const bestGuess =
      typeof updatedRaw === "string" && updatedRaw.length >= 10
        ? updatedRaw.slice(0, 10)
        : typeof createdRaw === "string" && createdRaw.length >= 10
          ? createdRaw.slice(0, 10)
          : now.toISOString().split("T")[0];
    fm.valid_from = bestGuess;
    added.push("valid_from");
  }

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: serializeFrontmatter(fm, page.body),
    summary: (() => {
      const m = page.body.match(/^#\s+.+\n+(.+)/m);
      return m ? m[1].slice(0, 120) : slug;
    })(),
    logOp: "edit",
    logDetails: () =>
      added.length > 0
        ? `auto-fix: added yopedia defaults: ${added.join(", ")}`
        : `auto-fix: unmigrated page already has all yopedia fields`,
    crossRefSource: null,
    author,
  });

  return {
    success: true,
    slug,
    message: added.length > 0
      ? `Added yopedia defaults: ${added.join(", ")}`
      : `Page already has all yopedia fields — no changes needed`,
  };
}

/**
 * Fix a supersedes-dangling issue by CLEARING the dead reference — the page's
 * `supersedes` points at a slug that no longer exists, so the pointer is stale.
 * Re-verifies the target is still missing before clearing (idempotent / safe
 * under queue retry), so a now-valid reference is never dropped.
 */
export async function fixSupersededDangling(slug: string, author = "lint-fix"): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  const supersedes = page.frontmatter.supersedes;
  if (typeof supersedes !== "string" || supersedes === "") {
    return { success: false, slug, message: `No supersedes field to fix on "${slug}"` };
  }
  // Don't clear a reference that has since become valid.
  if (await readWikiPageWithFrontmatter(supersedes)) {
    return {
      success: false,
      slug,
      message: `supersedes target "${supersedes}" now exists — nothing to fix`,
    };
  }

  const fm = { ...page.frontmatter };
  delete fm.supersedes;
  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: serializeFrontmatter(fm, page.body),
    summary: (() => {
      const m = page.body.match(/^#\s+.+\n+(.+)/m);
      return m ? m[1].slice(0, 120) : slug;
    })(),
    logOp: "edit",
    logDetails: () => `auto-fix: cleared dangling supersedes "${supersedes}"`,
    crossRefSource: null,
    author,
  });

  return {
    success: true,
    slug,
    message: `Cleared dangling supersedes "${supersedes}" from "${slug}"`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a lint-fix request to the appropriate handler based on issue type.
 *
 * @throws {FixValidationError} for missing fields or unsupported types
 * @throws {FixNotFoundError} when a required page doesn't exist
 */
export async function fixLintIssue(
  type: string,
  slug: string,
  targetSlug?: string,
  message?: string,
  author = "lint-fix",
): Promise<FixResult> {
  switch (type) {
    case "orphan-page":
      return fixOrphanPage(slug, author);
    case "stale-index":
      return fixStaleIndex(slug, author);
    case "empty-page":
      return fixEmptyPage(slug, author);
    case "missing-crossref":
      return fixMissingCrossRef(slug, targetSlug ?? "", author);
    case "contradiction":
      return fixContradiction(slug, targetSlug ?? "", message ?? "", author);
    case "missing-concept-page":
      return fixMissingConceptPage(message ?? "", author);
    case "broken-link":
      return fixBrokenLink(slug, targetSlug ?? "", author);
    case "stale-page":
      return fixStalePage(slug, author);
    case "unmigrated-page":
      return fixUnmigratedPage(slug, author);
    case "low-confidence":
      throw new FixValidationError(
        "Low-confidence pages cannot be auto-fixed. Ingest additional sources about this topic to improve confidence.",
      );
    case "uncited-claims":
      // Full auto-fix would require LLM-driven citation generation — out of scope.
      // Users should ingest a source URL or add inline citations manually.
      throw new FixValidationError(
        "Uncited-claims pages cannot be auto-fixed. Ingest a source URL for this topic or add inline citations manually.",
      );
    case "unresolved-discussions":
      throw new FixValidationError(
        "Unresolved discussions cannot be auto-fixed. Review and resolve the open threads on the talk page.",
      );
    case "duplicate-entity":
      throw new FixValidationError(
        "Duplicate entities require human judgment to merge. Review the alias lists and decide which page to keep.",
      );
    case "disputed-page":
      throw new FixValidationError(
        "Disputed pages cannot be auto-fixed. Review the page content and talk page to resolve the dispute through discussion.",
      );
    case "supersedes-dangling":
      // Auto-fixable: clear the dead reference (re-verified missing first).
      return fixSupersededDangling(slug, author);
    case "incomplete-coverage":
      throw new FixValidationError(
        "Incomplete coverage cannot be auto-fixed. Re-ingest the source URL to refresh the page content.",
      );
    case "dead-source":
      throw new FixValidationError(
        "Dead sources cannot be auto-fixed. Re-ingest from a new source or remove the dead source_url from frontmatter.",
      );
    default:
      throw new FixValidationError(
        "Auto-fix not supported for this issue type",
      );
  }
}
