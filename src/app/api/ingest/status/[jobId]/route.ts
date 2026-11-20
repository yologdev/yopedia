import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getIngestJob, effectiveStatus } from "@/lib/ingest-jobs";
import { wikiPageExists } from "@/lib/wiki";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * GET /api/ingest/status/<jobId> — poll an async ingest job's outcome.
 *
 * Owner-gated: a missing job AND a job owned by someone else both return 404, so
 * a job's existence is never leaked to a non-owner.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    let job;
    try {
      job = await getIngestJob(jobId);
    } catch (e) {
      // A malformed jobId (relPathFor throws) → 404; a real storage error must
      // NOT be masked as 404 — rethrow it to the 500 handler below.
      if (/invalid ingest job id/i.test(getErrorMessage(e))) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw e;
    }
    if (!job || job.owner !== principal.handle) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // A stalled (dead-worker) job reads as failed so the UI stops waiting on it.
    const eff = effectiveStatus(job);

    // The job record outlives its page: if a completed page was later deleted,
    // the "Recent ingests" strip would show a dead link. Report the job as gone
    // (404) so the client drops it quietly instead of linking to nothing. Only a
    // GENUINE miss should drop it — a transient storage error must not, or a blip
    // would silently evict a live job, so on a read error we fall through and
    // return the job as-is.
    if (eff.status === "done" && job.slug) {
      let gone = false;
      try {
        gone = !(await wikiPageExists(job.slug));
      } catch (e) {
        logger.warn("ingest", `status: page existence check failed for ${job.slug}`, e);
      }
      if (gone) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    }

    return NextResponse.json({
      status: eff.status,
      slug: job.slug,
      error: eff.error ?? job.error,
      url: job.url,
      title: job.title,
      ...(job.chunksFailed ? { chunksFailed: job.chunksFailed, chunksTotal: job.chunksTotal } : {}),
    });
  } catch (err) {
    logger.error("ingest", "ingest status error", err);
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}
