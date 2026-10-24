import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth resolution + the reused tool handlers so we test the ROUTE's
// auth/attribution/transport logic in isolation (no storage/LLM).
vi.mock("@/lib/agents", () => ({
  verifyAgentToken: vi.fn(),
  getAgent: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  getServicePrincipal: vi.fn(() => null),
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1 })),
}));
vi.mock("@/mcp", () => ({
  handleSearchWiki: vi.fn(async () => []),
  handleReadPage: vi.fn(),
  handleListPages: vi.fn(),
  handleQueryWiki: vi.fn(),
  handleIngestUrl: vi.fn(),
  handleIngestText: vi.fn(),
  handleReingest: vi.fn(),
  handleCreatePage: vi.fn(async () => ({ slug: "x", title: "X", created: true })),
  handleSaveQueryAnswer: vi.fn(),
  handleMaintenanceScan: vi.fn(async () => ({ tasks: [] })),
}));

import { verifyAgentToken, getAgent } from "@/lib/agents";
import { getServicePrincipal } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { handleCreatePage } from "@/mcp";
import { POST, GET } from "@/app/api/mcp/route";

const mockedVerify = vi.mocked(verifyAgentToken);
const mockedGetAgent = vi.mocked(getAgent);
const mockedService = vi.mocked(getServicePrincipal);
const mockedRateLimit = vi.mocked(enforceRateLimit);
const mockedCreate = vi.mocked(handleCreatePage);

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(() => {
  vi.clearAllMocks();
  mockedVerify.mockResolvedValue(null);
  mockedGetAgent.mockResolvedValue(null);
  mockedService.mockReturnValue(null);
  mockedRateLimit.mockResolvedValue({ allowed: true, remaining: 1 });
});

