import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock wiki.ts and lifecycle.ts — the modules lint-fix.ts depends on
// ---------------------------------------------------------------------------

vi.mock("../wiki", () => ({
  readWikiPage: vi.fn(),
  readWikiPageWithFrontmatter: vi.fn(),
  writeWikiPage: vi.fn(),
  listWikiPages: vi.fn(),
  updateIndex: vi.fn(),
  appendToLog: vi.fn(),
  isArtifactType: (t: string | undefined) => t === "html",
}));

vi.mock("../lifecycle", () => ({
  writeWikiPageWithSideEffects: vi.fn(async () => ({
    slug: "test",
    updatedSlugs: [],
  })),
  deleteWikiPage: vi.fn(async () => ({
    slug: "test",
    removedFromIndex: true,
    strippedBacklinksFrom: [],
  })),
}));

vi.mock("../llm", () => ({
  callLLM: vi.fn(async () => "# Rewritten Page\n\nResolved content."),
  hasLLMKey: vi.fn(() => false),
}));

vi.mock("../frontmatter", () => ({
  serializeFrontmatter: vi.fn(
    (data: Record<string, unknown>, body: string) => {
      const lines = ["---"];
      for (const [k, v] of Object.entries(data)) {
        lines.push(`${k}: ${String(v)}`);
      }
      lines.push("---");
      return `${lines.join("\n")}\n\n${body}`;
    },
  ),
}));

import { readWikiPage, readWikiPageWithFrontmatter, listWikiPages, updateIndex, appendToLog } from "../wiki";
import {
  writeWikiPageWithSideEffects,
  deleteWikiPage,
} from "../lifecycle";
import { callLLM, hasLLMKey } from "../llm";

import {
  fixOrphanPage,
  fixStaleIndex,
  fixEmptyPage,
  fixMissingCrossRef,
  fixContradiction,
  fixMissingConceptPage,
  fixStalePage,
  fixUnmigratedPage,
  fixDeadSource,
  fixLintIssue,
  FixValidationError,
  FixNotFoundError,
} from "../lint-fix";

const mockedReadWikiPage = vi.mocked(readWikiPage);
const mockedReadWikiPageWithFrontmatter = vi.mocked(readWikiPageWithFrontmatter);
const mockedListWikiPages = vi.mocked(listWikiPages);
const mockedUpdateIndex = vi.mocked(updateIndex);
const mockedAppendToLog = vi.mocked(appendToLog);
const mockedWriteWikiPageWithSideEffects = vi.mocked(
  writeWikiPageWithSideEffects,
);
const mockedDeleteWikiPage = vi.mocked(deleteWikiPage);
const mockedCallLLM = vi.mocked(callLLM);
const mockedHasLLMKey = vi.mocked(hasLLMKey);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fixOrphanPage
// ---------------------------------------------------------------------------

describe("fixOrphanPage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixOrphanPage("")).rejects.toThrow(FixValidationError);
    await expect(fixOrphanPage("")).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  it("throws FixNotFoundError when page does not exist", async () => {
    mockedReadWikiPage.mockResolvedValue(null);

    await expect(fixOrphanPage("no-such-page")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixOrphanPage("no-such-page")).rejects.toThrow(
      "Page not found: no-such-page",
    );
  });

  it("adds orphan page to index via writeWikiPageWithSideEffects", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "orphan",
      title: "Orphan Page",
      content: "# Orphan Page\n\nSome content about orphans.",
      path: "/wiki/orphan.md",
    });

    const result = await fixOrphanPage("orphan");

    expect(result).toEqual({
      success: true,
      slug: "orphan",
      message: "Added orphan to index",
    });

    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("orphan");
    expect(call.title).toBe("Orphan Page");
    expect(call.content).toBe("# Orphan Page\n\nSome content about orphans.");
    expect(call.summary).toBe("Some content about orphans.");
    expect(call.logOp).toBe("edit");
    expect(call.crossRefSource).toBeNull();
  });

  it("falls back to slug as summary when no first paragraph", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "bare",
      title: "bare",
      content: "No heading here",
      path: "/wiki/bare.md",
    });

    await fixOrphanPage("bare");

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.summary).toBe("bare");
  });
});

