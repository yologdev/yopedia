import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { IndexEntry } from "../types";

// ---------------------------------------------------------------------------
// Mock LLM and embeddings (same pattern as query.test.ts)
// ---------------------------------------------------------------------------
vi.mock("../llm", () => ({
  hasLLMKey: vi.fn(() => false),
  callLLM: vi.fn(async () => "mocked response"),
}));

vi.mock("../embeddings", () => ({
  searchByVector: vi.fn(async () => []),
  upsertEmbedding: vi.fn(async () => {}),
  removeEmbedding: vi.fn(async () => {}),
}));

import { hasLLMKey } from "../llm";
import { searchByVector } from "../embeddings";
import {
  selectPagesForQuery,
  searchIndex,
  buildContext,
} from "../query-search";
import { writeWikiPage, ensureDirectories } from "../wiki";
import * as wikiModule from "../wiki";

const mockedHasLLMKey = vi.mocked(hasLLMKey);
const mockedSearchByVector = vi.mocked(searchByVector);

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------
let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "query-search-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;

  mockedHasLLMKey.mockReturnValue(false);
  mockedSearchByVector.mockReset();
  mockedSearchByVector.mockResolvedValue([]);
});

afterEach(async () => {
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  if (originalRawDir === undefined) {
    delete process.env.RAW_DIR;
  } else {
    process.env.RAW_DIR = originalRawDir;
  }
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// selectPagesForQuery — scoped search
// ---------------------------------------------------------------------------
describe("selectPagesForQuery — scoped search", () => {
  it("returns all entries when no scopeSlugs provided (small wiki)", async () => {
    const entries: IndexEntry[] = [
      { slug: "alpha", title: "Alpha", summary: "Alpha page about neural networks" },
      { slug: "beta", title: "Beta", summary: "Beta page about transformers" },
      { slug: "gamma", title: "Gamma", summary: "Gamma page about attention" },
    ];
    const result = await selectPagesForQuery("neural networks", entries);
    // Small wiki (≤5 pages) returns all slugs
    expect(result).toEqual(["alpha", "beta", "gamma"]);
  });

  it("restricts returned slugs to scopeSlugs when provided", async () => {
    const entries: IndexEntry[] = [
      { slug: "alpha", title: "Alpha", summary: "Alpha neural networks" },
      { slug: "beta", title: "Beta", summary: "Beta transformers" },
      { slug: "gamma", title: "Gamma", summary: "Gamma attention" },
      { slug: "delta", title: "Delta", summary: "Delta embeddings" },
    ];
    const result = await selectPagesForQuery("neural networks", entries, ["alpha", "gamma"]);
    // Only alpha and gamma are in scope — small filtered set returns all
    expect(result).toEqual(["alpha", "gamma"]);
    expect(result).not.toContain("beta");
    expect(result).not.toContain("delta");
  });

  it("returns empty array when scopeSlugs filters out all entries", async () => {
    const entries: IndexEntry[] = [
      { slug: "alpha", title: "Alpha", summary: "Alpha neural networks" },
      { slug: "beta", title: "Beta", summary: "Beta transformers" },
    ];
    // Scope slugs that don't match any entries
    const result = await selectPagesForQuery("anything", entries, ["nonexistent", "missing"]);
    expect(result).toEqual([]);
  });

  it("handles empty scopeSlugs array (returns nothing)", async () => {
    const entries: IndexEntry[] = [
      { slug: "alpha", title: "Alpha", summary: "Alpha page" },
    ];
    const result = await selectPagesForQuery("anything", entries, []);
    expect(result).toEqual([]);
  });

  it("handles scope referencing deleted pages gracefully", async () => {
    // Agent references pages that no longer exist in the index
    const entries: IndexEntry[] = [
      { slug: "existing-page", title: "Existing", summary: "Exists" },
    ];
    // scopeSlugs include a page that's in entries and one that isn't
    const result = await selectPagesForQuery("anything", entries, ["existing-page", "deleted-page"]);
    // Only the existing page is returned
    expect(result).toEqual(["existing-page"]);
  });

  it("works with larger wikis using BM25 scoring within scope", async () => {
    // Create enough entries to exceed SMALL_WIKI_THRESHOLD (5)
    const entries: IndexEntry[] = [
      { slug: "nn", title: "Neural Networks", summary: "Deep learning neural network architectures" },
      { slug: "transformers", title: "Transformers", summary: "Transformer architecture attention" },
      { slug: "cnn", title: "CNN", summary: "Convolutional neural networks for images" },
      { slug: "rnn", title: "RNN", summary: "Recurrent neural networks for sequences" },
      { slug: "gan", title: "GAN", summary: "Generative adversarial networks" },
      { slug: "vae", title: "VAE", summary: "Variational autoencoders" },
      { slug: "bert", title: "BERT", summary: "Bidirectional encoder representations from transformers" },
    ];

    // Scope to only 3 pages — filtered set is small enough to return all
    const scoped = await selectPagesForQuery("neural networks", entries, ["nn", "cnn", "rnn"]);
    expect(scoped.length).toBeLessThanOrEqual(3);
    for (const slug of scoped) {
      expect(["nn", "cnn", "rnn"]).toContain(slug);
    }
  });

  it("uses BM25 ranking within a large scope", async () => {
    // Create >5 entries all in scope to force BM25 ranking
    const entries: IndexEntry[] = Array.from({ length: 8 }, (_, i) => ({
      slug: `page-${i}`,
      title: `Page ${i}`,
      summary: i === 0 ? "neural networks deep learning" : `topic ${i} unrelated content`,
    }));
    const allSlugs = entries.map((e) => e.slug);

    // Scope includes all pages; since >5 pages, BM25 kicks in
    const result = await selectPagesForQuery("neural networks", entries, allSlugs);
    // The page about neural networks should be ranked first
    expect(result[0]).toBe("page-0");
  });
});

// ---------------------------------------------------------------------------
// buildContext — with scoped pages
// ---------------------------------------------------------------------------
describe("buildContext — scoped pages", () => {
  it("returns context only from specified slugs", async () => {
    await ensureDirectories();
    await writeWikiPage("alpha", "# Alpha\n\nAlpha content about AI.");
    await writeWikiPage("beta", "# Beta\n\nBeta content about ML.");
    await writeWikiPage("gamma", "# Gamma\n\nGamma content about NLP.");

    const { context, slugs } = await buildContext(["alpha", "gamma"]);
    expect(slugs).toEqual(["alpha", "gamma"]);
    expect(context).toContain("Alpha content");
    expect(context).toContain("Gamma content");
    expect(context).not.toContain("Beta content");
  });

  it("skips slugs for pages that don't exist on disk", async () => {
    await ensureDirectories();
    await writeWikiPage("real", "# Real\n\nReal content.");

    const { context, slugs } = await buildContext(["real", "nonexistent"]);
    expect(slugs).toEqual(["real"]);
    expect(context).toContain("Real content");
  });

  it("returns empty context for empty slug list", async () => {
    const { context, slugs } = await buildContext([]);
    expect(context).toBe("");
    expect(slugs).toEqual([]);
  });

  it("returns empty context when all slugs reference deleted pages", async () => {
    await ensureDirectories();
    // No pages written — all references are to nonexistent pages
    const { context, slugs } = await buildContext(["ghost1", "ghost2"]);
    expect(context).toBe("");
    expect(slugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildContext — confidence and expiry annotations
// ---------------------------------------------------------------------------
describe("buildContext — confidence and expiry annotations", () => {
  it("includes confidence in the page header", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "high-conf",
      "---\nconfidence: 0.95\n---\n\n# High Confidence\n\nTrusted content.",
    );
    const { context } = await buildContext(["high-conf"]);
    expect(context).toContain("confidence: 0.95");
    expect(context).toContain("=== Page: High Confidence");
  });

  it("includes expiry in the page header", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "with-expiry",
      "---\nexpiry: 2030-06-15\n---\n\n# With Expiry\n\nFuture content.",
    );
    const { context } = await buildContext(["with-expiry"]);
    expect(context).toContain("expires: 2030-06-15");
  });

  it("marks expired pages with [EXPIRED] marker", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "old-page",
      "---\nexpiry: 2020-01-01\n---\n\n# Old Page\n\nStale content.",
    );
    const { context } = await buildContext(["old-page"]);
    expect(context).toContain("[EXPIRED — review before citing]");
  });

  it("does not mark future-expiry pages as expired", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "fresh-page",
      "---\nexpiry: 2099-12-31\n---\n\n# Fresh Page\n\nFresh content.",
    );
    const { context } = await buildContext(["fresh-page"]);
    expect(context).not.toContain("[EXPIRED");
  });

  it("marks low-confidence pages with [LOW CONFIDENCE] marker", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "uncertain",
      "---\nconfidence: 0.3\n---\n\n# Uncertain\n\nUncertain content.",
    );
    const { context } = await buildContext(["uncertain"]);
    expect(context).toContain("[LOW CONFIDENCE — treat as uncertain]");
  });

  it("does not mark pages at or above 0.5 confidence as low", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "ok-conf",
      "---\nconfidence: 0.5\n---\n\n# OK Confidence\n\nDecent content.",
    );
    const { context } = await buildContext(["ok-conf"]);
    expect(context).not.toContain("[LOW CONFIDENCE");
  });

  it("marks pages that are both expired and low-confidence", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "bad-page",
      "---\nconfidence: 0.2\nexpiry: 2020-06-01\n---\n\n# Bad Page\n\nBad content.",
    );
    const { context } = await buildContext(["bad-page"]);
    expect(context).toContain("[EXPIRED — review before citing]");
    expect(context).toContain("[LOW CONFIDENCE — treat as uncertain]");
  });

  it("uses frontmatter-stripped body (not raw content) in context", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "fm-page",
      "---\nconfidence: 0.8\ntags: [ai]\n---\n\n# FM Page\n\nBody only.",
    );
    const { context } = await buildContext(["fm-page"]);
    // Body should appear
    expect(context).toContain("Body only.");
    // Raw frontmatter delimiters should NOT appear
    expect(context).not.toContain("tags: [ai]");
  });

  it("handles pages without confidence or expiry gracefully", async () => {
    await ensureDirectories();
    await writeWikiPage("plain", "# Plain\n\nNo frontmatter at all.");
    const { context } = await buildContext(["plain"]);
    expect(context).toContain("=== Page: Plain");
    expect(context).toContain("slug: plain");
    expect(context).not.toContain("confidence:");
    expect(context).not.toContain("expires:");
    expect(context).not.toContain("[EXPIRED");
    expect(context).not.toContain("[LOW CONFIDENCE");
    expect(context).not.toContain("[DISPUTED");
    expect(context).not.toContain("[SUPERSEDED BY:");
  });
});

