import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the commons index — we only need getCommonsIndex for sitemap
// ---------------------------------------------------------------------------

vi.mock("@/lib/commons", () => ({
  getCommonsIndex: vi.fn(),
}));

import { getCommonsIndex } from "@/lib/commons";
import type { CommonsEntry } from "@/lib/commons";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";

const mockGetCommonsIndex = getCommonsIndex as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sitemap", () => {
  it("includes static pages and all commons wiki pages", async () => {
    const entries: CommonsEntry[] = [
      {
        tenant: "system",
        slug: "typescript",
        title: "TypeScript",
        summary: "A typed JS superset",
        updated: "2025-06-01T00:00:00Z",
      },
      {
        tenant: "system",
        slug: "rust",
        title: "Rust",
        summary: "Systems language",
        updated: "2025-07-15T12:00:00Z",
      },
    ];
    mockGetCommonsIndex.mockResolvedValue(entries);

    const result = await sitemap();

    // Static pages: /, /about, /wiki
    expect(result.length).toBe(3 + entries.length);
    expect(result[0].url).toBe("https://yopedia.yolog.dev/");
    expect(result[1].url).toBe("https://yopedia.yolog.dev/about");
    expect(result[2].url).toBe("https://yopedia.yolog.dev/wiki");

    // Dynamic wiki pages
    expect(result[3].url).toBe("https://yopedia.yolog.dev/wiki/typescript");
    expect(result[3].lastModified).toBe("2025-06-01T00:00:00Z");
    expect(result[4].url).toBe("https://yopedia.yolog.dev/wiki/rust");
    expect(result[4].lastModified).toBe("2025-07-15T12:00:00Z");
  });

  it("handles entries without an updated date", async () => {
    const entries: CommonsEntry[] = [
      {
        tenant: "system",
        slug: "no-date",
        title: "No date",
        summary: "Missing updated",
      },
    ];
    mockGetCommonsIndex.mockResolvedValue(entries);

    const result = await sitemap();
    const page = result.find(
      (r) => r.url === "https://yopedia.yolog.dev/wiki/no-date",
    );
    expect(page).toBeDefined();
    expect(page!.lastModified).toBeUndefined();
  });

  it("returns only static pages when the commons is empty", async () => {
    mockGetCommonsIndex.mockResolvedValue([]);

    const result = await sitemap();
    expect(result.length).toBe(3);
  });

  it("caps output at 50,000 URLs", async () => {
    // Build a large mock set — only need to verify the cap logic
    const bigList: CommonsEntry[] = Array.from({ length: 50_000 }, (_, i) => ({
      tenant: "system",
      slug: `page-${i}`,
      title: `Page ${i}`,
      summary: `Summary ${i}`,
    }));
    mockGetCommonsIndex.mockResolvedValue(bigList);

    const result = await sitemap();
    // 3 static + 50,000 dynamic = 50,003 → capped to 50,000
    expect(result.length).toBe(50_000);
  });
});

describe("robots", () => {
  it("returns robots config allowing /wiki/ and disallowing private paths", () => {
    const result = robots();

    expect(result.sitemap).toBe("https://yopedia.yolog.dev/sitemap.xml");
    expect(result.rules).toBeDefined();

    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const mainRule = rules[0];
    expect(mainRule.userAgent).toBe("*");
    expect(mainRule.allow).toBe("/wiki/");

    const disallowed = Array.isArray(mainRule.disallow)
      ? mainRule.disallow
      : [mainRule.disallow];
    expect(disallowed).toContain("/api/");
    expect(disallowed).toContain("/vault/");
    expect(disallowed).toContain("/settings/");
  });
});
