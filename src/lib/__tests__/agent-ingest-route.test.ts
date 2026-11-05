import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/agents", () => ({
  verifyAgentToken: vi.fn(),
  addAgentLearningPage: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getServicePrincipal: vi.fn(() => null),
}));

vi.mock("@/lib/ingest", () => ({
  ingestUrl: vi.fn(),
  ingest: vi.fn(),
}));

vi.mock("@/lib/vault", () => ({
  addToVault: vi.fn(),
  vaultOwnedBy: vi.fn(() => false),
}));

// Keep parseTask etc. real; only stub the queue producer. Default false ⇒
// off-Workers, so enqueueOrInline runs the inline path (the existing tests
// exercise that). Override to true to test the QUEUED (prod) path.
vi.mock("@/lib/tasks", async (orig) => ({
  ...(await orig<typeof import("@/lib/tasks")>()),
  enqueueTask: vi.fn(async () => false),
}));

import { verifyAgentToken, addAgentLearningPage, getAgent } from "@/lib/agents";
import { getServicePrincipal } from "@/lib/auth";
import { ingestUrl, ingest } from "@/lib/ingest";
import { addToVault, vaultOwnedBy } from "@/lib/vault";
import { enqueueTask } from "@/lib/tasks";
import { POST } from "@/app/api/agents/[id]/ingest/route";

const mockedEnqueue = vi.mocked(enqueueTask);
const mockedVerify = vi.mocked(verifyAgentToken);
const mockedAddLearning = vi.mocked(addAgentLearningPage);
const mockedGetAgent = vi.mocked(getAgent);
const mockedServicePrincipal = vi.mocked(getServicePrincipal);
const mockedIngestUrl = vi.mocked(ingestUrl);
const mockedIngest = vi.mocked(ingest);
const mockedAddToVault = vi.mocked(addToVault);
const mockedVaultOwnedBy = vi.mocked(vaultOwnedBy);

const params = Promise.resolve({ id: "alice--yoyo" });

function req(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/agents/alice--yoyo/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedEnqueue.mockResolvedValue(false); // default: inline path
  mockedVerify.mockResolvedValue("alice--yoyo");
  mockedServicePrincipal.mockReturnValue(null);
  mockedAddLearning.mockResolvedValue();
  mockedIngestUrl.mockResolvedValue({
    primarySlug: "ingested-page",
    relatedUpdated: [],
    wikiPages: ["ingested-page"],
    indexUpdated: true,
    rawPath: "raw/x",
  });
  mockedIngest.mockResolvedValue({
    primarySlug: "text-page",
    relatedUpdated: [],
    wikiPages: ["text-page"],
    indexUpdated: true,
    rawPath: "raw/y",
  });
});