// ---------------------------------------------------------------------------
// buildContext — disputed and supersedes annotations
// ---------------------------------------------------------------------------
describe("buildContext — disputed and supersedes annotations", () => {
  it("marks disputed pages with [DISPUTED] marker", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "contested",
      "---\ndisputed: true\n---\n\n# Contested\n\nDisputed content.",
    );
    const { context } = await buildContext(["contested"]);
    expect(context).toContain("[DISPUTED — claims under discussion]");
  });

  it("does not mark non-disputed pages with [DISPUTED] marker", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "agreed",
      "---\ndisputed: false\n---\n\n# Agreed\n\nAgreed content.",
    );
    const { context } = await buildContext(["agreed"]);
    expect(context).not.toContain("[DISPUTED");
  });

  it("does not mark pages without disputed field", async () => {
    await ensureDirectories();
    await writeWikiPage("no-disputed", "# No Disputed\n\nPlain content.");
    const { context } = await buildContext(["no-disputed"]);
    expect(context).not.toContain("[DISPUTED");
  });

  it("marks superseded page when a loaded page has supersedes pointing to it", async () => {
    await ensureDirectories();
    await writeWikiPage("old-version", "# Old Version\n\nOutdated content.");
    await writeWikiPage(
      "new-version",
      "---\nsupersedes: old-version\n---\n\n# New Version\n\nUpdated content.",
    );
    const { context } = await buildContext(["old-version", "new-version"]);
    expect(context).toContain("[SUPERSEDED BY: new-version]");
    // The superseding page should NOT have the superseded marker
    expect(context).not.toContain("[SUPERSEDED BY: old-version]");
  });

  it("includes supersedes in header metadata of the superseding page", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "replacement",
      "---\nsupersedes: original\n---\n\n# Replacement\n\nNew content.",
    );
    const { context } = await buildContext(["replacement"]);
    expect(context).toContain("supersedes: original");
  });

  it("does not add superseded marker when superseding page is not loaded", async () => {
    await ensureDirectories();
    await writeWikiPage("old-only", "# Old Only\n\nContent.");
    // The page that supersedes old-only exists but is not in the loaded slugs
    await writeWikiPage(
      "new-only",
      "---\nsupersedes: old-only\n---\n\n# New Only\n\nNew content.",
    );
    const { context } = await buildContext(["old-only"]);
    // Without new-only loaded, we can't know old-only is superseded
    expect(context).not.toContain("[SUPERSEDED BY:");
  });

  it("combines disputed and superseded markers on the same page", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "troubled",
      "---\ndisputed: true\n---\n\n# Troubled\n\nControversial and outdated.",
    );
    await writeWikiPage(
      "better",
      "---\nsupersedes: troubled\n---\n\n# Better\n\nImproved content.",
    );
    const { context } = await buildContext(["troubled", "better"]);
    expect(context).toContain("[DISPUTED — claims under discussion]");
    expect(context).toContain("[SUPERSEDED BY: better]");
  });

  it("combines all four markers (expired, low confidence, disputed, superseded)", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "worst-page",
      "---\nconfidence: 0.1\nexpiry: 2020-01-01\ndisputed: true\n---\n\n# Worst Page\n\nBad content.",
    );
    await writeWikiPage(
      "better-page",
      "---\nsupersedes: worst-page\n---\n\n# Better Page\n\nGood content.",
    );
    const { context } = await buildContext(["worst-page", "better-page"]);
    expect(context).toContain("[EXPIRED — review before citing]");
    expect(context).toContain("[LOW CONFIDENCE — treat as uncertain]");
    expect(context).toContain("[DISPUTED — claims under discussion]");
    expect(context).toContain("[SUPERSEDED BY: better-page]");
  });

  it("includes verified date when valid_from is set", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "verified-page",
      "---\nvalid_from: 2025-03-15\nsource_count: 2\n---\n\n# Verified Page\n\nContent.",
    );
    const { context } = await buildContext(["verified-page"]);
    expect(context).toContain("verified: 2025-03-15");
  });

  it("includes source count when source_count > 0", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "sourced-page",
      "---\nsource_count: 3\n---\n\n# Sourced Page\n\nContent.",
    );
    const { context } = await buildContext(["sourced-page"]);
    expect(context).toContain("sources: 3");
  });

  it("does not include sources header when source_count is 0", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "zero-sources",
      "---\nsource_count: 0\n---\n\n# Zero Sources\n\nContent.",
    );
    const { context } = await buildContext(["zero-sources"]);
    expect(context).not.toMatch(/sources: 0/);
  });

  it("adds NO SOURCES marker when source_count is 0 and no sources field", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "unsourced",
      "---\nsource_count: 0\n---\n\n# Unsourced\n\nContent.",
    );
    const { context } = await buildContext(["unsourced"]);
    expect(context).toContain("[NO SOURCES — provenance unknown]");
  });

  it("adds NO SOURCES marker when source_count is missing and no sources field", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "no-meta",
      "---\n---\n\n# No Meta\n\nContent.",
    );
    const { context } = await buildContext(["no-meta"]);
    expect(context).toContain("[NO SOURCES — provenance unknown]");
  });

  it("does not add NO SOURCES marker when sources JSON field is present", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "has-sources-json",
      '---\nsources: "[{\\"type\\":\\"url\\",\\"url\\":\\"https://example.com\\"}]"\n---\n\n# Has Sources\n\nContent.',
    );
    const { context } = await buildContext(["has-sources-json"]);
    expect(context).not.toContain("[NO SOURCES — provenance unknown]");
  });

  it("does not add NO SOURCES marker when source_count > 0", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "has-count",
      "---\nsource_count: 2\n---\n\n# Has Count\n\nContent.",
    );
    const { context } = await buildContext(["has-count"]);
    expect(context).not.toContain("[NO SOURCES — provenance unknown]");
  });

  it("handles source_count as string (legacy format)", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "legacy-count",
      "---\nsource_count: 5\n---\n\n# Legacy Count\n\nContent.",
    );
    const { context } = await buildContext(["legacy-count"]);
    expect(context).toContain("sources: 5");
    expect(context).not.toContain("[NO SOURCES — provenance unknown]");
  });
});