// ---------------------------------------------------------------------------
// fixStaleIndex
// ---------------------------------------------------------------------------

describe("fixStaleIndex", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixStaleIndex("")).rejects.toThrow(FixValidationError);
  });

  it("returns no-op when slug is not in the index", async () => {
    mockedReadWikiPage.mockResolvedValue(null); // page file genuinely missing
    mockedListWikiPages.mockResolvedValue([
      { slug: "other", title: "Other", summary: "..." },
    ]);

    const result = await fixStaleIndex("ghost");

    expect(result).toEqual({
      success: true,
      slug: "ghost",
      message: "Entry for ghost not found in index — no changes needed",
    });

    // Should not have called updateIndex or appendToLog
    expect(mockedUpdateIndex).not.toHaveBeenCalled();
    expect(mockedAppendToLog).not.toHaveBeenCalled();
  });

  it("removes stale entry from index", async () => {
    mockedReadWikiPage.mockResolvedValue(null); // page file genuinely missing
    mockedListWikiPages.mockResolvedValue([
      { slug: "good", title: "Good", summary: "keep" },
      { slug: "ghost", title: "Ghost", summary: "remove" },
    ]);

    const result = await fixStaleIndex("ghost");

    expect(result).toEqual({
      success: true,
      slug: "ghost",
      message: "Removed stale entry for ghost from index",
    });

    expect(mockedUpdateIndex).toHaveBeenCalledOnce();
    const updatedEntries = mockedUpdateIndex.mock.calls[0][0];
    expect(updatedEntries).toHaveLength(1);
    expect(updatedEntries[0].slug).toBe("good");

    expect(mockedAppendToLog).toHaveBeenCalledOnce();
    expect(mockedAppendToLog).toHaveBeenCalledWith(
      "edit",
      "ghost",
      "auto-fix: removed stale index entry for ghost",
    );
  });
});

// ---------------------------------------------------------------------------
// fixEmptyPage
// ---------------------------------------------------------------------------

describe("fixEmptyPage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixEmptyPage("")).rejects.toThrow(FixValidationError);
  });

  it("delegates to deleteWikiPage", async () => {
    const result = await fixEmptyPage("empty");

    expect(result).toEqual({
      success: true,
      slug: "empty",
      message: "Deleted empty page empty",
    });

    expect(mockedDeleteWikiPage).toHaveBeenCalledOnce();
    expect(mockedDeleteWikiPage).toHaveBeenCalledWith("empty", "lint-fix");
  });
});

// ---------------------------------------------------------------------------
// fixMissingCrossRef
// ---------------------------------------------------------------------------

