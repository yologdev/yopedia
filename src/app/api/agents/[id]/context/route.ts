import { NextResponse } from "next/server";
import { getAgent, resolveAgentPages } from "@/lib/agents";
import { tryReadWikiPageWithFrontmatter } from "@/lib/wiki";
import { getPrincipal, type Principal } from "@/lib/auth";
import { canReadFrontmatter } from "@/lib/authz";
import { mapWithConcurrency, READ_CONCURRENCY } from "@/lib/concurrency";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Separator used between concatenated page contents. */
const PAGE_SEPARATOR = "\n\n---\n\n";

/** Per-page metadata surfaced in the context response. */
interface PageMeta {
  confidence?: number;
  expiry?: string;
  disputed?: boolean;
  updated?: string;
  tags?: string[];
  owner?: string;
}

/** A single page entry in the `pages` array of a context section. */
interface PageEntry {
  slug: string;
  title: string;
  meta: PageMeta;
}

/** Result from {@link loadPages}: content blob + per-page metadata. */
interface LoadPagesResult {
  content: string;
  count: number;
  pages: PageEntry[];
}

/**
 * Extract the metadata fields from frontmatter that agents need
 * to make quality-informed decisions about each page.
 */
function extractPageMeta(fm: Record<string, unknown>): PageMeta {
  const meta: PageMeta = {};
  if (typeof fm.confidence === "number") meta.confidence = fm.confidence;
  if (typeof fm.expiry === "string") meta.expiry = fm.expiry;
  if (fm.disputed === true || fm.disputed === "true") meta.disputed = true;
  if (typeof fm.updated === "string") meta.updated = fm.updated;
  if (Array.isArray(fm.tags)) meta.tags = fm.tags as string[];
  if (typeof fm.owner === "string") meta.owner = fm.owner;
  return meta;
}

/**
 * Read wiki pages by slug, concatenate their content with a separator.
 * Missing or unparseable pages are skipped with a warning logged.
 * Returns per-page metadata alongside the concatenated content.
 */
async function loadPages(
  slugs: string[],
  principal: Principal | null,
): Promise<LoadPagesResult> {
  // Read every page in parallel (bounded) — this was a serial per-slug loop and
  // the dominant latency of the endpoint. Order is preserved so the assembled
  // context stays stable; unreadable/missing pages drop out below.
  const results = await mapWithConcurrency(slugs, READ_CONCURRENCY, (slug) =>
    // Guarded read: a page with malformed frontmatter drops out of the
    // assembled context (logged) instead of 500-ing the whole endpoint.
    tryReadWikiPageWithFrontmatter(slug, "agents"),
  );
  const contents: string[] = [];
  const pages: PageEntry[] = [];
  results.forEach((page, i) => {
    if (page) {
      // Skip pages the caller can't read (an agent's list may reference a
      // third party's private page).
      if (!canReadFrontmatter(page.frontmatter, principal)) return;
      contents.push(page.body);
      pages.push({
        slug: page.slug,
        title: page.title,
        meta: extractPageMeta(page.frontmatter),
      });
    } else {
      logger.warn("agents", `Wiki page "${slugs[i]}" not found — skipping`);
    }
  });
  return {
    content: contents.join(PAGE_SEPARATOR),
    count: contents.length,
    pages,
  };
}

/**
 * GET /api/agents/[id]/context
 *
 * The flagship context endpoint from YOYO.md Phase 4.
 *
 * Returns the agent's identity + learnings + social wisdom in one call,
 * so any project can bootstrap an agent by hitting one URL — no repo coupling.
 *
 * Response shape:
 * {
 *   agent: AgentProfile,
 *   context: {
 *     identity:    { content: string, pages: PageEntry[] },
 *     learnings:   { content: string, pages: PageEntry[] },
 *     socialWisdom: { content: string, pages: PageEntry[] },
 *   },
 *   meta: {
 *     totalChars: number,
 *     pageCount: number,
 *     generatedAt: string,
 *   }
 * }
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id || id.trim().length === 0) {
      return NextResponse.json(
        { error: "Agent ID must be a non-empty string" },
        { status: 400 },
      );
    }

    const agent = await getAgent(id);
    if (!agent) {
      return NextResponse.json(
        { error: `Agent "${id}" not found` },
        { status: 404 },
      );
    }

    // Resolve effective pages (own + inherited from the template chain), so a
    // forked per-user yoyo returns the base content it inherits.
    const pages = await resolveAgentPages(agent);

    // Load all context sections in parallel (read-gated per page)
    const principal = await getPrincipal();
    const [identity, learnings, social] = await Promise.all([
      loadPages(pages.identityPages, principal),
      loadPages(pages.learningPages, principal),
      loadPages(pages.socialPages, principal),
    ]);

    const totalChars =
      identity.content.length +
      learnings.content.length +
      social.content.length;
    const pageCount = identity.count + learnings.count + social.count;

    return NextResponse.json({
      agent,
      context: {
        identity: { content: identity.content, pages: identity.pages },
        learnings: { content: learnings.content, pages: learnings.pages },
        socialWisdom: { content: social.content, pages: social.pages },
      },
      meta: {
        totalChars,
        pageCount,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.includes("Invalid agent ID")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