// ---------------------------------------------------------------------------
// buildContext — sourceDetails (#1033)
// ---------------------------------------------------------------------------
describe("buildContext — sourceDetails", () => {
  it("returns sourceDetails matching page frontmatter", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "trusted-page",
      "---\nconfidence: 0.9\nexpiry: 2030-01-01\nsource_count: 3\n---\n\n# Trusted\n\nContent.",
    );
    const { sourceDetails } = await buildContext(["trusted-page"]);
    expect(sourceDetails).toHaveLength(1);
    expect(sourceDetails[0]).toEqual({
      slug: "trusted-page",
      confidence: 0.9,
      expiry: "2030-01-01",
      sourceCount: 3,
    });
  });

  it("includes disputed flag when page is disputed", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "disputed-page",
      "---\nconfidence: 0.4\ndisputed: true\n---\n\n# Disputed\n\nContent.",
    );
    const { sourceDetails } = await buildContext(["disputed-page"]);
    expect(sourceDetails).toHaveLength(1);
    expect(sourceDetails[0]).toEqual({
      slug: "disputed-page",
      confidence: 0.4,
      disputed: true,
    });
  });

  it("omits optional fields when frontmatter is minimal", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "minimal-page",
      "---\n---\n\n# Minimal\n\nContent.",
    );
    const { sourceDetails } = await buildContext(["minimal-page"]);
    expect(sourceDetails).toHaveLength(1);
    expect(sourceDetails[0]).toEqual({ slug: "minimal-page" });
  });

  it("returns empty sourceDetails for empty slugs", async () => {
    const { sourceDetails } = await buildContext([]);
    expect(sourceDetails).toEqual([]);
  });

  it("returns one detail per loaded page", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "page-a",
      "---\nconfidence: 0.8\n---\n\n# A\n\nContent.",
    );
    await writeWikiPage(
      "page-b",
      "---\nconfidence: 0.6\nexpiry: 2025-12-31\ndisputed: true\nsource_count: 2\n---\n\n# B\n\nContent.",
    );
    const { sourceDetails } = await buildContext(["page-a", "page-b"]);
    expect(sourceDetails).toHaveLength(2);
    expect(sourceDetails[0]).toEqual({ slug: "page-a", confidence: 0.8 });
    expect(sourceDetails[1]).toEqual({
      slug: "page-b",
      confidence: 0.6,
      expiry: "2025-12-31",
      disputed: true,
      sourceCount: 2,
    });
  });
});
describe("searchIndex — pre-filtered entries", () => {
  it("returns empty array for empty entries", async () => {
    const result = await searchIndex("neural networks", []);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty query", async () => {
    const entries: IndexEntry[] = [
      { slug: "a", title: "A", summary: "Some content" },
    ];
    const result = await searchIndex("", entries);
    expect(result).toEqual([]);
  });

  it("ranks entries by BM25 relevance", async () => {
    const entries: IndexEntry[] = [
      { slug: "irrelevant", title: "Cooking", summary: "How to make pasta" },
      { slug: "relevant", title: "Neural Networks", summary: "Deep neural networks for learning" },
      { slug: "somewhat", title: "Machine Learning", summary: "Learning algorithms and neural methods" },
    ];
    const result = await searchIndex("neural networks", entries, false);
    expect(result.length).toBeGreaterThan(0);
    // "relevant" should rank first — it has both "neural" and "networks" in title+summary
    expect(result[0]).toBe("relevant");
  });
});

