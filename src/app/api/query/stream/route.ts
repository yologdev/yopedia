import { NextRequest, NextResponse } from "next/server";
import { hasLLMKey, callLLMStream } from "@/lib/llm";
import {
  QUERY_MAX_OUTPUT_TOKENS,
  STREAM_DONE_SENTINEL,
  STREAM_ERROR_SENTINEL,
} from "@/lib/constants";
import { listReadableWikiPages, isAgentScopedType, isArtifactType } from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  selectPagesForQuery,
  buildContext,
  buildQuerySystemPrompt,
  type QueryFormat,
} from "@/lib/query";
import { resolveScopeSlugs } from "@/lib/search";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

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

    // Validate `format` if present; default to "prose" when missing.
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
    const queryFormat: QueryFormat =
      format === "table"
        ? "table"
        : format === "slides"
          ? "slides"
          : format === "html"
            ? "html"
            : "prose";

    // Validate `scope` if present — must be a string.
    if (scope !== undefined && typeof scope !== "string") {
      return NextResponse.json(
        { error: "scope must be a string (e.g. 'agent:yoyo')" },
        { status: 400 },
      );
    }

    const trimmedQuestion = question.trim();

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

    // Cost guard — each streaming query triggers an LLM generation.
    const rl = await enforceRateLimit("query", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before querying again." },
        { status: 429 },
      );
    }

    // Resolve scope to a set of slugs (handles the "mine" lens; empty "mine"
    // falls back to the full commons).
    const { scopeSlugs, error: scopeError } = await resolveScopeSlugs(
      scope,
      principal,
    );
    if (scopeError) {
      return NextResponse.json({ error: scopeError }, { status: 400 });
    }

    let entries = await listReadableWikiPages(principal);

    // Unscoped queries answer from the public commons only — exclude agent-scoped
    // pages (identity / knowledge / social), which surface solely via an explicit
    // `agent:` scope. Mirrors the non-streaming query() path (query.ts).
    if (!scopeSlugs) {
      entries = entries.filter(
        (e) => !isAgentScopedType(e.type) && !isArtifactType(e.type),
      );
    }

    // Empty wiki — nothing to query
    if (entries.length === 0) {
      return NextResponse.json(
        {
          error:
            "The wiki is empty. Please ingest some content first so I have something to answer from.",
        },
        { status: 400 },
      );
    }

    if (!hasLLMKey()) {
      return NextResponse.json(
        {
          error:
            "No API key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or another provider key.",
        },
        { status: 500 },
      );
    }

    // Select relevant pages and build context (same logic as query())
    const selectedSlugs = await selectPagesForQuery(trimmedQuestion, entries, scopeSlugs);
    const { context, slugs: loadedSlugs } =
      await buildContext(selectedSlugs);

    // Build the system prompt (same as non-streaming query)
    const systemPrompt = await buildQuerySystemPrompt(
      context,
      entries,
      selectedSlugs,
      queryFormat,
    );

    // Stream the LLM response, wrapping it in a custom ReadableStream that
    // appends a trailing sentinel so the client can detect truncation.
    const llmResult = callLLMStream(systemPrompt, trimmedQuestion, {
      maxOutputTokens: QUERY_MAX_OUTPUT_TOKENS,
    });

    const encoder = new TextEncoder();

    const sentinelStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of llmResult.textStream) {
            controller.enqueue(encoder.encode(chunk));
          }
          // LLM stream completed successfully — write the done sentinel.
          controller.enqueue(encoder.encode(STREAM_DONE_SENTINEL));
        } catch (err) {
          // Mid-stream LLM failure — write the error sentinel so the client
          // can distinguish a truncated answer from a complete one.
          logger.error("query", "LLM stream error mid-response", err);
          controller.enqueue(encoder.encode(STREAM_ERROR_SENTINEL));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(sentinelStream, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Percent-encode so non-ASCII slugs (e.g. CJK titles) survive the
        // header transport, which is Latin-1 on the wire. The client decodes
        // with decodeURIComponent before JSON.parse.
        "X-Wiki-Sources": encodeURIComponent(JSON.stringify(loadedSlugs)),
      },
    });
  } catch (error) {
    logger.error("query", "Query stream error", error);
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