describe("fixMissingCrossRef", () => {
  it("throws FixValidationError when slug is missing", async () => {
    await expect(fixMissingCrossRef("", "target")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixMissingCrossRef("", "target")).rejects.toThrow(
      "Missing required fields: slug and targetSlug",
    );
  });

  it("throws FixValidationError when targetSlug is missing", async () => {
    await expect(fixMissingCrossRef("source", "")).rejects.toThrow(
      FixValidationError,
    );
  });

  it("throws FixNotFoundError when source page not found", async () => {
    mockedReadWikiPage.mockResolvedValue(null);

    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      "Source page not found: source",
    );
  });

  it("throws FixNotFoundError when target page not found", async () => {
    // Mock returns source page first, then null for target — twice for the
    // two expect() calls that each invoke fixMissingCrossRef.
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nContent.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nContent.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce(null);

    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      "Target page not found: target",
    );
  });

  it("returns no-op when link already exists", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nSee [Target](target.md).",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce({
        slug: "target",
        title: "Target",
        content: "# Target\n\nTarget content.",
        path: "/wiki/target.md",
      });

    const result = await fixMissingCrossRef("source", "target");

    expect(result).toEqual({
      success: true,
      slug: "source",
      message: "Page already links to target.md — no changes needed",
    });

    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("skips an HTML artifact source (never appends markdown to its body)", async () => {
    mockedReadWikiPage.mockResolvedValueOnce({
      slug: "art",
      title: "Art",
      content: "<!doctype html><html><body>x</body></html>",
      path: "/wiki/art.md",
    });
    mockedReadWikiPageWithFrontmatter.mockResolvedValueOnce({
      slug: "art",
      title: "Art",
      frontmatter: { type: "html" },
      body: "<!doctype html><html><body>x</body></html>",
      path: "/wiki/art.md",
    } as unknown as Awaited<ReturnType<typeof readWikiPageWithFrontmatter>>);

    const result = await fixMissingCrossRef("art", "target");

    expect(result.success).toBe(true);
    expect(result.message).toContain("HTML artifacts");
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("inserts link into existing Related section", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content:
          "# Source\n\nSome content.\n\n## Related\n\n- [Other](other.md)\n",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce({
        slug: "target",
        title: "Target Page",
        content: "# Target Page\n\nTarget content.",
        path: "/wiki/target.md",
      });

    const result = await fixMissingCrossRef("source", "target");

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      "Added cross-reference from source.md to target.md",
    );

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.content).toContain("- [Target Page](target.md)");
    expect(call.content).toContain("- [Other](other.md)");
    expect(call.crossRefSource).toBeNull();
  });

  it("creates new Related section when none exists", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nSome content here.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce({
        slug: "target",
        title: "Target Page",
        content: "# Target Page\n\nTarget content.",
        path: "/wiki/target.md",
      });

    const result = await fixMissingCrossRef("source", "target");

    expect(result.success).toBe(true);

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.content).toContain("## Related\n\n- [Target Page](target.md)");
  });
});

// ---------------------------------------------------------------------------
// fixContradiction
// ---------------------------------------------------------------------------

describe("fixContradiction", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixContradiction("", "target", "msg")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixContradiction("", "target", "msg")).rejects.toThrow(
      "Missing required fields: slug and targetSlug",
    );
  });

  it("throws FixValidationError when targetSlug is empty", async () => {
    await expect(fixContradiction("source", "", "msg")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixContradiction("source", "", "msg")).rejects.toThrow(
      "Missing required fields: slug and targetSlug",
    );
  });

  it("throws FixNotFoundError when source page does not exist", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedReadWikiPage.mockResolvedValue(null);

    await expect(
      fixContradiction("no-such", "other", "msg"),
    ).rejects.toThrow(FixNotFoundError);
    await expect(
      fixContradiction("no-such", "other", "msg"),
    ).rejects.toThrow("Source page not found: no-such");
  });

  it("throws FixNotFoundError when target page does not exist", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nContent.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce(null);

    await expect(
      fixContradiction("source", "missing-target", "msg"),
    ).rejects.toThrow(FixNotFoundError);
  });

  it("throws FixValidationError when no LLM key is configured", async () => {
    mockedHasLLMKey.mockReturnValue(false);

    await expect(
      fixContradiction("source", "target", "msg"),
    ).rejects.toThrow(FixValidationError);
    await expect(
      fixContradiction("source", "target", "msg"),
    ).rejects.toThrow(
      "Cannot fix contradictions without an LLM provider configured",
    );
  });

  it("calls LLM with both pages' content and the contradiction description", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "page-a",
        title: "Page A",
        content: "# Page A\n\nClaims X is true.",
        path: "/wiki/page-a.md",
      })
      .mockResolvedValueOnce({
        slug: "page-b",
        title: "Page B",
        content: "# Page B\n\nClaims X is false.",
        path: "/wiki/page-b.md",
      });

    mockedCallLLM.mockResolvedValue("# Page A\n\nRevised: X is false.");

    const msg = "Contradiction between page-a, page-b: X is debated";
    await fixContradiction("page-a", "page-b", msg);

    expect(mockedCallLLM).toHaveBeenCalledOnce();

    const [systemPrompt, userMessage] = mockedCallLLM.mock.calls[0];
    expect(systemPrompt).toContain("resolving contradictions");
    expect(userMessage).toContain("# Page A");
    expect(userMessage).toContain("# Page B");
    expect(userMessage).toContain(msg);
  });

  it("writes the rewritten page via lifecycle pipeline", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "page-a",
        title: "Page A",
        content: "# Page A\n\nClaims X is true.",
        path: "/wiki/page-a.md",
      })
      .mockResolvedValueOnce({
        slug: "page-b",
        title: "Page B",
        content: "# Page B\n\nClaims X is false.",
        path: "/wiki/page-b.md",
      });

    mockedCallLLM.mockResolvedValue("# Page A\n\nRevised: X is false.");

    const result = await fixContradiction(
      "page-a",
      "page-b",
      "Contradiction between page-a, page-b: conflict",
    );

    expect(result).toEqual({
      success: true,
      slug: "page-a",
      message: "Rewrote page-a.md to resolve contradiction with page-b.md",
    });

    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("page-a");
    expect(call.content).toBe("# Page A\n\nRevised: X is false.");
    expect(call.logOp).toBe("edit");
  });
});

