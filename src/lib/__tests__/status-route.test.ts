import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — isolate the route from storage / config so the test is fast and
// deterministic. We mock the three index readers + the LLM provider info.
// ---------------------------------------------------------------------------

vi.mock("@/lib/llm", () => ({
  getProviderInfo: vi.fn(),
}));

vi.mock("@/lib/page-index", () => ({
  getPageIndex: vi.fn(),
}));

vi.mock("@/lib/contributor-index", () => ({
  getContributorIndex: vi.fn(),
}));

vi.mock("@/lib/discuss-stats-index", () => ({
  getDiscussStatsIndex: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { getProviderInfo } from "@/lib/llm";
import { getPageIndex } from "@/lib/page-index";
import { getContributorIndex } from "@/lib/contributor-index";
import { getDiscussStatsIndex } from "@/lib/discuss-stats-index";
import { GET } from "@/app/api/status/route";

const mockedProviderInfo = vi.mocked(getProviderInfo);
const mockedPageIndex = vi.mocked(getPageIndex);
const mockedContribIndex = vi.mocked(getContributorIndex);
const mockedDiscussIndex = vi.mocked(getDiscussStatsIndex);

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal provider info stub. */
const providerStub = () => ({
  configured: true,
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  embeddingSupport: true,
});

/** Page index stub with the given entries. */
function pageIndexStub(
  entries: Record<string, { sourceCount?: number; [k: string]: unknown }>,
) {
  return entries as Awaited<ReturnType<typeof getPageIndex>>;
}

/** Contributor index stub. */
function contribIndexStub(
  authors: Record<
    string,
    {
      editCount: number;
      pagesEdited: string[];
      disputedPageCount?: number;
      [k: string]: unknown;
    }
  >,
) {
  let revisionCount = 0;
  let contributorCount = 0;
  for (const a of Object.values(authors)) {
    revisionCount += a.editCount;
    contributorCount += 1;
  }
  return {
    authors,
    totals: { revisionCount, contributorCount },
  } as Awaited<ReturnType<typeof getContributorIndex>>;
}

/** Discuss-stats index stub. */
function discussIndexStub(
  entries: Record<string, { total: number; open: number }>,
) {
  return entries as Awaited<ReturnType<typeof getDiscussStatsIndex>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/status", () => {
  it("returns provider info and commons stats when all indexes are populated", async () => {
    mockedProviderInfo.mockReturnValue(providerStub());
    mockedPageIndex.mockResolvedValue(
      pageIndexStub({
        "page-a": { slug: "page-a", title: "A", summary: "s", sourceCount: 2 },
        "page-b": { slug: "page-b", title: "B", summary: "s", sourceCount: 1 },
        "page-c": { slug: "page-c", title: "C", summary: "s" },
      }),
    );
    mockedContribIndex.mockResolvedValue(
      contribIndexStub({
        alice: { editCount: 5, pagesEdited: ["page-a", "page-b"], disputedPageCount: 1 },
        bob: { editCount: 3, pagesEdited: ["page-c"], disputedPageCount: 0 },
      }),
    );
    mockedDiscussIndex.mockResolvedValue(
      discussIndexStub({
        "page-a": { total: 2, open: 1 },
        "page-b": { total: 1, open: 0 },
      }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();

    // Provider fields unchanged
    expect(json.configured).toBe(true);
    expect(json.provider).toBe("anthropic");
    expect(json.model).toBe("claude-sonnet-4-20250514");
    expect(json.embeddingSupport).toBe(true);

    // Commons stats
    expect(json.commons).toBeDefined();
    expect(json.commons.pageCount).toBe(3);
    expect(json.commons.sourceCount).toBe(3); // 2 + 1 + 0
    expect(json.commons.contributorCount).toBe(2);
    expect(json.commons.revisionCount).toBe(8); // 5 + 3
    expect(json.commons.openThreadCount).toBe(1);
    // disputedPageCount: alice has 1 disputed among [page-a, page-b],
    // so the slug set is {page-a, page-b} (size 2), sum-of-per-author = 1,
    // min(2, 1) = 1
    expect(json.commons.disputedPageCount).toBe(1);
  });

  it("returns zeros when all indexes are absent (not yet seeded)", async () => {
    mockedProviderInfo.mockReturnValue(providerStub());
    mockedPageIndex.mockResolvedValue(null);
    mockedContribIndex.mockResolvedValue(null);
    mockedDiscussIndex.mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.commons).toBeDefined();
    expect(json.commons.pageCount).toBe(0);
    expect(json.commons.sourceCount).toBe(0);
    expect(json.commons.contributorCount).toBe(0);
    expect(json.commons.revisionCount).toBe(0);
    expect(json.commons.disputedPageCount).toBe(0);
    expect(json.commons.openThreadCount).toBe(0);
  });

  it("preserves backward compatibility — provider fields remain at the top level", async () => {
    mockedProviderInfo.mockReturnValue({
      configured: false,
      provider: null,
      model: null,
      embeddingSupport: false,
    });
    mockedPageIndex.mockResolvedValue(null);
    mockedContribIndex.mockResolvedValue(null);
    mockedDiscussIndex.mockResolvedValue(null);

    const res = await GET();
    const json = await res.json();

    expect(json.configured).toBe(false);
    expect(json.provider).toBeNull();
    expect(json.model).toBeNull();
    expect(json.embeddingSupport).toBe(false);
    // commons is still present even when provider isn't configured
    expect(json.commons).toBeDefined();
  });

  it("gracefully handles index read failures (logs and defaults to 0)", async () => {
    mockedProviderInfo.mockReturnValue(providerStub());
    mockedPageIndex.mockRejectedValue(new Error("KV read timeout"));
    mockedContribIndex.mockRejectedValue(new Error("storage error"));
    mockedDiscussIndex.mockRejectedValue(new Error("network error"));

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.commons.pageCount).toBe(0);
    expect(json.commons.sourceCount).toBe(0);
    expect(json.commons.contributorCount).toBe(0);
    expect(json.commons.revisionCount).toBe(0);
    expect(json.commons.openThreadCount).toBe(0);
  });

  it("returns 500 when getProviderInfo throws", async () => {
    mockedProviderInfo.mockImplementation(() => {
      throw new Error("config broken");
    });

    const res = await GET();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.configured).toBe(false);
    expect(json.error).toContain("config broken");
  });

  it("counts sourceCount correctly with missing sourceCount on some entries", async () => {
    mockedProviderInfo.mockReturnValue(providerStub());
    mockedPageIndex.mockResolvedValue(
      pageIndexStub({
        a: { slug: "a", title: "A", summary: "s", sourceCount: 5 },
        b: { slug: "b", title: "B", summary: "s" }, // no sourceCount
        c: { slug: "c", title: "C", summary: "s", sourceCount: 0 },
      }),
    );
    mockedContribIndex.mockResolvedValue(null);
    mockedDiscussIndex.mockResolvedValue(null);

    const res = await GET();
    const json = await res.json();
    expect(json.commons.pageCount).toBe(3);
    expect(json.commons.sourceCount).toBe(5); // 5 + 0 + 0
  });

  it("computes disputedPageCount as min(slugSet, sumPerAuthor) for multi-author overlap", async () => {
    mockedProviderInfo.mockReturnValue(providerStub());
    mockedPageIndex.mockResolvedValue(null);
    // alice edited [a, b] with 1 disputed, bob edited [b, c] with 1 disputed.
    // slug set for authors with disputed > 0 = {a, b, c} (size 3)
    // sum of per-author disputed = 1 + 1 = 2
    // min(3, 2) = 2
    mockedContribIndex.mockResolvedValue(
      contribIndexStub({
        alice: { editCount: 2, pagesEdited: ["a", "b"], disputedPageCount: 1 },
        bob: { editCount: 2, pagesEdited: ["b", "c"], disputedPageCount: 1 },
      }),
    );
    mockedDiscussIndex.mockResolvedValue(null);

    const res = await GET();
    const json = await res.json();
    expect(json.commons.disputedPageCount).toBe(2);
  });
});
