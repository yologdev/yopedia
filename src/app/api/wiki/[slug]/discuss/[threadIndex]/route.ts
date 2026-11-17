import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import { getThread, resolveThread } from "@/lib/talk";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { canReadSlug } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

type RouteParams = { params: Promise<{ slug: string; threadIndex: string }> };

/**
 * GET /api/wiki/[slug]/discuss/[threadIndex]
 *
 * Returns a single discussion thread by index.
 * Returns `{ thread: TalkThread }` or 404.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { slug: encodedSlug, threadIndex } = await params;
    const slug = decodeSlug(encodedSlug);
    if (!(await canReadSlug(slug, await getPrincipal()))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const idx = parseInt(threadIndex, 10);
    if (!Number.isFinite(idx) || idx < 0) {
      return NextResponse.json(
        { error: "threadIndex must be a non-negative integer" },
        { status: 400 },
      );
    }

    const thread = await getThread(slug, idx);
    if (!thread) {
      return NextResponse.json(
        { error: `thread ${idx} not found for page "${slug}"` },
        { status: 404 },
      );
    }

    return NextResponse.json({ thread });
  } catch (err) {
    logger.error("discuss get failed:", getErrorMessage(err));
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/wiki/[slug]/discuss/[threadIndex]
 *
 * Update a discussion thread's status.
 * Body: `{ status: "open" | "resolved" | "wontfix" }`
 * Returns `{ thread: TalkThread }`.
 *
 * Only the thread author, the page owner, or a service principal may change
 * thread status. Other authenticated users receive 403.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const { slug: encodedSlug, threadIndex } = await params;
    const slug = decodeSlug(encodedSlug);

    // Resolve principal — prefer Clerk session, fall back to service token.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);

    // Cost guard — discussion writes mutate storage. Service principals are
    // rate-limited too (they share the same wiki surface budget).
    if (principal) {
      const rl = await enforceRateLimit("wiki", principal.id);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please wait before making more changes." },
          { status: 429 },
        );
      }
    }

    // Realm-aware read ACL: a private page's discussions are invisible to
    // non-owners (cloaked as 404 — no existence oracle).
    if (!(await canReadSlug(slug, principal))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const idx = parseInt(threadIndex, 10);
    if (!Number.isFinite(idx) || idx < 0) {
      return NextResponse.json(
        { error: "threadIndex must be a non-negative integer" },
        { status: 400 },
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

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    const { status } = body as Record<string, unknown>;
    if (status !== "open" && status !== "resolved" && status !== "wontfix") {
      return NextResponse.json(
        { error: 'status must be "open", "resolved", or "wontfix"' },
        { status: 400 },
      );
    }

    // Fetch the thread to check ownership before resolving.
    const existing = await getThread(slug, idx);
    if (!existing) {
      return NextResponse.json(
        { error: `thread ${idx} not found for page "${slug}"` },
        { status: 404 },
      );
    }

    // --- Ownership check ---
    // Service principals bypass the ownership check entirely.
    const isService = principal?.id.startsWith("service:");
    if (!isService) {
      if (!principal) {
        return NextResponse.json(
          { error: "authentication required" },
          { status: 401 },
        );
      }

      // The thread author is the author of the first comment.
      const threadAuthor = existing.comments[0]?.author;
      const isThreadAuthor = threadAuthor === principal.handle;

      // The page owner comes from the page's frontmatter.
      const { readWikiPageWithFrontmatter } = await import("@/lib/wiki");
      const page = await readWikiPageWithFrontmatter(slug);
      const pageOwner = page?.frontmatter?.owner;
      const isPageOwner =
        typeof pageOwner === "string" && pageOwner === principal.handle;

      if (!isThreadAuthor && !isPageOwner) {
        return NextResponse.json(
          { error: "only the thread author or page owner may change thread status" },
          { status: 403 },
        );
      }
    }

    const thread = await resolveThread(slug, idx, status);
    return NextResponse.json({ thread });
  } catch (err) {
    const message = getErrorMessage(err);
    // resolveThread throws if thread index is out of bounds
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    logger.error("discuss resolve failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
