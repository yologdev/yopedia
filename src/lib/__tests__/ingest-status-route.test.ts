import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ingest-jobs", async (importActual) => ({
  // Keep the real (pure) effectiveStatus; only stub the storage-backed read.
  ...(await importActual<typeof import("@/lib/ingest-jobs")>()),
  getIngestJob: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
}));
vi.mock("@/lib/wiki", () => ({
  wikiPageExists: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getIngestJob } from "@/lib/ingest-jobs";
import { getPrincipal } from "@/lib/auth";
import { wikiPageExists } from "@/lib/wiki";
import { GET } from "@/app/api/ingest/status/[jobId]/route";

const mockedGetJob = vi.mocked(getIngestJob);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedPageExists = vi.mocked(wikiPageExists);

const call = (jobId: string) =>
  GET(new Request("http://localhost/api/ingest/status/" + jobId), {
    params: Promise.resolve({ jobId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetPrincipal.mockResolvedValue({ id: "alice", handle: "alice" });
  // Default: a done job's page still exists (override to false to simulate delete).
  mockedPageExists.mockResolvedValue(true);
});

describe("GET /api/ingest/status/[jobId]", () => {
  it("401 when not signed in", async () => {
    mockedGetPrincipal.mockResolvedValueOnce(null);
    expect((await call("j1")).status).toBe(401);
  });

  it("404 when the job is missing", async () => {
    mockedGetJob.mockResolvedValue(null);
    expect((await call("j1")).status).toBe(404);
  });

  it("404 when the job is owned by someone else (no existence leak)", async () => {
    mockedGetJob.mockResolvedValue({
      jobId: "j1",
      url: "u",
      owner: "bob",
      status: "done",
      slug: "s",
      createdAt: "",
      updatedAt: "",
    });
    expect((await call("j1")).status).toBe(404);
  });

  it("returns the status to the owner", async () => {
    mockedGetJob.mockResolvedValue({
      jobId: "j1",
      url: "https://youtu.be/x",
      owner: "alice",
      status: "done",
      slug: "my-page",
      createdAt: "",
      updatedAt: "",
    });
    const res = await call("j1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done", slug: "my-page" });
  });

  const doneJob = (over: Record<string, unknown> = {}) => ({
    jobId: "j1",
    url: "https://youtu.be/x",
    owner: "alice",
    status: "done" as const,
    slug: "the-page",
    createdAt: "",
    updatedAt: "",
    ...over,
  });

  it("404s a done job whose page was deleted (drops a dead link from the strip)", async () => {
    mockedGetJob.mockResolvedValue(doneJob({ slug: "deleted-page" }));
    mockedPageExists.mockResolvedValue(false); // page no longer exists
    expect((await call("j1")).status).toBe(404);
  });

  it("returns the job (200) when the page-existence check errors — a storage blip must not evict a live job", async () => {
    mockedGetJob.mockResolvedValue(doneJob());
    mockedPageExists.mockRejectedValue(new Error("R2 timeout"));
    const res = await call("j1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done", slug: "the-page" });
  });

  it("does not existence-check a done job with no slug (returns 200)", async () => {
    mockedGetJob.mockResolvedValue(doneJob({ slug: undefined }));
    const res = await call("j1");
    expect(res.status).toBe(200);
    expect(mockedPageExists).not.toHaveBeenCalled();
  });

  it("never existence-checks a non-done job (a missing page can't 404 a failed job)", async () => {
    mockedGetJob.mockResolvedValue(doneJob({ status: "failed", error: "boom", slug: "p" }));
    mockedPageExists.mockResolvedValue(false);
    const res = await call("j1");
    expect(res.status).toBe(200);
    expect(mockedPageExists).not.toHaveBeenCalled();
  });

  it("reports a long-stalled processing job as failed (dead worker)", async () => {
    mockedGetJob.mockResolvedValue({
      jobId: "j1",
      url: "https://youtu.be/x",
      owner: "alice",
      status: "processing",
      createdAt: "",
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    const res = await call("j1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/stalled/i);
  });

  it("returns chunksFailed and chunksTotal when present on a done job", async () => {
    mockedGetJob.mockResolvedValue(doneJob({ chunksFailed: 3, chunksTotal: 12 }));
    const res = await call("j1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    expect(body.chunksFailed).toBe(3);
    expect(body.chunksTotal).toBe(12);
  });

  it("omits chunk fields when job has no chunk failures (backward compatible)", async () => {
    mockedGetJob.mockResolvedValue(doneJob());
    const res = await call("j1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    expect(body.chunksFailed).toBeUndefined();
    expect(body.chunksTotal).toBeUndefined();
  });
});
