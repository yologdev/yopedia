import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  STREAM_DONE_SENTINEL,
  STREAM_ERROR_SENTINEL,
} from "@/lib/constants";

// ---------------------------------------------------------------------------
// #413: the streaming query route must apply the SAME agent-scoped filter the
// non-streaming query() does — unscoped queries answer from the public commons
// only, never from agent-identity/knowledge/social pages.
// ---------------------------------------------------------------------------

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));

vi.mock("@/lib/search", () => ({
  // Default to UNSCOPED; individual tests override per scope.
  resolveScopeSlugs: vi.fn(async () => ({ scopeSlugs: undefined })),
}));

vi.mock("@/lib/wiki", () => ({
  listReadableWikiPages: vi.fn(),
  // Real-ish predicates: agent-scoped types are the `agent-*` family; saved
  // artifacts are `html`.
  isAgentScopedType: (t: unknown) =>
    typeof t === "string" && t.startsWith("agent-"),
  isArtifactType: (t: unknown) => t === "html",
}));

/**
 * Helper: create a mock return value for callLLMStream. The route accesses
 * `.textStream` (an async iterable of string chunks).
 */
function makeMockStream(chunks: string[]) {
  return {
    textStream: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

/**
 * Helper: create a mock return value whose textStream throws mid-iteration.
 */
function makeMockErrorStream(chunksBeforeError: string[], error: Error) {
  return {
    textStream: (async function* () {
      for (const c of chunksBeforeError) yield c;
      throw error;
    })(),
  };
}

vi.mock("@/lib/llm", () => ({
  hasLLMKey: vi.fn(() => true),
  // Default: empty stream so the route completes without a real LLM.
  callLLMStream: vi.fn(() => makeMockStream([])),
}));

vi.mock("@/lib/query", () => ({
  selectPagesForQuery: vi.fn(async () => ["concept-a"]),
  buildContext: vi.fn(async () => ({ context: "ctx", slugs: ["concept-a"] })),
  buildQuerySystemPrompt: vi.fn(() => "system"),
}));

import { listReadableWikiPages } from "@/lib/wiki";
import { resolveScopeSlugs } from "@/lib/search";
import { selectPagesForQuery } from "@/lib/query";
import { callLLMStream } from "@/lib/llm";
import { getPrincipal } from "@/lib/auth";
import { POST } from "@/app/api/query/stream/route";

const mockedList = vi.mocked(listReadableWikiPages);
const mockedScope = vi.mocked(resolveScopeSlugs);
const mockedSelect = vi.mocked(selectPagesForQuery);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedCallLLMStream = vi.mocked(callLLMStream);

const ENTRIES = [
  { slug: "concept-a", title: "A", summary: "", type: undefined },
  { slug: "yoyo-identity", title: "Y", summary: "", type: "agent-identity" },
  { slug: "yoyo-notes", title: "N", summary: "", type: "agent-knowledge" },
] as unknown as Awaited<ReturnType<typeof listReadableWikiPages>>;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/query/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read the full body text from a streaming Response. */
async function readBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue(ENTRIES);
  mockedScope.mockResolvedValue({ scopeSlugs: undefined });
  // Default: a signed-in user (the middleware guarantees a session for POST).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetPrincipal.mockResolvedValue({ id: "u", handle: "u" } as any);
  // Reset mock stream to default (empty) for each test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedCallLLMStream.mockReturnValue(makeMockStream([]) as any);
});

describe("POST /api/query/stream — agent-scope filtering (#413)", () => {
  it("excludes agent-scoped pages from an UNSCOPED query", async () => {
    await POST(makeRequest({ question: "what is A?" }));

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    expect(passedEntries.map((e) => e.type)).not.toContain("agent-identity");
    expect(passedEntries.map((e) => e.type)).not.toContain("agent-knowledge");
    expect(passedEntries.map((e) => (e as { slug: string }).slug)).toEqual([
      "concept-a",
    ]);
  });

  it("keeps agent-scoped pages when an agent: scope is provided", async () => {
    mockedScope.mockResolvedValue({ scopeSlugs: ["yoyo-identity", "yoyo-notes"] });

    await POST(makeRequest({ question: "what is yoyo?", scope: "agent:yoyo" }));

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    // Scoped query: no agent filter — the full readable set flows through.
    expect(passedEntries.map((e) => e.type)).toContain("agent-identity");
    expect(passedEntries.map((e) => e.type)).toContain("agent-knowledge");
  });

  it("excludes saved html artifacts from an unscoped query (and accepts format:html)", async () => {
    mockedList.mockResolvedValue([
      { slug: "concept-a", title: "A", summary: "", type: undefined },
      { slug: "saved-chart", title: "Chart", summary: "", type: "html" },
    ] as unknown as Awaited<ReturnType<typeof listReadableWikiPages>>);

    await POST(makeRequest({ question: "?", format: "html" }));

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    // The artifact's markup must never enter the LLM context.
    expect(passedEntries.map((e) => e.type)).not.toContain("html");
    expect(passedEntries.map((e) => (e as { slug: string }).slug)).toEqual([
      "concept-a",
    ]);
  });

  it("rejects an invalid format with 400", async () => {
    const res = await POST(makeRequest({ question: "?", format: "bogus" }));
    expect(res.status).toBe(400);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller and never selects pages / calls the LLM", async () => {
    mockedGetPrincipal.mockResolvedValueOnce(null); // anonymous
    const res = await POST(makeRequest({ question: "what is A?" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/sign in/i);
    // Stopped before any expensive work — no page selection, no LLM stream.
    expect(mockedSelect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #993: streaming sentinel — the server appends a trailing marker so the
// client can distinguish a complete answer from a truncated one.
// ---------------------------------------------------------------------------

describe("POST /api/query/stream — sentinel markers (#993)", () => {
  it("appends STREAM_DONE_SENTINEL after a successful LLM stream", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCallLLMStream.mockReturnValue(makeMockStream(["Hello", " world"]) as any);

    const res = await POST(makeRequest({ question: "what is A?" }));
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body).toContain("Hello world");
    expect(body).toContain(STREAM_DONE_SENTINEL);
    expect(body).not.toContain(STREAM_ERROR_SENTINEL);
    // The sentinel is TRAILING — all content comes before it.
    expect(body.indexOf("Hello")).toBeLessThan(body.indexOf(STREAM_DONE_SENTINEL));
  });

  it("appends STREAM_ERROR_SENTINEL when the LLM stream throws mid-response", async () => {
    mockedCallLLMStream.mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeMockErrorStream(["Partial ans"], new Error("provider timeout")) as any,
    );

    const res = await POST(makeRequest({ question: "what is A?" }));
    // The HTTP response is still 200 — the error happened mid-stream.
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body).toContain("Partial ans");
    expect(body).toContain(STREAM_ERROR_SENTINEL);
    expect(body).not.toContain(STREAM_DONE_SENTINEL);
  });

  it("appends STREAM_DONE_SENTINEL even for an empty LLM stream", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCallLLMStream.mockReturnValue(makeMockStream([]) as any);

    const res = await POST(makeRequest({ question: "what is A?" }));
    const body = await readBody(res);
    expect(body).toBe(STREAM_DONE_SENTINEL);
  });

  it("includes X-Wiki-Sources header on streamed responses", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCallLLMStream.mockReturnValue(makeMockStream(["ok"]) as any);

    const res = await POST(makeRequest({ question: "what is A?" }));
    const header = res.headers.get("X-Wiki-Sources");
    expect(header).toBeTruthy();
    const slugs = JSON.parse(decodeURIComponent(header!));
    expect(slugs).toEqual(["concept-a"]);
  });
});
