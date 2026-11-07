import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock the ingest library — we only test the route's validation and wiring
// ---------------------------------------------------------------------------
vi.mock("@/lib/ingest", () => ({
  ingest: vi.fn(),
  ingestUrl: vi.fn(),
  reingest: vi.fn(),
  // Real-ish derivation: first non-empty line, capped — enough for the route's
  // display-title fallback.
  deriveTitleFromContent: (c: string) =>
    (c.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 120),
}));

// Staging is exercised only for oversized pasted text; default the helper.
vi.mock("@/lib/ingest-staging", () => ({
  stageText: vi.fn(async () => "raw/uploads/job/text.md"),
}));

vi.mock("@/lib/wiki", () => ({
  readWikiPageWithFrontmatter: vi.fn(),
}));

vi.mock("@/lib/fetch", () => ({
  isUrl: (s: string) => s.startsWith("http://") || s.startsWith("https://"),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "test-user", handle: "test-user" })),
  getServicePrincipal: vi.fn(() => null),
}));

// The async batch path enqueues; default to "queued" (true).
vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn(async () => true) }));

vi.mock("@/lib/ingest-jobs", () => ({
  createIngestJob: vi.fn(async () => ({})),
  updateIngestJob: vi.fn(async () => ({})),
}));
vi.mock("@/lib/youtube", () => ({
  isYouTubeUrl: (u: string) => /youtu\.?be|youtube\.com/i.test(u),
}));

vi.mock("@/lib/vault", () => ({
  vaultOwnedBy: vi.fn(() => true),
  addToVault: vi.fn(async () => {}),
}));

import { ingest, ingestUrl, reingest } from "@/lib/ingest";
import { enqueueTask } from "@/lib/tasks";
import { createIngestJob } from "@/lib/ingest-jobs";
import { readWikiPageWithFrontmatter } from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";
import { getServicePrincipal } from "@/lib/auth";
import { vaultOwnedBy } from "@/lib/vault";
import { POST } from "@/app/api/ingest/route";
import { POST as POST_BATCH } from "@/app/api/ingest/batch/route";
import { POST as POST_REINGEST } from "@/app/api/ingest/reingest/route";
import type { IngestResult } from "@/lib/types";
import { ClientInputError } from "@/lib/errors";
import { MAX_CONTENT_LENGTH } from "@/lib/constants";

const mockedIngest = vi.mocked(ingest);
const mockedIngestUrl = vi.mocked(ingestUrl);
const mockedReingest = vi.mocked(reingest);
const mockedReadWikiPage = vi.mocked(readWikiPageWithFrontmatter);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedGetServicePrincipal = vi.mocked(getServicePrincipal);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedCreateJob = vi.mocked(createIngestJob);
const mockedVaultOwnedBy = vi.mocked(vaultOwnedBy);

function makeRequest(url: string, body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockedIngest.mockReset();
  mockedIngestUrl.mockReset();
  mockedReingest.mockReset();
  mockedReadWikiPage.mockReset();
  mockedGetPrincipal.mockResolvedValue({ id: "test-user", handle: "test-user" });
  mockedGetServicePrincipal.mockReturnValue(null);
  // Default to the OFF-WORKERS (queue-absent) path so tests that assert
  // ingestUrl/ingest were called exercise the inline fallback. Tests that assert
  // the queued `{queued,jobId}` response set this to `true` explicitly.
  mockedEnqueue.mockReset();
  mockedEnqueue.mockResolvedValue(false);
  // Default vault ownership to true (owned); tests that assert 403 override.
  mockedVaultOwnedBy.mockReset();
  mockedVaultOwnedBy.mockReturnValue(true);
});

const fakeResult: IngestResult = {
  rawPath: "raw/test.md",
  primarySlug: "test-page",
  relatedUpdated: [],
  wikiPages: ["test-page"],
  indexUpdated: true,
};