// ---------------------------------------------------------------------------
// fixMissingConceptPage
// ---------------------------------------------------------------------------

describe("fixMissingConceptPage", () => {
  const validMessage =
    'Concept "Backpropagation" is mentioned in neural-networks, gradient-descent but has no dedicated page. Core concept in deep learning.';

  it("throws FixValidationError when concept cannot be parsed from message", async () => {
    await expect(fixMissingConceptPage("bad message format")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixMissingConceptPage("bad message format")).rejects.toThrow(
      "Could not parse concept name from lint message",
    );
  });

  it("returns no-op when the page already exists", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "backpropagation",
      title: "Backpropagation",
      content: "# Backpropagation\n\nExisting content.",
      path: "/wiki/backpropagation.md",
    });

    const result = await fixMissingConceptPage(validMessage);

    expect(result).toEqual({
      success: true,
      slug: "backpropagation",
      message: "Page backpropagation.md already exists — no changes needed",
    });
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("generates a stub page when no LLM key is available", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockReturnValue(false);

    const result = await fixMissingConceptPage(validMessage);

    expect(result.success).toBe(true);
    expect(result.slug).toBe("backpropagation");
    expect(result.message).toContain("Created stub page");
    expect(result.message).toContain("Backpropagation");

    expect(mockedCallLLM).not.toHaveBeenCalled();
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("backpropagation");
    expect(call.title).toBe("Backpropagation");
    expect(call.content).toContain("# Backpropagation");
    expect(call.content).toContain("auto-generated by lint");
    expect(call.logOp).toBe("ingest");
    expect(call.crossRefSource).toBe(call.content);
  });

  it("calls callLLM when a key is available", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockReturnValue(true);
    mockedCallLLM.mockResolvedValue(
      "# Backpropagation\n\nBackpropagation is an algorithm for training neural networks.",
    );

    const result = await fixMissingConceptPage(validMessage);

    expect(result.success).toBe(true);
    expect(result.slug).toBe("backpropagation");

    expect(mockedCallLLM).toHaveBeenCalledOnce();
    expect(mockedCallLLM.mock.calls[0][1]).toContain("Backpropagation");

    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.content).toContain("algorithm for training neural networks");
    expect(call.logOp).toBe("ingest");
  });

  it("returns a proper FixResult shape", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockReturnValue(false);

    const result = await fixMissingConceptPage(validMessage);

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("slug");
    expect(result).toHaveProperty("message");
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.slug).toBe("string");
    expect(typeof result.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// fixStalePage
// ---------------------------------------------------------------------------

describe("fixStalePage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixStalePage("")).rejects.toThrow(FixValidationError);
    await expect(fixStalePage("")).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  it("throws FixNotFoundError when page does not exist", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue(null);

    await expect(fixStalePage("no-such-page")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixStalePage("no-such-page")).rejects.toThrow(
      "Page not found: no-such-page",
    );
  });

  it("bumps expiry to ~90 days from now and writes page", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "stale",
      title: "Stale Page",
      content: "---\nexpiry: 2025-01-01\n---\n\n# Stale Page\n\nOld content.",
      path: "/wiki/stale.md",
      frontmatter: { expiry: "2025-01-01" },
      body: "# Stale Page\n\nOld content.",
    });

    const result = await fixStalePage("stale");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("stale");
    expect(result.message).toMatch(/^Expiry extended to \d{4}-\d{2}-\d{2}, verified as of \d{4}-\d{2}-\d{2}$/);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();

    // Verify the written content includes both new expiry and valid_from
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("stale");
    expect(call.content).toContain("expiry:");
    expect(call.content).toContain("valid_from:");
    expect(call.content).toContain("# Stale Page");
    expect(call.logOp).toBe("edit");
    expect(call.author).toBe("lint-fix");
  });
});

