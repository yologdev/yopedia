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

/**
 * Read wiki pages by slug, concatenate their content with a separator.
 * Missing or unparseable pages are skipped with a warning logged.
 */
async function loadPages(
  slugs: string[],
  principal: Principal | null,
): Promise<{ content: string; count: number }> {
  // Read every page in parallel (bounded) — this was a serial per-slug loop and
  // the dominant latency of the endpoint. Order is preserved so the assembled
  // context stays stable; unreadable/missing pages drop out below.
  const pages = await mapWithConcurrency(slugs, READ_CONCURRENCY, (slug) =>
    // Guarded read: a page with malformed frontmatter drops out of the
    // assembled context (logged) instead of 500-ing the whole endpoint.
    tryReadWikiPageWithFrontmatter(slug, "agents"),
  );
  const contents: string[] = [];
  pages.forEach((page, i) => {
    if (page) {
      // Skip pages the caller can't read (an agent's list may reference a
      // third party's private page).
      if (!canReadFrontmatter(page.frontmatter, principal)) return;
      contents.push(page.body);
    } else {
      logger.warn("agents", `Wiki page "${slugs[i]}" not found — skipping`);
    }
  });
  return {
    content: contents.join(PAGE_SEPARATOR),
    count: contents.length,
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
 *     identity: string,
 *     learnings: string,
 *     socialWisdom: string,
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
        identity: identity.content,
        learnings: learnings.content,
        socialWisdom: social.content,
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