// ---------------------------------------------------------------------------
// searchIndex — full-body BM25 size gate
// ---------------------------------------------------------------------------
describe("searchIndex — full-body size gate", () => {
  it("reads page bodies for a small corpus (≤ BM25_FULLBODY_MAX_PAGES)", async () => {
    await ensureDirectories();
    await writeWikiPage("nn", "# Neural Networks\n\nDeep learning architectures.");
    await writeWikiPage("pasta", "# Pasta\n\nHow to cook pasta.");
    const entries: IndexEntry[] = [
      { slug: "nn", title: "Neural Networks", summary: "intro" },
      { slug: "pasta", title: "Pasta", summary: "food" },
    ];
    const readSpy = vi.spyOn(wikiModule, "readWikiPage");

    // Default fullBody=true and 2 ≤ 200 ⇒ full-body path reads each page.
    const result = await searchIndex("neural networks", entries);
    expect(readSpy).toHaveBeenCalled();
    expect(result[0]).toBe("nn");
    readSpy.mockRestore();
  });

  it("issues ZERO body reads above the gate, still ranking by title+summary", async () => {
    // 201 > 200 ⇒ index-level BM25, no disk reads. No page files written.
    const entries: IndexEntry[] = Array.from({ length: 201 }, (_, i) => ({
      slug: `page-${i}`,
      title: i === 0 ? "Neural Networks" : `Topic ${i}`,
      summary: i === 0 ? "deep neural networks for learning" : `unrelated content ${i}`,
    }));
    const readSpy = vi.spyOn(wikiModule, "readWikiPage");

    const result = await searchIndex("neural networks", entries);
    expect(readSpy).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toBe("page-0");
    readSpy.mockRestore();
  });

  it("honours an explicit fullBody=false even for a small corpus", async () => {
    await ensureDirectories();
    await writeWikiPage("a", "# A\n\nalpha body");
    const entries: IndexEntry[] = [{ slug: "a", title: "A", summary: "alpha" }];
    const readSpy = vi.spyOn(wikiModule, "readWikiPage");

    await searchIndex("alpha", entries, false);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });
});