describe("POST /api/agents/[id]/ingest", () => {
  it("ingests a URL as the agent (scoped) and attaches it to learnings", async () => {
    const res = await POST(req({ url: "https://example.com" }, "alice--yoyo.s"), {
      params,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe("ingested-page");
    expect(mockedIngestUrl).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        author: "alice--yoyo",
        owner: "alice--yoyo",
        pageType: "agent-knowledge",
      }),
    );
    expect(mockedAddLearning).toHaveBeenCalledWith("alice--yoyo", "ingested-page");
  });

  it("returns the async response contract { queued, jobId }", async () => {
    const res = await POST(req({ url: "https://example.com" }, "alice--yoyo.s"), {
      params,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(typeof body.jobId).toBe("string");
  });

  it("on Workers (queue available) enqueues the agent Task and does NOT run inline", async () => {
    // This is the PROD path — assert the producer/consumer field seam directly,
    // not just the off-Workers inline fallback the other tests exercise.
    mockedEnqueue.mockResolvedValue(true);
    const res = await POST(req({ url: "https://example.com" }, "alice--yoyo.s"), {
      params,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).queued).toBe(true);
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ingest",
        url: "https://example.com",
        owner: "alice--yoyo",
        author: "alice--yoyo",
        triggeredBy: "alice--yoyo",
        pageType: "agent-knowledge",
        learningFor: "alice--yoyo",
        jobId: expect.any(String),
      }),
    );
    // Enqueued ⇒ the inline ingest must NOT have run.
    expect(mockedIngestUrl).not.toHaveBeenCalled();
    expect(mockedAddLearning).not.toHaveBeenCalled();
  });

  it("ingests text", async () => {
    const res = await POST(
      req({ text: "hello", title: "Note" }, "alice--yoyo.s"),
      { params },
    );
    expect(res.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalledWith(
      "Note",
      "hello",
      expect.objectContaining({ pageType: "agent-knowledge" }),
    );
  });

  it("401 without a bearer token", async () => {
    const res = await POST(req({ url: "https://example.com" }), { params });
    expect(res.status).toBe(401);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("401 for an invalid token", async () => {
    mockedVerify.mockResolvedValue(null);
    const res = await POST(req({ url: "https://example.com" }, "bad"), { params });
    expect(res.status).toBe(401);
  });

  it("403 when the token authenticates a different agent", async () => {
    mockedVerify.mockResolvedValue("bob--yoyo");
    const res = await POST(req({ url: "https://example.com" }, "bob--yoyo.s"), {
      params,
    });
    expect(res.status).toBe(403);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("a per-agent mismatch is denied even if a system principal is also present", async () => {
    // Precedence guard: the per-agent check must short-circuit BEFORE the
    // system-token branch — a wrong agent token can't escalate via the system path.
    mockedVerify.mockResolvedValue("bob--yoyo");
    mockedServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    const res = await POST(req({ url: "https://example.com" }, "bob--yoyo.s"), {
      params,
    });
    expect(res.status).toBe(403);
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("400 when neither url nor text is provided", async () => {
    const res = await POST(req({}, "alice--yoyo.s"), { params });
    expect(res.status).toBe(400);
  });

  describe("system token (the @yoyoevolve loop)", () => {
    it("ingests into a registered (existing) agent", async () => {
      mockedVerify.mockResolvedValue(null); // not an agent token
      mockedServicePrincipal.mockReturnValue({
        id: "service:yopedia",
        handle: "yopedia",
      });
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo" } as never);

      const res = await POST(req({ url: "https://example.com" }, "sys-token"), {
        params,
      });
      expect(res.status).toBe(200);
      expect(mockedIngestUrl).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ pageType: "agent-knowledge" }),
      );
      expect(mockedAddLearning).toHaveBeenCalledWith("alice--yoyo", "ingested-page");
    });

    it("ingests text (not just url) into an existing agent", async () => {
      mockedVerify.mockResolvedValue(null);
      mockedServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo" } as never);

      const res = await POST(
        req({ text: "an X post body", title: "Post" }, "sys-token"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedIngest).toHaveBeenCalledWith(
        "Post",
        "an X post body",
        expect.objectContaining({ pageType: "agent-knowledge", owner: "alice--yoyo" }),
      );
    });

    it("404 when the handle is not a registered user (agent missing) — skip", async () => {
      mockedVerify.mockResolvedValue(null);
      mockedServicePrincipal.mockReturnValue({
        id: "service:yopedia",
        handle: "yopedia",
      });
      mockedGetAgent.mockResolvedValue(null); // no such agent → not a user

      const res = await POST(req({ url: "https://example.com" }, "sys-token"), {
        params,
      });
      expect(res.status).toBe(404);
      expect(mockedIngestUrl).not.toHaveBeenCalled();
    });

    it("asOwner: ingests into the owner's OWN content (not agent-scoped) and does not touch learnings", async () => {
      mockedVerify.mockResolvedValue(null);
      mockedServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);

      const res = await POST(
        req({ url: "https://example.com", asOwner: true }, "sys-token"),
        { params },
      );
      expect(res.status).toBe(200);
      // Owner-attributed, normal page — NO agent-knowledge scope.
      const opts = mockedIngestUrl.mock.calls[0][1];
      expect(opts).toMatchObject({ author: "alice--yoyo", owner: "alice", sourceType: "url" });
      expect(opts).not.toHaveProperty("pageType");
      // Owner content is not appended to the agent's learnings.
      expect(mockedAddLearning).not.toHaveBeenCalled();
    });

    it("asOwner: derives sourceType 'x-mention' for X/Twitter URLs", async () => {
      mockedVerify.mockResolvedValue(null);
      mockedServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);

      const res = await POST(
        req({ url: "https://x.com/user/status/123", asOwner: true }, "sys-token"),
        { params },
      );
      expect(res.status).toBe(200);
      const opts = mockedIngestUrl.mock.calls[0][1];
      expect(opts).toMatchObject({ sourceType: "x-mention" });
    });

    it("asOwner: derives sourceType 'x-mention' for twitter.com URLs", async () => {
      mockedVerify.mockResolvedValue(null);
      mockedServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);

      const res = await POST(
        req({ url: "https://twitter.com/user/status/456", asOwner: true }, "sys-token"),
        { params },
      );
      expect(res.status).toBe(200);
      const opts = mockedIngestUrl.mock.calls[0][1];
      expect(opts).toMatchObject({ sourceType: "x-mention" });
    });

    it("asOwner: derives sourceType 'text' for text-only ingests", async () => {
      mockedVerify.mockResolvedValue(null);
      mockedServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);

      const res = await POST(
        req({ text: "some note", title: "My Note", asOwner: true }, "sys-token"),
        { params },
      );
      expect(res.status).toBe(200);
      const opts = mockedIngest.mock.calls[0][2];
      expect(opts).toMatchObject({ sourceType: "text" });
    });

    it("asOwner: per-agent token resolves the agent's human owner and creates a public page", async () => {
      mockedVerify.mockResolvedValue("alice--yoyo"); // per-agent token, matches path
      mockedServicePrincipal.mockReturnValue(null);
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);

      const res = await POST(
        req({ url: "https://example.com", asOwner: true }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      // Owner-attributed, normal page — NO agent-knowledge scope.
      const opts = mockedIngestUrl.mock.calls[0][1];
      expect(opts).toMatchObject({ author: "alice--yoyo", owner: "alice", triggeredBy: "alice", sourceType: "url" });
      expect(opts).not.toHaveProperty("pageType");
      // Owner content is not appended to the agent's learnings.
      expect(mockedAddLearning).not.toHaveBeenCalled();
    });

    it("asOwner: per-agent token is rejected (403) when the agent has no registered owner", async () => {
      mockedVerify.mockResolvedValue("alice--yoyo"); // per-agent token, matches path
      mockedServicePrincipal.mockReturnValue(null);
      // Agent exists but has no owner field
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo" } as never);

      const res = await POST(
        req({ url: "https://example.com", asOwner: true }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(403);
      expect(mockedIngestUrl).not.toHaveBeenCalled();
    });
  });

  describe("vault filing", () => {
    it("files into explicit vaultId when owner owns the vault", async () => {
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);
      mockedVaultOwnedBy.mockReturnValue(true);

      const res = await POST(
        req({ url: "https://example.com", vaultId: "alice--research" }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedAddToVault).toHaveBeenCalledWith("alice--research", "ingested-page");
    });

    it("falls back to defaultVault when no explicit vaultId", async () => {
      mockedGetAgent.mockResolvedValue({
        id: "alice--yoyo",
        owner: "alice",
        defaultVault: "alice--default",
      } as never);
      mockedVaultOwnedBy.mockReturnValue(true);

      const res = await POST(
        req({ url: "https://example.com" }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedAddToVault).toHaveBeenCalledWith("alice--default", "ingested-page");
    });

    it("explicit vaultId overrides defaultVault", async () => {
      mockedGetAgent.mockResolvedValue({
        id: "alice--yoyo",
        owner: "alice",
        defaultVault: "alice--default",
      } as never);
      mockedVaultOwnedBy.mockReturnValue(true);

      const res = await POST(
        req({ url: "https://example.com", vaultId: "alice--override" }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedAddToVault).toHaveBeenCalledWith("alice--override", "ingested-page");
    });

    it("skips vault filing when neither vaultId nor defaultVault exist", async () => {
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);

      const res = await POST(
        req({ url: "https://example.com" }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedAddToVault).not.toHaveBeenCalled();
    });

    it("skips vault filing when owner does not own the vault", async () => {
      mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", owner: "alice" } as never);
      mockedVaultOwnedBy.mockReturnValue(false);

      const res = await POST(
        req({ url: "https://example.com", vaultId: "bob--research" }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      // Ingest succeeds but vault filing is skipped (not owned).
      expect(mockedAddToVault).not.toHaveBeenCalled();
    });

    it("works with system token and defaultVault", async () => {
      mockedVerify.mockResolvedValue(null);
      mockedServicePrincipal.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
      mockedGetAgent.mockResolvedValue({
        id: "alice--yoyo",
        owner: "alice",
        defaultVault: "alice--default",
      } as never);
      mockedVaultOwnedBy.mockReturnValue(true);

      const res = await POST(
        req({ url: "https://example.com" }, "sys-token"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedAddToVault).toHaveBeenCalledWith("alice--default", "ingested-page");
    });
  });

  describe("tags", () => {
    it("forwards tags to ingestUrl opts", async () => {
      const res = await POST(
        req({ url: "https://example.com", tags: ["ai", "research"] }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedIngestUrl).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ tags: ["ai", "research"] }),
      );
    });

    it("forwards tags to ingest (text path) opts", async () => {
      const res = await POST(
        req({ text: "Some knowledge", title: "Note", tags: ["notes"] }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedIngest).toHaveBeenCalledWith(
        "Note",
        "Some knowledge",
        expect.objectContaining({ tags: ["notes"] }),
      );
    });

    it("omitting tags still works (backward compatible)", async () => {
      const res = await POST(
        req({ url: "https://example.com" }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(200);
      expect(mockedIngestUrl).toHaveBeenCalledWith(
        "https://example.com",
        expect.not.objectContaining({ tags: expect.anything() }),
      );
    });

    it("rejects non-array tags", async () => {
      const res = await POST(
        req({ url: "https://example.com", tags: "not-an-array" }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/tags must be an array of strings/);
    });

    it("rejects tags with non-string elements", async () => {
      const res = await POST(
        req({ url: "https://example.com", tags: ["valid", 123] }, "alice--yoyo.s"),
        { params },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/tags must be an array of strings/);
    });
  });
});