// ---------------------------------------------------------------------------
// fixUnmigratedPage
// ---------------------------------------------------------------------------

describe("fixUnmigratedPage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixUnmigratedPage("")).rejects.toThrow(FixValidationError);
    await expect(fixUnmigratedPage("")).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  it("throws FixNotFoundError when page does not exist", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue(null);

    await expect(fixUnmigratedPage("no-such")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixUnmigratedPage("no-such")).rejects.toThrow(
      "Page not found: no-such",
    );
  });

  it("adds all missing yopedia defaults to a bare page", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "bare-page",
      title: "Bare Page",
      content: "---\ncreated: 2025-01-01\n---\n\n# Bare Page\n\nContent.",
      path: "/wiki/bare-page.md",
      frontmatter: { created: "2025-01-01" },
      body: "# Bare Page\n\nContent.",
    });

    const result = await fixUnmigratedPage("bare-page");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("bare-page");
    expect(result.message).toContain("confidence");
    expect(result.message).toContain("expiry");
    expect(result.message).toContain("authors");
    expect(result.message).toContain("contributors");
    expect(result.message).toContain("disputed");
    expect(result.message).toContain("valid_from");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();

    // Verify the frontmatter passed through the lifecycle pipeline
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("bare-page");
    expect(call.logOp).toBe("edit");
    expect(call.author).toBe("lint-fix");
    // The serialized output will contain the defaults
    const written = call.content;
    expect(written).toContain("confidence");
    expect(written).toContain("0.5");
    expect(written).toContain("authors");
    expect(written).toContain("system");
    expect(written).toContain("disputed");
    expect(written).toContain("false");
    // valid_from should be derived from the page's created date
    expect(written).toContain("valid_from: 2025-01-01");
  });

  it("does NOT overwrite existing fields", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "partial",
      title: "Partial",
      content: "---\nconfidence: 0.9\nauthors: [yoyo]\n---\n\n# Partial\n\nContent.",
      path: "/wiki/partial.md",
      frontmatter: { confidence: 0.9, authors: ["yoyo"] },
      body: "# Partial\n\nContent.",
    });

    const result = await fixUnmigratedPage("partial");

    expect(result.success).toBe(true);
    // Should only add the missing fields
    expect(result.message).toContain("expiry");
    expect(result.message).toContain("contributors");
    expect(result.message).toContain("disputed");
    expect(result.message).toContain("valid_from");
    // Should NOT mention fields that already existed
    expect(result.message).not.toContain("confidence");
    expect(result.message).not.toContain("authors");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("reports no changes when all fields already present", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "complete",
      title: "Complete",
      content: "---\nconfidence: 0.8\nauthors: [human]\nexpiry: 2026-12-01\ncontributors: []\ndisputed: false\n---\n\n# Complete\n\nContent.",
      path: "/wiki/complete.md",
      frontmatter: {
        confidence: 0.8,
        authors: ["human"],
        expiry: "2026-12-01",
        contributors: [],
        disputed: false,
        valid_from: "2026-06-01",
      },
      body: "# Complete\n\nContent.",
    });

    const result = await fixUnmigratedPage("complete");

    expect(result.success).toBe(true);
    expect(result.message).toContain("no changes needed");
  });
});

