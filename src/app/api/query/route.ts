import { NextRequest, NextResponse } from "next/server";
import { query, type QueryFormat } from "@/lib/query";
import { getPrincipal } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

function parseFormat(value: unknown): QueryFormat {
  if (value === "table") return "table";
  if (value === "slides") return "slides";
  if (value === "html") return "html";
  return "prose";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { question, format, scope } = body;

    if (
      !question ||
      typeof question !== "string" ||
      question.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "question is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    // Validate `format` if present; default to "prose" when missing/invalid.
    if (
      format !== undefined &&
      format !== "prose" &&
      format !== "table" &&
      format !== "slides" &&
      format !== "html"
    ) {
      return NextResponse.json(
        { error: "format must be 'prose', 'table', 'slides', or 'html'" },
        { status: 400 },
      );
    }

    // Validate `scope` if present — must be a string.
    if (scope !== undefined && typeof scope !== "string") {
      return NextResponse.json(
        { error: "scope must be a string (e.g. 'agent:yoyo')" },
        { status: 400 },
      );
    }

    // Querying invokes the LLM (a real cost), so it's signed-in-only. The
    // middleware write-gate already 401s anonymous POSTs to /api/**; this is
    // defense-in-depth at the cost-critical endpoint so a future middleware/
    // matcher change can't silently open free anonymous querying. (Agents query
    // via MCP — query() directly — not this route, so this doesn't gate them.)
    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json(
        { error: "Sign in required to query yopedia." },
        { status: 401 },
      );
    }

    // Cost guard — each query triggers an LLM generation.
    const rl = await enforceRateLimit("query", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before querying again." },
        { status: 429 },
      );
    }

    const result = await query(
      question.trim(),
      parseFormat(format),
      scope || undefined,
      principal,
    );

    return NextResponse.json(result);
  } catch (error) {
    logger.error("query", "Query error", error);
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
