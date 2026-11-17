import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import { listThreads, createThread } from "@/lib/talk";
import { getPrincipal } from "@/lib/auth";
import { canReadSlug } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * GET /api/wiki/[slug]/discuss
 *
 * Lists all discussion threads for a wiki page.
 * Returns `{ threads: TalkThread[] }` — empty array if none exist.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);
    if (!(await canReadSlug(slug, await getPrincipal()))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const threads = await listThreads(slug);
    return NextResponse.json({ threads });
  } catch (err) {
    logger.error("discuss list failed:", getErrorMessage(err));
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/wiki/[slug]/discuss
 *
 * Create a new discussion thread.
 * Body: `{ title: string, author: string, body: string }`
 * Returns `{ thread: TalkThread }` with status 201.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);
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

    const { title, body: threadBody } = body as Record<string, unknown>;

    // Thread author is the authenticated principal, never the request body.
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

    if (typeof title !== "string" || title.trim().length === 0) {
      return NextResponse.json(
        { error: "title must be a non-empty string" },
        { status: 400 },
      );
    }
    if (typeof threadBody !== "string" || threadBody.trim().length === 0) {
      return NextResponse.json(
        { error: "body must be a non-empty string" },
        { status: 400 },
      );
    }

    const thread = await createThread(slug, title.trim(), principal.handle, threadBody.trim());
    return NextResponse.json({ thread }, { status: 201 });
  } catch (err) {
    logger.error("discuss create failed:", getErrorMessage(err));
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status: 500 },
    );
  }
}
