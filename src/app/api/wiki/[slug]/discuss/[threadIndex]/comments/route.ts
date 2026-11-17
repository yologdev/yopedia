import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import { addComment } from "@/lib/talk";
import { getPrincipal } from "@/lib/auth";
import { canReadSlug } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

type RouteParams = { params: Promise<{ slug: string; threadIndex: string }> };

/**
 * POST /api/wiki/[slug]/discuss/[threadIndex]/comments
 *
 * Add a comment to an existing discussion thread.
 * Body: `{ author: string, body: string, parentId?: string }`
 * Returns `{ comment: TalkComment }` with status 201.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug: encodedSlug, threadIndex } = await params;
    const slug = decodeSlug(encodedSlug);
    const idx = parseInt(threadIndex, 10);
    if (!Number.isFinite(idx) || idx < 0) {
      return NextResponse.json(
        { error: "threadIndex must be a non-negative integer" },
        { status: 400 },
      );
    }

    // Comment author is the authenticated principal, never the request body.
    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Cost guard — discussion writes mutate storage.
    const rl = await enforceRateLimit("wiki", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before making more changes." },
        { status: 429 },
      );
    }

    // Realm-aware read ACL: a private page's discussions are invisible to
    // non-owners (cloaked as 404 — no existence oracle).
    if (!(await canReadSlug(slug, principal))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
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

    const { body: commentBody, parentId } = body as Record<string, unknown>;

    const author = principal.handle;

    if (typeof commentBody !== "string" || commentBody.trim().length === 0) {
      return NextResponse.json(
        { error: "body must be a non-empty string" },
        { status: 400 },
      );
    }
    if (parentId !== undefined && typeof parentId !== "string") {
      return NextResponse.json(
        { error: "parentId must be a string if provided" },
        { status: 400 },
      );
    }

    const comment = await addComment(
      slug,
      idx,
      author,
      commentBody.trim(),
      typeof parentId === "string" ? parentId : undefined,
    );
    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    const message = getErrorMessage(err);
    // addComment throws if thread index is out of bounds
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    // addComment throws if thread is resolved or wontfix
    if (message.includes("Cannot comment on a")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    logger.error("discuss comment failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
