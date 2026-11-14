import { NextResponse } from "next/server";
import { fuzzySearchWikiContent, resolveScope } from "@/lib/search";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * GET /api/wiki/search?q=search+terms&scope=agent:yoyo&limit=5
 *
 * Full-text search across wiki page content.
 * Returns matching pages with snippets showing match context.
 * Falls back to fuzzy matching when exact results are sparse.
 *
 * When `scope` is provided, only pages within that scope are searched.
 * `limit` controls the maximum number of results (1–50, default 10).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();

    if (!q || q.length === 0) {
      return NextResponse.json(
        { error: "q parameter is required" },
        { status: 400 },
      );
    }

    const scopeParam = url.searchParams.get("scope");
    let scope;
    if (scopeParam) {
      scope = await resolveScope(scopeParam);
      if (!scope) {
        return NextResponse.json(
          { error: "Invalid scope or agent not found" },
          { status: 400 },
        );
      }
    }

    const limitParam = url.searchParams.get("limit");
    let limit = DEFAULT_LIMIT;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isNaN(parsed)) {
        limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
      }
    }

    const principal = await getPrincipal();
    const results = await fuzzySearchWikiContent(q, limit, scope, principal);
    return NextResponse.json({ results });
  } catch (err) {
    const message = getErrorMessage(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
