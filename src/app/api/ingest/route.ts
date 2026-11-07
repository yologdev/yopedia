import { NextRequest, NextResponse } from "next/server";
import { ingest, ingestUrl, deriveTitleFromContent } from "@/lib/ingest";
import type { IngestOptions } from "@/lib/ingest";
import { isUrl } from "@/lib/fetch";
import { type Task } from "@/lib/tasks";
import { createIngestJob } from "@/lib/ingest-jobs";
import { enqueueOrInline } from "@/lib/ingest-async";
import { stageText } from "@/lib/ingest-staging";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { MAX_CONTENT_LENGTH } from "@/lib/constants";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { addToVault, vaultOwnedBy } from "@/lib/vault";

/** Pasted text larger than this is staged to R2 rather than carried inline in
 *  the queue message (Cloudflare Queues cap a message at 128 KB). 96000 chars
 *  leaves headroom under the cap for the task envelope and multibyte (UTF-8)
 *  characters — this repo is CJK-heavy, so don't raise it toward 128k blindly. */
const MAX_INLINE_CONTENT_CHARS = 96000;

export async function POST(request: NextRequest) {
  try {
    // Writes require an authenticated user (also enforced in middleware for
    // Clerk sessions). Service tokens (scheduled agent jobs) are accepted as a
    // fallback — the acting identity comes from the session or token, never
    // from the request body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Cost guard — each ingest triggers LLM synthesis + embedding.
    const rl = await enforceRateLimit("ingest", principal.id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before ingesting again." },
        { status: 429 },
      );
    }

    const body = await request.json();

    const { url, title, content, triggeredBy, tags, sourceUrl, sourceType } = body;

    // Validate triggeredBy if provided
    if (triggeredBy !== undefined && typeof triggeredBy !== "string") {
      return NextResponse.json(
        { error: "triggeredBy must be a string if provided" },
        { status: 400 },
      );
    }

    // Validate sourceType if provided.
    const VALID_SOURCE_TYPES = ["url", "text", "x-mention", "image", "pdf", "youtube"];
    if (sourceType !== undefined && !VALID_SOURCE_TYPES.includes(sourceType)) {
      return NextResponse.json(
        { error: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    // Validate sourceUrl if provided (text path provenance — the URL path
    // records its own source automatically)
    if (sourceUrl !== undefined && (typeof sourceUrl !== "string" || !isUrl(sourceUrl.trim()))) {
      return NextResponse.json(
        { error: "sourceUrl must be a valid URL if provided" },
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

    // Build ingest options from the request body (used only on the inline
    // off-Workers fallback; the queue carries its own minimal fields).
    const options: IngestOptions = {};
    if (typeof triggeredBy === "string" && triggeredBy.length > 0) {
      options.triggeredBy = triggeredBy;
    }
    if (Array.isArray(tags) && tags.length > 0) {
      options.tags = tags;
    }
    if (typeof sourceUrl === "string" && sourceUrl.trim().length > 0) {
      options.sourceUrl = sourceUrl.trim();
    }
    if (typeof sourceType === "string" && sourceType.length > 0) {
      options.sourceType = sourceType as IngestOptions["sourceType"];
    }
    // Attribution from the authenticated session (authoritative; overrides any
    // client-supplied triggeredBy to prevent spoofing).
    options.author = principal.handle;
    options.owner = principal.handle;
    options.triggeredBy = principal.handle;

    const tagsForTask =
      options.tags && options.tags.length > 0 ? { tags: options.tags } : {};
    const vaultForTask = validatedVaultId ? { vaultId: validatedVaultId } : {};

    // ----- URL path (takes precedence) -----
    if (url && typeof url === "string" && isUrl(url.trim())) {
      const trimmedUrl = url.trim();
      const jobId = crypto.randomUUID();
      await createIngestJob({ jobId, url: trimmedUrl, owner: principal.handle });
      return await enqueueOrInline(
        jobId,
        {
          kind: "ingest",
          url: trimmedUrl,
          owner: options.owner,
          author: options.author,
          ...tagsForTask,
          ...vaultForTask,
          jobId,
        },
        async () => {
          const result = await ingestUrl(trimmedUrl, options);
          if (validatedVaultId) {
            try { await addToVault(validatedVaultId, result.primarySlug); }
            catch (err) { logger.warn("ingest", `vault filing failed: ${(err as Error).message}`); }
          }
          return result;
        },
      );
    }

    // ----- Text path: content required; title optional -----
    if (
      !content ||
      typeof content !== "string" ||
      content.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "content is required and must be a non-empty string (or provide a url)" },
        { status: 400 },
      );
    }
    if (title !== undefined && typeof title !== "string") {
      return NextResponse.json(
        { error: "title must be a string if provided" },
        { status: 400 },
      );
    }

    const trimmedContent = content.trim();
    // Enforce the same content-size cap the URL and PDF paths use.
    if (trimmedContent.length > MAX_CONTENT_LENGTH) {
      return NextResponse.json(
        {
          error: `Text content too large: ${trimmedContent.length.toLocaleString()} chars exceeds the ${MAX_CONTENT_LENGTH.toLocaleString()} char limit. Please shorten the input.`,
        },
        { status: 400 },
      );
    }
    const trimmedTitle = typeof title === "string" ? title.trim() : "";
    // Display title for the recent-ingests list (best-effort): given title, else
    // a title derived from the content.
    const displayTitle = trimmedTitle || deriveTitleFromContent(trimmedContent) || "Untitled";

    const jobId = crypto.randomUUID();
    await createIngestJob({ jobId, owner: principal.handle, title: displayTitle });

    // Small enough to ride inline in the queue message; otherwise stage to R2.
    let task: Task;
    if (trimmedContent.length <= MAX_INLINE_CONTENT_CHARS) {
      task = {
        kind: "ingest",
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        content: trimmedContent,
        owner: options.owner,
        author: options.author,
        ...tagsForTask,
        ...vaultForTask,
        jobId,
      };
    } else {
      const key = await stageText(jobId, trimmedContent);
      task = {
        kind: "ingest",
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        owner: options.owner,
        author: options.author,
        ...tagsForTask,
        ...vaultForTask,
        jobId,
        staged: { key, kind: "text" },
      };
    }

    return await enqueueOrInline(jobId, task, async () => {
      const result = await ingest(trimmedTitle, trimmedContent, options);
      if (validatedVaultId) {
        try { await addToVault(validatedVaultId, result.primarySlug); }
        catch (err) { logger.warn("ingest", `vault filing failed: ${(err as Error).message}`); }
      }
      return result;
    });
  } catch (error) {
    const msg = getErrorMessage(error);
    // Bad-input failures (e.g. a deleted/private X post, an unsafe URL) are
    // tagged ClientInputError → 400 + warn. Anything else is a real server
    // failure → 500 + error log, so genuine bugs aren't buried as 500 noise.
    if (error instanceof ClientInputError) {
      logger.warn("ingest", `Ingest rejected: ${msg}`);
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    logger.error("ingest", "Ingest error", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
