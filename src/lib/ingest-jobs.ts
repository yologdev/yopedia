/**
 * Status records for ASYNC ingest jobs (currently YouTube — see the queue path
 * in `/api/ingest`). A slow ingest is enqueued to the task queue instead of run
 * synchronously; this lets the UI poll the outcome ("done → here's your page" /
 * "failed → reason") rather than hanging the request. One JSON file per job under
 * `ingest-jobs/<jobId>.json`, owner-stamped so a status read can be gated.
 */

import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { logger } from "./logger";

/** Default TTL for terminal ingest jobs before GC deletes the file (7 days). */
export const INGEST_JOB_GC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type IngestJobStatus = "queued" | "processing" | "done" | "failed";

/**
 * A job that's been `queued`/`processing` longer than this is treated as
 * `failed` ON READ — the consumer worker likely died mid-run (a long video can
 * hit the CPU limit) and would never write a terminal status, leaving the UI
 * polling "working…" forever. Generous: well past any real ingest time (a long
 * transcript's map/reduce synthesis runs in a few parallel batches, not tens of
 * minutes), and the queue refreshes `updatedAt` on each retry, so a job actively
 * being retried is never falsely flagged.
 */
export const INGEST_JOB_STALE_MS = 20 * 60 * 1000;

/**
 * The status a reader should act on: a non-terminal job that hasn't advanced in
 * {@link INGEST_JOB_STALE_MS} is reported as `failed` (it stalled), so the UI
 * shows a reason and stops polling instead of waiting on a dead job forever.
 */
export function effectiveStatus(
  job: Pick<IngestJob, "status" | "updatedAt">,
): { status: IngestJobStatus; error?: string } {
  if (job.status === "queued" || job.status === "processing") {
    const age = Date.now() - Date.parse(job.updatedAt);
    if (Number.isFinite(age) && age > INGEST_JOB_STALE_MS) {
      return { status: "failed", error: "This ingest stalled — please try again." };
    }
  }
  return { status: job.status };
}

export interface IngestJob {
  jobId: string;
  /** The source URL being ingested. Absent for non-URL sources (pasted text,
   *  uploaded PDF/image) — those show only the `title`. */
  url?: string;
  /** Handle of the user who triggered it — only they may read the status. */
  owner: string;
  status: IngestJobStatus;
  /** Resulting page slug, once `done`. */
  slug?: string;
  /** Failure reason, once `failed`. */
  error?: string;
  /** Display title for the recent-ingests list (best-effort). */
  title?: string;
  /** Number of MAP chunks that failed during MAP/REDUCE synthesis. */
  chunksFailed?: number;
  /** Total number of MAP chunks attempted during MAP/REDUCE synthesis. */
  chunksTotal?: number;
  createdAt: string;
  updatedAt: string;
}

/** jobIds are UUIDs; reject anything else so a crafted id can't escape the prefix. */
function relPathFor(jobId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) {
    throw new Error(`invalid ingest job id: ${jobId}`);
  }
  return `ingest-jobs/${jobId}.json`;
}

/** Create a job in the `queued` state. */
export async function createIngestJob(input: {
  jobId: string;
  /** Optional — non-URL sources (pasted text, uploaded PDF/image) have none. */
  url?: string;
  owner: string;
  title?: string;
}): Promise<IngestJob> {
  const now = new Date().toISOString();
  const job: IngestJob = {
    jobId: input.jobId,
    ...(input.url ? { url: input.url } : {}),
    owner: input.owner,
    title: input.title,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await getStorage().writeFile(relPathFor(input.jobId), JSON.stringify(job));
  return job;
}

/** Read a job, or `null` if it doesn't exist. */
export async function getIngestJob(jobId: string): Promise<IngestJob | null> {
  try {
    const raw = await getStorage().readFile(relPathFor(jobId));
    return JSON.parse(raw) as IngestJob;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Merge a patch into an existing job and re-stamp `updatedAt`. No-op (returns
 * `null`) if the job is gone — a status update must never resurrect or partially
 * write a record.
 */
export async function updateIngestJob(
  jobId: string,
  patch: Partial<Pick<IngestJob, "status" | "slug" | "error" | "title" | "chunksFailed" | "chunksTotal">>,
): Promise<IngestJob | null> {
  const existing = await getIngestJob(jobId);
  if (!existing) {
    logger.warn("ingest-jobs", `updateIngestJob: job ${jobId} not found`);
    return null;
  }
  const updated: IngestJob = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await getStorage().writeFile(relPathFor(jobId), JSON.stringify(updated));
  return updated;
}

// ---------------------------------------------------------------------------
// Garbage collection — purge terminal jobs older than a TTL
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: Set<IngestJobStatus> = new Set(["done", "failed"]);
const JOBS_PREFIX = "ingest-jobs";

/**
 * List all job files and delete terminal (`done` / `failed`) jobs whose
 * `updatedAt` is older than `ttlMs`. Non-terminal jobs are never deleted —
 * they may still be processing or retrying, even if they look old.
 *
 * Returns the number of files deleted.
 */
export async function purgeStaleIngestJobs(
  ttlMs: number = INGEST_JOB_GC_TTL_MS,
): Promise<number> {
  const storage = getStorage();
  const entries = await storage.listFiles(JOBS_PREFIX);
  const cutoff = Date.now() - ttlMs;
  let deleted = 0;

  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const relPath = `${JOBS_PREFIX}/${entry.name}`;
    try {
      const raw = await storage.readFile(relPath);
      const job: IngestJob = JSON.parse(raw);
      if (!TERMINAL_STATUSES.has(job.status)) continue;
      const updatedMs = Date.parse(job.updatedAt);
      if (!Number.isFinite(updatedMs) || updatedMs > cutoff) continue;
      await storage.deleteFile(relPath);
      deleted++;
    } catch (err) {
      // Best-effort: skip files that vanish mid-scan or are unparseable.
      if (!isEnoent(err)) {
        logger.warn("ingest-jobs", `GC: failed to process ${entry.name}:`, err);
      }
    }
  }

  if (deleted > 0) {
    logger.info("ingest-jobs", `GC: purged ${deleted} stale job(s)`);
  }
  return deleted;
}