// ===========================================================================
// POST /api/ingest — error → HTTP status mapping
// ===========================================================================
describe("POST /api/ingest — text title optional", () => {
  it("queues a text ingest with no title (enqueues content inline, returns jobId)", async () => {
    mockedEnqueue.mockResolvedValue(true);
    const res = await POST(
      makeRequest("http://localhost/api/ingest", { content: "Some pasted content." }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queued).toBe(true);
    expect(typeof data.jobId).toBe("string");
    // Small content rides inline in the queue message (no title supplied).
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ingest", content: "Some pasted content." }),
    );
    // The queue handles it — the route never calls ingest() synchronously.
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it("runs the text ingest inline when the queue is unavailable (off-Workers)", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedIngest.mockResolvedValue(fakeResult);
    const res = await POST(
      makeRequest("http://localhost/api/ingest", { content: "Some pasted content." }),
    );
    expect(res.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalledWith(
      "",
      "Some pasted content.",
      expect.anything(),
    );
    expect((await res.json()).queued).toBe(true);
  });

  it("still requires content", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/ingest", { title: "Only a title" }),
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /api/ingest — text content size cap
// ===========================================================================
describe("POST /api/ingest — text content size cap", () => {
  it("rejects text content exceeding MAX_CONTENT_LENGTH with 400", async () => {
    const oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
    const res = await POST(
      makeRequest("http://localhost/api/ingest", { content: oversized }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/too large/i);
    expect(data.error).toMatch(/100,000/);
    // Must not reach the ingest function
    expect(mockedIngest).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("accepts text content at exactly MAX_CONTENT_LENGTH", async () => {
    mockedEnqueue.mockResolvedValue(true);
    const atLimit = "x".repeat(MAX_CONTENT_LENGTH);
    const res = await POST(
      makeRequest("http://localhost/api/ingest", { content: atLimit }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/ingest — YouTube goes async (queued)", () => {
  it("enqueues a YouTube URL and returns { queued, jobId } without running ingest", async () => {
    mockedEnqueue.mockResolvedValue(true);
    const res = await POST(
      makeRequest("http://localhost/api/ingest", {
        url: "https://youtu.be/dQw4w9WgXcQ",
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queued).toBe(true);
    expect(typeof data.jobId).toBe("string");
    expect(mockedCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://youtu.be/dQw4w9WgXcQ", owner: "test-user" }),
    );
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ingest", url: "https://youtu.be/dQw4w9WgXcQ" }),
    );
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("falls back to a synchronous ingest when the queue is unavailable (off-Workers)", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedIngestUrl.mockResolvedValue(fakeResult);
    const res = await POST(
      makeRequest("http://localhost/api/ingest", {
        url: "https://youtu.be/abc",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockedIngestUrl).toHaveBeenCalled();
    const data = await res.json();
    // Inline fallback resolves the job and reports the slug; the poll-based
    // client flow still completes uniformly.
    expect(data.queued).toBe(true);
    expect(data.slug).toBe("test-page");
  });
});

describe("POST /api/ingest — error status mapping", () => {
  it("maps a ClientInputError (e.g. deleted/private X post) to 400 + the message", async () => {
    // Off-Workers (queue absent): the route runs ingestUrl inline, so its error
    // surfaces with the same status mapping as before.
    mockedEnqueue.mockResolvedValue(false);
    mockedIngestUrl.mockRejectedValue(
      new ClientInputError("That X post couldn't be read — it may be deleted, private, or from a protected account."),
    );
    const res = await POST(
      makeRequest("http://localhost/api/ingest", { url: "https://x.com/u/status/1" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/deleted, private/);
  });

  it("maps an unexpected error to 500", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedIngestUrl.mockRejectedValue(new Error("boom"));
    const res = await POST(
      makeRequest("http://localhost/api/ingest", { url: "https://x.com/u/status/2" }),
    );
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/ingest — tags support
// ===========================================================================
describe("POST /api/ingest — tags", () => {
  describe("validation", () => {
    it("rejects tags that is not an array", async () => {
      const res = await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          url: "https://example.com/page",
          tags: "not-an-array",
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/tags/i);
    });

    it("rejects tags containing non-string items", async () => {
      const res = await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          url: "https://example.com/page",
          tags: ["valid", 123],
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/tags/i);
    });

    it("rejects tags that is a number", async () => {
      const res = await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          url: "https://example.com/page",
          tags: 42,
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/tags/i);
    });

    it("accepts missing tags (undefined)", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      const res = await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          url: "https://example.com/page",
        }),
      );
      expect(res.status).toBe(200);
    });

    it("accepts empty tags array", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      const res = await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          url: "https://example.com/page",
          tags: [],
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("forwarding tags via URL path", () => {
    it("forwards tags to ingestUrl", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      const res = await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          url: "https://example.com/page",
          tags: ["foo", "bar"],
        }),
      );
      expect(res.status).toBe(200);
      expect(mockedIngestUrl).toHaveBeenCalledWith(
        "https://example.com/page",
        expect.objectContaining({ tags: ["foo", "bar"] }),
      );
    });

    it("does not include tags in options when empty array", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          url: "https://example.com/page",
          tags: [],
        }),
      );
      const opts = mockedIngestUrl.mock.calls[0][1];
      expect(opts).not.toHaveProperty("tags");
    });
  });

  describe("forwarding tags via text path", () => {
    it("forwards tags to ingest", async () => {
      mockedIngest.mockResolvedValue(fakeResult);
      const res = await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          title: "Test Page",
          content: "Some content here",
          tags: ["alpha"],
        }),
      );
      expect(res.status).toBe(200);
      expect(mockedIngest).toHaveBeenCalledWith(
        "Test Page",
        "Some content here",
        expect.objectContaining({ tags: ["alpha"] }),
      );
    });

    it("does not include tags in options when not provided", async () => {
      mockedIngest.mockResolvedValue(fakeResult);
      await POST(
        makeRequest("http://localhost:3000/api/ingest", {
          title: "Test Page",
          content: "Some content here",
        }),
      );
      const opts = mockedIngest.mock.calls[0][2];
      expect(opts).not.toHaveProperty("tags");
    });
  });
});

// ===========================================================================
// POST /api/ingest/batch — tags support
// ===========================================================================
describe("POST /api/ingest/batch — tags", () => {
  describe("validation", () => {
    it("rejects tags that is not an array", async () => {
      const res = await POST_BATCH(
        makeRequest("http://localhost:3000/api/ingest/batch", {
          urls: ["https://example.com/a"],
          tags: "not-an-array",
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/tags/i);
    });

    it("rejects tags containing non-string items", async () => {
      const res = await POST_BATCH(
        makeRequest("http://localhost:3000/api/ingest/batch", {
          urls: ["https://example.com/a"],
          tags: ["ok", null],
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/tags/i);
    });

    it("accepts missing tags", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      const res = await POST_BATCH(
        makeRequest("http://localhost:3000/api/ingest/batch", {
          urls: ["https://example.com/a"],
        }),
      );
      // The route streams NDJSON — status 200 means it got past validation
      expect(res.status).toBe(200);
    });
  });

  describe("forwarding tags", () => {
    it("forwards tags to each ingestUrl call", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      const res = await POST_BATCH(
        makeRequest("http://localhost:3000/api/ingest/batch", {
          urls: ["https://example.com/a", "https://example.com/b"],
          tags: ["batch-tag"],
        }),
      );
      expect(res.status).toBe(200);

      // Consume the stream to trigger all ingestUrl calls
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      expect(mockedIngestUrl).toHaveBeenCalledTimes(2);
      expect(mockedIngestUrl).toHaveBeenCalledWith(
        "https://example.com/a",
        expect.objectContaining({ tags: ["batch-tag"] }),
      );
      expect(mockedIngestUrl).toHaveBeenCalledWith(
        "https://example.com/b",
        expect.objectContaining({ tags: ["batch-tag"] }),
      );
    });

    it("does not pass tags when tags is empty", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      const res = await POST_BATCH(
        makeRequest("http://localhost:3000/api/ingest/batch", {
          urls: ["https://example.com/a"],
          tags: [],
        }),
      );

      // Consume the stream
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      expect(mockedIngestUrl.mock.calls[0][1]).not.toHaveProperty("tags");
      expect(mockedIngestUrl.mock.calls[0][1]).toMatchObject({ author: "test-user" });
    });

    it("does not pass tags when tags is undefined", async () => {
      mockedIngestUrl.mockResolvedValue(fakeResult);
      const res = await POST_BATCH(
        makeRequest("http://localhost:3000/api/ingest/batch", {
          urls: ["https://example.com/a"],
        }),
      );

      // Consume the stream
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      expect(mockedIngestUrl.mock.calls[0][1]).not.toHaveProperty("tags");
      expect(mockedIngestUrl.mock.calls[0][1]).toMatchObject({ author: "test-user" });
    });
  });
});

// ===========================================================================
// POST /api/ingest — service token auth
// ===========================================================================
describe("POST /api/ingest — service token auth", () => {
  const fakeResult: IngestResult = {
    rawPath: "raw/test.md",
    primarySlug: "test-page",
    relatedUpdated: [],
    wikiPages: ["test-page"],
    indexUpdated: true,
  };

  it("accepts a valid service token when Clerk session is absent", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    mockedIngestUrl.mockResolvedValue(fakeResult);

    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        url: "https://example.com/page",
      }, "valid-service-token"),
    );
    expect(res.status).toBe(200);
    expect(mockedIngestUrl).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({ author: "yopedia", owner: "yopedia" }),
    );
  });

  it("returns 401 when neither Clerk session nor service token is present", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue(null);

    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        url: "https://example.com/page",
      }),
    );
    expect(res.status).toBe(401);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("returns 401 when service token is invalid (getServicePrincipal returns null)", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue(null);

    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        url: "https://example.com/page",
      }, "wrong-token"),
    );
    expect(res.status).toBe(401);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("prefers Clerk session when both are available", async () => {
    mockedGetPrincipal.mockResolvedValue({ id: "clerk-user", handle: "alice" });
    mockedGetServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    mockedIngestUrl.mockResolvedValue(fakeResult);

    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        url: "https://example.com/page",
      }, "valid-service-token"),
    );
    expect(res.status).toBe(200);
    // Clerk principal wins — author/owner should be "alice", not "yopedia"
    expect(mockedIngestUrl).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({ author: "alice", owner: "alice" }),
    );
  });
});

