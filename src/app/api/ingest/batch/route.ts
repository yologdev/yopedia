import { NextRequest, NextResponse } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { isUrl } from "@/lib/fetch";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { enqueueTask } from "@/lib/tasks";
import { MAX_BATCH_URLS } from "@/lib/constants";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { addToVault, vaultOwnedBy } from "@/lib/vault";

/** A batch URL that couldn't be enqueued (queue absent) and was run inline. */
interface InlineResult {
  index: number;
  url: string;
  success: boolean;
  slug?: string;
  error?: string;
}

export async function POST(request: NextRequest) {
  try {
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Cost guard — batch ingest triggers LLM synthesis per URL (highest cost
    // multiplier of all ingest endpoints).
    const rl = await enforceRateLimit("ingest", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before ingesting again." },
        { status: 429 },
      );
    }

    const body = await request.json();
    const { urls, tags } = body;

    // --- Validate input ------------------------------------------------
    if (!Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json(
        { error: "urls is required and must be a non-empty array of strings" },
        { status: 400 },
      );
    }

    // Validate tags if provided
    if (tags !== undefined) {
      if (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === "string")) {
        return NextResponse.json(
          { error: "tags must be an array of strings if provided" },
          { status: 400 },
        );
      }
    }

    // Validate vaultId: must be a non-empty string owned by the caller.
    let validatedVaultId: string | undefined;
    if (body.vaultId !== undefined) {
      if (typeof body.vaultId !== "string" || body.vaultId.trim().length === 0) {
        return NextResponse.json(
          { error: "vaultId must be a non-empty string if provided" },
          { status: 400 },
        );
      }
      if (!vaultOwnedBy(body.vaultId, principal.handle)) {
        return NextResponse.json(
          { error: "Vault not found or not owned by you" },
          { status: 403 },
        );
      }
      validatedVaultId = body.vaultId;
    }

    if (urls.length > MAX_BATCH_URLS) {
      return NextResponse.json(
        { error: `Too many URLs. Maximum batch size is ${MAX_BATCH_URLS}.` },
        { status: 400 },
      );
    }

    // Validate every URL upfront — reject the whole batch if any are bad
    const malformed: { index: number; url: unknown }[] = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      if (typeof u !== "string" || !isUrl(u.trim())) {
        malformed.push({ index: i, url: u });
      }
    }

    if (malformed.length > 0) {
      return NextResponse.json(
        {
          error: "Some URLs are malformed. Fix them and retry the entire batch.",
          malformed,
        },
        { status: 400 },
      );
    }

    // --- Async by default: enqueue one ingest task per URL, return at once ----
    // The queue (Cloudflare Queues) processes them in the background — decoupled,
    // retryable, rate-limited — so a big batch never holds the request open or
    // hammers the LLM. Off-Workers (local dev / tests) the queue is absent, so
    // each URL runs inline and its result is reported — mirroring the per-source
    // inline fallback the single-ingest routes use.
    const ingestOptions = {
      ...(Array.isArray(tags) && tags.length > 0 ? { tags } : {}),
      author: principal.handle,
      owner: principal.handle,
      triggeredBy: principal.handle,
    };

    let queued = 0;
    let failed = 0;
    const inlineResults: InlineResult[] = [];
    for (let i = 0; i < urls.length; i++) {
      const url = (urls[i] as string).trim();
      // Per-URL try/catch: a single send() rejection (backpressure, etc.) must
      // not abort the batch after partial enqueue — count it and report honest
      // totals rather than 500-ing with work already queued.
      let ok: boolean;
      try {
        ok = await enqueueTask({
          kind: "ingest",
          url,
          owner: principal.handle,
          author: principal.handle,
          ...(Array.isArray(tags) && tags.length > 0 ? { tags } : {}),
          ...(validatedVaultId ? { vaultId: validatedVaultId } : {}),
        });
      } catch (err) {
        logger.warn("ingest", `batch enqueue failed for ${url}`, err);
        failed++;
        continue;
      }
      if (ok) {
        queued++;
        continue;
      }
      // Queue unavailable (off-Workers) — run this URL inline.
      try {
        const result = await ingestUrl(url, ingestOptions);
        if (validatedVaultId) {
          try { await addToVault(validatedVaultId, result.primarySlug); }
          catch (err) { logger.warn("ingest", `vault filing failed for ${url}: ${(err as Error).message}`); }
        }
        inlineResults.push({ index: i, url, success: true, slug: result.primarySlug });
      } catch (err) {
        inlineResults.push({
          index: i,
          url,
          success: false,
          error: getErrorMessage(err, "Unknown error"),
        });
      }
    }

    if (inlineResults.length > 0) {
      // Off-Workers path: report each URL's inline outcome.
      return NextResponse.json({
        mode: "inline",
        total: urls.length,
        results: inlineResults,
      });
    }
    if (queued === 0) {
      return NextResponse.json(
        { error: "Task queue unavailable and no URLs could be ingested." },
        { status: 503 },
      );
    }
    return NextResponse.json({
      mode: "async",
      queued,
      total: urls.length,
      ...(failed > 0 ? { failed } : {}),
    });
  } catch (error) {
    logger.error("ingest", "Batch ingest error", error);
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
