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

type Page = {
  slug: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

/** Build a slug→page table and wire the read mock to resolve from it, with an
 *  optional per-slug delay so later slugs can finish FIRST — that catches a
 *  zip/order-preservation regression that a uniform-latency mock would miss. */
function wirePages(table: Record<string, Omit<Page, "slug"> | null>, delays: Record<string, number> = {}) {
  mockedRead.mockImplementation(async (slug: string) => {
    const delay = delays[slug] ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const entry = table[slug] ?? null;
    if (!entry) return null as never;
    // The route reads .slug, .title, .frontmatter, and .body.
    return { slug, ...entry } as never;
  });
}

/** Public page with default title derived from slug. */
const pub = (body: string, title?: string): Omit<Page, "slug"> => ({
  frontmatter: {},
  body,
  title: title ?? (body.split("\n")[0].replace(/^#\s*/, "") || "Untitled"),
});

/** Public page with rich frontmatter. */
const rich = (
  body: string,
  fm: Record<string, unknown>,
  title?: string,
): Omit<Page, "slug"> => ({
  frontmatter: fm,
  body,
  title: title ?? "Rich Page",
});

/** Private page. */
const priv = (body: string, owner: string): Omit<Page, "slug"> => ({
  frontmatter: { visibility: "private", owner },
  body,
  title: "Private",
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
    // content field is nested inside the section object now
    expect(json.context.identity.content).toBe("A\n\n---\n\nB\n\n---\n\nC");
    expect(json.context.learnings.content).toBe("L");
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
    expect(json.context.identity.content).toBe("A\n\n---\n\nC");
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
    expect(json.context.learnings.content).toBe("MINE");
    expect(json.context.learnings.content).not.toContain("SECRET");
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
    expect(json.context.learnings.content).toBe("SECRET");
    expect(json.meta.pageCount).toBe(1);
  });

  it("404s for an unknown agent", async () => {
    mockedGetAgent.mockResolvedValue(null as never);
    expect((await call()).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Per-page metadata (pages array)
// ---------------------------------------------------------------------------

describe("GET /api/agents/[id]/context — per-page metadata", () => {
  it("returns a pages array per section with slug, title, and meta", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["id-page"],
      learningPages: ["learn-page"],
      socialPages: ["social-page"],
    } as never);
    wirePages({
      "id-page": rich(
        "Identity content",
        { confidence: 0.95, tags: ["agent"], updated: "2026-10-01", owner: "alice" },
        "My Identity",
      ),
      "learn-page": rich(
        "Learnings content",
        { confidence: 0.8, expiry: "2027-01-01", disputed: true },
        "My Learnings",
      ),
      "social-page": pub("Social content", "Social Wisdom"),
    });

    const json = await (await call()).json();

    // Identity section
    expect(json.context.identity.pages).toHaveLength(1);
    expect(json.context.identity.pages[0]).toEqual({
      slug: "id-page",
      title: "My Identity",
      meta: {
        confidence: 0.95,
        tags: ["agent"],
        updated: "2026-10-01",
        owner: "alice",
      },
    });

    // Learnings section
    expect(json.context.learnings.pages).toHaveLength(1);
    expect(json.context.learnings.pages[0]).toEqual({
      slug: "learn-page",
      title: "My Learnings",
      meta: {
        confidence: 0.8,
        expiry: "2027-01-01",
        disputed: true,
      },
    });

    // Social section — no frontmatter, so meta is empty
    expect(json.context.socialWisdom.pages).toHaveLength(1);
    expect(json.context.socialWisdom.pages[0]).toEqual({
      slug: "social-page",
      title: "Social Wisdom",
      meta: {},
    });
  });

  it("returns empty pages array for sections with no pages", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: [],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({});

    const json = await (await call()).json();
    expect(json.context.identity.pages).toEqual([]);
    expect(json.context.learnings.pages).toEqual([]);
    expect(json.context.socialWisdom.pages).toEqual([]);
    // content should be empty strings
    expect(json.context.identity.content).toBe("");
    expect(json.context.learnings.content).toBe("");
    expect(json.context.socialWisdom.content).toBe("");
  });

  it("omits missing pages from the pages array", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["exists", "gone"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({
      exists: rich("content", { confidence: 0.5 }, "Exists"),
      gone: null,
    });

    const json = await (await call()).json();
    expect(json.context.identity.pages).toHaveLength(1);
    expect(json.context.identity.pages[0].slug).toBe("exists");
  });

  it("omits private pages from the pages array for non-owners", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["public-page", "secret-page"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({
      "public-page": pub("Public", "Public Page"),
      "secret-page": priv("Secret", "bob"),
    });
    mockedPrincipal.mockResolvedValue({ id: "alice", handle: "alice" });

    const json = await (await call()).json();
    expect(json.context.identity.pages).toHaveLength(1);
    expect(json.context.identity.pages[0].slug).toBe("public-page");
  });

  it("gracefully handles pages with no frontmatter fields (empty meta)", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["bare-page"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({
      "bare-page": { frontmatter: {}, body: "bare content", title: "Bare" },
    });

    const json = await (await call()).json();
    expect(json.context.identity.pages[0].meta).toEqual({});
    expect(json.context.identity.content).toBe("bare content");
  });

  it("handles disputed as boolean true", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["d-page"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({
      "d-page": rich("body", { disputed: true }, "Disputed"),
    });

    const json = await (await call()).json();
    expect(json.context.identity.pages[0].meta.disputed).toBe(true);
  });

  it("handles disputed as string 'true'", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["d-page"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({
      "d-page": rich("body", { disputed: "true" }, "Disputed"),
    });

    const json = await (await call()).json();
    expect(json.context.identity.pages[0].meta.disputed).toBe(true);
  });

  it("omits disputed from meta when it's falsy", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["nd-page"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({
      "nd-page": rich("body", { disputed: false }, "Not Disputed"),
    });

    const json = await (await call()).json();
    expect(json.context.identity.pages[0].meta).not.toHaveProperty("disputed");
  });

  it("preserves pages array order matching content order", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["first", "second", "third"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages(
      {
        first: pub("First", "First Page"),
        second: pub("Second", "Second Page"),
        third: pub("Third", "Third Page"),
      },
      // Stagger delays to stress ordering
      { first: 10, second: 5, third: 1 },
    );

    const json = await (await call()).json();
    const slugs = json.context.identity.pages.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(["first", "second", "third"]);
    expect(json.context.identity.content).toBe("First\n\n---\n\nSecond\n\n---\n\nThird");
  });

  it("only includes recognized metadata fields", async () => {
    mockedResolve.mockResolvedValue({
      identityPages: ["extra-fm"],
      learningPages: [],
      socialPages: [],
    } as never);
    wirePages({
      "extra-fm": rich(
        "body",
        {
          confidence: 0.9,
          owner: "alice",
          unrecognized_field: "should not appear",
          visibility: "public",
        },
        "Extra FM",
      ),
    });

    const json = await (await call()).json();
    const meta = json.context.identity.pages[0].meta;
    expect(meta.confidence).toBe(0.9);
    expect(meta.owner).toBe("alice");
    expect(meta).not.toHaveProperty("unrecognized_field");
    expect(meta).not.toHaveProperty("visibility");
  });
});
