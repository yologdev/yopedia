import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Import directly from lint-checks (not via lint)
import {
  getOnDiskSlugs,
  checkOrphanPages,
  checkStaleIndex,
  checkEmptyPages,
  checkBrokenLinks,
  checkMissingCrossRefs,
  checkStalePages,
  checkLowConfidence,
  checkUnmigratedPages,
  checkUncitedClaims,
  checkUnresolvedDiscussions,
  checkDisputedPages,
  checkSupersededDangling,
  LOW_CONFIDENCE_THRESHOLD,
  STALE_VERIFICATION_DAYS,
  buildSummary,
} from "../lint-checks";
import type { LintIssue } from "../types";

// We use writeWikiPage / ensureDirectories to set up wiki pages on disk.
import { writeWikiPage, updateIndex, ensureDirectories } from "../wiki";
import { serializeFrontmatter } from "../frontmatter";
import { serializeSources } from "../sources";
import type { IndexEntry } from "../types";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lint-checks-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  await ensureDirectories();
  _resetStorage();
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
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getOnDiskSlugs
// ---------------------------------------------------------------------------
describe("getOnDiskSlugs", () => {
  it("returns slugs from page-index when seeded", async () => {
    // Seed the page-index with two content pages
    const { getStorage } = await import("../storage");
    await getStorage().putIndex("pages", {
      alpha: { slug: "alpha", title: "Alpha", summary: "A page" },
      beta: { slug: "beta", title: "Beta", summary: "B page" },
    });

    const slugs = await getOnDiskSlugs();
    expect(slugs.sort()).toEqual(["alpha", "beta"]);
  });

  it("returns empty array when page-index is absent even if .md files exist", async () => {
    const wikiDir = process.env.WIKI_DIR!;
    await fs.writeFile(path.join(wikiDir, "alpha.md"), "# Alpha\n\nContent");
    await fs.writeFile(path.join(wikiDir, "beta.md"), "# Beta\n\nContent");
    await fs.writeFile(path.join(wikiDir, "index.md"), "# Index\n\n- alpha");
    await fs.writeFile(path.join(wikiDir, "log.md"), "# Log\n\n- entry");

    const slugs = await getOnDiskSlugs();
    expect(slugs).toEqual([]);
  });

  it("returns empty array when directory does not exist", async () => {
    const slugs = await getOnDiskSlugs();
    expect(slugs).toEqual([]);
  });

  it("returns empty array when page-index is absent regardless of file types on disk", async () => {
    const wikiDir = process.env.WIKI_DIR!;
    await fs.writeFile(path.join(wikiDir, "page.md"), "# Page\n\nContent");
    await fs.writeFile(path.join(wikiDir, "readme.txt"), "Not a wiki page");
    await fs.writeFile(path.join(wikiDir, "data.json"), "{}");
    await fs.writeFile(path.join(wikiDir, ".hidden"), "secret");

    const slugs = await getOnDiskSlugs();
    expect(slugs).toEqual([]);
  });

  it("returns empty array for an empty directory", async () => {
    const slugs = await getOnDiskSlugs();
    expect(slugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkOrphanPages
// ---------------------------------------------------------------------------
describe("checkOrphanPages", () => {
  it("returns issues for slugs on disk but not in index", async () => {
    const diskSlugs = ["alpha", "beta", "gamma"];
    const indexSlugs = new Set(["alpha"]);

    const issues = await checkOrphanPages(diskSlugs, indexSlugs);
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.type === "orphan-page")).toBe(true);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(issues.map((i) => i.slug).sort()).toEqual(["beta", "gamma"]);
  });

  it("populates suggestion field for orphan pages", async () => {
    const issues = await checkOrphanPages(["orphaned"], new Set());
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toBeDefined();
    expect(issues[0].suggestion).toContain("orphaned");
  });

  it("returns empty array when all slugs are in index", async () => {
    const diskSlugs = ["alpha", "beta"];
    const indexSlugs = new Set(["alpha", "beta"]);

    const issues = await checkOrphanPages(diskSlugs, indexSlugs);
    expect(issues).toEqual([]);
  });

  it("returns empty array for empty inputs", async () => {
    const issues = await checkOrphanPages([], new Set());
    expect(issues).toEqual([]);
  });

  it("returns empty array for empty disk slugs with populated index", async () => {
    const issues = await checkOrphanPages([], new Set(["alpha", "beta"]));
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkStaleIndex
// ---------------------------------------------------------------------------
describe("checkStaleIndex", () => {
  it("returns issues for index slugs with no disk file", async () => {
    const indexSlugs = new Set(["alpha", "beta", "gamma"]);
    const diskSlugs = new Set(["alpha"]);

    const issues = await checkStaleIndex(indexSlugs, diskSlugs);
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.type === "stale-index")).toBe(true);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues.map((i) => i.slug).sort()).toEqual(["beta", "gamma"]);
  });

  it("populates suggestion field for stale index entries", async () => {
    const issues = await checkStaleIndex(new Set(["my-topic"]), new Set());
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toBeDefined();
    expect(issues[0].suggestion).toContain("my topic");
  });

  it("returns empty array when all index slugs exist on disk", async () => {
    const indexSlugs = new Set(["alpha", "beta"]);
    const diskSlugs = new Set(["alpha", "beta", "extra"]);

    const issues = await checkStaleIndex(indexSlugs, diskSlugs);
    expect(issues).toEqual([]);
  });

  it("returns empty array for empty inputs", async () => {
    const issues = await checkStaleIndex(new Set(), new Set());
    expect(issues).toEqual([]);
  });

  it("returns issues for all entries when disk is empty", async () => {
    const indexSlugs = new Set(["a", "b"]);
    const diskSlugs = new Set<string>();

    const issues = await checkStaleIndex(indexSlugs, diskSlugs);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.slug).sort()).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// checkEmptyPages
// ---------------------------------------------------------------------------
describe("checkEmptyPages", () => {
  it("detects pages with very little content (just a heading)", async () => {
    await writeWikiPage("empty-page", "# Empty Page\n\n");

    const issues = await checkEmptyPages(["empty-page"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("empty-page");
    expect(issues[0].slug).toBe("empty-page");
    expect(issues[0].severity).toBe("warning");
  });

  it("populates suggestion field for empty pages", async () => {
    await writeWikiPage("sparse-topic", "# Sparse Topic\n\n");

    const issues = await checkEmptyPages(["sparse-topic"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toBeDefined();
    expect(issues[0].suggestion).toContain("Sparse Topic");
    expect(issues[0].suggestion).toContain("ingest");
  });

  it("passes pages with substantial content", async () => {
    await writeWikiPage(
      "good-page",
      "# Good Page\n\nThis is a page with plenty of meaningful content that should easily pass the empty check threshold of fifty characters.",
    );

    const issues = await checkEmptyPages(["good-page"]);
    expect(issues).toEqual([]);
  });

  it("detects pages with only a heading and a few words", async () => {
    await writeWikiPage("short-page", "# Short Page\n\nToo short.");

    const issues = await checkEmptyPages(["short-page"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].slug).toBe("short-page");
  });

  it("handles missing files gracefully (skips them)", async () => {
    // "nonexistent" slug has no file on disk
    const issues = await checkEmptyPages(["nonexistent"]);
    expect(issues).toEqual([]);
  });

  it("returns empty array for empty input", async () => {
    const issues = await checkEmptyPages([]);
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkBrokenLinks
// ---------------------------------------------------------------------------
describe("checkBrokenLinks", () => {
  it("detects links to non-existent pages", async () => {
    await writeWikiPage(
      "source",
      "# Source\n\nThis links to [Missing](missing.md) which does not exist on disk.",
    );

    const issues = await checkBrokenLinks(["source"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("broken-link");
    expect(issues[0].slug).toBe("source");
    expect(issues[0].target).toBe("missing");
    expect(issues[0].severity).toBe("warning");
  });

  it("populates suggestion field for broken links", async () => {
    await writeWikiPage(
      "linker",
      "# Linker\n\nSee [Deep Learning](deep-learning.md) for more details on the topic.",
    );

    const issues = await checkBrokenLinks(["linker"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toBeDefined();
    expect(issues[0].suggestion).toContain("deep learning");
    expect(issues[0].suggestion).toContain("Create");
  });

  it("does not flag links to existing pages", async () => {
    await writeWikiPage(
      "source",
      "# Source\n\nThis links to [Target](target.md) which exists.",
    );
    await writeWikiPage(
      "target",
      "# Target\n\nThis is the target page with enough content to pass all checks.",
    );

    const issues = await checkBrokenLinks(["source", "target"]);
    expect(issues).toEqual([]);
  });

  it("skips links to infrastructure files (index.md, log.md)", async () => {
    await writeWikiPage(
      "page",
      "# Page\n\nSee the [index](index.md) and [log](log.md) for details.",
    );

    const issues = await checkBrokenLinks(["page"]);
    expect(issues).toEqual([]);
  });

  it("returns empty array when pages have no links", async () => {
    await writeWikiPage(
      "plain",
      "# Plain\n\nThis page has no wiki links at all, just plain text content.",
    );

    const issues = await checkBrokenLinks(["plain"]);
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkMissingCrossRefs
// ---------------------------------------------------------------------------
describe("checkMissingCrossRefs", () => {
  it("detects when page A mentions a term that is slug B's title but does not link to B", async () => {
    await writeWikiPage(
      "machine-learning",
      "# Machine Learning\n\nMachine learning is a subfield of artificial intelligence that uses neural networks to learn patterns from data.",
    );
    await writeWikiPage(
      "neural-networks",
      "# Neural Networks\n\nNeural networks are computational models inspired by the human brain.",
    );

    const issues = await checkMissingCrossRefs(["machine-learning", "neural-networks"]);
    // "machine-learning" mentions "neural networks" but doesn't link to it
    const crossRefIssues = issues.filter(
      (i) => i.slug === "machine-learning" && i.target === "neural-networks",
    );
    expect(crossRefIssues).toHaveLength(1);
    expect(crossRefIssues[0].type).toBe("missing-crossref");
    expect(crossRefIssues[0].severity).toBe("info");
  });

  it("populates suggestion field for missing cross-refs", async () => {
    await writeWikiPage(
      "overview",
      "# Overview\n\nThis page covers transformers and how they relate to modern language models.",
    );
    await writeWikiPage(
      "transformers",
      "# Transformers\n\nTransformers are a neural network architecture using self-attention mechanisms.",
    );

    const issues = await checkMissingCrossRefs(["overview", "transformers"]);
    const crossRefIssues = issues.filter(
      (i) => i.slug === "overview" && i.target === "transformers",
    );
    expect(crossRefIssues).toHaveLength(1);
    expect(crossRefIssues[0].suggestion).toBeDefined();
    expect(crossRefIssues[0].suggestion).toContain("Transformers");
    expect(crossRefIssues[0].suggestion).toContain("transformers.md");
  });

  it("does NOT flag partial matches inside larger words", async () => {
    // "map" should not match inside "bitmap"
    await writeWikiPage(
      "graphics",
      "# Graphics\n\nWe use a bitmap to store pixel data for the rendering pipeline and other operations.",
    );
    await writeWikiPage(
      "map",
      "# Map\n\nA map is a data structure for key-value pairs used in many algorithms.",
    );

    const issues = await checkMissingCrossRefs(["graphics", "map"]);
    // "bitmap" contains "map" but word-boundary matching should prevent this
    const falsePositives = issues.filter(
      (i) => i.slug === "graphics" && i.target === "map",
    );
    expect(falsePositives).toHaveLength(0);
  });

  it("does not flag when a link already exists", async () => {
    await writeWikiPage(
      "overview",
      "# Overview\n\nThis article covers [Python](python.md) programming language features extensively.",
    );
    await writeWikiPage(
      "python",
      "# Python\n\nPython is a high-level programming language used widely in data science.",
    );

    const issues = await checkMissingCrossRefs(["overview", "python"]);
    const crossRefIssues = issues.filter(
      (i) => i.slug === "overview" && i.target === "python",
    );
    expect(crossRefIssues).toHaveLength(0);
  });

  it("handles pages with no potential cross-refs", async () => {
    await writeWikiPage(
      "lonely",
      "# Lonely\n\nThis page stands on its own with content that doesn't reference any other topic.",
    );

    const issues = await checkMissingCrossRefs(["lonely"]);
    expect(issues).toEqual([]);
  });

  it("ignores titles shorter than 3 characters", async () => {
    await writeWikiPage(
      "article",
      "# Article\n\nThis text mentions AI several times: AI is great, AI is the future.",
    );
    await writeWikiPage(
      "ai",
      "# AI\n\nArtificial intelligence overview with enough content for validation.",
    );

    const issues = await checkMissingCrossRefs(["article", "ai"]);
    // "AI" is only 2 chars — should be ignored to avoid false positives
    const crossRefIssues = issues.filter(
      (i) => i.slug === "article" && i.target === "ai",
    );
    expect(crossRefIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------
describe("buildSummary", () => {
  it("returns clean message for empty array", () => {
    const summary = buildSummary([]);
    expect(summary).toBe("Wiki is clean — no issues found.");
  });

  it("returns correct counts for a single error", () => {
    const issues: LintIssue[] = [
      { type: "stale-index", slug: "a", message: "stale", severity: "error" },
    ];
    const summary = buildSummary(issues);
    expect(summary).toBe("Found 1 issue: 1 error.");
  });

  it("returns correct counts for mixed severity issues", () => {
    const issues: LintIssue[] = [
      { type: "stale-index", slug: "a", message: "stale", severity: "error" },
      { type: "stale-index", slug: "b", message: "stale", severity: "error" },
      { type: "orphan-page", slug: "c", message: "orphan", severity: "warning" },
      { type: "missing-crossref", slug: "d", message: "missing", severity: "info" },
      { type: "missing-crossref", slug: "e", message: "missing", severity: "info" },
      { type: "missing-crossref", slug: "f", message: "missing", severity: "info" },
    ];
    const summary = buildSummary(issues);
    expect(summary).toBe("Found 6 issues: 2 errors, 1 warning, 3 infos.");
  });

  it("handles only warnings", () => {
    const issues: LintIssue[] = [
      { type: "orphan-page", slug: "a", message: "orphan", severity: "warning" },
      { type: "orphan-page", slug: "b", message: "orphan", severity: "warning" },
    ];
    const summary = buildSummary(issues);
    expect(summary).toBe("Found 2 issues: 2 warnings.");
  });

  it("handles only infos", () => {
    const issues: LintIssue[] = [
      { type: "missing-crossref", slug: "a", message: "info issue", severity: "info" },
    ];
    const summary = buildSummary(issues);
    expect(summary).toBe("Found 1 issue: 1 info.");
  });

  it("pluralizes correctly for single items", () => {
    const issues: LintIssue[] = [
      { type: "stale-index", slug: "a", message: "stale", severity: "error" },
      { type: "orphan-page", slug: "b", message: "orphan", severity: "warning" },
      { type: "missing-crossref", slug: "c", message: "info", severity: "info" },
    ];
    const summary = buildSummary(issues);
    expect(summary).toBe("Found 3 issues: 1 error, 1 warning, 1 info.");
  });
});

// ---------------------------------------------------------------------------
// Helper: create a wiki page with frontmatter and add it to the index
// ---------------------------------------------------------------------------

/** Accumulator for index entries within a single test. */
let _testIndexEntries: IndexEntry[] = [];

/** Reset between tests so entries don't leak. */
const _originalBeforeEach = beforeEach;

// Insert a cleanup step at the start of each test.
_originalBeforeEach(() => {
  _testIndexEntries = [];
});

async function createPageWithIndex(
  slug: string,
  title: string,
  frontmatter: Record<string, string | string[] | number | boolean>,
  body?: string,
): Promise<void> {
  const md = body ?? `# ${title}\n\nContent for ${title} with enough text for validation.`;
  const content = serializeFrontmatter(frontmatter, md);
  await writeWikiPage(slug, content);
  _testIndexEntries.push({ slug, title, summary: `About ${title}` });
  await updateIndex(_testIndexEntries);
}

// ---------------------------------------------------------------------------
// checkStalePages
// ---------------------------------------------------------------------------
describe("checkStalePages", () => {
  it("flags a page whose expiry is in the past", async () => {
    await createPageWithIndex("old-news", "Old News", {
      expiry: "2020-01-01",
      created: "2019-01-01",
    });

    const issues = await checkStalePages();
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("stale-page");
    expect(issues[0].slug).toBe("old-news");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("2020-01-01");
    expect(issues[0].suggestion).toBeDefined();
  });

  it("does NOT flag a page whose expiry is in the future", async () => {
    await createPageWithIndex("fresh-page", "Fresh Page", {
      expiry: "2099-12-31",
      created: "2025-01-01",
    });

    const issues = await checkStalePages();
    expect(issues).toHaveLength(0);
  });

  it("gracefully skips pages with no expiry field", async () => {
    await createPageWithIndex("no-expiry", "No Expiry", {
      created: "2025-01-01",
    });

    const issues = await checkStalePages();
    expect(issues).toHaveLength(0);
  });

  it("flags multiple stale pages", async () => {
    await createPageWithIndex("stale-a", "Stale A", { expiry: "2020-06-01" });
    await createPageWithIndex("stale-b", "Stale B", { expiry: "2021-03-15" });
    await createPageWithIndex("fresh-c", "Fresh C", { expiry: "2099-01-01" });

    const issues = await checkStalePages();
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.slug).sort()).toEqual(["stale-a", "stale-b"]);
  });

  it("includes valid_from in message when available on expired page", async () => {
    await createPageWithIndex("old-verified", "Old Verified", {
      expiry: "2020-01-01",
      valid_from: "2019-06-15",
      created: "2019-01-01",
    });

    const issues = await checkStalePages();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("2020-01-01");
    expect(issues[0].message).toContain("last verified 2019-06-15");
  });

  it("flags page with very old valid_from even if expiry is in the future", async () => {
    // valid_from is over STALE_VERIFICATION_DAYS ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - (STALE_VERIFICATION_DAYS + 10));
    const oldDateStr = oldDate.toISOString().slice(0, 10);

    await createPageWithIndex("old-verification", "Old Verification", {
      expiry: "2099-12-31",
      valid_from: oldDateStr,
      created: "2025-01-01",
    });

    const issues = await checkStalePages();
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("stale-page");
    expect(issues[0].slug).toBe("old-verification");
    expect(issues[0].severity).toBe("info");
    expect(issues[0].message).toContain(oldDateStr);
    expect(issues[0].message).toContain(`over ${STALE_VERIFICATION_DAYS} days ago`);
  });

  it("does NOT flag page with recent valid_from and future expiry", async () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 10);
    const recentDateStr = recentDate.toISOString().slice(0, 10);

    await createPageWithIndex("recently-verified", "Recently Verified", {
      expiry: "2099-12-31",
      valid_from: recentDateStr,
      created: "2025-01-01",
    });

    const issues = await checkStalePages();
    expect(issues).toHaveLength(0);
  });

  it("does not double-flag when both expiry passed and valid_from old", async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - (STALE_VERIFICATION_DAYS + 10));
    const oldDateStr = oldDate.toISOString().slice(0, 10);

    await createPageWithIndex("double-stale", "Double Stale", {
      expiry: "2020-01-01",
      valid_from: oldDateStr,
      created: "2019-01-01",
    });

    const issues = await checkStalePages();
    // Should get exactly 1 issue (warning for expired), not 2
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// checkLowConfidence
// ---------------------------------------------------------------------------
describe("checkLowConfidence", () => {
  it("flags a page with confidence below the threshold", async () => {
    await createPageWithIndex("shaky-page", "Shaky Page", {
      confidence: 0.5,
      created: "2025-01-01",
    });

    const issues = await checkLowConfidence();
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("low-confidence");
    expect(issues[0].slug).toBe("shaky-page");
    expect(issues[0].severity).toBe("info");
    expect(issues[0].message).toContain("0.5");
    expect(issues[0].message).toContain(String(LOW_CONFIDENCE_THRESHOLD));
    expect(issues[0].suggestion).toBeDefined();
    expect(issues[0].suggestion).toContain("Shaky Page");
  });

  it("does NOT flag a page with confidence above the threshold", async () => {
    await createPageWithIndex("solid-page", "Solid Page", {
      confidence: 0.65,
      created: "2025-01-01",
    });

    const issues = await checkLowConfidence();
    expect(issues).toHaveLength(0);
  });

  it("gracefully skips pages with no confidence field", async () => {
    await createPageWithIndex("no-confidence", "No Confidence", {
      created: "2025-01-01",
    });

    const issues = await checkLowConfidence();
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a page with confidence exactly at the threshold", async () => {
    await createPageWithIndex("borderline", "Borderline", {
      confidence: LOW_CONFIDENCE_THRESHOLD,
      created: "2025-01-01",
    });

    const issues = await checkLowConfidence();
    expect(issues).toHaveLength(0);
  });

  it("flags confidence of 0", async () => {
    await createPageWithIndex("zero-conf", "Zero Confidence", {
      confidence: 0,
      created: "2025-01-01",
    });

    const issues = await checkLowConfidence();
    expect(issues).toHaveLength(1);
    expect(issues[0].slug).toBe("zero-conf");
  });
});

// ---------------------------------------------------------------------------
// checkUnmigratedPages
// ---------------------------------------------------------------------------
describe("checkUnmigratedPages", () => {
  it("flags a page with no yopedia fields", async () => {
    await createPageWithIndex("old-page", "Old Page", {
      created: "2025-01-01",
    });

    const issues = await checkUnmigratedPages();
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("unmigrated-page");
    expect(issues[0].slug).toBe("old-page");
    expect(issues[0].severity).toBe("info");
    expect(issues[0].message).toContain("yopedia metadata");
    expect(issues[0].suggestion).toBeDefined();
  });

  it("does NOT flag a page with all three core fields", async () => {
    await createPageWithIndex("migrated-page", "Migrated Page", {
      created: "2025-01-01",
      confidence: 0.7,
      authors: ["yoyo"],
      expiry: "2026-06-01",
    });

    const issues = await checkUnmigratedPages();
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a page with only confidence (partial is fine)", async () => {
    await createPageWithIndex("partial-page", "Partial Page", {
      created: "2025-01-01",
      confidence: 0.5,
    });

    const issues = await checkUnmigratedPages();
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a page with only authors", async () => {
    await createPageWithIndex("author-only", "Author Only", {
      created: "2025-01-01",
      authors: ["system"],
    });

    const issues = await checkUnmigratedPages();
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a page with only expiry", async () => {
    await createPageWithIndex("expiry-only", "Expiry Only", {
      created: "2025-01-01",
      expiry: "2026-12-01",
    });

    const issues = await checkUnmigratedPages();
    expect(issues).toHaveLength(0);
  });

  it("never flags infrastructure pages (index.md)", async () => {
    // Write an index.md file with no yopedia fields — it should be skipped
    const wikiDir = process.env.WIKI_DIR!;
    await fs.writeFile(path.join(wikiDir, "index.md"), "# Index\n\n- stuff");

    // The index isn't in the listWikiPages results by convention,
    // but even if somehow it appears the INFRASTRUCTURE_FILES check guards it
    const issues = await checkUnmigratedPages();
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkUncitedClaims
// ---------------------------------------------------------------------------
describe("checkUncitedClaims", () => {
  it("flags a page with no sources and no inline citations", async () => {
    await createPageWithIndex("bare-claims", "Bare Claims", {
      created: "2025-01-01",
      confidence: 0.5,
    }, "# Bare Claims\n\nThis page makes claims without any citations or sources.");

    const issues = await checkUncitedClaims();
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("uncited-claims");
    expect(issues[0].slug).toBe("bare-claims");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("no sources");
    expect(issues[0].message).toContain("no inline citations");
    expect(issues[0].suggestion).toBeDefined();
    expect(issues[0].suggestion).toContain("Bare Claims");
  });

  it("does NOT flag a page with structured sources", async () => {
    const sources = serializeSources([{
      type: "url",
      url: "https://example.com/article",
      fetched: "2025-01-01",
      triggered_by: "system",
    }]);
    await createPageWithIndex("sourced-page", "Sourced Page", {
      created: "2025-01-01",
      sources,
    }, "# Sourced Page\n\nThis page has a source in frontmatter.");

    const issues = await checkUncitedClaims();
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a page with numbered inline citations", async () => {
    await createPageWithIndex("numbered-cites", "Numbered Cites", {
      created: "2025-01-01",
    }, "# Numbered Cites\n\nThe sky is blue [1] and grass is green [2].");

    const issues = await checkUncitedClaims();
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a page with named inline citations", async () => {
    await createPageWithIndex("named-cites", "Named Cites", {
      created: "2025-01-01",
    }, "# Named Cites\n\nAccording to recent research [source], this is true.");

    const issues = await checkUncitedClaims();
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a page with wikilink citations", async () => {
    await createPageWithIndex("wikilink-cites", "Wikilink Cites", {
      created: "2025-01-01",
    }, "# Wikilink Cites\n\nSee [[related-topic]] for more details.");

    const issues = await checkUncitedClaims();
    expect(issues).toHaveLength(0);
  });

  it("flags multiple uncited pages", async () => {
    await createPageWithIndex("uncited-a", "Uncited A", {
      created: "2025-01-01",
    }, "# Uncited A\n\nNo citations here.");
    await createPageWithIndex("uncited-b", "Uncited B", {
      created: "2025-01-01",
    }, "# Uncited B\n\nNo citations here either.");

    const issues = await checkUncitedClaims();
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.slug).sort()).toEqual(["uncited-a", "uncited-b"]);
  });

  it("does NOT flag a page with empty sources string but inline citations", async () => {
    await createPageWithIndex("empty-sources-with-cites", "Empty Sources With Cites", {
      created: "2025-01-01",
      sources: "[]",
    }, "# Page\n\nSome fact [1] supported by inline citation.");

    const issues = await checkUncitedClaims();
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkUnresolvedDiscussions
// ---------------------------------------------------------------------------
describe("checkUnresolvedDiscussions", () => {
  it("returns no issues when no discuss files exist", async () => {
    await writeWikiPage("clean-page", "# Clean\n\nNo discussions here.");
    const slugs = ["clean-page"];
    const issues = await checkUnresolvedDiscussions(slugs);
    expect(issues).toHaveLength(0);
  });

  it("flags a page with open discussion threads", async () => {
    await writeWikiPage("debated", "# Debated\n\nSome content.");
    // Create a discuss file with one open and one resolved thread
    const discussDir = path.join(tmpDir, "discuss");
    await fs.mkdir(discussDir, { recursive: true });
    const threads = [
      { title: "Thread 1", status: "open", author: "alice", createdAt: new Date().toISOString(), comments: [] },
      { title: "Thread 2", status: "resolved", author: "bob", createdAt: new Date().toISOString(), comments: [] },
    ];
    await fs.writeFile(path.join(discussDir, "debated.json"), JSON.stringify(threads));
    _resetStorage();

    const issues = await checkUnresolvedDiscussions(["debated"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("unresolved-discussions");
    expect(issues[0].slug).toBe("debated");
    expect(issues[0].severity).toBe("warning");
  });

  it("uses plural when multiple threads are open", async () => {
    await writeWikiPage("hot-topic", "# Hot Topic\n\nControversial.");
    const discussDir = path.join(tmpDir, "discuss");
    await fs.mkdir(discussDir, { recursive: true });
    const threads = [
      { title: "T1", status: "open", author: "a", createdAt: new Date().toISOString(), comments: [] },
      { title: "T2", status: "open", author: "b", createdAt: new Date().toISOString(), comments: [] },
    ];
    await fs.writeFile(path.join(discussDir, "hot-topic.json"), JSON.stringify(threads));
    _resetStorage();

    const issues = await checkUnresolvedDiscussions(["hot-topic"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("2 unresolved discussion threads");
  });
});

// ---------------------------------------------------------------------------
// checkDisputedPages
// ---------------------------------------------------------------------------
describe("checkDisputedPages", () => {
  it("flags a page with disputed: true", async () => {
    await createPageWithIndex("controversial", "Controversial Topic", {
      disputed: true,
      created: "2025-01-01",
    });

    const issues = await checkDisputedPages();
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("disputed-page");
    expect(issues[0].slug).toBe("controversial");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("disputed");
    expect(issues[0].suggestion).toContain("discussion");
  });

  it("returns no issues when no pages are disputed", async () => {
    await createPageWithIndex("peaceful", "Peaceful Topic", {
      disputed: false,
      created: "2025-01-01",
    });
    await createPageWithIndex("neutral", "Neutral Topic", {
      created: "2025-01-01",
    });

    const issues = await checkDisputedPages();
    expect(issues).toHaveLength(0);
  });

  it("mentions existing unresolved threads when present", async () => {
    await createPageWithIndex("hot-debate", "Hot Debate", {
      disputed: true,
      created: "2025-01-01",
    });

    // Create a discuss file with one open thread
    const discussDir = path.join(tmpDir, "discuss");
    await fs.mkdir(discussDir, { recursive: true });
    const threads = [
      { title: "Disagreement", status: "open", author: "alice", createdAt: new Date().toISOString(), comments: [] },
    ];
    await fs.writeFile(path.join(discussDir, "hot-debate.json"), JSON.stringify(threads));
    _resetStorage();

    const issues = await checkDisputedPages();
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("1 unresolved discussion thread");
    expect(issues[0].suggestion).toContain("resolve");
  });

  it("suggests opening a discussion when disputed page has no threads", async () => {
    await createPageWithIndex("no-discussion", "No Discussion Yet", {
      disputed: true,
      created: "2025-01-01",
    });

    const issues = await checkDisputedPages();
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("no discussion threads");
    expect(issues[0].suggestion).toContain("Open a discussion thread");
  });
});

// ---------------------------------------------------------------------------
// checkSupersededDangling
// ---------------------------------------------------------------------------
describe("checkSupersededDangling", () => {
  it("flags a page whose supersedes target does not exist on disk", async () => {
    const content = serializeFrontmatter(
      { supersedes: "nonexistent-slug", created: "2024-01-01" },
      "# Current Page\n\nThis page supersedes a nonexistent page with enough content.",
    );
    await writeWikiPage("current-page", content);

    const issues = await checkSupersededDangling(["current-page"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("supersedes-dangling");
    expect(issues[0].slug).toBe("current-page");
    expect(issues[0].target).toBe("nonexistent-slug");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].suggestion).toBeDefined();
    expect(issues[0].suggestion).toContain("nonexistent-slug");
  });

  it("does NOT flag a page whose supersedes target exists on disk", async () => {
    await writeWikiPage(
      "old-page",
      "# Old Page\n\nThis is the old page with enough content for validation.",
    );
    const content = serializeFrontmatter(
      { supersedes: "old-page", created: "2024-01-01" },
      "# New Page\n\nThis page supersedes old-page with enough content for validation.",
    );
    await writeWikiPage("new-page", content);

    const issues = await checkSupersededDangling(["new-page", "old-page"]);
    expect(issues).toEqual([]);
  });

  it("does NOT flag pages without a supersedes field", async () => {
    await writeWikiPage(
      "normal-page",
      "# Normal Page\n\nThis page has no supersedes field, just plain content for testing.",
    );

    const issues = await checkSupersededDangling(["normal-page"]);
    expect(issues).toEqual([]);
  });
});