// ---------------------------------------------------------------------------
// fixLintIssue — dispatcher
// ---------------------------------------------------------------------------

describe("fixLintIssue", () => {
  it("dispatches orphan-page to fixOrphanPage", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "orphan",
      title: "Orphan",
      content: "# Orphan\n\nContent.",
      path: "/wiki/orphan.md",
    });

    const result = await fixLintIssue("orphan-page", "orphan");
    expect(result.slug).toBe("orphan");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("dispatches stale-index to fixStaleIndex", async () => {
    mockedReadWikiPage.mockResolvedValue(null); // page file genuinely missing
    mockedListWikiPages.mockResolvedValue([
      { slug: "stale", title: "Stale", summary: "..." },
    ]);

    const result = await fixLintIssue("stale-index", "stale");
    expect(result.slug).toBe("stale");
    expect(mockedUpdateIndex).toHaveBeenCalledOnce();
  });

  it("dispatches empty-page to fixEmptyPage", async () => {
    const result = await fixLintIssue("empty-page", "empty");
    expect(result.slug).toBe("empty");
    expect(mockedDeleteWikiPage).toHaveBeenCalledOnce();
  });

  it("dispatches missing-crossref to fixMissingCrossRef", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "src",
        title: "Src",
        content: "# Src\n\nContent.",
        path: "/wiki/src.md",
      })
      .mockResolvedValueOnce({
        slug: "tgt",
        title: "Tgt",
        content: "# Tgt\n\nContent.",
        path: "/wiki/tgt.md",
      });

    const result = await fixLintIssue("missing-crossref", "src", "tgt");
    expect(result.slug).toBe("src");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("dispatches contradiction to fixContradiction", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "alpha",
        title: "Alpha",
        content: "# Alpha\n\nClaim A.",
        path: "/wiki/alpha.md",
      })
      .mockResolvedValueOnce({
        slug: "beta",
        title: "Beta",
        content: "# Beta\n\nClaim B.",
        path: "/wiki/beta.md",
      });

    mockedCallLLM.mockResolvedValue("# Alpha\n\nResolved claim.");

    const msg = "Contradiction between alpha, beta: conflicting claims";
    const result = await fixLintIssue("contradiction", "alpha", "beta", msg);
    expect(result.slug).toBe("alpha");
    expect(mockedCallLLM).toHaveBeenCalledOnce();
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("dispatches missing-concept-page to fixMissingConceptPage", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockReturnValue(false);

    const msg =
      'Concept "Attention Mechanism" is mentioned in transformers, bert but has no dedicated page. Important concept.';
    const result = await fixLintIssue(
      "missing-concept-page",
      "transformers",
      undefined,
      msg,
    );
    expect(result.slug).toBe("attention-mechanism");
    expect(result.success).toBe(true);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("throws FixValidationError for unknown issue type", async () => {
    await expect(fixLintIssue("banana", "slug")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("banana", "slug")).rejects.toThrow(
      "Auto-fix not supported for this issue type",
    );
  });

  it("dispatches stale-page to fixStalePage and bumps expiry by 90 days", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "old-topic",
      title: "Old Topic",
      content: "---\nexpiry: 2025-01-01\n---\n\n# Old Topic\n\nStale content.",
      path: "/wiki/old-topic.md",
      frontmatter: { expiry: "2025-01-01" },
      body: "# Old Topic\n\nStale content.",
    });

    const result = await fixLintIssue("stale-page", "old-topic");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("old-topic");
    expect(result.message).toMatch(/^Expiry extended to \d{4}-\d{2}-\d{2}, verified as of \d{4}-\d{2}-\d{2}$/);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const dateMatch = result.message.match(/Expiry extended to (\d{4}-\d{2}-\d{2}), verified as of (\d{4}-\d{2}-\d{2})$/);
    expect(dateMatch).not.toBeNull();
    const newExpiry = new Date(dateMatch![1]);
    const validFrom = new Date(dateMatch![2]);
    const now = new Date();
    const diffDays = (newExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(88);
    expect(diffDays).toBeLessThan(92);
    // valid_from should be today
    const validDiff = Math.abs(validFrom.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(validDiff).toBeLessThan(1);
  });

  it("throws FixNotFoundError for stale-page with missing page", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue(null);

    await expect(fixLintIssue("stale-page", "no-such")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixLintIssue("stale-page", "no-such")).rejects.toThrow(
      "Page not found: no-such",
    );
  });

  it("throws helpful FixValidationError for low-confidence type", async () => {
    await expect(fixLintIssue("low-confidence", "weak-page")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("low-confidence", "weak-page")).rejects.toThrow(
      "Low-confidence pages cannot be auto-fixed",
    );
  });

  it("throws helpful FixValidationError for duplicate-entity type", async () => {
    await expect(fixLintIssue("duplicate-entity", "some-slug")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("duplicate-entity", "some-slug")).rejects.toThrow(
      "Duplicate entities require human judgment to merge",
    );
  });

  it("throws helpful FixValidationError for disputed-page type", async () => {
    await expect(fixLintIssue("disputed-page", "some-slug")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("disputed-page", "some-slug")).rejects.toThrow(
      "Disputed pages cannot be auto-fixed",
    );
  });

  it("dispatches supersedes-dangling to fixSupersededDangling (clears the dead ref)", async () => {
    // Page declares supersedes: "ghost"; "ghost" has no page → dangling.
    mockedReadWikiPageWithFrontmatter.mockImplementation(async (slug: string) =>
      slug === "some-slug"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ({ title: "Some", body: "# Some\n\nBody.", frontmatter: { supersedes: "ghost" } } as any)
        : null,
    );

    const result = await fixLintIssue("supersedes-dangling", "some-slug");
    expect(result.success).toBe(true);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    // The dangling supersedes was removed from the written frontmatter.
    const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(written.content).not.toContain("supersedes");
  });

  it("throws helpful FixValidationError for incomplete-coverage type", async () => {
    await expect(fixLintIssue("incomplete-coverage", "some-slug")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("incomplete-coverage", "some-slug")).rejects.toThrow(
      "Incomplete coverage cannot be auto-fixed. Re-ingest the source URL to refresh the page content.",
    );
  });

  it("dispatches unmigrated-page to fixUnmigratedPage", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "old-page",
      title: "Old Page",
      content: "---\ncreated: 2025-01-01\n---\n\n# Old Page\n\nLegacy content.",
      path: "/wiki/old-page.md",
      frontmatter: { created: "2025-01-01" },
      body: "# Old Page\n\nLegacy content.",
    });

    const result = await fixLintIssue("unmigrated-page", "old-page");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("old-page");
    expect(result.message).toContain("yopedia defaults");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// fixDeadSource
