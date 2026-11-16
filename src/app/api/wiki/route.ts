import { NextResponse } from "next/server";
import {
  validateSlug,
  readWikiPage,
  listReadableWikiPages,
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
  isAgentScopedType,
  type Frontmatter,
} from "@/lib/wiki";
import { extractSummary } from "@/lib/ingest";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";

/**
 * GET /api/wiki
 *
 * Lightweight list of all wiki pages (slug, title, summary).
 * Much cheaper than /api/wiki/graph which reads every page and builds a link graph.
 *
 * By default, agent-scoped pages (`type: agent-*` — identity, knowledge, …) are
 * excluded from the response so the main feed stays human-centric. Pass
 * `?includeAgentPages=true` to include them (used by agent profile pages).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const includeAgentPages =
      url.searchParams.get("includeAgentPages") === "true";

    const principal = await getPrincipal();
    let entries = await listReadableWikiPages(principal);
    if (!includeAgentPages) {
      entries = entries.filter((e) => !isAgentScopedType(e.type));
    }
    return NextResponse.json({ pages: entries });
  } catch (err) {
    const message = getErrorMessage(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/wiki
 *
 * Create a brand-new wiki page. Returns 409 if the slug already exists —
 * use PUT /api/wiki/[slug] to update an existing page.
 *
 * Body: `{ slug: string, content: string }`
 */
export async function POST(req: Request) {
  try {
    // Attribution from the authenticated session, never the body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Cost guard — wiki writes mutate storage and rebuild indexes.
    const rl = await enforceRateLimit("wiki", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before making more wiki changes." },
        { status: 429 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    const slug =
      body && typeof body === "object" && "slug" in body
        ? (body as { slug: unknown }).slug
        : undefined;
    const content =
      body && typeof body === "object" && "content" in body
        ? (body as { content: unknown }).content
        : undefined;
    const tags =
      body && typeof body === "object" && "tags" in body
        ? (body as { tags: unknown }).tags
        : undefined;
    const authorStr = principal.handle;
    const tagsArr: string[] =
      Array.isArray(tags) && tags.every((t: unknown) => typeof t === "string")
        ? (tags as string[])
        : [];

    if (typeof slug !== "string" || slug.trim().length === 0) {
      return NextResponse.json(
        { error: "slug must be a non-empty string" },
        { status: 400 },
      );
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json(
        { error: "content must be a non-empty string" },
        { status: 400 },
      );
    }

    validateSlug(slug);

    // Conflict check — don't overwrite existing pages
    const existing = await readWikiPage(slug);
    if (existing) {
      return NextResponse.json(
        { error: `page already exists: ${slug}` },
        { status: 409 },
      );
    }

    // Derive title from the first H1, falling back to slug
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : slug;

    const bodyForSummary = content.replace(/^#\s+.+$/m, "").trim();
    const summary = extractSummary(bodyForSummary);

    const today = new Date().toISOString().slice(0, 10);
    // Compute a default expiry 90 days from now (matches SCHEMA.md standard)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 90);
    const expiry = expiryDate.toISOString().slice(0, 10);

    const frontmatter: Frontmatter = {
      title,
      created: today,
      updated: today,
      confidence: 0.5,
      expiry,
      owner: authorStr,
      visibility: "public",
      authors: [authorStr],
      valid_from: today,
      disputed: false,
      contributors: [],
      aliases: [],
      tags: tagsArr,
      sources: [],
    };
    const fullContent = serializeFrontmatter(frontmatter, content);

    const result = await writeWikiPageWithSideEffects({
      slug,
      title,
      content: fullContent,
      summary,
      logOp: "ingest",
      crossRefSource: content,
      author: authorStr,
      logDetails: (ctx) =>
        `created · found ${ctx.updatedSlugs.length} cross-ref(s)`,
    });

    // Echo the owner so the client can navigate to the canonical
    // `/u/<tenant>/<slug>` URL after creation (tenant-silos P2).
    return NextResponse.json({ ...result, owner: authorStr }, { status: 201 });
  } catch (err) {
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
