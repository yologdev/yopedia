import { NextResponse } from "next/server";
import { getServicePrincipal } from "@/lib/auth";
import { parseTask } from "@/lib/tasks";
import { reconcileFromTalk } from "@/lib/reconcile";
import { ingest, ingestUrl, ingestPdf, ingestImage, reingest } from "@/lib/ingest";
import { fixLintIssue } from "@/lib/lint-fix";
import { updateIngestJob } from "@/lib/ingest-jobs";
import { readStagedBytes, readStagedText, deleteStaged } from "@/lib/ingest-staging";
import { agentIdFor, addAgentLearningPage, DEFAULT_AGENT_NAME } from "@/lib/agents";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { addToVault } from "@/lib/vault";

/**
 * POST /api/tasks/run — execute one agent task.
 *
 * The SOLE caller is the task-consumer worker (`workers/task-consumer/`), which
 * drains the Cloudflare Queue and POSTs each message here with the service
 * token. Gated to {@link getServicePrincipal} only — never a human/Clerk session.
 *
 * Status contract (drives the consumer's ack/retry, which maps to CF Queues):
 *   - 2xx → done, ack the message.
 *   - 4xx → permanently-bad/poison task → ack + drop (don't retry; → DLQ on the
 *           consumer side if it chooses). Malformed body, or a missing page/thread.
 *   - 5xx → transient failure → the consumer retries (CF redelivers; DLQ after
 *           max_retries).
 *
 * Handlers are idempotent/retry-safe: reconcile re-reconciles harmlessly, ingest
 * dedups.
 */