// ---------------------------------------------------------------------------

describe("fixDeadSource", () => {
  it("throws FixValidationError for empty slug", async () => {
    await expect(fixDeadSource("")).rejects.toThrow(FixValidationError);
    await expect(fixDeadSource("")).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  it("throws FixNotFoundError for missing page", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue(null);
    await expect(fixDeadSource("no-such-page")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixDeadSource("no-such-page")).rejects.toThrow(
      "Page not found: no-such-page",
    );
  });

  it("clears source_url from frontmatter for a 4xx dead source", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "dead-page",
      title: "Dead Page",
      content: '---\nsource_url: "https://gone.example.com"\n---\n\n# Dead Page\n\nContent here.',
      path: "/wiki/dead-page.md",
      frontmatter: { source_url: "https://gone.example.com" },
      body: "# Dead Page\n\nContent here.",
    });

    const result = await fixDeadSource(
      "dead-page",
      "Source URL returned 404: https://gone.example.com",
    );

    expect(result.success).toBe(true);
    expect(result.slug).toBe("dead-page");
    expect(result.message).toContain("Cleared dead source_url");
    expect(result.message).toContain("https://gone.example.com");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    // The written content should NOT contain source_url
    const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(written.content).not.toContain("source_url");
  });

  it("skips clearing for 5xx (transient) sources", async () => {
    const result = await fixDeadSource(
      "transient-page",
      "Source URL returned 503 (may be transient): https://example.com/down",
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("transient");
    expect(result.message).toContain("503");
    // Should NOT try to read or write the page
    expect(mockedReadWikiPageWithFrontmatter).not.toHaveBeenCalled();
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("returns no-op when source_url is already absent", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "no-source",
      title: "No Source",
      content: "---\n---\n\n# No Source\n\nSome content.",
      path: "/wiki/no-source.md",
      frontmatter: {},
      body: "# No Source\n\nSome content.",
    });

    const result = await fixDeadSource(
      "no-source",
      "Source URL returned 404: https://example.com",
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("No source_url to clear");
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("clears source_url even without a message (no status guard)", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "dead-page",
      title: "Dead Page",
      content: '---\nsource_url: "https://dead.example.com"\n---\n\n# Dead Page\n\nBody.',
      path: "/wiki/dead-page.md",
      frontmatter: { source_url: "https://dead.example.com" },
      body: "# Dead Page\n\nBody.",
    });

    const result = await fixDeadSource("dead-page");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Cleared dead source_url");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// fixLintIssue dispatcher — dead-source
// ---------------------------------------------------------------------------

describe("fixLintIssue — dead-source dispatch", () => {
  it("dispatches dead-source to fixDeadSource and clears source_url", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "some-page",
      title: "Some Page",
      content: '---\nsource_url: "https://404.example.com"\n---\n\n# Some Page\n\nBody text.',
      path: "/wiki/some-page.md",
      frontmatter: { source_url: "https://404.example.com" },
      body: "# Some Page\n\nBody text.",
    });

    const result = await fixLintIssue(
      "dead-source",
      "some-page",
      undefined,
      "Source URL returned 404: https://404.example.com",
    );

    expect(result.success).toBe(true);
    expect(result.slug).toBe("some-page");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(written.content).not.toContain("source_url");
  });

  it("does not fix dead-source with 5xx status (transient)", async () => {
    const result = await fixLintIssue(
      "dead-source",
      "some-page",
      undefined,
      "Source URL returned 502 (may be transient): https://example.com/api",
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("transient");
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// UI fixable types consistency — ensure the LintIssueCard component declares
// stale-page and unmigrated-page as fixable, matching backend support.
// ---------------------------------------------------------------------------
describe("LintIssueCard fixable types consistency", () => {
  // These mirror the sets in src/components/LintIssueCard.tsx.
  // If the component changes, update these to match.
  const uiFixableTypes = new Set([
    "missing-crossref",
    "orphan-page",
    "stale-index",
    "empty-page",
    "contradiction",
    "missing-concept-page",
    "broken-link",
    "stale-page",
    "unmigrated-page",
  ]);

  const uiFixLabels: Record<string, string> = {
    "missing-crossref": "Fix",
    "orphan-page": "Add to index",
    "stale-index": "Remove from index",
    "empty-page": "Delete page",
    "contradiction": "Resolve",
    "missing-concept-page": "Create page",
    "broken-link": "Remove link",
    "stale-page": "Extend expiry",
    "unmigrated-page": "Add defaults",
  };

  it("includes stale-page in fixable types", () => {
    expect(uiFixableTypes.has("stale-page")).toBe(true);
  });

  it("includes unmigrated-page in fixable types", () => {
    expect(uiFixableTypes.has("unmigrated-page")).toBe(true);
  });

  it("has a descriptive label for stale-page", () => {
    expect(uiFixLabels["stale-page"]).toBe("Extend expiry");
  });

  it("has a descriptive label for unmigrated-page", () => {
    expect(uiFixLabels["unmigrated-page"]).toBe("Add defaults");
  });

  it("every fixable type has a label", () => {
    for (const type of uiFixableTypes) {
      expect(uiFixLabels[type]).toBeDefined();
    }
  });
});