// ===========================================================================
// POST /api/ingest/batch — service token auth
// ===========================================================================
describe("POST /api/ingest/batch — async (queue) mode", () => {
  beforeEach(() => {
    mockedEnqueue.mockClear();
    mockedIngestUrl.mockClear();
    mockedEnqueue.mockResolvedValue(true);
  });

  it("enqueues one ingest task per URL and returns immediately (no streaming)", async () => {
    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: ["https://example.com/a", "https://example.com/b"],
        tags: ["docs"],
        async: true,
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ mode: "async", queued: 2, total: 2 });
    // Did NOT run the synchronous ingest.
    expect(mockedIngestUrl).not.toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ingest",
        url: "https://example.com/a",
        owner: "test-user",
        author: "test-user",
        tags: ["docs"],
      }),
    );
  });

  it("tolerates a mid-batch enqueue throw — reports queued + failed, not 500", async () => {
    mockedEnqueue
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("queue backpressure"))
      .mockResolvedValueOnce(true);
    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: [
          "https://example.com/a",
          "https://example.com/b",
          "https://example.com/c",
        ],
        async: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queued: 2, total: 3, failed: 1 });
  });

  it("runs URLs inline when the queue is unavailable (off-Workers)", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedIngestUrl.mockResolvedValue(fakeResult);
    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: ["https://example.com/a"],
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mode).toBe("inline");
    expect(data.results).toEqual([
      { index: 0, url: "https://example.com/a", success: true, slug: "test-page" },
    ]);
    expect(mockedIngestUrl).toHaveBeenCalled();
  });

  it("still validates URLs before enqueuing", async () => {
    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: ["not-a-url"],
        async: true,
      }),
    );
    expect(res.status).toBe(400);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest/batch — service token auth", () => {
  it("accepts a valid service token when Clerk session is absent", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    // Off-Workers (queue absent) → inline path runs ingestUrl with attribution.
    mockedEnqueue.mockResolvedValue(false);
    mockedIngestUrl.mockResolvedValue(fakeResult);

    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: ["https://example.com/page"],
      }, "valid-service-token"),
    );
    expect(res.status).toBe(200);

    expect(mockedIngestUrl).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({ author: "yopedia", owner: "yopedia" }),
    );
  });

  it("returns 401 when neither Clerk session nor service token is present", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue(null);

    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: ["https://example.com/page"],
      }),
    );
    expect(res.status).toBe(401);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("returns 401 when service token is invalid", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue(null);

    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: ["https://example.com/page"],
      }, "wrong-token"),
    );
    expect(res.status).toBe(401);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("prefers Clerk session when both are available", async () => {
    mockedGetPrincipal.mockResolvedValue({ id: "clerk-user", handle: "alice" });
    mockedGetServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    mockedEnqueue.mockResolvedValue(false);
    mockedIngestUrl.mockResolvedValue(fakeResult);

    const res = await POST_BATCH(
      makeRequest("http://localhost:3000/api/ingest/batch", {
        urls: ["https://example.com/page"],
      }, "valid-service-token"),
    );
    expect(res.status).toBe(200);

    // Clerk principal wins
    expect(mockedIngestUrl).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({ author: "alice", owner: "alice" }),
    );
  });
});

