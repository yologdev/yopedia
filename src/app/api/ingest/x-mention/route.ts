import { NextRequest, NextResponse } from "next/server";
import { ingestXMention } from "@/lib/ingest";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

/** Pattern matching x.com or twitter.com post URLs. */
const X_URL_PATTERN = /^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i;

export async function POST(request: NextRequest) {
  try {
    // Clerk session (human) OR service token (scheduled agent jobs) — never
    // the request body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Cost guard — X mention ingest triggers LLM synthesis.
    const rl = await enforceRateLimit("ingest", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before ingesting again." },
        { status: 429 },
      );
    }

    const body = await request.json();
    const { url, triggeredBy } = body;

    // --- Validate url ---
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      return NextResponse.json(
        { error: "url is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    if (!X_URL_PATTERN.test(url.trim())) {
      return NextResponse.json(
        { error: "url must be an x.com or twitter.com URL" },
        { status: 400 },
      );
    }

    // --- Validate triggeredBy ---
    if (
      !triggeredBy ||
      typeof triggeredBy !== "string" ||
      triggeredBy.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "triggeredBy is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    // `triggeredBy` (the X handle) stays as source provenance; the page owner
    // and author are the authenticated principal (Phase 1: the caller is the
    // logged-in user; the @yoyoevolve service loop is a later phase).
    const result = await ingestXMention(url.trim(), triggeredBy.trim(), {
      author: principal.handle,
      owner: principal.handle,
    });
    return NextResponse.json(result);
  } catch (error) {
    logger.error("ingest-x-mention", "X mention ingest error", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
