/**
 * Shared async-ingest dispatch for the ingest routes. Each interactive/API
 * ingest creates a job and returns `{ queued, jobId }` for the client to poll
 * (`/api/ingest/status/[jobId]`); the work is enqueued on Workers, or run inline
 * off-Workers (local dev / tests, where the queue is absent). This helper
 * centralizes that enqueue-or-inline so the URL/text/PDF/image routes don't each
 * carry a copy (which would drift).
 */
import { NextResponse } from "next/server";
import { enqueueTask, type Task } from "./tasks";
import { updateIngestJob } from "./ingest-jobs";
import { getErrorMessage } from "./errors";
import { logger } from "./logger";

/** Mark a job failed (best-effort; a status-write blip must not mask the real
 *  error we're about to rethrow — but log it rather than swallowing silently). */
async function markFailed(jobId: string, err: unknown): Promise<void> {
  await updateIngestJob(jobId, {
    status: "failed",
    error: getErrorMessage(err),
  }).catch((writeErr) =>
    logger.warn("ingest", `failed to mark job ${jobId} failed`, writeErr),
  );
}

/**
 * Enqueue `task` and return `{ queued: true, jobId }`. When the queue is absent
 * (off-Workers — local dev / tests), run `inline()` synchronously and mark the
 * job `done` so the same poll-based client flow still resolves. If EITHER the
 * enqueue OR the inline run throws after the job exists, mark it `failed` (so it
 * can't show "working…" until the 20-min stale fallback) and rethrow as a 500.
 */
export async function enqueueOrInline(
  jobId: string,
  task: Task,
  inline: () => Promise<{ primarySlug: string; chunksFailed?: number; chunksTotal?: number }>,
): Promise<NextResponse> {
  let enqueued: boolean;
  try {
    enqueued = await enqueueTask(task);
  } catch (e) {
    await markFailed(jobId, e);
    throw e;
  }
  if (enqueued) {
    return NextResponse.json({ queued: true, jobId });
  }
  // Off-Workers inline path: mark failed on throw too (symmetric with the
  // enqueue branch) so the failure is immediate, not 20 minutes later.
  let result: { primarySlug: string; chunksFailed?: number; chunksTotal?: number };
  try {
    result = await inline();
  } catch (e) {
    await markFailed(jobId, e);
    throw e;
  }
  await updateIngestJob(jobId, {
    status: "done",
    slug: result.primarySlug,
    ...(result.chunksFailed ? { chunksFailed: result.chunksFailed, chunksTotal: result.chunksTotal } : {}),
  });
  return NextResponse.json({ queued: true, jobId, slug: result.primarySlug });
}