// ===========================================================================
// POST /api/ingest/reingest — direct re-synthesis (no preview/commit two-step)
// ===========================================================================
describe("POST /api/ingest/reingest — direct re-synthesis", () => {
  const fakeResult: IngestResult = {
    rawPath: "",
    primarySlug: "p",
    relatedUpdated: [],
    wikiPages: ["p"],
    indexUpdated: true,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const publicPage: any = {
    content: "# P",
    frontmatter: { title: "P", source_url: "https://example.com/s", owner: "yuanhao", visibility: "private" },
  };

  beforeEach(() => {
    mockedGetPrincipal.mockResolvedValue({ id: "u", handle: "yuanhao" });
    mockedReadWikiPage.mockResolvedValue(publicPage);
    mockedReingest.mockResolvedValue(fakeResult);
  });

  it("re-synthesizes directly (no preview/generatedContent options)", async () => {
    const res = await POST_REINGEST(
      makeRequest("http://localhost/api/ingest/reingest", { slug: "p" }),
    );
    expect(res.status).toBe(200);
    expect(mockedReingest).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({ author: "yuanhao", triggeredBy: "yuanhao" }),
    );
    // The two-step options are gone: the call carries only attribution.
    const opts = mockedReingest.mock.calls[0][1]!;
    expect(opts).not.toHaveProperty("preview");
    expect(opts).not.toHaveProperty("generatedContent");
  });

  it("requires a non-empty slug", async () => {
    const res = await POST_REINGEST(
      makeRequest("http://localhost/api/ingest/reingest", { slug: "" }),
    );
    expect(res.status).toBe(400);
    expect(mockedReingest).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/ingest/reingest — service token auth
// ===========================================================================
describe("POST /api/ingest/reingest — service token auth", () => {
  const fakeReingestResult: IngestResult = {
    rawPath: "raw/test.md",
    primarySlug: "test-page",
    relatedUpdated: [],
    wikiPages: ["test-page"],
    indexUpdated: true,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePageWithFrontmatter: any = {
    content: "# Test\nHello",
    frontmatter: {
      title: "Test",
      source_url: "https://example.com/source",
      owner: "alice",
      visibility: "private",
    },
  };

  it("accepts a valid service token when Clerk session is absent", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    mockedReadWikiPage.mockResolvedValue(fakePageWithFrontmatter);
    mockedReingest.mockResolvedValue(fakeReingestResult);

    const res = await POST_REINGEST(
      makeRequest("http://localhost:3000/api/ingest/reingest", {
        slug: "test-page",
      }, "valid-service-token"),
    );
    expect(res.status).toBe(200);
    expect(mockedReingest).toHaveBeenCalledWith(
      "test-page",
      expect.objectContaining({ author: "yopedia", triggeredBy: "yopedia" }),
    );
  });

  it("returns 401 when neither Clerk session nor service token is present", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue(null);

    const res = await POST_REINGEST(
      makeRequest("http://localhost:3000/api/ingest/reingest", {
        slug: "test-page",
      }),
    );
    expect(res.status).toBe(401);
    expect(mockedReingest).not.toHaveBeenCalled();
  });

  it("returns 401 when service token is invalid", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue(null);

    const res = await POST_REINGEST(
      makeRequest("http://localhost:3000/api/ingest/reingest", {
        slug: "test-page",
      }, "wrong-token"),
    );
    expect(res.status).toBe(401);
    expect(mockedReingest).not.toHaveBeenCalled();
  });

  it("prefers Clerk session when both are available", async () => {
    mockedGetPrincipal.mockResolvedValue({ id: "clerk-user", handle: "alice" });
    mockedGetServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    mockedReadWikiPage.mockResolvedValue(fakePageWithFrontmatter);
    mockedReingest.mockResolvedValue(fakeReingestResult);

    const res = await POST_REINGEST(
      makeRequest("http://localhost:3000/api/ingest/reingest", {
        slug: "test-page",
      }, "valid-service-token"),
    );
    expect(res.status).toBe(200);
    // Clerk principal wins
    expect(mockedReingest).toHaveBeenCalledWith(
      "test-page",
      expect.objectContaining({ author: "alice", triggeredBy: "alice" }),
    );
  });

  it("cloaks a non-owner re-ingesting a PRIVATE page (404), never calling reingest", async () => {
    mockedGetPrincipal.mockResolvedValue({ id: "clerk-user", handle: "alice" });
    mockedGetServicePrincipal.mockReturnValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bobSecretPage: any = {
      content: "# Secret",
      frontmatter: {
        title: "Secret",
        source_url: "https://example.com/source",
        owner: "bob",
        visibility: "private",
      },
    };
    mockedReadWikiPage.mockResolvedValue(bobSecretPage);

    const res = await POST_REINGEST(
      makeRequest("http://localhost:3000/api/ingest/reingest", {
        slug: "bob-secret",
      }),
    );
    // A private page the caller can't read is "not found" (no existence oracle).
    expect(res.status).toBe(404);
    expect(mockedReingest).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/ingest — vaultId ownership enforcement
// ===========================================================================

describe("POST /api/ingest — vaultId ownership", () => {
  it("returns 403 when vaultId is not owned by the caller (text path)", async () => {
    mockedVaultOwnedBy.mockReturnValue(false);
    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        content: "Some text to ingest",
        vaultId: "foreign-vault",
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/vault not found or not owned/i);
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it("returns 403 when vaultId is not owned by the caller (URL path)", async () => {
    mockedVaultOwnedBy.mockReturnValue(false);
    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        url: "https://example.com/article",
        vaultId: "foreign-vault",
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/vault not found or not owned/i);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("succeeds with a valid owned vaultId", async () => {
    mockedVaultOwnedBy.mockReturnValue(true);
    mockedIngest.mockResolvedValue(fakeResult);
    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        content: "Some text",
        vaultId: "my-vault",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalled();
  });

  it("succeeds without a vaultId", async () => {
    mockedIngest.mockResolvedValue(fakeResult);
    const res = await POST(
      makeRequest("http://localhost:3000/api/ingest", {
        content: "Some text",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalled();
  });
});