export async function POST(req: Request) {
  // Service-token only.
  const principal = getServicePrincipal(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const task = parseTask(body);
  if (!task) {
    // Poison message — don't retry.
    return NextResponse.json({ error: "malformed task" }, { status: 400 });
  }

  try {
    if (task.kind === "reconcile") {
      // Attribute the edit to the requester's yoyo (the human who asked), else a
      // generic yoyo for autonomous/unknown triggers.
      const author = task.requestedBy
        ? agentIdFor(task.requestedBy, DEFAULT_AGENT_NAME)
        : undefined;
      const result = await reconcileFromTalk(task.slug, task.threadIndex, {
        author,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (task.kind === "maintain") {
      // Autonomous maintenance (Q2). Attributed to a generic yoyo (no requester).
      if (task.op === "reconcile") {
        if (typeof task.threadIndex !== "number") {
          return NextResponse.json(
            { error: "maintain:reconcile requires threadIndex" },
            { status: 400 },
          );
        }
        const result = await reconcileFromTalk(task.slug, task.threadIndex);
        return NextResponse.json({ ok: true, ...result });
      }
      if (task.op === "fix") {
        // Deterministic, no-LLM lint auto-fix (backfill defaults, drop dead refs).
        if (!task.lintType) {
          return NextResponse.json(
            { error: "maintain:fix requires lintType" },
            { status: 400 },
          );
        }
        const result = await fixLintIssue(task.lintType, task.slug, task.targetSlug);
        return NextResponse.json({ ok: true, ...result });
      }
      // op === "staleness": refresh an expired page from its source.
      const result = await reingest(task.slug, {
        author: DEFAULT_AGENT_NAME,
        triggeredBy: DEFAULT_AGENT_NAME,
      });
      return NextResponse.json({ ok: true, slug: result.primarySlug });
    }

    // kind === "ingest"
    // triggeredBy defaults to author (the common case); agent ingests pass it
    // explicitly so author=agent while triggeredBy=human owner.
    const triggeredBy = task.triggeredBy ?? task.author;
    const opts = {
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.author ? { author: task.author } : {}),
      ...(triggeredBy ? { triggeredBy } : {}),
      // Agent ingests carry a scoped page type + (text) provenance url/type.
      ...(task.pageType ? { pageType: task.pageType } : {}),
      ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
      ...(task.sourceType ? { sourceType: task.sourceType } : {}),
      ...(task.tags && task.tags.length > 0 ? { tags: task.tags } : {}),
      // A user-supplied title must survive the queue hop — ingestPdf/ingestImage
      // use it to override the derived title (and, for images, the slug). The
      // text path passes title positionally below; for it `opts.title` is unused.
      ...(task.title && task.title.trim() ? { title: task.title.trim() } : {}),
    };
    // For a tracked async job, record progress so the UI can poll the outcome.
    if (task.jobId) await updateIngestJob(task.jobId, { status: "processing" });

    // Route to the right ingest path:
    //  - staged: uploaded bytes/text in R2 (delete the blob after, best-effort);
    //  - source pdf/image with a url: the URL PDF/image path (not generic);
    //  - url: generic URL; content: pasted text.
    let result;
    if (task.staged) {
      const { key, kind, filename, contentType } = task.staged;
      try {
        if (kind === "pdf") {
          const bytes = await readStagedBytes(key);
          result = await ingestPdf(
            { bytes, filename: filename || "document.pdf" },
            opts,
          );
        } else if (kind === "image") {
          const bytes = await readStagedBytes(key);
          result = await ingestImage(
            { bytes, filename: filename || "image", contentType },
            opts,
          );
        } else {
          // kind === "text"
          const text = await readStagedText(key);
          result = await ingest(task.title?.trim() || "Untitled", text, opts);
        }
      } finally {
        // R2 has no TTL — drop the staged blob whether the ingest succeeded or
        // threw. Best-effort: deleteStaged never throws.
        await deleteStaged(key);
      }
    } else if (task.source === "pdf" && task.url) {
      result = await ingestPdf({ pdfUrl: task.url }, opts);
    } else if (task.source === "image" && task.url) {
      result = await ingestImage({ imageUrl: task.url }, opts);
    } else if (task.url) {
      result = await ingestUrl(task.url, opts);
    } else {
      result = await ingest(task.title?.trim() || "Untitled", task.content ?? "", opts);
    }

    if (task.jobId) {
      await updateIngestJob(task.jobId, {
        status: "done",
        slug: result.primarySlug,
        ...(result.chunksFailed ? { chunksFailed: result.chunksFailed, chunksTotal: result.chunksTotal } : {}),
      });
    }

    // Agent-scoped ingest: attach the page to the agent's learnings. Fail-soft —
    // the job is already `done` and the page exists; we won't fail the ingest over
    // this. But a THROW here means the page is orphaned from the agent (it won't
    // surface under the profile / `agent:` scope), so log it at error (matching
    // addAgentLearningPage's own severity for the missing-agent case).
    if (task.learningFor) {
      try {
        await addAgentLearningPage(task.learningFor, result.primarySlug);
      } catch (err) {
        logger.error(
          "tasks",
          `learning-page attach failed for agent="${task.learningFor}" slug="${result.primarySlug}": ${getErrorMessage(err)}`,
        );
      }
    }

    // Auto-file into vault if requested (fail-soft: never fail the ingest).
    if (task.vaultId) {
      try {
        await addToVault(task.vaultId, result.primarySlug);
      } catch (err) {
        logger.warn("tasks", `vault filing failed for vault="${task.vaultId}" slug="${result.primarySlug}": ${(err as Error).message}`);
      }
    }

    return NextResponse.json({ ok: true, slug: result.primarySlug });
  } catch (err) {
    const message = getErrorMessage(err);
    // Record the failure on a tracked async job so the user sees the reason
    // (a later retry that succeeds will overwrite this back to "done"). Guarded:
    // a storage error here must not mask the original failure or skip the
    // status mapping below.
    if (task.kind === "ingest" && task.jobId) {
      try {
        await updateIngestJob(task.jobId, { status: "failed", error: message });
      } catch (writeErr) {
        logger.error(
          "tasks",
          `failed to record ingest job ${task.jobId} failure`,
          writeErr,
        );
      }
    }
    // A missing page/thread is permanent → poison (4xx), don't retry forever.
    if (/not found/i.test(message)) {
      logger.warn("tasks", `task "${task.kind}" permanently failed: ${message}`);
      return NextResponse.json({ error: message }, { status: 422 });
    }
    // Otherwise transient (LLM hiccup, lock contention) → retry.
    logger.error("tasks", `task "${task.kind}" failed`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
