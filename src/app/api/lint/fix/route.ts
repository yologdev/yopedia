import { NextRequest, NextResponse } from "next/server";
import {
  fixLintIssue,
  FixValidationError,
  FixNotFoundError,
} from "@/lib/lint-fix";
import { getErrorMessage } from "@/lib/errors";
import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * POST /api/lint/fix — auto-fix a lint issue.
 *
 * Supported issue types:
 * - `missing-crossref`: appends a cross-reference link to the source page.
 * - `orphan-page`: adds the page to the wiki index.
 * - `stale-index`: removes a stale entry from the wiki index.
 * - `empty-page`: deletes an empty page entirely.
 * - `contradiction`: rewrites the source page via LLM to resolve a conflict.
 *
 * Request body:
 * ```json
 * { "type": "missing-crossref", "slug": "source-page", "targetSlug": "target-page" }
 * { "type": "orphan-page", "slug": "page-slug" }
 * { "type": "stale-index", "slug": "page-slug" }
 * { "type": "empty-page", "slug": "page-slug" }
 * { "type": "contradiction", "slug": "page-a", "targetSlug": "page-b", "message": "..." }
 * ```
 */
export async function POST(req: NextRequest) {
  try {
    // Lint fixes mutate pages — owner-only.
    const principal = await getPrincipal();
    if (!isOwnerHandle(principal?.handle)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Cost guard — lint fixes mutate pages.
    const rl = await enforceRateLimit("wiki", principal!.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before fixing more issues." },
        { status: 429 },
      );
    }

    const body = await req.json();
    const { type, slug, targetSlug, message } = body;

    const result = await fixLintIssue(type, slug, targetSlug, message);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FixValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof FixNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    logger.error("lint", "Lint fix error", error);
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