describe("POST /api/mcp — auth resolution", () => {
  it("allows unauthenticated reads (no token → tools/list 200)", async () => {
    const res = await POST(post({ id: 1, method: "tools/list" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("maintenance_scan appears in the tool list", async () => {
    const res = await POST(post({ id: 1, method: "tools/list" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const toolNames = body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("maintenance_scan");
  });

  it("401s a presented-but-invalid token (not a silent downgrade to anon)", async () => {
    // verifyAgentToken → null AND no service principal.
    const res = await POST(post({ id: 1, method: "tools/list" }, auth("bogus")));
    expect(res.status).toBe(401);
  });

  it("401s a valid token whose agent is gone (orphaned) — no anon downgrade", async () => {
    mockedVerify.mockResolvedValue("alice--yoyo");
    mockedGetAgent.mockResolvedValue(null); // deleted/renamed
    const res = await POST(post({ id: 1, method: "tools/list" }, auth("t")));
    expect(res.status).toBe(401);
  });

  it("500s (not 401) when the agent store errors — outage isn't masked as a bad token", async () => {
    mockedVerify.mockResolvedValue("alice--yoyo");
    mockedGetAgent.mockRejectedValue(new Error("R2 down"));
    const res = await POST(post({ id: 1, method: "ping" }, auth("t")));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/mcp — write attribution", () => {
  it("attributes a write to the agent's OWNER and ignores a spoofed arguments.owner", async () => {
    mockedVerify.mockResolvedValue("alice--yoyo");
    mockedGetAgent.mockResolvedValue({ owner: "alice" } as Awaited<ReturnType<typeof getAgent>>);

    const res = await POST(
      post(
        {
          id: 1,
          method: "tools/call",
          params: {
            name: "create_page",
            // Attacker tries to attribute the page to someone else.
            arguments: { slug: "p", content: "# P", owner: "victim", author: "victim" },
          },
        },
        auth("t"),
      ),
    );
    expect(res.status).toBe(200);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const arg = mockedCreate.mock.calls[0][0];
    // The resolved owner wins over the spoofed values.
    expect(arg.owner).toBe("alice");
    expect(arg.author).toBe("alice");
  });

  it("a write via the service token attributes to the service principal", async () => {
    mockedService.mockReturnValue({ id: "service:sys", handle: "sys" });
    const res = await POST(
      post(
        { id: 1, method: "tools/call", params: { name: "create_page", arguments: { slug: "p", content: "# P" } } },
        auth("service-tok"),
      ),
    );
    expect(res.status).toBe(200);
    expect(mockedCreate.mock.calls[0][0].owner).toBe("sys");
  });

  it("a write with no token returns an auth-required isError (handler not called)", async () => {
    const res = await POST(
      post({ id: 1, method: "tools/call", params: { name: "create_page", arguments: { slug: "p", content: "# P" } } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp — transport", () => {
  it("rejects an oversized batch with -32600/400", async () => {
    const batch = Array.from({ length: 21 }, (_, i) => ({ id: i, method: "ping" }));
    const res = await POST(post(batch));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it("accepts a batch at the cap and returns an array of responses", async () => {
    const batch = Array.from({ length: 20 }, (_, i) => ({ id: i, method: "ping" }));
    const res = await POST(post(batch));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(20);
  });

  it("a batch of only notifications → 202 no body", async () => {
    const res = await POST(post([{ method: "notifications/initialized" }]));
    expect(res.status).toBe(202);
  });

  it("malformed JSON body → -32700/400", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("GET is 405 with Allow: POST", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    mockedRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const res = await POST(post({ id: 1, method: "ping" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe(-32000);
  });
});

describe("POST /api/mcp — MCP v2 protocol", () => {
  it("server/discover returns supported versions and capabilities", async () => {
    const res = await POST(post({ id: 1, method: "server/discover" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.supportedVersions).toContain("2026-07-28");
    expect(body.result.supportedVersions).toContain("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: {}, resources: {} });
    expect(body.result.resultType).toBe("complete");
  });

  it("all responses include resultType: complete", async () => {
    const res = await POST(post({ id: 1, method: "tools/list" }));
    const body = await res.json();
    expect(body.result.resultType).toBe("complete");
  });

  it("tools/list includes CacheableResult fields", async () => {
    const res = await POST(post({ id: 1, method: "tools/list" }));
    const body = await res.json();
    expect(body.result.ttlMs).toBe(3600000);
    expect(body.result.cacheScope).toBe("public");
  });

  it("responses include server info in _meta", async () => {
    const res = await POST(post({ id: 1, method: "tools/list" }));
    const body = await res.json();
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "yopedia",
      version: "1.0.0",
    });
  });

  it("initialize still works for v1 backward compat", async () => {
    const res = await POST(post({ id: 1, method: "initialize" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2026-07-28");
    expect(body.result.resultType).toBe("complete");
  });
});

describe("POST /api/mcp — v2 header validation", () => {
  it("skips validation when MCP-Protocol-Version header is absent (v1 client)", async () => {
    const res = await POST(post({ id: 1, method: "tools/list" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("passes validation with the current protocol version", async () => {
    const res = await POST(
      post({ id: 1, method: "tools/list" }, { "MCP-Protocol-Version": "2026-07-28" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("passes validation with the backward-compat version 2025-06-18", async () => {
    const res = await POST(
      post({ id: 1, method: "tools/list" }, { "MCP-Protocol-Version": "2025-06-18" }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects an unsupported protocol version with -32022", async () => {
    const res = await POST(
      post(
        { id: 1, method: "tools/list" },
        { "MCP-Protocol-Version": "1999-01-01" },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32022);
    expect(body.error.message).toContain("Unsupported protocol version");
    expect(body.error.message).toContain("1999-01-01");
  });

  it("rejects mismatched Mcp-Method header with -32020", async () => {
    const res = await POST(
      post(
        { id: 1, method: "tools/list" },
        { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32020);
    expect(body.error.message).toContain("Mcp-Method");
    expect(body.error.message).toContain("tools/call");
    expect(body.error.message).toContain("tools/list");
  });

  it("passes when Mcp-Method header matches body method", async () => {
    const res = await POST(
      post(
        { id: 1, method: "tools/list" },
        { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("ignores Mcp-Method when header is absent (optional)", async () => {
    const res = await POST(
      post(
        { id: 1, method: "tools/list" },
        { "MCP-Protocol-Version": "2026-07-28" },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("rejects mismatched Mcp-Name header on tools/call with -32020", async () => {
    mockedVerify.mockResolvedValue("alice--yoyo");
    mockedGetAgent.mockResolvedValue({ owner: "alice" } as Awaited<ReturnType<typeof getAgent>>);

    const res = await POST(
      post(
        {
          id: 1,
          method: "tools/call",
          params: { name: "search_wiki", arguments: { query: "test" } },
        },
        {
          Authorization: "Bearer t",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Name": "read_page",
        },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32020);
    expect(body.error.message).toContain("Mcp-Name");
    expect(body.error.message).toContain("read_page");
    expect(body.error.message).toContain("search_wiki");
  });

  it("passes when Mcp-Name matches params.name on tools/call", async () => {
    const res = await POST(
      post(
        {
          id: 1,
          method: "tools/call",
          params: { name: "search_wiki", arguments: { query: "test" } },
        },
        {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Name": "search_wiki",
        },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("Mcp-Name is ignored for non-tools/call methods", async () => {
    const res = await POST(
      post(
        { id: 1, method: "tools/list" },
        { "MCP-Protocol-Version": "2026-07-28", "Mcp-Name": "anything" },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("unsupported version is rejected even in batch requests", async () => {
    const batch = [{ id: 1, method: "ping" }, { id: 2, method: "tools/list" }];
    const res = await POST(
      post(batch, { "MCP-Protocol-Version": "1999-01-01" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32022);
  });

  it("batch with valid v2 version header proceeds normally", async () => {
    const batch = [{ id: 1, method: "ping" }, { id: 2, method: "tools/list" }];
    const res = await POST(
      post(batch, { "MCP-Protocol-Version": "2026-07-28" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("preserves request id in error responses", async () => {
    const res = await POST(
      post(
        { id: 42, method: "tools/list" },
        { "MCP-Protocol-Version": "0000-00-00" },
      ),
    );
    const body = await res.json();
    expect(body.id).toBe(42);
  });

  it("uses null id when body has no id", async () => {
    const res = await POST(
      post(
        { method: "tools/list" },
        { "MCP-Protocol-Version": "0000-00-00" },
      ),
    );
    const body = await res.json();
    expect(body.id).toBeNull();
  });
});
