import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import { getThread, addComment } from "@/lib/talk";
import { getPrincipal } from "@/lib/auth";
import { canReadSlug } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enqueueTask } from "@/lib/tasks";
import { agentIdFor, DEFAULT_AGENT_NAME } from "@/lib/agents";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

type RouteParams = { params: Promise<{ slug: string; threadIndex: string }> };

/**
 * POST /api/wiki/[slug]/discuss/[threadIndex]/ask-yoyo
 *
 * The "Ask yoyo to address this" producer: enqueue a `reconcile` task so an
 * agent reads the page + this thread and revises the page asynchronously (the
 * "agents maintain, humans discuss" loop). Signed-in only; read-gated (a private
 * page's discussions are cloaked as 404 for non-owners). Posts a "yoyo is on it"
 * note so the thread shows pending state; the agent posts the result later.
 */
export async function POST(_req: Request, { params }: RouteParams) {
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

    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Cost guard — each ask-yoyo enqueues an LLM reconcile task.
    const rl = await enforceRateLimit("reconcile", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before asking yoyo again." },
        { status: 429 },
      );
    }

    // Realm-aware read ACL: cloak a private page's discussions as 404.
    if (!(await canReadSlug(slug, principal))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const thread = await getThread(slug, idx);
    if (!thread) {
      return NextResponse.json({ error: "thread not found" }, { status: 404 });
    }

    const queued = await enqueueTask({
      kind: "reconcile",
      slug,
      threadIndex: idx,
      requestedBy: principal.handle,
    });

    if (!queued) {
      // The task queue isn't available (e.g. off the Workers runtime). Surface
      // it rather than silently claiming success.
      return NextResponse.json(
        { error: "Task queue unavailable." },
        { status: 503 },
      );
    }

    // Best-effort pending note from the requester's yoyo, so the thread shows
    // it's being worked on. Non-fatal if it fails (e.g. a resolved thread).
    const agent = agentIdFor(principal.handle, DEFAULT_AGENT_NAME);
    try {
      await addComment(
        slug,
        idx,
        agent,
        "🛠 Queued — yoyo will review this thread and update the page shortly.",
      );
    } catch (err) {
      logger.warn("ask-yoyo", "pending note failed (non-fatal):", err);
    }

    return NextResponse.json({ queued: true });
  } catch (err) {
    logger.error("ask-yoyo", "enqueue failed:", err);
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}
