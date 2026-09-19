import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the data SOURCES only. canReadFrontmatter (authz) and mapWithConcurrency
// (concurrency) stay REAL, so the test exercises the route's actual ordering +
// access-control behavior — the two invariants the parallel-read refactor put at
// risk (see context/route.ts loadPages).
// Partial mock: override only the two data lookups; keep the rest real so
// canReadFrontmatter's call into agentOwnerHandle (also from this module) works.
vi.mock("@/lib/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents")>()),
  getAgent: vi.fn(),
  resolveAgentPages: vi.fn(),
}));
vi.mock("@/lib/wiki", () => ({
  tryReadWikiPageWithFrontmatter: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
}));

import { getAgent, resolveAgentPages } from "@/lib/agents";
import { tryReadWikiPageWithFrontmatter } from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";
import { GET } from "@/app/api/agents/[id]/context/route";

const mockedGetAgent = vi.mocked(getAgent);
const mockedResolve = vi.mocked(resolveAgentPages);
const mockedRead = vi.mocked(tryReadWikiPageWithFrontmatter);
const mockedPrincipal = vi.mocked(getPrincipal);

type Page = { frontmatter: Record<string, unknown>; body: string };

/** Build a slug→page table and wire the read mock to resolve from it, with an
 *  optional per-slug delay so later slugs can finish FIRST — that catches a
 *  zip/order-preservation regression that a uniform-latency mock would miss. */
function wirePages(table: Record<string, Page | null>, delays: Record<string, number> = {}) {
  mockedRead.mockImplementation(async (slug: string) => {
    const delay = delays[slug] ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const page = table[slug] ?? null;
    // The route only reads .frontmatter and .body; cast covers the wider type.
    return page as never;
  });
}

const pub = (body: string): Page => ({ frontmatter: {}, body });
const priv = (body: string, owner: string): Page => ({
  frontmatter: { visibility: "private", owner },
  body,
});

function call(id = "alice--yoyo") {
  return GET(new Request("http://x/api/agents/x/context"), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAgent.mockResolvedValue({ id: "alice--yoyo", name: "yoyo" } as never);
  mockedPrincipal.mockResolvedValue(null);
});

describe("GET /api/agents/[id]/context — loadPages ordering + access control", () => {
  it("preserves slug order within a section even when later pages resolve first", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["id-a", "id-b", "id-c"],
      learningPages: ["learn-a"],
      socialPages: [],
    } as never);
    // id-a is SLOWEST so a naive push-on-resolve would put it last.
    wirePages(
      { "id-a": pub("A"), "id-b": pub("B"), "id-c": pub("C"), "learn-a": pub("L") },
      { "id-a": 15, "id-b": 5, "id-c": 1 },
    );

    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.context.identity).toBe("A\n\n---\n\nB\n\n---\n\nC");
    expect(json.context.learnings).toBe("L");
    expect(json.meta.pageCount).toBe(4);
  });

  it("skips a missing page (read returns null) and counts only the survivors", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["id-a", "gone", "id-c"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({ "id-a": pub("A"), gone: null, "id-c": pub("C") });

    const json = await (await call()).json();
    expect(json.context.identity).toBe("A\n\n---\n\nC");
    expect(json.meta.pageCount).toBe(2);
  });

  it("excludes a third party's private page from a non-owner's context", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["mine"],
      learningPages: ["mine", "bobs-secret"],
      socialPages: [],
    } as never);
    wirePages({ mine: pub("MINE"), "bobs-secret": priv("SECRET", "bob") });
    mockedPrincipal.mockResolvedValue({ id: "alice", handle: "alice" });

    const json = await (await call()).json();
    // The private page Bob owns is gated out; Alice's learnings hold only "MINE".
    expect(json.context.learnings).toBe("MINE");
    expect(json.context.learnings).not.toContain("SECRET");
    expect(json.meta.pageCount).toBe(2); // identity:mine + learnings:mine
  });

  it("includes an owner's own private page for that owner", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: [],
      learningPages: ["bobs-secret"],
      socialPages: [],
    } as never);
    wirePages({ "bobs-secret": priv("SECRET", "bob") });
    mockedPrincipal.mockResolvedValue({ id: "bob", handle: "bob" });

    const json = await (await call()).json();
    expect(json.context.learnings).toBe("SECRET");
    expect(json.meta.pageCount).toBe(1);
  });

  it("404s for an unknown agent", async () => {
    mockedGetAgent.mockResolvedValue(null as never);
    expect((await call()).status).toBe(404);
  });
});
