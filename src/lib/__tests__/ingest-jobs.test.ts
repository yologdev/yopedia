import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  createIngestJob,
  getIngestJob,
  updateIngestJob,
  effectiveStatus,
  purgeStaleIngestJobs,
  INGEST_JOB_STALE_MS,
  INGEST_JOB_GC_TTL_MS,
} from "../ingest-jobs";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalWikiDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-jobs-test-"));
  originalDataDir = process.env.DATA_DIR;
  originalWikiDir = process.env.WIKI_DIR;
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ingest-jobs", () => {
  it("create → get round-trips a queued job", async () => {
    await createIngestJob({ jobId: "abc-123", url: "https://youtu.be/x", owner: "alice" });
    const job = await getIngestJob("abc-123");
    expect(job).toMatchObject({
      jobId: "abc-123",
      url: "https://youtu.be/x",
      owner: "alice",
      status: "queued",
    });
    expect(job!.createdAt).toBeTruthy();
  });

  it("update merges a patch and re-stamps updatedAt", async () => {
    await createIngestJob({ jobId: "j1", url: "u", owner: "alice" });
    const done = await updateIngestJob("j1", { status: "done", slug: "my-page" });
    expect(done).toMatchObject({ status: "done", slug: "my-page", owner: "alice" });
    const reread = await getIngestJob("j1");
    expect(reread!.status).toBe("done");
    expect(reread!.slug).toBe("my-page");
  });

  it("get returns null for a missing job", async () => {
    expect(await getIngestJob("nope")).toBeNull();
  });

  it("update is a no-op (null) for a missing job — never resurrects it", async () => {
    expect(await updateIngestJob("ghost", { status: "failed", error: "x" })).toBeNull();
    expect(await getIngestJob("ghost")).toBeNull();
  });

  it("persists chunksFailed and chunksTotal through update", async () => {
    await createIngestJob({ jobId: "c1", url: "u", owner: "alice" });
    const done = await updateIngestJob("c1", {
      status: "done",
      slug: "my-page",
      chunksFailed: 2,
      chunksTotal: 10,
    });
    expect(done).toMatchObject({
      status: "done",
      slug: "my-page",
      chunksFailed: 2,
      chunksTotal: 10,
    });
    const reread = await getIngestJob("c1");
    expect(reread!.chunksFailed).toBe(2);
    expect(reread!.chunksTotal).toBe(10);
  });

  it("omits chunk fields when not provided (backward compatible)", async () => {
    await createIngestJob({ jobId: "c2", url: "u", owner: "alice" });
    const done = await updateIngestJob("c2", { status: "done", slug: "p" });
    expect(done!.chunksFailed).toBeUndefined();
    expect(done!.chunksTotal).toBeUndefined();
  });

  it("rejects a path-traversing job id", async () => {
    await expect(getIngestJob("../secrets")).rejects.toThrow(/invalid ingest job id/);
  });
});

describe("effectiveStatus (stale detection)", () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("ages a long-stuck processing job to failed", () => {
    const eff = effectiveStatus({ status: "processing", updatedAt: iso(INGEST_JOB_STALE_MS + 1000) });
    expect(eff.status).toBe("failed");
    expect(eff.error).toMatch(/stalled/i);
  });

  it("leaves a recently-updated processing job alone", () => {
    expect(effectiveStatus({ status: "processing", updatedAt: iso(1000) })).toEqual({
      status: "processing",
    });
  });

  it("never overrides a terminal status", () => {
    expect(effectiveStatus({ status: "done", updatedAt: iso(INGEST_JOB_STALE_MS * 10) })).toEqual({
      status: "done",
    });
    expect(effectiveStatus({ status: "failed", updatedAt: iso(INGEST_JOB_STALE_MS * 10) })).toEqual({
      status: "failed",
    });
  });
});

describe("purgeStaleIngestJobs (GC)", () => {
  /** Helper: create a job and manually backdate its updatedAt. */
  async function createBackdatedJob(
    jobId: string,
    status: "queued" | "processing" | "done" | "failed",
    msAgo: number,
  ) {
    const job = await createIngestJob({ jobId, url: "https://example.com", owner: "alice" });
    // Patch the status and backdate updatedAt directly on disk.
    const backdated = {
      ...job,
      status,
      updatedAt: new Date(Date.now() - msAgo).toISOString(),
    };
    const { getStorage } = await import("../storage");
    await getStorage().writeFile(
      `ingest-jobs/${jobId}.json`,
      JSON.stringify(backdated),
    );
    return backdated;
  }

  it("deletes terminal jobs older than the TTL", async () => {
    await createBackdatedJob("old-done", "done", INGEST_JOB_GC_TTL_MS + 1000);
    await createBackdatedJob("old-failed", "failed", INGEST_JOB_GC_TTL_MS + 1000);

    const deleted = await purgeStaleIngestJobs();
    expect(deleted).toBe(2);
    expect(await getIngestJob("old-done")).toBeNull();
    expect(await getIngestJob("old-failed")).toBeNull();
  });

  it("keeps jobs younger than the TTL regardless of status", async () => {
    await createBackdatedJob("young-done", "done", INGEST_JOB_GC_TTL_MS - 60_000);
    await createBackdatedJob("young-failed", "failed", INGEST_JOB_GC_TTL_MS - 60_000);
    await createBackdatedJob("young-queued", "queued", INGEST_JOB_GC_TTL_MS - 60_000);

    const deleted = await purgeStaleIngestJobs();
    expect(deleted).toBe(0);
    expect(await getIngestJob("young-done")).not.toBeNull();
    expect(await getIngestJob("young-failed")).not.toBeNull();
    expect(await getIngestJob("young-queued")).not.toBeNull();
  });

  it("keeps non-terminal jobs even if older than the TTL", async () => {
    await createBackdatedJob("old-queued", "queued", INGEST_JOB_GC_TTL_MS + 1000);
    await createBackdatedJob("old-processing", "processing", INGEST_JOB_GC_TTL_MS + 1000);

    const deleted = await purgeStaleIngestJobs();
    expect(deleted).toBe(0);
    expect(await getIngestJob("old-queued")).not.toBeNull();
    expect(await getIngestJob("old-processing")).not.toBeNull();
  });

  it("handles a mix of keep and delete in the same scan", async () => {
    await createBackdatedJob("old-done", "done", INGEST_JOB_GC_TTL_MS + 1000);
    await createBackdatedJob("young-done", "done", INGEST_JOB_GC_TTL_MS - 60_000);
    await createBackdatedJob("old-processing", "processing", INGEST_JOB_GC_TTL_MS + 1000);

    const deleted = await purgeStaleIngestJobs();
    expect(deleted).toBe(1);
    expect(await getIngestJob("old-done")).toBeNull();
    expect(await getIngestJob("young-done")).not.toBeNull();
    expect(await getIngestJob("old-processing")).not.toBeNull();
  });
});
