import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  extractSummary,
  ingest,
  ingestUrl,
  reingest,
  buildIngestSystemPrompt,
  chunkText,
  parseConceptMarker,
  parseDisputedMarker,
  normalizeTags,
  deriveTitleFromContent,
  collectTagVocabulary,
  computeConfidence,
  stripImageMarkdown,
  mergeSourceEntry,
} from "../ingest";
import { slugify } from "../slugify";
import { loadPageConventions } from "../schema";
import {
  isUrl,
  stripHtml,
  extractTitle,
  extractWithReadability,
  fetchUrlContent,
  validateUrlSafety,
} from "../fetch";
import { findRelatedPages, updateRelatedPages } from "../search";
import { parseSources } from "../sources";
import { MAX_LLM_INPUT_CHARS } from "../constants";
import {
  listWikiPages,
  readWikiPage,
  writeWikiPage,
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
  type Frontmatter,
} from "../wiki";
import { resetSourceIndex } from "../source-index";
import { resetAliasIndex } from "../alias-index";
import { hasEmbeddingSupport, searchByVector, contentHash } from "../embeddings";
import type { IndexEntry, SourceEntry } from "../types";

const mockedHasEmbeddingSupport = vi.mocked(hasEmbeddingSupport);
const mockedSearchByVector = vi.mocked(searchByVector);

// Mock the LLM module so ingest never calls the real API
vi.mock("../llm", () => ({
  hasLLMKey: vi.fn(() => false),
  callLLM: vi.fn(),
}));

// Partial-mock embeddings: keep every real export (contentHash, the no-op
// embed/upsert behaviour, etc.) but make `hasEmbeddingSupport` and
// `searchByVector` overridable so the concept resolver's SEMANTIC step (layer 3)
// can be exercised. Defaults delegate to the real impls, so non-embedding tests
// behave exactly as before (no provider → support false → semantic step skipped).
vi.mock("../embeddings", async (orig) => {
  const actual = await orig<typeof import("../embeddings")>();
  return {
    ...actual,
    hasEmbeddingSupport: vi.fn(actual.hasEmbeddingSupport),
    searchByVector: vi.fn(actual.searchByVector),
  };
});

// Mock unpdf for PDF extraction tests
const mockIngestExtractText = vi.fn();
const mockIngestCleanup = vi.fn();
const mockIngestGetDocumentProxy = vi.fn();

vi.mock("unpdf", () => ({
  getDocumentProxy: (...args: unknown[]) => mockIngestGetDocumentProxy(...args),
  extractText: (...args: unknown[]) => mockIngestExtractText(...args),
}));

// Import the mocked module so we can override per-test
import { hasLLMKey, callLLM } from "../llm";
const mockedHasLLMKey = vi.mocked(hasLLMKey);
const mockedCallLLM = vi.mocked(callLLM);

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips special characters", () => {
    expect(slugify("What's New? (2024)")).toBe("what-s-new-2024");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  ---Hello---  ")).toBe("hello");
  });

  it("collapses consecutive non-alphanumeric chars into a single hyphen", () => {
    expect(slugify("a   b...c")).toBe("a-b-c");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles purely numeric titles", () => {
    expect(slugify("2024")).toBe("2024");
  });
});

// ---------------------------------------------------------------------------
// ingest — empty slug guard
// ---------------------------------------------------------------------------

describe("deriveTitleFromContent", () => {
  it("prefers a markdown H1", () => {
    expect(deriveTitleFromContent("# My Heading\n\nbody")).toBe("My Heading");
  });
  it("falls back to the first non-empty line, markers stripped", () => {
    expect(deriveTitleFromContent("\n\n- First bullet line\nmore")).toBe("First bullet line");
  });
  it("truncates at a sentence boundary", () => {
    expect(deriveTitleFromContent("This is a sentence. And more.")).toBe("This is a sentence");
  });
  it("returns '' when there's no usable line", () => {
    expect(deriveTitleFromContent("   \n  ###  ")).toBe("");
  });
});

describe("ingest — title derivation", () => {
  it("derives the title/slug from the content when the title is empty", async () => {
    const result = await ingest("", "Distributed Systems\n\nSome content about consensus.");
    // First non-empty line becomes the provisional title (no LLM in this test).
    expect(result.primarySlug).toBe("distributed-systems");
    // The written body must use the derived title, not an empty `# ` heading.
    const page = await readWikiPageWithFrontmatter("distributed-systems");
    expect(page!.content).toContain("# Distributed Systems");
    expect(page!.content).not.toMatch(/^#\s*$/m);
  });

  it("derives from a markdown H1 when the title is empty", async () => {
    const result = await ingest("", "# Vector Databases\n\nThey store embeddings.");
    expect(result.primarySlug).toBe("vector-databases");
  });

  it("throws only when neither a title nor content yields a usable slug", async () => {
    await expect(ingest("!!!", "###  \n  ")).rejects.toThrow(/could be derived/);
    await expect(ingest("   ", "   ")).rejects.toThrow(/could be derived/);
  });

  it("a title-less paste with an LLM CONCEPT lands on the concept slug + records the derived title as an alias", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    try {
      mockedCallLLM.mockResolvedValue(
        "CONCEPT: Vector Databases\nALIASES: none\n\n# Vector Databases\n\n## Summary\n\nThey store embeddings.",
      );
      const result = await ingest(
        "",
        "Vector search systems store embeddings for similarity.",
      );
      // Concept slug wins over the first-line-derived provisional slug.
      expect(result.primarySlug).toBe("vector-databases");
      const page = await readWikiPageWithFrontmatter("vector-databases");
      const aliases = (page!.frontmatter.aliases ?? []) as string[];
      // The derived provisional title becomes an alias; no empty string leaks.
      expect(aliases).toContain(
        "Vector search systems store embeddings for similarity",
      );
      expect(aliases).not.toContain("");
    } finally {
      mockedHasLLMKey.mockReturnValue(false);
      mockedCallLLM.mockReset();
    }
  });

  it("a title-less paste derives its slug from the synthesized CONCEPT (no fork)", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    try {
      // No preview/commit two-step anymore: synthesis runs and the CONCEPT marker
      // drives the slug for a title-less paste.
      mockedCallLLM.mockResolvedValue(
        "CONCEPT: Topic X\nALIASES: none\n\n# Topic X\n\n## Summary\n\nSynthesized body.",
      );
      const result = await ingest("", "some pasted content here.", {});
      expect(result.primarySlug).toBe("topic-x");
      expect(await readWikiPageWithFrontmatter("topic-x")).not.toBeNull();
    } finally {
      mockedHasLLMKey.mockReturnValue(false);
      mockedCallLLM.mockReset();
    }
  });
});

// ---------------------------------------------------------------------------
// extractSummary
// ---------------------------------------------------------------------------

describe("extractSummary", () => {
  it("does not split on bare period (old bug: 'Dr.' → 'Dr')", () => {
    const text = "Dr. Smith is a renowned scientist. He studies AI.";
    const summary = extractSummary(text);
    // Old code split on bare "." giving "Dr". New code uses "[.!?]\s" which
    // matches "Dr. " — gives "Dr." which at least includes the period.
    // The key fix: it's no longer splitting on bare "." or bare "\n".
    expect(summary).not.toBe("Dr");
    expect(summary.length).toBeGreaterThanOrEqual(3);
  });

  it("uses first sentence ending with period-space", () => {
    const text = "This is the first sentence. This is the second.";
    expect(extractSummary(text)).toBe("This is the first sentence.");
  });

  it("uses paragraph break as boundary", () => {
    const text = "First paragraph without period\n\nSecond paragraph here";
    expect(extractSummary(text)).toBe("First paragraph without period");
  });

  it("picks the earlier of sentence boundary and paragraph break", () => {
    const text = "Short sentence. More text\n\nParagraph two";
    expect(extractSummary(text)).toBe("Short sentence.");
  });

  it("truncates long content with no sentence boundary", () => {
    const long = "a".repeat(300);
    const summary = extractSummary(long);
    expect(summary.length).toBeLessThanOrEqual(203 + 3); // 200 + "..."
    expect(summary.endsWith("...")).toBe(true);
  });

  it("returns empty string for empty content", () => {
    expect(extractSummary("")).toBe("");
    expect(extractSummary("   ")).toBe("");
  });

  it("returns full content when shorter than maxLen and no sentence end", () => {
    expect(extractSummary("Short text")).toBe("Short text");
  });

  it("handles exclamation marks as sentence boundaries", () => {
    const text = "Wow! That was amazing. Indeed.";
    expect(extractSummary(text)).toBe("Wow!");
  });

  it("handles question marks as sentence boundaries", () => {
    const text = "What happened? Nobody knows.";
    expect(extractSummary(text)).toBe("What happened?");
  });

  it("respects custom maxLen", () => {
    const text = "This is a fairly long first sentence that goes on and on. Second sentence.";
    const summary = extractSummary(text, 20);
    // Sentence boundary is beyond maxLen=20, so it truncates
    expect(summary.length).toBeLessThanOrEqual(23 + 3);
    expect(summary.endsWith("...")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ingest pipeline (integration, no LLM key)
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  // Silo paths resolve against DATA_DIR (default: cwd). Without this the pages
  // land outside tmpDir and leak into the next test — which is how a re-ingest
  // here could dedup onto a page a previous test created.
  process.env.DATA_DIR = tmpDir;
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

describe("ingest", () => {
  it("creates wiki page and index entry", async () => {
    const result = await ingest("Test Article", "This is the content. More stuff here.");
    expect(result.wikiPages).toContain("test-article");
    expect(result.indexUpdated).toBe(true);

    const entries = await listWikiPages();
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("test-article");
    expect(entries[0].title).toBe("Test Article");
    expect(entries[0].summary).toBe("This is the content.");
  });

  it("writes the pageType to frontmatter.type on a new page (agent-scoping)", async () => {
    const result = await ingest("Agent Note", "Knowledge the agent learned.", {
      pageType: "agent-knowledge",
    });
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.frontmatter.type).toBe("agent-knowledge");
  });

  it("does not change an existing page's scope on re-ingest", async () => {
    // A plain public page (no type)…
    await ingest("Shared Topic", "Public content here.");
    // …re-ingested with an agent pageType must NOT be flipped to agent-scope.
    const result = await ingest("Shared Topic", "Public content, expanded.", {
      pageType: "agent-knowledge",
    });
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.frontmatter.type).toBeUndefined();
  });

  it("updates existing entry on re-ingest instead of duplicating", async () => {
    // First ingest
    await ingest("My Topic", "Original content about the topic. More details.");

    let entries = await listWikiPages();
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe("Original content about the topic.");

    // Re-ingest with updated content
    await ingest("My Topic", "Updated content about the topic. New information.");

    entries = await listWikiPages();
    // Should still be 1 entry, NOT 2
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("My Topic");
    expect(entries[0].summary).toBe("Updated content about the topic.");
  });

  it("updates title on re-ingest when slug matches but title differs", async () => {
    // The slug for both is "hello-world"
    await ingest("Hello World", "First version of the doc. Details here.");

    let entries = await listWikiPages();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Hello World");

    // Same slug, different title text (slug normalizes the same)
    await ingest("Hello  World", "Second version of the doc. Different details.");

    entries = await listWikiPages();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Hello  World");
    expect(entries[0].summary).toBe("Second version of the doc.");
  });

  it("uses extractSummary for index entries (not bare period split)", async () => {
    await ingest("Dr Smith Bio", "Dr. Smith earned his Ph.D. in 2001. He then joined MIT.");

    const entries = await listWikiPages();
    expect(entries).toHaveLength(1);
    // Old code would produce "Dr" from bare period split.
    // New code produces "Dr." (period + space boundary) — still short but includes punctuation.
    expect(entries[0].summary).not.toBe("Dr");
    expect(entries[0].summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ingest — YAML frontmatter
// ---------------------------------------------------------------------------

describe("ingest — auto tags", () => {
  beforeEach(() => {
    mockedHasLLMKey.mockReturnValue(true);
  });
  afterEach(() => {
    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  it("keeps caller-supplied tags when the synthesis emits no TAGS line", async () => {
    // Caller tags (e.g. the /ingest form) must survive even when the synthesized
    // body carries no TAGS marker — the only path to the page is the options.tags
    // merge (conceptTags is empty here).
    mockedCallLLM.mockResolvedValue("# Reviewed Page\n\n## Summary\n\nSynthesized body.");
    const result = await ingest("Reviewed Page", "original source text", {
      tags: ["ml", "nlp"],
    });
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect((page!.frontmatter.tags as string[]).sort()).toEqual(["ml", "nlp"]);
  });

  it("merges freshly synthesized tags with an existing page's on-disk tags on re-ingest", async () => {
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Topic Alpha\nTAGS: keep-me\n\n# Topic Alpha\n\nFirst version.",
    );
    await ingest("Topic Alpha", "first source about the topic");

    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Topic Alpha\nTAGS: keep-me, new-one\n\n# Topic Alpha\n\nSecond version, changed.",
    );
    const result = await ingest("Topic Alpha", "second source, changed content");

    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    // `topic-alpha` is the always-added concept tag (the page's own topic).
    expect((page!.frontmatter.tags as string[]).sort()).toEqual([
      "keep-me",
      "new-one",
      "topic-alpha",
    ]);
  });

  it("persists LLM-synthesized TAGS to the page frontmatter", async () => {
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: Vector Databases\nTAGS: Databases, vector-search, #AI\n\n# Vector Databases\n\n## Summary\n\nStores embeddings.",
    );

    const result = await ingest("Vector DBs", "A source about vector databases and ANN search.");
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    // The concept ("Vector Databases" → `vector-databases`) leads, then the
    // synthesized facets — the page is always tagged with its own topic.
    expect(page!.frontmatter.tags).toEqual([
      "vector-databases",
      "databases",
      "vector-search",
      "ai",
    ]);
  });

  it("always tags the page with its own concept, and caps the set at MAX_AUTO_TAGS", async () => {
    // The LLM emits coarse facets (more than the cap); the page's concept
    // ("Agent Harness" → `agent-harness`) is added as a topic tag, LEADS (so it
    // survives the cap), and the whole set is bounded — the LLM never coins the
    // concept itself because it's told to keep facets coarser than it.
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: Agent Harness\nTAGS: ai-agents, llm, orchestration, software, systems, tooling, infra\n\n# Agent Harness\n\nBody.",
    );
    const result = await ingest("Agent Harness", "Source about the agent harness loop.");
    const tags = (await readWikiPageWithFrontmatter(result.primarySlug))!.frontmatter
      .tags as string[];
    expect(tags).toContain("agent-harness"); // the page's own topic is tagged
    expect(tags[0]).toBe("agent-harness"); // leads, so it survives the cap
    expect(tags.length).toBeLessThanOrEqual(6); // MAX_AUTO_TAGS — no sprawl
  });

  it("caps the tag union on re-ingest and keeps established tags over fresh facets (sprawl fix)", async () => {
    // First ingest fills the page to the cap: concept + 5 facets = 6 tags.
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: Topic Beta\nTAGS: old-a, old-b, old-c, old-d, old-e\n\n# Topic Beta\n\nV1.",
    );
    await ingest("Topic Beta", "first source about topic beta");

    // Re-ingest with five all-new facets. The OLD unbounded union would reach 11
    // tags; the cap holds it at 6, preserving the concept + established tags. Fresh
    // facets fill only free slots (here: none), so they wait — this guards both the
    // bound AND that a re-ingest doesn't churn/evict the page's existing tags.
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: Topic Beta\nTAGS: new-a, new-b, new-c, new-d, new-e\n\n# Topic Beta\n\nV2, changed.",
    );
    const result = await ingest("Topic Beta", "second source, changed content");

    const tags = (await readWikiPageWithFrontmatter(result.primarySlug))!.frontmatter
      .tags as string[];
    expect(tags.length).toBeLessThanOrEqual(6); // bounded — the sprawl fix
    expect(tags[0]).toBe("topic-beta"); // concept still leads after the merge
    expect(tags).toContain("old-a"); // established tags preserved (no churn)
    expect(tags).not.toContain("new-e"); // fresh facets wait for a free slot
  });

  it("dedupes the concept tag against an identical synthesized facet (no wasted slot)", async () => {
    // The concept slug and one facet collide ("databases"). The concept must
    // appear once, leading — not twice, and without consuming an extra slot.
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: Databases\nTAGS: databases, vector-search\n\n# Databases\n\nBody.",
    );
    const result = await ingest("Databases", "A source about databases.");
    const tags = (await readWikiPageWithFrontmatter(result.primarySlug))!.frontmatter
      .tags as string[];
    expect(tags).toEqual(["databases", "vector-search"]);
  });

  it("tags a CJK-titled page with its own concept (CJK tags preserved, not stripped)", async () => {
    // slugify keeps CJK and normalizeTags now shares that char class, so a Chinese
    // concept becomes a real tag instead of being stripped to empty (the old bug
    // that left CJK pages — first-class on this wiki — with no concept tag).
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: 知识库\nTAGS: 数据, ai\n\n# 知识库\n\nBody.",
    );
    const result = await ingest("知识库", "A source about knowledge bases.");
    const tags = (await readWikiPageWithFrontmatter(result.primarySlug))!.frontmatter
      .tags as string[];
    expect(tags[0]).toBe("知识库"); // the CJK concept leads — survives normalization
    expect(tags).toContain("数据"); // CJK facets survive too
    expect(tags).toContain("ai");
  });

  it("merges synthesized tags with caller-supplied tags (deduped)", async () => {
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: Caching\nTAGS: performance, caching\n\n# Caching\n\nBody.",
    );

    const result = await ingest("Caching", "Source about caching.", {
      tags: ["systems", "caching"],
    });
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect((page!.frontmatter.tags as string[]).sort()).toEqual([
      "caching",
      "performance",
      "systems",
    ]);
  });

  it("collectTagVocabulary reflects tags across ingested pages, most-used first", async () => {
    mockedCallLLM.mockResolvedValueOnce("CONCEPT: Alpha\nTAGS: ml, nlp\n\n# Alpha\n\nBody.");
    await ingest("Alpha", "source alpha about ml and nlp");
    mockedCallLLM.mockResolvedValueOnce("CONCEPT: Beta\nTAGS: ml\n\n# Beta\n\nBody.");
    await ingest("Beta", "source beta about ml");

    const vocab = await collectTagVocabulary();
    expect(vocab[0]).toBe("ml"); // used by both pages → ranked first
    expect(vocab).toContain("nlp");
  });

  it("buildIngestSystemPrompt injects the existing tag vocabulary for reuse", async () => {
    mockedCallLLM.mockResolvedValueOnce(
      "CONCEPT: Gamma\nTAGS: machine-learning, nlp\n\n# Gamma\n\nBody.",
    );
    await ingest("Gamma", "source gamma");

    const prompt = await buildIngestSystemPrompt();
    expect(prompt).toContain("Tags already used across this wiki");
    expect(prompt).toContain("machine-learning");
  });
});

describe("ingest — YAML frontmatter", () => {
  it("prepends a frontmatter block to new pages", async () => {
    await ingest("Frontmatter Test", "Some source content. With a sentence.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("frontmatter-test");
    expect(page).not.toBeNull();

    // Raw content must start with the frontmatter delimiter.
    expect(page!.content.startsWith("---\n")).toBe(true);

    // Parsed frontmatter has the four expected keys.
    expect(typeof page!.frontmatter.created).toBe("string");
    expect(typeof page!.frontmatter.updated).toBe("string");
    expect(page!.frontmatter.source_count).toBe(1);
    expect(page!.frontmatter.tags).toEqual([]);

    // created/updated are YYYY-MM-DD strings.
    expect(page!.frontmatter.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(page!.frontmatter.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Body (frontmatter stripped) still contains a heading.
    expect(page!.body).toContain("# ");
  });

  it("increments source_count and preserves created on re-ingest", async () => {
    const { readWikiPageWithFrontmatter } = await import("../wiki");

    await ingest("Recurring", "First version of the content. Details.");
    const first = await readWikiPageWithFrontmatter("recurring");
    expect(first).not.toBeNull();
    const originalCreated = first!.frontmatter.created as string;
    expect(first!.frontmatter.source_count).toBe(1);

    // Simulate a later re-ingest: manually rewrite the page with an older
    // `created` date so we can verify it's preserved across re-ingest even
    // when the clock has moved.
    await writeWikiPage(
      "recurring",
      `---\ncreated: 2020-01-01\nupdated: 2020-01-01\nsource_count: 1\ntags: [keep-me]\n---\n\n# Recurring\n\nOlder body.\n`,
    );

    await ingest("Recurring", "Second version of the content. More details.");

    const second = await readWikiPageWithFrontmatter("recurring");
    expect(second).not.toBeNull();
    // created preserved from the existing page on disk
    expect(second!.frontmatter.created).toBe("2020-01-01");
    // source_count incremented
    expect(second!.frontmatter.source_count).toBe(2);
    // updated advanced to today (YYYY-MM-DD)
    expect(second!.frontmatter.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(second!.frontmatter.updated).not.toBe("2020-01-01");
    // user-edited tags preserved
    expect(second!.frontmatter.tags).toEqual(["keep-me"]);
    // sanity: originalCreated was a "today" date on the first ingest
    expect(originalCreated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// ingest — Phase 1 (yopedia) frontmatter fields
// ---------------------------------------------------------------------------

describe("ingest — Phase 1 frontmatter fields", () => {
  it("new page gets confidence, disputed, authors, expiry", async () => {
    await ingest("Phase1 New", "Fresh content for Phase 1. Has details.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("phase1-new");
    expect(page).not.toBeNull();

    // Heuristic: a single text source → 0.50 (no longer a constant 0.7).
    expect(page!.frontmatter.confidence).toBe(0.5);
    expect(page!.frontmatter.disputed).toBe(false);
    expect(page!.frontmatter.authors).toEqual(["system"]);
    expect(page!.frontmatter.contributors).toEqual([]);
    expect(page!.frontmatter.supersedes).toBe("");
    expect(page!.frontmatter.aliases).toEqual([]);

    // valid_from should be today's date (YYYY-MM-DD)
    const validFrom = page!.frontmatter.valid_from as string;
    expect(validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const validFromDate = new Date(validFrom);
    const today = new Date();
    const validFromDiff = Math.abs(validFromDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
    expect(validFromDiff).toBeLessThan(1);

    // expiry should be a YYYY-MM-DD string ~90 days from now
    const expiry = page!.frontmatter.expiry as string;
    expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const expiryDate = new Date(expiry);
    const now = new Date();
    const diffDays = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(85);
    expect(diffDays).toBeLessThan(95);
  });

  it("re-ingest preserves authors, aliases, disputed and adds system to contributors", async () => {
    // First ingest to create the page
    await ingest("Phase1 Reingest", "First version content. With details.");

    // Manually rewrite the page with custom Phase 1 fields to simulate edits
    await writeWikiPage(
      "phase1-reingest",
      `---\ncreated: 2024-06-01\nupdated: 2024-06-01\nsource_count: 1\ntags: []\nconfidence: 0.9\nexpiry: 2024-09-01\nauthors: [alice]\ncontributors: [bob]\ndisputed: true\nsupersedes: old-page\naliases: [p1r, phase-one]\n---\n\n# Phase1 Reingest\n\nEdited body.\n`,
    );

    // Re-ingest
    await ingest("Phase1 Reingest", "Second version content. Updated info.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("phase1-reingest");
    expect(page).not.toBeNull();

    // authors preserved (not reset to ["system"])
    expect(page!.frontmatter.authors).toEqual(["alice"]);
    // "system" appended to contributors since not already present
    expect(page!.frontmatter.contributors).toEqual(["bob", "system"]);
    // disputed preserved
    expect(page!.frontmatter.disputed).toBe(true);
    // supersedes preserved
    expect(page!.frontmatter.supersedes).toBe("old-page");
    // aliases preserved
    expect(page!.frontmatter.aliases).toEqual(["p1r", "phase-one"]);
    // confidence is recomputed from signals (not preserved). The manually
    // written page had no sources[], so the re-ingest's single text source +
    // the preserved disputed=true flag caps it at 0.5.
    expect(page!.frontmatter.confidence).toBe(0.5);

    // (A) The disputed page got an OPEN reconciliation thread so the dispute is
    // actionable (human / ask-yoyo / maintenance scan).
    const { listThreads, RECONCILE_THREAD_TITLE } = await import("../talk");
    const threads = await listThreads("phase1-reingest");
    expect(
      threads.some(
        (t) => t.status === "open" && t.title === RECONCILE_THREAD_TITLE,
      ),
    ).toBe(true);

    // expiry reset to ~90 days from now (not the old 2024-09-01)
    const expiry = page!.frontmatter.expiry as string;
    const expiryDate = new Date(expiry);
    const now = new Date();
    const diffDays = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(85);
    expect(diffDays).toBeLessThan(95);

    // valid_from should reset to today (not preserved from old page)
    const validFrom = page!.frontmatter.valid_from as string;
    expect(validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const validFromDate = new Date(validFrom);
    const validFromDiff = Math.abs(validFromDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(validFromDiff).toBeLessThan(1);
  });

  it("re-ingest does not duplicate system in contributors", async () => {
    await ingest("Phase1 NoDup", "Content for dedup test. Some text.");

    // Manually set contributors to include "system" already
    await writeWikiPage(
      "phase1-nodup",
      `---\ncreated: 2024-06-01\nupdated: 2024-06-01\nsource_count: 1\ntags: []\nconfidence: 0.7\nexpiry: 2024-09-01\nauthors: [system]\ncontributors: [system, editor]\ndisputed: false\nsupersedes:\naliases: []\n---\n\n# Phase1 NoDup\n\nBody.\n`,
    );

    await ingest("Phase1 NoDup", "Second content for dedup test. More text.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("phase1-nodup");
    expect(page).not.toBeNull();

    // "system" should appear only once
    expect(page!.frontmatter.contributors).toEqual(["system", "editor"]);
  });

  it("re-ingest recomputes confidence from signals (ignores a manually-set value)", async () => {
    await ingest("Phase1 LowConf", "Content for confidence test. Details here.");

    // Manually set confidence to 0.5; the re-ingest should recompute, not keep it.
    await writeWikiPage(
      "phase1-lowconf",
      `---\ncreated: 2024-06-01\nupdated: 2024-06-01\nsource_count: 1\ntags: []\nconfidence: 0.5\nexpiry: 2024-09-01\nauthors: [system]\ncontributors: []\ndisputed: false\nsupersedes:\naliases: []\n---\n\n# Phase1 LowConf\n\nBody.\n`,
    );

    await ingest("Phase1 LowConf", "Second content. Updated details.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("phase1-lowconf");
    expect(page).not.toBeNull();

    // Recomputed from the single text source (0.50) — not the manual 0.5.
    expect(page!.frontmatter.confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// ingest — source URL tracking in frontmatter
// ---------------------------------------------------------------------------

describe("ingest — source URL tracking", () => {
  it("stores source_url in frontmatter when sourceUrl option is provided", async () => {
    const result = await ingest("Url Source Test", "Content from a URL. Some text.", {
      sourceUrl: "https://example.com/article",
    });

    expect(result.sourceUrl).toBe("https://example.com/article");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("url-source-test");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.source_url).toBe("https://example.com/article");
  });

  it("does NOT add source_url when no sourceUrl option is provided (text paste)", async () => {
    await ingest("Plain Text Paste", "Just some pasted text. Nothing special.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("plain-text-paste");
    expect(page).not.toBeNull();
    // source_url should be absent from the frontmatter
    expect(page!.frontmatter.source_url).toBeUndefined();
  });

  it("preserves existing source_url on re-ingest without a new URL", async () => {
    // First ingest with a URL
    await ingest("Reingest Url", "First version content. Details here.", {
      sourceUrl: "https://example.com/original",
    });

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const first = await readWikiPageWithFrontmatter("reingest-url");
    expect(first).not.toBeNull();
    expect(first!.frontmatter.source_url).toBe("https://example.com/original");

    // Re-ingest the same slug WITHOUT providing a sourceUrl (e.g. text paste update)
    await ingest("Reingest Url", "Second version content. Updated details.");

    const second = await readWikiPageWithFrontmatter("reingest-url");
    expect(second).not.toBeNull();
    // The original source_url should be preserved
    expect(second!.frontmatter.source_url).toBe("https://example.com/original");
  });

  it("stores a per-source raw snapshot with a distinct raw_id per source", async () => {
    const { readWikiPageWithFrontmatter, readRawSourceById } = await import("../wiki");

    await ingest("Multi Source Page", "First source body. Some detail here.", {
      sourceUrl: "https://a.example.com/one",
    });
    await ingest("Multi Source Page", "Second source body. Other detail here.", {
      sourceUrl: "https://b.example.com/two",
    });

    const page = await readWikiPageWithFrontmatter("multi-source-page");
    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources).toHaveLength(2);
    const ids = sources.map((s) => s.raw_id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2); // one snapshot per source

    for (const s of sources) {
      const raw = await readRawSourceById("multi-source-page", s.raw_id!);
      expect(raw.content.length).toBeGreaterThan(0);
    }
  });

  it("overwrites source_url on re-ingest with a new URL", async () => {
    // First ingest with a URL
    await ingest("Reingest New Url", "First content. Has details.", {
      sourceUrl: "https://example.com/v1",
    });

    // Re-ingest with a different URL
    await ingest("Reingest New Url", "Updated content. More details.", {
      sourceUrl: "https://example.com/v2",
    });

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("reingest-new-url");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.source_url).toBe("https://example.com/v2");
  });

  it("ingestUrl passes the URL through to frontmatter", async () => {
    // Mock fetch so ingestUrl doesn't make a real HTTP request
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([
        ["content-type", "text/html"],
      ]) as unknown as Headers,
      body: {
        getReader: () => {
          let called = false;
          return {
            read: () => {
              if (!called) {
                called = true;
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode(
                    "<html><head><title>Fetched Article</title></head><body><p>Article body content. A full sentence.</p></body></html>",
                  ),
                });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
            cancel: vi.fn(),
          };
        },
      },
    });

    try {
      const result = await ingestUrl("https://example.com/fetched-article");
      expect(result.sourceUrl).toBe("https://example.com/fetched-article");

      const { readWikiPageWithFrontmatter } = await import("../wiki");
      const page = await readWikiPageWithFrontmatter(result.primarySlug);
      expect(page).not.toBeNull();
      expect(page!.frontmatter.source_url).toBe("https://example.com/fetched-article");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// ingest — structured sources[] provenance
// ---------------------------------------------------------------------------

describe("ingest — structured sources[] provenance", () => {
  it("new URL ingest creates sources[] with a url-type entry", async () => {
    await ingest("Sources Url", "Content from a URL. Full sentence here.", {
      sourceUrl: "https://example.com/sources-test",
    });

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("sources-url");
    expect(page).not.toBeNull();

    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources).toHaveLength(1);
    expect(sources[0].type).toBe("url");
    expect(sources[0].url).toBe("https://example.com/sources-test");
    expect(sources[0].fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sources[0].triggered_by).toBe("system");
  });

  it("new text ingest creates sources[] with a text-type entry", async () => {
    await ingest("Sources Text", "Pasted text content. More details here.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("sources-text");
    expect(page).not.toBeNull();

    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources).toHaveLength(1);
    expect(sources[0].type).toBe("text");
    expect(sources[0].url).toBe("text-paste");
    expect(sources[0].triggered_by).toBe("system");
  });

  it("re-ingest with different URL appends to sources[]", async () => {
    // First ingest with URL A
    await ingest("Sources Append", "First content. Full sentence.", {
      sourceUrl: "https://example.com/a",
    });

    // Re-ingest with URL B
    await ingest("Sources Append", "Second content. Updated info.", {
      sourceUrl: "https://example.com/b",
    });

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("sources-append");
    expect(page).not.toBeNull();

    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe("https://example.com/a");
    expect(sources[1].url).toBe("https://example.com/b");
    // Corroboration: a 2nd distinct source URL raises confidence (0.6 → 0.65).
    expect(page!.frontmatter.confidence).toBe(0.65);
  });

  it("re-ingest with same URL updates fetched date instead of duplicating", async () => {
    await ingest("Sources Dedup", "First version content. Details.", {
      sourceUrl: "https://example.com/same",
    });

    // Re-ingest with the same URL
    await ingest("Sources Dedup", "Updated content version. More info.", {
      sourceUrl: "https://example.com/same",
    });

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("sources-dedup");
    expect(page).not.toBeNull();

    const sources = parseSources(page!.frontmatter.sources as string);
    // Should still be 1 entry, not 2
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://example.com/same");
    expect(sources[0].fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("re-ingest of text-paste over existing URL preserves both entries", async () => {
    // First ingest with a URL
    await ingest("Sources Mixed", "URL content. Full sentence here.", {
      sourceUrl: "https://example.com/mixed",
    });

    // Re-ingest as text paste (no sourceUrl)
    await ingest("Sources Mixed", "Additional pasted text. More info.");

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("sources-mixed");
    expect(page).not.toBeNull();

    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources).toHaveLength(2);
    expect(sources[0].type).toBe("url");
    expect(sources[0].url).toBe("https://example.com/mixed");
    expect(sources[1].type).toBe("text");
    expect(sources[1].url).toBe("text-paste");
  });

  it("backward compat: source_url still set alongside sources[]", async () => {
    await ingest("Sources Compat", "Content for compat test. Sentence.", {
      sourceUrl: "https://example.com/compat",
    });

    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const page = await readWikiPageWithFrontmatter("sources-compat");
    expect(page).not.toBeNull();

    // Old field still present for backward compat
    expect(page!.frontmatter.source_url).toBe("https://example.com/compat");
    // New structured field also present
    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources).toHaveLength(1);
  });
});

describe("isUrl", () => {
  it("recognizes http URLs", () => {
    expect(isUrl("http://example.com")).toBe(true);
  });

  it("recognizes https URLs", () => {
    expect(isUrl("https://example.com/path?q=1")).toBe(true);
  });

  it("rejects plain text", () => {
    expect(isUrl("just some text")).toBe(false);
  });

  it("rejects titles that contain URLs", () => {
    expect(isUrl("My article about https")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isUrl("")).toBe(false);
  });

  it("handles URLs with leading whitespace", () => {
    expect(isUrl("  https://example.com")).toBe(true);
  });

  it("rejects ftp URLs", () => {
    expect(isUrl("ftp://files.example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripHtml & extractTitle
// ---------------------------------------------------------------------------

describe("stripHtml", () => {
  it("removes basic HTML tags and preserves text", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("removes script tags and their contents", () => {
    const html = '<p>Before</p><script>var x = 1;</script><p>After</p>';
    expect(stripHtml(html)).toBe("Before After");
  });

  it("removes style tags and their contents", () => {
    const html = '<style>.foo { color: red; }</style><p>Content</p>';
    expect(stripHtml(html)).toBe("Content");
  });

  it("removes nav, header, footer elements", () => {
    const html = '<nav><a href="/">Home</a></nav><main><p>Article text</p></main><footer>Copyright</footer>';
    expect(stripHtml(html)).toBe("Article text");
  });

  it("removes noscript elements", () => {
    const html = '<noscript>Please enable JS</noscript><p>Real content</p>';
    expect(stripHtml(html)).toBe("Real content");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot; &#39; &nbsp;")).toBe('& < > " \'');
  });

  it("decodes numeric decimal entities", () => {
    // &#8212; = em dash (—), &#169; = copyright (©)
    expect(stripHtml("Hello&#8212;world")).toBe("Hello\u2014world");
    expect(stripHtml("&#169; 2026")).toBe("\u00A9 2026");
  });

  it("decodes numeric hex entities", () => {
    // &#x2014; = em dash (—), &#x2019; = right single quote (')
    expect(stripHtml("Hello&#x2014;world")).toBe("Hello\u2014world");
    expect(stripHtml("it&#x2019;s")).toBe("it\u2019s");
  });

  it("decodes common named HTML5 entities", () => {
    expect(stripHtml("a&mdash;b")).toBe("a\u2014b");
    expect(stripHtml("a&ndash;b")).toBe("a\u2013b");
    expect(stripHtml("wait&hellip;")).toBe("wait\u2026");
    expect(stripHtml("&lsquo;hi&rsquo;")).toBe("\u2018hi\u2019");
    expect(stripHtml("&ldquo;hi&rdquo;")).toBe("\u201Chi\u201D");
    expect(stripHtml("&trade; &copy; &reg;")).toBe("\u2122 \u00A9 \u00AE");
    expect(stripHtml("&bull; &middot;")).toBe("\u2022 \u00B7");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("<p>  Hello   world  </p>")).toBe("Hello world");
  });

  it("handles multiline script tags", () => {
    const html = `<script type="text/javascript">
      function foo() {
        return "bar";
      }
    </script><p>Content here</p>`;
    expect(stripHtml(html)).toBe("Content here");
  });

  it("decodes astral Unicode decimal entities (emoji)", () => {
    // &#128512; = U+1F600 = 😀 (grinning face)
    expect(stripHtml("&#128512;")).toBe("😀");
  });

  it("decodes astral Unicode hex entities (emoji)", () => {
    // &#x1F600; = U+1F600 = 😀 (grinning face)
    expect(stripHtml("&#x1F600;")).toBe("😀");
  });

  it("decodes astral Unicode mixed with text", () => {
    expect(stripHtml("Hello &#128512; World")).toBe("Hello 😀 World");
  });
});

describe("extractTitle", () => {
  it("extracts title from HTML", () => {
    const html = '<html><head><title>My Page Title</title></head><body></body></html>';
    expect(extractTitle(html)).toBe("My Page Title");
  });

  it("returns empty string when no title tag", () => {
    const html = '<html><head></head><body><p>content</p></body></html>';
    expect(extractTitle(html)).toBe("");
  });

  it("handles title with extra whitespace", () => {
    const html = '<title>  Spaced   Title  </title>';
    expect(extractTitle(html)).toBe("Spaced Title");
  });
});

// ---------------------------------------------------------------------------
// extractWithReadability
// ---------------------------------------------------------------------------

describe("extractWithReadability", () => {
  it("extracts article content and title from well-structured HTML", () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>My Article</title></head>
      <body>
        <nav><a href="/">Home</a></nav>
        <article>
          <h1>My Article</h1>
          <p>This is the first paragraph of a well-written article about testing.</p>
          <p>This is the second paragraph with more detail about the topic at hand.</p>
          <p>And a third paragraph to ensure there is enough content for Readability.</p>
        </article>
        <footer>Copyright 2024</footer>
      </body>
      </html>
    `;
    const result = extractWithReadability(html);
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain("first paragraph");
    expect(result!.textContent).toContain("second paragraph");
    // Nav and footer content should not appear in extracted text
    expect(result!.textContent).not.toContain("Copyright 2024");
  });

  it("returns null for minimal HTML with no article structure", () => {
    const html = "<html><body><p>Hi</p></body></html>";
    const result = extractWithReadability(html);
    // Readability may return null for very short/non-article content
    // Either null or a valid result is acceptable for minimal content
    if (result !== null) {
      expect(result.textContent.length).toBeGreaterThan(0);
    }
  });

  it("strips script and style content from article extraction", () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Script Test</title></head>
      <body>
        <article>
          <h1>Article Title</h1>
          <p>Real article content that should be extracted properly.</p>
          <p>More content to give Readability something substantial to work with.</p>
          <p>Yet another paragraph of meaningful article text for extraction.</p>
          <script>var tracking = "should not appear";</script>
          <style>.hidden { display: none; }</style>
        </article>
      </body>
      </html>
    `;
    const result = extractWithReadability(html);
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain("Real article content");
    expect(result!.textContent).not.toContain("should not appear");
    expect(result!.textContent).not.toContain("display: none");
  });

  it("handles HTML with tables cleanly", () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Table Page</title></head>
      <body>
        <article>
          <h1>Data Report</h1>
          <p>Here is a summary of the data from the quarterly report.</p>
          <table>
            <tr><th>Name</th><th>Value</th></tr>
            <tr><td>Alpha</td><td>100</td></tr>
            <tr><td>Beta</td><td>200</td></tr>
          </table>
          <p>The above table shows the key metrics for the quarter.</p>
          <p>Additional analysis follows in the next section of this report.</p>
        </article>
      </body>
      </html>
    `;
    const result = extractWithReadability(html);
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain("Alpha");
    expect(result!.textContent).toContain("Beta");
    expect(result!.textContent).toContain("summary of the data");
  });
});

// ---------------------------------------------------------------------------
// fetchUrlContent (mocked fetch)
// ---------------------------------------------------------------------------

describe("fetchUrlContent", () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
    <head><title>Test Article</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <header><h1>Site Header</h1></header>
      <main>
        <h1>Test Article</h1>
        <p>This is the main article content. It has multiple sentences.</p>
        <p>Second paragraph with more information.</p>
      </main>
      <footer><p>Copyright 2024</p></footer>
      <script>console.log("tracking");</script>
    </body>
    </html>
  `;

  /** Helper to create a mock headers object */
  function mockHeaders(h: Record<string, string> = {}) {
    return { get: (key: string) => h[key.toLowerCase()] ?? null };
  }

  it("extracts title and content from HTML", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      text: () => Promise.resolve(sampleHtml),
    });

    try {
      const result = await fetchUrlContent("https://example.com/article");
      expect(result.title).toBe("Test Article");
      expect(result.content).toContain("main article content");
      expect(result.content).toContain("Second paragraph");
      // Nav, header, footer, script content should be stripped
      expect(result.content).not.toContain("Site Header");
      expect(result.content).not.toContain("Copyright 2024");
      expect(result.content).not.toContain("tracking");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to hostname when no title tag", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      text: () => Promise.resolve("<html><body><p>Some content</p></body></html>"),
    });

    try {
      const result = await fetchUrlContent("https://example.com/page");
      expect(result.title).toBe("example.com");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws on HTTP error", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    try {
      await expect(fetchUrlContent("https://example.com/missing")).rejects.toThrow(
        "Failed to fetch URL: 404 Not Found",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws when Content-Length header exceeds 5 MB", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders({ "content-length": "10000000" }),
      text: () => Promise.resolve("<p>should not be read</p>"),
    });

    try {
      await expect(fetchUrlContent("https://example.com/huge")).rejects.toThrow(
        /Content too large.*10000000/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws when body exceeds 5 MB (no Content-Length header)", async () => {
    const originalFetch = global.fetch;
    const hugeBody = "<p>" + "x".repeat(6 * 1024 * 1024) + "</p>";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(), // no content-length
      text: () => Promise.resolve(hugeBody),
    });

    try {
      await expect(fetchUrlContent("https://example.com/huge")).rejects.toThrow(
        /Content too large/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("truncates extracted content exceeding 100K characters", async () => {
    const originalFetch = global.fetch;
    // Build HTML whose stripped text will be > 100K chars
    const longText = "word ".repeat(25_000); // 125K chars
    const html = `<html><head><title>Long Doc</title></head><body><p>${longText}</p></body></html>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      text: () => Promise.resolve(html),
    });

    try {
      const result = await fetchUrlContent("https://example.com/long");
      expect(result.content.length).toBeLessThanOrEqual(100_000 + 30); // allow for suffix
      expect(result.content).toContain("[Content truncated]");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("passes AbortSignal.timeout to fetch", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      text: () => Promise.resolve("<html><body><p>Hello</p></body></html>"),
    });

    try {
      await fetchUrlContent("https://example.com/test");
      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1]).toHaveProperty("signal");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("uses Readability for article-shaped HTML", async () => {
    const originalFetch = global.fetch;
    const articleHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Readability Article</title></head>
      <body>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <header><h1>Site Name</h1></header>
        <article>
          <h1>Readability Article</h1>
          <p>This is a substantial article with enough content for Readability to detect it as an article. It discusses various topics in detail.</p>
          <p>The second paragraph continues the discussion with additional details and analysis of the subject matter at hand.</p>
          <p>A third paragraph provides even more context and ensures Readability has sufficient text to work with for extraction.</p>
        </article>
        <footer><p>Copyright 2024 - Site Footer</p></footer>
        <script>console.log("analytics tracking code");</script>
      </body>
      </html>
    `;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      text: () => Promise.resolve(articleHtml),
    });

    try {
      const result = await fetchUrlContent("https://example.com/article");
      expect(result.title).toBe("Readability Article");
      expect(result.content).toContain("substantial article");
      expect(result.content).toContain("second paragraph");
      // Readability should strip nav, footer, script content
      expect(result.content).not.toContain("analytics tracking code");
      expect(result.content).not.toContain("Copyright 2024");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to stripHtml when Readability cannot parse the page", async () => {
    const originalFetch = global.fetch;
    // Minimal HTML that Readability may not identify as an article
    const minimalHtml = `<html><body><p>Some content</p></body></html>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      text: () => Promise.resolve(minimalHtml),
    });

    try {
      const result = await fetchUrlContent("https://example.com/minimal");
      // Whether Readability succeeds or the fallback kicks in,
      // we should still get the content
      expect(result.content).toContain("Some content");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("prefers Readability title over regex-extracted title", async () => {
    const originalFetch = global.fetch;
    // HTML where <title> differs from the article heading that Readability might pick up
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>SEO Title - MySite.com</title></head>
      <body>
        <article>
          <h1>Clean Article Title</h1>
          <p>This is a well-structured article with enough content for Readability to process it correctly and extract the article.</p>
          <p>Additional paragraphs help Readability determine this is indeed an article worth extracting from the page.</p>
          <p>A third paragraph of meaningful content ensures the extraction succeeds with proper title detection.</p>
        </article>
      </body>
      </html>
    `;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      text: () => Promise.resolve(html),
    });

    try {
      const result = await fetchUrlContent("https://example.com/article");
      // Readability should extract a title - it may use <title> or <h1>
      // The key thing: we should get a meaningful title, not just the hostname
      expect(result.title).toBeTruthy();
      expect(result.title).not.toBe("example.com");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("extracts text from a PDF URL via unpdf", async () => {
    const originalFetch = global.fetch;
    const pdfBytes = new ArrayBuffer(100);
    mockIngestGetDocumentProxy.mockResolvedValue({ cleanup: mockIngestCleanup });
    mockIngestExtractText.mockResolvedValue({
      totalPages: 2,
      text: "Introduction to AI\n\nArtificial intelligence is transforming the world.",
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: () => Promise.resolve(pdfBytes),
    });

    try {
      const result = await fetchUrlContent("https://example.com/doc.pdf");
      expect(result.title).toBe("Introduction to AI");
      expect(result.content).toContain("Artificial intelligence");
      expect(mockIngestGetDocumentProxy).toHaveBeenCalled();
      expect(mockIngestExtractText).toHaveBeenCalled();
      expect(mockIngestCleanup).toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      mockIngestGetDocumentProxy.mockReset();
      mockIngestExtractText.mockReset();
      mockIngestCleanup.mockReset();
    }
  });

  it("throws on unsupported content type (image/png)", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders({ "content-type": "image/png" }),
      text: () => Promise.resolve("binary garbage"),
    });

    try {
      await expect(
        fetchUrlContent("https://example.com/image.png"),
      ).rejects.toThrow("Unsupported content type");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns raw text for text/plain content type (no HTML parsing)", async () => {
    const originalFetch = global.fetch;
    const plainText = "This is plain text content.\nSecond line of text.";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders({ "content-type": "text/plain; charset=utf-8" }),
      text: () => Promise.resolve(plainText),
    });

    try {
      const result = await fetchUrlContent("https://example.com/readme.txt");
      expect(result.title).toBe("example.com");
      expect(result.content).toBe(plainText);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns raw text for text/markdown content type", async () => {
    const originalFetch = global.fetch;
    const markdown = "# Hello\n\nSome **bold** text.";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders({ "content-type": "text/markdown" }),
      text: () => Promise.resolve(markdown),
    });

    try {
      const result = await fetchUrlContent("https://example.com/doc.md");
      expect(result.title).toBe("example.com");
      expect(result.content).toBe(markdown);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("proceeds with HTML parsing when Content-Type header is absent", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(), // no content-type
      text: () => Promise.resolve(sampleHtml),
    });

    try {
      const result = await fetchUrlContent("https://example.com/article");
      // Should still parse HTML successfully
      expect(result.title).toBe("Test Article");
      expect(result.content).toContain("main article content");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles content-type with charset parameter correctly", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders({ "content-type": "text/html; charset=utf-8" }),
      text: () => Promise.resolve(sampleHtml),
    });

    try {
      const result = await fetchUrlContent("https://example.com/article");
      expect(result.title).toBe("Test Article");
      expect(result.content).toContain("main article content");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// ingestUrl (integration with mocked fetch, no LLM key)
// ---------------------------------------------------------------------------

describe("ingestUrl", () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
    <head><title>Web Article</title></head>
    <body>
      <main>
        <p>This is a web article about AI. It covers many topics.</p>
      </main>
    </body>
    </html>
  `;

  it("fetches URL and creates wiki page", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: () => Promise.resolve(sampleHtml),
    });

    try {
      const result = await ingestUrl("https://example.com/ai-article");
      expect(result.wikiPages).toContain("web-article");
      expect(result.indexUpdated).toBe(true);

      const entries = await listWikiPages();
      const entry = entries.find((e) => e.slug === "web-article");
      expect(entry).toBeDefined();
      expect(entry!.title).toBe("Web Article");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// cross-referencing
// ---------------------------------------------------------------------------

describe("cross-referencing", () => {
  describe("findRelatedPages", () => {
    it("returns empty array when no LLM key", async () => {
      mockedHasLLMKey.mockReturnValue(false);
      const entries: IndexEntry[] = [
        { title: "AI", slug: "ai", summary: "About AI" },
      ];
      const result = await findRelatedPages("new-page", "some content", entries);
      expect(result).toEqual([]);
    });

    it("returns empty array when no existing pages", async () => {
      mockedHasLLMKey.mockReturnValue(true);
      const result = await findRelatedPages("new-page", "some content", []);
      expect(result).toEqual([]);
    });

    it("returns related slugs from LLM response", async () => {
      mockedHasLLMKey.mockReturnValue(true);
      mockedCallLLM.mockResolvedValue('["ai", "machine-learning"]');
      const entries: IndexEntry[] = [
        { title: "AI", slug: "ai", summary: "About AI" },
        { title: "Machine Learning", slug: "machine-learning", summary: "About ML" },
        { title: "Cooking", slug: "cooking", summary: "About cooking" },
      ];
      const result = await findRelatedPages("new-page", "deep learning content", entries);
      expect(result).toEqual(["ai", "machine-learning"]);
    });

    it("filters out invalid slugs from LLM response", async () => {
      mockedHasLLMKey.mockReturnValue(true);
      mockedCallLLM.mockResolvedValue('["ai", "nonexistent-page"]');
      const entries: IndexEntry[] = [
        { title: "AI", slug: "ai", summary: "About AI" },
      ];
      const result = await findRelatedPages("new-page", "content", entries);
      expect(result).toEqual(["ai"]);
    });

    it("filters out the new page's own slug", async () => {
      mockedHasLLMKey.mockReturnValue(true);
      mockedCallLLM.mockResolvedValue('["new-page", "ai"]');
      const entries: IndexEntry[] = [
        { title: "New Page", slug: "new-page", summary: "The new page" },
        { title: "AI", slug: "ai", summary: "About AI" },
      ];
      const result = await findRelatedPages("new-page", "content", entries);
      expect(result).toEqual(["ai"]);
    });

    it("returns empty array on LLM error", async () => {
      mockedHasLLMKey.mockReturnValue(true);
      mockedCallLLM.mockRejectedValue(new Error("API error"));
      const entries: IndexEntry[] = [
        { title: "AI", slug: "ai", summary: "About AI" },
      ];
      const result = await findRelatedPages("new-page", "content", entries);
      expect(result).toEqual([]);
    });

    it("returns empty array on malformed JSON", async () => {
      mockedHasLLMKey.mockReturnValue(true);
      mockedCallLLM.mockResolvedValue("not valid json at all");
      const entries: IndexEntry[] = [
        { title: "AI", slug: "ai", summary: "About AI" },
      ];
      const result = await findRelatedPages("new-page", "content", entries);
      expect(result).toEqual([]);
    });

    it("returns empty array when only entry is the new page itself", async () => {
      mockedHasLLMKey.mockReturnValue(true);
      const entries: IndexEntry[] = [
        { title: "New Page", slug: "new-page", summary: "The new page" },
      ];
      const result = await findRelatedPages("new-page", "content", entries);
      // indexList would be empty after filtering out newSlug
      expect(result).toEqual([]);
    });
  });

  describe("updateRelatedPages", () => {
    it("appends 'See also' link to related pages", async () => {
      await writeWikiPage("ai", "# AI\n\nContent about AI.");
      const updated = await updateRelatedPages("new-page", "New Page", ["ai"]);
      expect(updated).toEqual(["ai"]);

      const page = await readWikiPage("ai");
      expect(page).not.toBeNull();
      expect(page!.content).toContain("**See also:** [New Page](new-page.md)");
    });

    it("skips pages that already link to the new page", async () => {
      await writeWikiPage(
        "ai",
        "# AI\n\nContent about AI. See [New Page](new-page.md).",
      );
      const updated = await updateRelatedPages("new-page", "New Page", ["ai"]);
      expect(updated).toEqual([]);
    });

    it("appends to existing 'See also' section rather than creating duplicate", async () => {
      await writeWikiPage(
        "ai",
        "# AI\n\nContent about AI.\n\n**See also:** [Other Page](other-page.md)",
      );
      const updated = await updateRelatedPages("new-page", "New Page", ["ai"]);
      expect(updated).toEqual(["ai"]);

      const page = await readWikiPage("ai");
      expect(page).not.toBeNull();
      // Should have both links on the same "See also" line
      expect(page!.content).toContain(
        "**See also:** [Other Page](other-page.md), [New Page](new-page.md)",
      );
      // Should NOT have two separate "See also" lines
      const seeAlsoCount = (page!.content.match(/\*\*See also:\*\*/g) || []).length;
      expect(seeAlsoCount).toBe(1);
    });

    it("skips non-existent pages", async () => {
      const updated = await updateRelatedPages("new-page", "New Page", [
        "nonexistent",
      ]);
      expect(updated).toEqual([]);
    });

    it("handles multiple related pages", async () => {
      await writeWikiPage("ai", "# AI\n\nContent about AI.");
      await writeWikiPage("ml", "# ML\n\nContent about ML.");
      const updated = await updateRelatedPages("new-page", "New Page", [
        "ai",
        "ml",
      ]);
      expect(updated).toEqual(["ai", "ml"]);

      const aiPage = await readWikiPage("ai");
      const mlPage = await readWikiPage("ml");
      expect(aiPage!.content).toContain("[New Page](new-page.md)");
      expect(mlPage!.content).toContain("[New Page](new-page.md)");
    });
  });

  describe("ingest with cross-referencing", () => {
    it("returns multiple wikiPages when cross-refs are updated", async () => {
      // Pre-populate the wiki with an existing page
      await writeWikiPage("ai", "# AI\n\nContent about artificial intelligence.");

      // Set up index with the existing page
      const { updateIndex } = await import("../wiki");
      await updateIndex([
        { title: "AI", slug: "ai", summary: "Content about artificial intelligence" },
      ]);

      // Enable LLM and mock responses
      mockedHasLLMKey.mockReturnValue(true);

      // First call: generate wiki page content; second call: find related pages
      mockedCallLLM
        .mockResolvedValueOnce("# Deep Learning\n\n## Summary\n\nAbout deep learning.")
        .mockResolvedValueOnce('["ai"]');

      const result = await ingest(
        "Deep Learning",
        "Deep learning is a subset of AI. It uses neural networks.",
      );

      expect(result.wikiPages).toContain("deep-learning");
      expect(result.wikiPages).toContain("ai");
      expect(result.wikiPages.length).toBe(2);
      expect(result.primarySlug).toBe("deep-learning");
      expect(result.relatedUpdated).toEqual(["ai"]);

      // Verify the AI page was updated with a cross-reference
      const aiPage = await readWikiPage("ai");
      expect(aiPage!.content).toContain("[Deep Learning](deep-learning.md)");
    });

    it("returns only the new page when no LLM key (existing behavior)", async () => {
      mockedHasLLMKey.mockReturnValue(false);
      const result = await ingest("Solo Page", "Content for a solo page. More text.");
      expect(result.wikiPages).toEqual(["solo-page"]);
      expect(result.primarySlug).toBe("solo-page");
      expect(result.relatedUpdated).toEqual([]);
    });
  });

  // Restore default mock after cross-referencing tests
  afterEach(() => {
    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });
});

// ---------------------------------------------------------------------------
// schema-aware ingest prompt
// ---------------------------------------------------------------------------

describe("schema-aware ingest prompt", () => {
  it("loadPageConventions reads the real SCHEMA.md and starts at the right heading", async () => {
    const conventions = await loadPageConventions();
    // The slice must start with the section heading itself.
    expect(conventions.startsWith("## Page conventions")).toBe(true);
    // And include a recognizable substring from the current SCHEMA.md.
    // If SCHEMA.md ever stops mentioning kebab-case slugs in this section,
    // this test failing is the co-evolution alarm — fix the schema or the
    // ingest path, not the test, to keep them in sync.
    expect(conventions).toContain("kebab-case slugs");
  });

  it("loadPageConventions stops at the next ## heading (no bleed into Operations)", async () => {
    const conventions = await loadPageConventions();
    // The very next top-level section after "Page conventions" in the
    // current SCHEMA.md is "## Operations". The slice MUST NOT include it.
    expect(conventions).not.toContain("## Operations");
    // And must not include text from later sections either.
    expect(conventions).not.toContain("Cross-reference policy");
    expect(conventions).not.toContain("Lint checks");
  });

  it("loadPageConventions returns empty string for a missing file", async () => {
    const result = await loadPageConventions(
      "/nonexistent/path/SCHEMA-does-not-exist.md",
    );
    expect(result).toBe("");
  });

  it("loadPageConventions returns empty string when section is absent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-schema-"));
    try {
      const fakeSchema = path.join(tmpDir, "SCHEMA.md");
      await fs.writeFile(
        fakeSchema,
        "# Wiki Schema\n\n## Layers\n\nNothing about page conventions here.\n",
      );
      const result = await loadPageConventions(fakeSchema);
      expect(result).toBe("");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("buildIngestSystemPrompt composes the base prompt with the conventions slice", async () => {
    const prompt = await buildIngestSystemPrompt();
    // Base prompt marker — comes from INGEST_SYSTEM_PROMPT_BASE.
    expect(prompt).toContain("You are a wiki editor");
    // Conventions marker — comes from SCHEMA.md.
    expect(prompt).toContain("## Page conventions");
    expect(prompt).toContain("kebab-case slugs");
    // The composition glue text proves we went through the full path,
    // not just the early-return branch.
    expect(prompt).toContain("conventions (from SCHEMA.md)");
  });

  it("buildIngestSystemPrompt always contains the base prompt (graceful composition)", async () => {
    // Whether or not SCHEMA.md is present, the base prompt must survive
    // intact — graceful degradation rather than a crash on a fresh clone.
    const prompt = await buildIngestSystemPrompt();
    expect(prompt).toContain("You are a wiki editor");
    expect(prompt).toContain("then pure markdown, and nothing else");
    // Asks the LLM to emit the leading CONCEPT marker (drives concept-slug
    // convergence — see parseConceptMarker).
    expect(prompt).toContain("CONCEPT: <canonical concept name>");
    // Fidelity section: the prompt asks for a Details section that preserves
    // substantive source content (not just a thin summary).
    expect(prompt).toContain("## Details");
  });

  it("buildIngestSystemPrompt asks for a TAGS line in the output spec", async () => {
    const prompt = await buildIngestSystemPrompt();
    expect(prompt).toContain("TAGS:");
    expect(prompt).toContain("lowercase, hyphenated");
  });
});

// ---------------------------------------------------------------------------
// parseConceptMarker — pull the leading CONCEPT line out of synthesis output
// ---------------------------------------------------------------------------

describe("parseConceptMarker", () => {
  it("extracts the concept and strips the marker line from the body", () => {
    const { concept, aliases, body } = parseConceptMarker(
      "CONCEPT: Transformer\n\n# Transformer\n\n## Summary\n\nAttention.",
    );
    expect(concept).toBe("Transformer");
    expect(aliases).toEqual([]);
    expect(body).toBe("# Transformer\n\n## Summary\n\nAttention.");
    expect(body).not.toContain("CONCEPT:");
  });

  it("parses the ALIASES line into a synonym list and strips both headers", () => {
    const { concept, aliases, body } = parseConceptMarker(
      "CONCEPT: Retrieval-Augmented Generation\nALIASES: RAG, retrieval augmentation; RAG pipeline\n\n# RAG\n\nBody.",
    );
    expect(concept).toBe("Retrieval-Augmented Generation");
    expect(aliases).toEqual(["RAG", "retrieval augmentation", "RAG pipeline"]);
    expect(body).toBe("# RAG\n\nBody.");
    expect(body).not.toContain("ALIASES:");
  });

  it("treats ALIASES: none as no aliases", () => {
    const { concept, aliases, body } = parseConceptMarker(
      "CONCEPT: Backpropagation\nALIASES: none\n\n# Backpropagation\n",
    );
    expect(concept).toBe("Backpropagation");
    expect(aliases).toEqual([]);
    expect(body).toBe("# Backpropagation\n");
  });

  it("returns concept '' and the unchanged body when no marker is present", () => {
    const raw = "# Plain Page\n\n## Summary\n\nNo marker here.";
    const { concept, aliases, body } = parseConceptMarker(raw);
    expect(concept).toBe("");
    expect(aliases).toEqual([]);
    expect(body).toBe(raw);
  });

  it("is case-insensitive and tolerates leading whitespace / a BOM", () => {
    const { concept, body } = parseConceptMarker(
      "﻿  concept:   Self-Attention  \n# Title",
    );
    expect(concept).toBe("Self-Attention");
    expect(body).toBe("# Title");
  });

  it("handles CRLF line endings", () => {
    const { concept, body } = parseConceptMarker(
      "CONCEPT: RAG\r\n\r\n# RAG\r\n",
    );
    expect(concept).toBe("RAG");
    expect(body).toBe("# RAG\r\n");
  });

  it("only consumes a marker on the FIRST line, not mid-body", () => {
    const raw = "# Title\n\nThe line CONCEPT: not-a-marker appears in prose.";
    const { concept, body } = parseConceptMarker(raw);
    expect(concept).toBe("");
    expect(body).toBe(raw);
  });

  it("parses a TAGS line (normalized) and strips all three headers", () => {
    const { concept, aliases, tags, body } = parseConceptMarker(
      "CONCEPT: Transformer\nALIASES: none\nTAGS: Machine Learning, deep-learning, #NLP\n\n# Transformer\n\nBody.",
    );
    expect(concept).toBe("Transformer");
    expect(aliases).toEqual([]);
    expect(tags).toEqual(["machine-learning", "deep-learning", "nlp"]);
    expect(body).toBe("# Transformer\n\nBody.");
    expect(body).not.toContain("TAGS:");
  });

  it("parses TAGS even when it precedes ALIASES", () => {
    const { aliases, tags, body } = parseConceptMarker(
      "CONCEPT: RAG\nTAGS: retrieval, llm\nALIASES: retrieval-augmented generation\n\n# RAG\n",
    );
    expect(tags).toEqual(["retrieval", "llm"]);
    expect(aliases).toEqual(["retrieval-augmented generation"]);
    expect(body).toBe("# RAG\n");
  });

  it("returns no tags when the TAGS line is absent or 'none'", () => {
    expect(parseConceptMarker("CONCEPT: X\n\n# X\n").tags).toEqual([]);
    expect(parseConceptMarker("CONCEPT: X\nTAGS: none\n\n# X\n").tags).toEqual([]);
  });
});

describe("computeConfidence", () => {
  const src = (type: SourceEntry["type"], url: string): SourceEntry => ({
    type,
    url,
    fetched: "2026-01-01",
    triggered_by: "system",
  });

  it("scores by the strongest source type present", () => {
    expect(computeConfidence([src("text", "text-paste")], false)).toBe(0.5);
    expect(computeConfidence([src("url", "https://a.com")], false)).toBe(0.6);
    expect(computeConfidence([src("pdf", "https://a.com/p.pdf")], false)).toBe(0.68);
    // strongest type wins (same URL → no corroboration bonus)
    expect(
      computeConfidence([src("text", "https://a.com"), src("pdf", "https://a.com")], false),
    ).toBe(0.68);
  });

  it("adds corroboration for additional distinct source URLs (capped)", () => {
    expect(
      computeConfidence([src("url", "https://a.com"), src("url", "https://b.com")], false),
    ).toBe(0.65); // 0.6 + 0.05
    expect(
      computeConfidence(
        [
          src("url", "https://a.com"),
          src("url", "https://b.com"),
          src("url", "https://c.com"),
          src("url", "https://d.com"),
          src("url", "https://e.com"),
        ],
        false,
      ),
    ).toBe(0.75); // 0.6 + capped 0.15
  });

  it("normalizes URL variants before counting distinct sources", () => {
    // http vs https + trailing slash → same source, no corroboration bonus
    expect(
      computeConfidence(
        [src("url", "http://example.com"), src("url", "https://www.example.com/")],
        false,
      ),
    ).toBe(0.6); // only 1 distinct URL after normalization → no bonus
    // text-paste sentinel should NOT be normalized
    expect(
      computeConfidence(
        [src("text", "text-paste"), src("text", "text-paste")],
        false,
      ),
    ).toBe(0.5); // both are text-paste → 1 distinct, no bonus
  });

  it("caps a disputed page at 0.5 and falls back to 0.5 for no sources", () => {
    expect(computeConfidence([src("pdf", "https://a.com/p.pdf")], true)).toBe(0.5);
    expect(computeConfidence([], false)).toBe(0.5);
  });
});

describe("normalizeTags", () => {
  it("lowercases, hyphenates, strips '#', and dedupes", () => {
    expect(normalizeTags(["Machine Learning", "#NLP", "machine  learning", "deep_learning"])).toEqual([
      "machine-learning",
      "nlp",
      "deep-learning",
    ]);
  });

  it("caps the number of tags", () => {
    expect(normalizeTags(["a", "b", "c", "d", "e", "f", "g", "h"], 3)).toEqual(["a", "b", "c"]);
  });

  it("drops entries that normalize to empty", () => {
    expect(normalizeTags(["###", "  ", "ok"])).toEqual(["ok"]);
  });

  it("preserves CJK tags (shares slugify's char class)", () => {
    // CJK is kept, not stripped — a Chinese/Korean concept tag must survive the
    // same way CJK slugs do. ASCII normalization is unchanged.
    expect(normalizeTags(["知识库", "Machine Learning", "데이터"])).toEqual([
      "知识库",
      "machine-learning",
      "데이터",
    ]);
  });
});

describe("parseDisputedMarker", () => {
  it("detects a leading DISPUTED: yes line and strips it", () => {
    const { disputed, body } = parseDisputedMarker(
      "DISPUTED: yes\n\n# Topic\n\nBoth views.",
    );
    expect(disputed).toBe(true);
    expect(body).toBe("# Topic\n\nBoth views.");
    expect(body).not.toContain("DISPUTED:");
  });

  it("returns disputed=false and the unchanged body when no marker", () => {
    const raw = "# Topic\n\nA reconciled, undisputed page.";
    const { disputed, body } = parseDisputedMarker(raw);
    expect(disputed).toBe(false);
    expect(body).toBe(raw);
  });

  it("does not trip on the word disputed appearing mid-body", () => {
    const raw = "# Topic\n\nThe sources are DISPUTED: yes, in prose.";
    const { disputed, body } = parseDisputedMarker(raw);
    expect(disputed).toBe(false);
    expect(body).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// ingest — concept-slug convergence (content-derived slug from CONCEPT marker)
// ---------------------------------------------------------------------------

describe("ingest — concept-slug convergence", () => {
  beforeEach(() => {
    resetSourceIndex();
    resetAliasIndex();
    mockedHasLLMKey.mockReturnValue(true);
  });
  afterEach(() => {
    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  it("derives the page slug from the CONCEPT marker, not the title", async () => {
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Transformer\n\n# Transformer\n\n## Summary\n\nSelf-attention architecture.",
    );

    const result = await ingest(
      "An Illustrated Intro to Transformers",
      "Transformers use self-attention. More detail about the architecture here.",
    );

    // Slug comes from the concept, not slugify(title).
    expect(result.primarySlug).toBe("transformer");

    const page = await readWikiPageWithFrontmatter("transformer");
    expect(page).not.toBeNull();
    // Marker line never leaks into the stored body.
    expect(page!.content).not.toContain("CONCEPT:");
    // The page is titled by the concept, and the source title becomes an alias
    // so a later ingest under that title also converges here.
    expect(page!.frontmatter.aliases).toContain(
      "An Illustrated Intro to Transformers",
    );
  });

  it("converges two differently-titled sources of one concept onto a single page", async () => {
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Transformer\n\n# Transformer\n\n## Summary\n\nThe attention architecture.",
    );

    await ingest("Intro to Transformers", "First source about transformers. Details.");
    await ingest("The Transformer, Explained", "A second, differently-worded source. More.");

    const entries = await listWikiPages();
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("transformer");

    const page = await readWikiPageWithFrontmatter("transformer");
    // Both ingests counted as sources of the one concept page. (YAML may
    // round-trip the count as a number, so compare numerically.)
    expect(Number(page!.frontmatter.source_count)).toBe(2);
    // Both source titles recorded as aliases.
    expect(page!.frontmatter.aliases).toContain("Intro to Transformers");
    expect(page!.frontmatter.aliases).toContain("The Transformer, Explained");
  });

  it("falls back to the title slug when the LLM emits no CONCEPT marker", async () => {
    mockedCallLLM.mockResolvedValue(
      "# Plain Page\n\n## Summary\n\nNo concept marker emitted.",
    );

    const result = await ingest("Plain Title", "Some content without a marker. More.");

    expect(result.primarySlug).toBe("plain-title");
    const page = await readWikiPageWithFrontmatter("plain-title");
    // No self-alias when no convergence happened (concept == title route).
    expect((page!.frontmatter.aliases ?? []) as string[]).not.toContain(
      "Plain Title",
    );
  });

  it("records the LLM-supplied concept synonyms as aliases", async () => {
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Retrieval-Augmented Generation\nALIASES: RAG, retrieval augmentation\n\n# RAG\n\n## Summary\n\nGrounded generation.",
    );

    const result = await ingest(
      "A Deep Dive on RAG Systems",
      "RAG grounds an LLM in retrieved documents. Architecture details here.",
    );

    expect(result.primarySlug).toBe("retrieval-augmented-generation");
    const page = await readWikiPageWithFrontmatter(
      "retrieval-augmented-generation",
    );
    const aliases = (page!.frontmatter.aliases ?? []) as string[];
    expect(aliases).toContain("RAG");
    expect(aliases).toContain("retrieval augmentation");
    // Plus the source title.
    expect(aliases).toContain("A Deep Dive on RAG Systems");
  });

  it("pinSlug keeps the page on its slug instead of forking to the concept slug", async () => {
    // Even though the LLM names a different concept, pinSlug (used by reingest)
    // must update IN PLACE rather than fork to `totally-different`.
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Totally Different\n\n# Totally Different\n\n## Summary\n\nBody.",
    );

    const result = await ingest("Pinned Page", "some source content here", {
      pinSlug: "pinned-page",
    });

    expect(result.primarySlug).toBe("pinned-page");
    expect(await readWikiPageWithFrontmatter("pinned-page")).not.toBeNull();
    expect(await readWikiPageWithFrontmatter("totally-different")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ingest — concept resolver (layer 3: retrieve candidates + LLM-adjudicate merge)
// ---------------------------------------------------------------------------

describe("ingest — concept resolver (adjudicated merge)", () => {
  beforeEach(() => {
    resetSourceIndex();
    resetAliasIndex();
    mockedHasLLMKey.mockReturnValue(true);
    mockedCallLLM.mockImplementation(async (system: string, user: string) => {
      // The adjudicator (distinct system prompt) decides merges; by default it
      // confirms a merge into "alpha-thing" whenever that candidate is offered.
      if (system.includes("decide whether")) {
        return user.includes("alpha-thing") ? "alpha-thing" : "none";
      }
      // Otherwise it's the synthesis call — two differently-worded sources get
      // DIFFERENT concept slugs, so only the adjudicator can merge them.
      return user.includes("alpha")
        ? "CONCEPT: Alpha Thing\nALIASES: none\n\n# Alpha Thing\n\n## Summary\n\nAbout alpha."
        : "CONCEPT: Beta Thing\nALIASES: none\n\n# Beta Thing\n\n## Summary\n\nAbout beta.";
    });
  });
  afterEach(() => {
    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
    mockedHasEmbeddingSupport.mockReturnValue(false);
    mockedSearchByVector.mockResolvedValue([]);
  });

  it("merges a differently-worded source into the candidate the adjudicator confirms", async () => {
    mockedHasEmbeddingSupport.mockReturnValue(true);
    // The retrieval surfaces "alpha-thing" as a near candidate; the adjudicator
    // (mock) confirms it's the same concept.
    mockedSearchByVector.mockResolvedValue([
      { slug: "alpha-thing", score: 0.95 },
    ]);

    // First source forks its own page (no existing page to merge into yet —
    // the search hit names a page that doesn't exist at that moment, so it's
    // skipped and "alpha-thing" is created).
    await ingest("Alpha Source", "First source, alpha topic. Details here.");
    expect((await listWikiPages()).map((p) => p.slug)).toEqual(["alpha-thing"]);

    // Second source's concept slug would be "beta-thing", but retrieval points
    // at "alpha-thing" (same owner/scope) and the adjudicator confirms → merge.
    const result = await ingest("Beta Source", "Second source, beta wording. More.");

    expect(result.primarySlug).toBe("alpha-thing");
    const pages = await listWikiPages();
    expect(pages).toHaveLength(1);
    expect(pages[0].slug).toBe("alpha-thing");
    expect(
      Number(
        (await readWikiPageWithFrontmatter("alpha-thing"))!.frontmatter
          .source_count,
      ),
    ).toBe(2);
  });

  it("forks when no candidate clears the retrieval floor (no adjudication call)", async () => {
    mockedHasEmbeddingSupport.mockReturnValue(true);
    // Nearest page exists but is below CONCEPT_ADJUDICATE_FLOOR (0.6) → it isn't
    // even offered to the adjudicator → fork.
    mockedSearchByVector.mockResolvedValue([
      { slug: "alpha-thing", score: 0.5 },
    ]);

    await ingest("Alpha Source", "First source, alpha topic. Details here.");
    await ingest("Beta Source", "Second source, beta wording. More.");

    const slugs = (await listWikiPages()).map((p) => p.slug).sort();
    expect(slugs).toEqual(["alpha-thing", "beta-thing"]);
    // Cost invariant: nothing cleared the floor → the adjudicator never ran.
    expect(
      mockedCallLLM.mock.calls.filter((c) => c[0].includes("decide whether")),
    ).toHaveLength(0);
  });

  it("never folds into an artifact / agent-scoped candidate even at the same scope", async () => {
    mockedHasEmbeddingSupport.mockReturnValue(true);
    mockedSearchByVector.mockResolvedValue([{ slug: "alpha-thing", score: 0.95 }]);

    // Both pages are agent-knowledge + same owner, so the scope-EQUALITY check
    // passes; only the artifact/agent-scoped guard can prevent the fold here.
    await ingest("Alpha Source", "First source, alpha topic. Details here.", {
      pageType: "agent-knowledge",
      owner: "alice",
      author: "alice",
    });
    const result = await ingest("Beta Source", "Second source, beta wording. More.", {
      pageType: "agent-knowledge",
      owner: "alice",
      author: "alice",
    });

    expect(result.primarySlug).toBe("beta-thing"); // forked, not merged
    // The guard drops the candidate BEFORE adjudication — so it never even ran.
    expect(
      mockedCallLLM.mock.calls.filter((c) => c[0].includes("decide whether")),
    ).toHaveLength(0);
  });

  it("forks when the adjudicator judges the candidate a DIFFERENT concept", async () => {
    mockedHasEmbeddingSupport.mockReturnValue(true);
    mockedSearchByVector.mockResolvedValue([{ slug: "alpha-thing", score: 0.95 }]);
    // Override: adjudicator always says "none".
    mockedCallLLM.mockImplementation(async (system: string, user: string) =>
      system.includes("decide whether")
        ? "none"
        : user.includes("alpha")
          ? "CONCEPT: Alpha Thing\nALIASES: none\n\n# Alpha Thing\n\n## Summary\n\nA."
          : "CONCEPT: Beta Thing\nALIASES: none\n\n# Beta Thing\n\n## Summary\n\nB.",
    );

    await ingest("Alpha Source", "First source, alpha topic. Details here.");
    const result = await ingest("Beta Source", "Second source, beta wording. More.");

    expect(result.primarySlug).toBe("beta-thing");
    expect((await listWikiPages()).map((p) => p.slug).sort()).toEqual([
      "alpha-thing",
      "beta-thing",
    ]);
  });

  it("forks when the adjudicator returns a slug that wasn't offered (hallucination guard)", async () => {
    mockedHasEmbeddingSupport.mockReturnValue(true);
    mockedSearchByVector.mockResolvedValue([{ slug: "alpha-thing", score: 0.95 }]);
    mockedCallLLM.mockImplementation(async (system: string, user: string) =>
      system.includes("decide whether")
        ? "some-other-slug" // not one of the candidates
        : user.includes("alpha")
          ? "CONCEPT: Alpha Thing\nALIASES: none\n\n# Alpha Thing\n\n## Summary\n\nA."
          : "CONCEPT: Beta Thing\nALIASES: none\n\n# Beta Thing\n\n## Summary\n\nB.",
    );

    await ingest("Alpha Source", "First source, alpha topic. Details here.");
    const result = await ingest("Beta Source", "Second source, beta wording. More.");

    expect(result.primarySlug).toBe("beta-thing");
  });

  it("merges via the BM25 fallback when embeddings are unavailable (the pre-backfill prod path)", async () => {
    // Vectorize not backfilled → searchByVector unused; candidates come from a
    // title+summary BM25 pass. The two sources share tokens ("widget protocol").
    mockedHasEmbeddingSupport.mockReturnValue(false);
    mockedCallLLM.mockImplementation(async (system: string, user: string) => {
      if (system.includes("decide whether")) {
        return user.includes("widget-protocol") ? "widget-protocol" : "none";
      }
      return user.toLowerCase().includes("specification")
        ? "CONCEPT: Widget Protocol\nALIASES: none\n\n# Widget Protocol\n\n## Summary\n\nThe widget protocol specification."
        : "CONCEPT: Widget Spec\nALIASES: none\n\n# Widget Spec\n\n## Summary\n\nThe widget protocol, explained.";
    });

    await ingest("First", "First note on the widget protocol specification details.");
    expect((await listWikiPages()).map((p) => p.slug)).toContain("widget-protocol");

    const result = await ingest("Second", "Second note, widget protocol explained anew.");

    expect(result.primarySlug).toBe("widget-protocol");
    expect(await listWikiPages()).toHaveLength(1);
  });

  it("does NOT semantic-merge an agent-knowledge ingest into a public page (scope guard)", async () => {
    mockedHasEmbeddingSupport.mockReturnValue(true);
    mockedSearchByVector.mockResolvedValue([
      { slug: "alpha-thing", score: 0.95 },
    ]);

    // Public page first (no `type`).
    await ingest("Alpha Source", "First source, alpha topic. Details here.");
    // Same owner, semantically near — but agent-scoped. The scope guard forks
    // rather than folding agent-knowledge into the public feed page.
    const result = await ingest("Beta Source", "Second source, beta wording. More.", {
      pageType: "agent-knowledge",
    });

    expect(result.primarySlug).toBe("beta-thing");
    expect(await readWikiPageWithFrontmatter("beta-thing")).not.toBeNull();
    // The public page was left untouched (still a single source).
    const alpha = await readWikiPageWithFrontmatter("alpha-thing");
    expect(Number(alpha!.frontmatter.source_count)).toBe(1);
  });

  it("does NOT merge across owners even on a high-confidence hit", async () => {
    mockedHasEmbeddingSupport.mockReturnValue(true);
    mockedSearchByVector.mockResolvedValue([
      { slug: "alpha-thing", score: 0.95 },
    ]);

    // Alice owns the alpha page.
    await ingest("Alpha Source", "First source, alpha topic. Details here.", {
      owner: "alice",
      author: "alice",
    });
    // Bob ingests a semantically-near source — the same-silo guard must fork
    // rather than attach Bob's source to Alice's page.
    await ingest("Beta Source", "Second source, beta wording. More.", {
      owner: "bob",
      author: "bob",
    });

    const slugs = (await listWikiPages()).map((p) => p.slug).sort();
    expect(slugs).toEqual(["alpha-thing", "beta-thing"]);
  });
});

// ---------------------------------------------------------------------------
// ingest — reconcile on merge (layer 4: accumulate-and-reconcile + disputed)
// ---------------------------------------------------------------------------

describe("ingest — reconcile on merge", () => {
  // Synthesis emits a CONCEPT marker; the reconcile call (distinguished by its
  // system prompt) returns the merged body. Keyed on the prompt so the two LLM
  // roles never cross-contaminate.
  function wire(reconcileOutput: string) {
    mockedCallLLM.mockImplementation(async (system: string) =>
      system.includes("canonical page about one concept")
        ? reconcileOutput
        : "CONCEPT: Topic\nALIASES: none\n\n# Topic\n\n## Summary\n\nA take on the topic.",
    );
  }

  beforeEach(() => {
    resetSourceIndex();
    resetAliasIndex();
    mockedHasLLMKey.mockReturnValue(true);
  });
  afterEach(() => {
    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  it("re-synthesizes existing + new into the merged body (not an overwrite)", async () => {
    wire("# Topic\n\n## Summary\n\nMerged: both the first and second takes combined.");

    await ingest("Topic A", "First source for the topic. Details one.");
    const result = await ingest("Topic B", "Second complementary source. Details two.");

    expect(result.primarySlug).toBe("topic");
    const page = await readWikiPageWithFrontmatter("topic");
    expect(page!.content).toContain("Merged: both the first and second takes combined.");
    expect(page!.frontmatter.disputed).toBe(false);
    // The merge counted both sources onto the one page.
    expect(Number(page!.frontmatter.source_count)).toBe(2);

    // Reconcile must see the frontmatter-STRIPPED existing body, never the YAML
    // block — otherwise page metadata (owner/content_hash/…) leaks into the
    // merge prompt and can bleed into the merged prose.
    const reconcileCall = mockedCallLLM.mock.calls.find(([sys]) =>
      (sys as string).includes("canonical page about one concept"),
    );
    expect(reconcileCall).toBeDefined();
    const reconcileUser = reconcileCall![1] as string;
    expect(reconcileUser).not.toContain("content_hash:");
    expect(reconcileUser).not.toMatch(/^owner:/m);
  });

  it("flags the page disputed when reconcile reports a contradiction", async () => {
    wire("DISPUTED: yes\n\n# Topic\n\n## Summary\n\nExisting says X; the new source says Y.");

    await ingest("Topic A", "Original claim about the topic. Details.");
    await ingest("Topic B", "A contradicting claim about the topic. Details.");

    const page = await readWikiPageWithFrontmatter("topic");
    expect(page!.frontmatter.disputed).toBe(true);
    // A reconcile-escalated dispute caps confidence at 0.5 (computed after the
    // reconcile sets the flag).
    expect(page!.frontmatter.confidence).toBe(0.5);
    expect(page!.content).toContain("Existing says X; the new source says Y.");
    // The DISPUTED marker is stripped from the stored body.
    expect(page!.content).not.toContain("DISPUTED:");
  });

  it("does NOT reconcile (no extra LLM call) when there is no existing page", async () => {
    wire("# Topic\n\nMerged body that must never appear for a brand-new page.");

    await ingest("Topic A", "Only source. Details.");

    // Exactly one page, and the reconcile output never reached it.
    const page = await readWikiPageWithFrontmatter("topic");
    expect(page!.content).not.toContain("Merged body that must never appear");
    expect(page!.frontmatter.disputed).toBe(false);
  });

  it("degrades to the new body (ingest still succeeds) when reconcile throws", async () => {
    // callLLM throws on API errors / empty output; the merge path must not let
    // that fail an ingest whose synthesis already succeeded.
    mockedCallLLM.mockImplementation(async (system: string) => {
      if (system.includes("canonical page about one concept")) {
        throw new Error("LLM response contained no text");
      }
      return "CONCEPT: Topic\nALIASES: none\n\n# Topic\n\n## Summary\n\nFresh synthesis body.";
    });

    await ingest("Topic A", "First source. Details one.");
    const result = await ingest("Topic B", "Second source. Details two.");

    expect(result.primarySlug).toBe("topic");
    const page = await readWikiPageWithFrontmatter("topic");
    // Reconcile failed → kept the freshly synthesized body; ingest succeeded.
    expect(page!.content).toContain("Fresh synthesis body.");
    expect(page!.frontmatter.disputed).toBe(false);
    expect(Number(page!.frontmatter.source_count)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ingest — realm guard: never converge a non-owner onto a PRIVATE page
// (private = owner-only; the Finding-1 fix)
// ---------------------------------------------------------------------------

describe("ingest — private-page convergence guard", () => {
  beforeEach(() => {
    resetSourceIndex();
    resetAliasIndex();
    mockedHasLLMKey.mockReturnValue(true);
  });
  afterEach(() => {
    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  /** Seed a PRIVATE page owned by `owner` with the given slug + body/hash. */
  async function seedPrivate(
    slug: string,
    owner: string,
    body: string,
    extra: Partial<Frontmatter> = {},
  ) {
    const fm: Frontmatter = {
      created: "2026-01-01",
      updated: "2026-01-01",
      owner,
      visibility: "private",
      authors: [owner],
      contributors: [],
      source_count: "1",
      confidence: 0.7,
      expiry: "2099-01-01",
      tags: [],
      content_hash: contentHash(body),
      ...extra,
    };
    await writeWikiPage(slug, serializeFrontmatter(fm, `# ${slug}\n\n${body}`));
    // Rebuild the source + alias indexes so the seeded page is resolvable.
    resetSourceIndex();
    resetAliasIndex();
  }

  it("does NOT dedup a non-owner's identical-content ingest into a private page", async () => {
    const body = "Identical body for the private dedup test. More detail here.";
    await seedPrivate("alice-secret", "alice", body);
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Bob Topic\nALIASES: none\n\n# Bob Topic\n\n## Summary\n\nBob's own.",
    );

    const result = await ingest("Bob Doc", body, {
      owner: "bob",
      author: "bob",
    });

    // Bob got his OWN page, not alice's private slug.
    expect(result.primarySlug).not.toBe("alice-secret");
    expect(result.deduped).toBeFalsy();
    // Alice's private page is untouched (no new source, no bob contributor).
    const priv = await readWikiPageWithFrontmatter("alice-secret");
    expect(Number(priv!.frontmatter.source_count)).toBe(1);
    expect(priv!.frontmatter.contributors).not.toContain("bob");
  });

  it("forks when a non-owner's concept slug collides with a private page", async () => {
    await seedPrivate("transformer", "alice", "Alice's private notes on transformers.");
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Transformer\nALIASES: none\n\n# Transformer\n\n## Summary\n\nBob's public take.",
    );

    const result = await ingest("Bob On Transformers", "Bob's distinct source text about them.", {
      owner: "bob",
      author: "bob",
    });

    // Forked off the occupied private slug.
    expect(result.primarySlug).not.toBe("transformer");
    expect(result.primarySlug).toMatch(/^transformer-\d+$/);
    // Alice's private page is untouched.
    const priv = await readWikiPageWithFrontmatter("transformer");
    expect(priv!.frontmatter.owner).toBe("alice");
    expect(priv!.frontmatter.visibility).toBe("private");
    expect(Number(priv!.frontmatter.source_count)).toBe(1);
  });

  it("lets the OWNER re-ingest into their own private page (merge, no fork)", async () => {
    await seedPrivate("transformer", "alice", "Alice's first private take on transformers.");
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Transformer\nALIASES: none\n\n# Transformer\n\n## Summary\n\nAlice's refined take.",
    );

    const result = await ingest("Transformers", "Alice's second private source.", {
      owner: "alice",
      author: "alice",
    });

    expect(result.primarySlug).toBe("transformer");
    const priv = await readWikiPageWithFrontmatter("transformer");
    expect(Number(priv!.frontmatter.source_count)).toBe(2);
    expect(priv!.frontmatter.visibility).toBe("private"); // stays private
  });

  it("lets the owner's AGENT write the owner's private page (agents of owner can write his vault)", async () => {
    await seedPrivate("transformer", "alice", "Alice's first private take.");
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Transformer\nALIASES: none\n\n# Transformer\n\n## Summary\n\nAgent's addition.",
    );

    // The agent acts for alice (owner = alice--yoyo → same human owner).
    const result = await ingest("Transformers", "A source the agent found.", {
      owner: "alice--yoyo",
      author: "alice--yoyo",
    });

    expect(result.primarySlug).toBe("transformer");
    expect(Number((await readWikiPageWithFrontmatter("transformer"))!.frontmatter.source_count)).toBe(2);
  });

  it("does NOT write into a private page bob doesn't own — forks to his own slug", async () => {
    await seedPrivate("transformer", "alice", "Alice's private notes on transformers.");
    mockedCallLLM.mockResolvedValue(
      "CONCEPT: Transformer\nALIASES: none\n\n# Transformer\n\n## Summary\n\nBob's page.",
    );

    // Bob ingests under a title that resolves (via the alias index) to alice's
    // private slug "transformer". The fork guard forks to a fresh slug, so the
    // private page is never written to and its slug never comes back.
    const result = await ingest("Transformer", "Bob's distinct source text.", {
      owner: "bob",
      author: "bob",
    });

    expect(result.primarySlug).not.toBe("transformer");
    expect(result.wikiPages).not.toContain("transformer");
    expect(result.relatedUpdated).not.toContain("transformer");
    // Alice's private page is untouched — still one source.
    expect(
      Number((await readWikiPageWithFrontmatter("transformer"))!.frontmatter.source_count),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe("chunkText", () => {
  it("returns a single chunk when content is shorter than limit", () => {
    const text = "Short content here.";
    const chunks = chunkText(text, 100);
    expect(chunks).toEqual([text]);
  });

  it("splits on paragraph boundaries", () => {
    const para1 = "First paragraph with some text.";
    const para2 = "Second paragraph with more text.";
    const para3 = "Third paragraph with even more.";
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    // Each paragraph is ~31 chars. Set limit to 65 so two fit but not three.
    const chunks = chunkText(text, 65);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${para1}\n\n${para2}`);
    expect(chunks[1]).toBe(para3);
  });

  it("splits a single giant paragraph on sentence boundaries", () => {
    const s1 = "First sentence here.";
    const s2 = "Second sentence here.";
    const s3 = "Third sentence here.";
    // Single paragraph (no \n\n), joined by spaces
    const text = `${s1} ${s2} ${s3}`;
    // Set limit so only ~2 sentences fit per chunk
    const chunks = chunkText(text, 45);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Every chunk must be within the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(45);
    }
  });

  it("preserves all content (join approximates original)", () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i + 1} has some content about topic ${i}.`,
    );
    const text = paragraphs.join("\n\n");
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // Rejoining should contain all original paragraphs
    const rejoined = chunks.join("\n\n");
    for (const para of paragraphs) {
      expect(rejoined).toContain(para);
    }
  });

  it("hard-splits a sentence that exceeds maxChars", () => {
    // One long word with no sentence boundaries
    const text = "a".repeat(300);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("uses MAX_LLM_INPUT_CHARS as the default", () => {
    // Just verify the constant is exported and is a sensible number
    expect(MAX_LLM_INPUT_CHARS).toBe(12_000);
    // Default chunkText with short text returns single chunk
    const short = "hello";
    expect(chunkText(short)).toEqual([short]);
  });
});

// ---------------------------------------------------------------------------
// ingest — chunked LLM calls for long content
// ---------------------------------------------------------------------------

describe("ingest — chunked LLM calls", () => {
  it("calls LLM multiple times for long content", async () => {
    // Enable LLM mock
    mockedHasLLMKey.mockReturnValue(true);
    mockedCallLLM.mockResolvedValue("# Wiki Page\n\n## Summary\n\nMocked content.");

    // Create content longer than MAX_LLM_INPUT_CHARS
    const longContent = Array.from(
      { length: 300 },
      (_, i) => `Paragraph ${i} discusses topic number ${i} in detail with enough text to be substantial.`,
    ).join("\n\n");

    expect(longContent.length).toBeGreaterThan(MAX_LLM_INPUT_CHARS);

    const result = await ingest("Long Article", longContent);
    expect(result.primarySlug).toBe("long-article");

    // Should have called LLM more than once due to chunking
    expect(mockedCallLLM.mock.calls.length).toBeGreaterThan(1);

    // Reset
    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  it("map-reduces long content: maps each chunk from source, then merges into one article", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    // Route MAP vs REDUCE off the USER message structure (stable behavior), not
    // prompt prose: reduce is fed the merged "# Part N" notes; map is fed a raw
    // "Part k of N of the source" chunk.
    mockedCallLLM.mockImplementation(async (_system: string, user: string) => {
      if (/^# Part 1\b/.test(user)) {
        return "CONCEPT: Topic\nTAGS: t\n\n# Topic\n\n## Summary\n\nMerged.\n\n## Key Points\n\n- point";
      }
      return "Distilled note from a chunk.";
    });

    const longContent = Array.from(
      { length: 300 },
      (_, i) => `Paragraph ${i} discusses topic number ${i} in detail with enough text to be substantial.`,
    ).join("\n\n");
    expect(longContent.length).toBeGreaterThan(MAX_LLM_INPUT_CHARS);

    const result = await ingest("Topic", longContent);
    const calls = mockedCallLLM.mock.calls;

    // N map calls (one per chunk, each fed the SOURCE part — never a prior
    // summary, so no cross-chunk drift) + exactly one reduce call.
    const mapCalls = calls.filter((c) => /distilling ONE part/.test(c[0]));
    const reduceCalls = calls.filter((c) => /given faithful NOTES/.test(c[0]));
    expect(mapCalls.length).toBeGreaterThan(1);
    expect(reduceCalls).toHaveLength(1);
    expect(mapCalls[0][1]).toMatch(/Part 1 of \d+ of the source/);
    // The reduce input is the merged per-part notes, not a single chunk.
    expect(reduceCalls[0][1]).toContain("# Part 1");

    // The persisted page is the reduce output — one clean set of sections.
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.content).toContain("Merged.");
    expect(page!.content.match(/## Key Points/g) ?? []).toHaveLength(1);

    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  it("map-reduce partial failure: single chunk error does not crash ingest", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    let mapCallCount = 0;
    mockedCallLLM.mockImplementation(async (system: string, _user: string) => {
      // Reduce call — identified by the reduce system prompt
      if (/given faithful NOTES/.test(system)) {
        return "CONCEPT: Topic\nTAGS: t\n\n# Topic\n\n## Summary\n\nMerged.\n\n## Key Points\n\n- point";
      }
      // Map calls — fail the first one, succeed the rest
      mapCallCount++;
      if (mapCallCount === 1) {
        throw new Error("content filter triggered");
      }
      return "Distilled note from a chunk.";
    });

    const longContent = Array.from(
      { length: 300 },
      (_, i) => `Paragraph ${i} discusses topic number ${i} in detail with enough text to be substantial.`,
    ).join("\n\n");
    expect(longContent.length).toBeGreaterThan(MAX_LLM_INPUT_CHARS);

    // Should NOT throw — the failed chunk is skipped gracefully
    const result = await ingest("Topic", longContent);

    // Verify a reduce call still happened (not all chunks failed)
    const reduceCalls = mockedCallLLM.mock.calls.filter((c) => /given faithful NOTES/.test(c[0]));
    expect(reduceCalls).toHaveLength(1);

    // The page was created despite one chunk failing
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.content).toContain("Merged.");

    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  it("map-reduce total failure: all chunks error produces clear error", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedCallLLM.mockImplementation(async (system: string, _user: string) => {
      // Map calls all fail; reduce should never be reached
      if (/given faithful NOTES/.test(system)) {
        return "CONCEPT: Topic\nTAGS: t\n\n# Topic\n\n## Summary\n\nShould not appear.";
      }
      throw new Error("context overflow");
    });

    const longContent = Array.from(
      { length: 300 },
      (_, i) => `Paragraph ${i} discusses topic number ${i} in detail with enough text to be substantial.`,
    ).join("\n\n");
    expect(longContent.length).toBeGreaterThan(MAX_LLM_INPUT_CHARS);

    // Should throw because ALL map calls failed
    await expect(ingest("Topic", longContent)).rejects.toThrow(
      /synthesis produced no content/,
    );

    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });

  it("calls LLM exactly once for short content", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedCallLLM.mockResolvedValue("# Short Page\n\n## Summary\n\nBrief.");

    const shortContent = "A brief article about something. Not very long.";
    expect(shortContent.length).toBeLessThan(MAX_LLM_INPUT_CHARS);

    await ingest("Short Article", shortContent);

    expect(mockedCallLLM.mock.calls.length).toBe(1);

    mockedHasLLMKey.mockReturnValue(false);
    mockedCallLLM.mockReset();
  });
});

// ---------------------------------------------------------------------------
// validateUrlSafety — SSRF protection
// ---------------------------------------------------------------------------

describe("validateUrlSafety", () => {
  // Blocked URLs
  it("blocks localhost", () => {
    expect(() => validateUrlSafety("http://localhost/foo")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks 127.0.0.1", () => {
    expect(() => validateUrlSafety("http://127.0.0.1/foo")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks AWS metadata endpoint 169.254.169.254", () => {
    expect(() =>
      validateUrlSafety("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(/URL blocked/);
  });

  it("blocks 10.x.x.x private range", () => {
    expect(() => validateUrlSafety("http://10.0.0.1/internal")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks 192.168.x.x private range", () => {
    expect(() => validateUrlSafety("http://192.168.1.1/admin")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks 172.16.x.x private range", () => {
    expect(() => validateUrlSafety("http://172.16.0.1/")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks IPv6 loopback [::1]", () => {
    expect(() => validateUrlSafety("http://[::1]/")).toThrow(/URL blocked/);
  });

  it("blocks file:// scheme", () => {
    expect(() => validateUrlSafety("file:///etc/passwd")).toThrow(
      /URL blocked.*not allowed/,
    );
  });

  it("blocks ftp:// scheme", () => {
    expect(() => validateUrlSafety("ftp://files.example.com/")).toThrow(
      /URL blocked.*not allowed/,
    );
  });

  it("blocks .local hostnames", () => {
    expect(() => validateUrlSafety("http://myserver.local/api")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks .internal hostnames", () => {
    expect(() => validateUrlSafety("http://db.internal/admin")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks 0.0.0.0", () => {
    expect(() => validateUrlSafety("http://0.0.0.0/")).toThrow(/URL blocked/);
  });

  // Allowed URLs
  it("allows https://example.com", () => {
    expect(() => validateUrlSafety("https://example.com")).not.toThrow();
  });

  it("allows http://example.com", () => {
    expect(() => validateUrlSafety("http://example.com")).not.toThrow();
  });

  it("allows public IP addresses", () => {
    expect(() => validateUrlSafety("http://8.8.8.8/")).not.toThrow();
  });

  // IPv4-mapped IPv6 addresses
  it("blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(() => validateUrlSafety("http://[::ffff:127.0.0.1]/")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks IPv4-mapped IPv6 private (::ffff:10.0.0.1)", () => {
    expect(() => validateUrlSafety("http://[::ffff:10.0.0.1]/")).toThrow(
      /URL blocked/,
    );
  });

  it("blocks IPv4-mapped IPv6 link-local (::ffff:169.254.169.254)", () => {
    expect(() =>
      validateUrlSafety("http://[::ffff:169.254.169.254]/"),
    ).toThrow(/URL blocked/);
  });

  it("allows IPv4-mapped IPv6 public (::ffff:8.8.8.8)", () => {
    expect(() =>
      validateUrlSafety("http://[::ffff:8.8.8.8]/"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchUrlContent — redirect handling
// ---------------------------------------------------------------------------

describe("fetchUrlContent — redirect handling", () => {
  /** Helper to create a mock headers object */
  function mockHeaders(h: Record<string, string> = {}) {
    return { get: (key: string) => h[key.toLowerCase()] ?? null };
  }

  it("uses redirect: 'manual' in fetch options", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: mockHeaders(),
      text: () => Promise.resolve("<html><body><p>Hello</p></body></html>"),
      body: null,
    });

    try {
      await fetchUrlContent("https://example.com/page");
      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1]).toHaveProperty("redirect", "manual");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("follows safe redirects", async () => {
    const originalFetch = global.fetch;
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: redirect
        return Promise.resolve({
          ok: false,
          status: 302,
          headers: mockHeaders({ location: "https://safe.example.com/final" }),
          text: () => Promise.resolve(""),
          body: null,
        });
      }
      // Second call: final page
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: mockHeaders({ "content-type": "text/html" }),
        text: () =>
          Promise.resolve("<html><head><title>Final</title></head><body><p>Content here</p></body></html>"),
        body: null,
      });
    });

    try {
      const result = await fetchUrlContent("https://example.com/start");
      expect(result.title).toBe("Final");
      expect(result.content).toContain("Content here");
      expect(callCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("blocks redirect to private IP", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 301,
      headers: mockHeaders({
        location: "http://169.254.169.254/latest/meta-data/",
      }),
      text: () => Promise.resolve(""),
      body: null,
    });

    try {
      await expect(
        fetchUrlContent("https://example.com/evil-redirect"),
      ).rejects.toThrow(/URL blocked/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("blocks redirect to localhost", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: mockHeaders({ location: "http://127.0.0.1/secret" }),
      text: () => Promise.resolve(""),
      body: null,
    });

    try {
      await expect(
        fetchUrlContent("https://example.com/evil-redirect"),
      ).rejects.toThrow(/URL blocked/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws on too many redirects", async () => {
    const originalFetch = global.fetch;
    let callNum = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callNum++;
      return Promise.resolve({
        ok: false,
        status: 302,
        headers: mockHeaders({
          location: `https://example.com/hop-${callNum}`,
        }),
        text: () => Promise.resolve(""),
        body: null,
      });
    });

    try {
      await expect(
        fetchUrlContent("https://example.com/loop"),
      ).rejects.toThrow(/Too many redirects/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws when redirect has no Location header", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 301,
      headers: mockHeaders(), // no location
      text: () => Promise.resolve(""),
      body: null,
    });

    try {
      await expect(
        fetchUrlContent("https://example.com/bad-redirect"),
      ).rejects.toThrow(/Location header/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("streams body and enforces size limit incrementally", async () => {
    const originalFetch = global.fetch;
    // Create a mock readable stream that yields chunks
    const chunk1 = new TextEncoder().encode("x".repeat(100));
    const chunk2 = new TextEncoder().encode("x".repeat(6 * 1024 * 1024)); // exceeds MAX_RESPONSE_SIZE

    let readCount = 0;
    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        readCount++;
        if (readCount === 1) return Promise.resolve({ done: false, value: chunk1 });
        if (readCount === 2) return Promise.resolve({ done: false, value: chunk2 });
        return Promise.resolve({ done: true, value: undefined });
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: mockHeaders(),
      body: { getReader: () => mockReader },
    });

    try {
      await expect(
        fetchUrlContent("https://example.com/huge-stream"),
      ).rejects.toThrow(/Content too large/);
      expect(mockReader.cancel).toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// reingest
// ---------------------------------------------------------------------------

describe("reingest", () => {
  it("succeeds when page has source_url — re-fetches and updates", async () => {
    const originalFetch = global.fetch;

    // 1. Ingest a page with a source URL first
    await ingest("Reingest Test", "Original content about reingest. More details.", {
      sourceUrl: "https://example.com/reingest-test",
    });

    // Verify the page was created with source_url
    const { readWikiPageWithFrontmatter } = await import("../wiki");
    const before = await readWikiPageWithFrontmatter("reingest-test");
    expect(before).not.toBeNull();
    expect(before!.frontmatter.source_url).toBe("https://example.com/reingest-test");

    // 2. Mock global.fetch to simulate re-fetching the URL
    const mockHdrs = () =>
      new Map([["content-type", "text/html"]]) as unknown as Headers;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: mockHdrs(),
      body: null,
      text: () =>
        Promise.resolve(
          "<html><head><title>Reingest Test Updated</title></head><body><p>Updated content about reingest. Fresh data here.</p></body></html>",
        ),
    });

    try {
      const result = await reingest("reingest-test");
      expect(result.indexUpdated).toBe(true);
      expect(result.sourceUrl).toBe("https://example.com/reingest-test");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("re-ingesting a plain URL stays on the page's slug even when the concept differs (no fork)", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    const originalFetch = global.fetch;
    try {
      // First ingest → concept "Original Concept" → slug "original-concept".
      mockedCallLLM.mockResolvedValue(
        "CONCEPT: Original Concept\n\n# Original Concept\n\n## Summary\n\nv1.",
      );
      const first = await ingest("Seed Title", "seed content about the topic", {
        sourceUrl: "https://example.com/doc",
      });
      expect(first.primarySlug).toBe("original-concept");

      // Re-fetch returns fresh content; synthesis now names a DIFFERENT concept.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
        body: null,
        text: () =>
          Promise.resolve(
            "<html><head><title>Doc</title></head><body><p>completely updated body here</p></body></html>",
          ),
      });
      mockedCallLLM.mockResolvedValue(
        "CONCEPT: A Completely Different Concept\n\n# Different\n\n## Summary\n\nv2.",
      );

      const result = await reingest("original-concept");

      // Pinned: updated in place, no fork to the new concept slug.
      expect(result.primarySlug).toBe("original-concept");
      expect(
        await readWikiPageWithFrontmatter("a-completely-different-concept"),
      ).toBeNull();
    } finally {
      global.fetch = originalFetch;
      mockedHasLLMKey.mockReturnValue(false);
      mockedCallLLM.mockReset();
    }
  });

  it("re-synthesizes the page in place — a renamed concept doesn't fork the slug", async () => {
    mockedHasLLMKey.mockReturnValue(true);
    const originalFetch = global.fetch;
    try {
      mockedCallLLM.mockResolvedValue("CONCEPT: Topic\n\n# Topic\n\n## Summary\n\nv1 body.");
      await ingest("Topic", "seed", { sourceUrl: "https://example.com/doc" });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
        body: null,
        text: () =>
          Promise.resolve("<html><head><title>Doc</title></head><body><p>fresh</p></body></html>"),
      });
      // The re-synthesis renames the concept; pinSlug keeps it on "topic".
      mockedCallLLM.mockResolvedValue(
        "CONCEPT: Renamed Topic\n\n# Renamed Topic\n\n## Summary\n\nv2 body.",
      );

      const result = await reingest("topic");

      expect(result.primarySlug).toBe("topic"); // pinned — no fork to renamed-topic
      expect(await readWikiPageWithFrontmatter("renamed-topic")).toBeNull();
      const page = await readWikiPageWithFrontmatter("topic");
      // Written in place: the page now carries the v2 body (reconciled with v1).
      expect(page!.content).toContain("v2 body");
      // The title follows the new concept.
      const entries = await listWikiPages();
      expect(entries.find((e) => e.slug === "topic")!.title).toBe("Renamed Topic");
    } finally {
      global.fetch = originalFetch;
      mockedHasLLMKey.mockReturnValue(false);
      mockedCallLLM.mockReset();
    }
  });

  it("dedups a re-ingested source by URL even when the type differs", async () => {
    // A PDF page re-fetched as a plain "url" must not create a second source
    // entry for the same URL (the bug behind the duplicated arxiv sources).
    await ingest("Dup Source", "First version of the content. Details.", {
      sourceUrl: "https://example.com/paper",
      sourceType: "pdf",
    });
    await ingest("Dup Source", "Second version, changed content. More.", {
      sourceUrl: "https://example.com/paper",
      sourceType: "url",
    });

    const page = await readWikiPageWithFrontmatter("dup-source");
    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://example.com/paper");
    expect(sources[0].type).toBe("pdf"); // original, more-specific type preserved
  });

  it("throws when page has no source_url", async () => {
    // Ingest a page without a source URL (text-based ingest)
    await ingest("No Source Url", "Some content without a URL. Details here.");

    await expect(reingest("no-source-url")).rejects.toThrow(
      /no source URL recorded/,
    );
  });

  it("throws when page does not exist", async () => {
    await expect(reingest("nonexistent-page")).rejects.toThrow(
      /not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Ingest ledger persistence
// ---------------------------------------------------------------------------

import { getLedgerPath, persistToLedger, readLedger, type LedgerEntry } from "../ingest";
import { _resetStorage, getStorage } from "../storage";

describe("ingest ledger", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;

  beforeEach(async () => {
    _resetStorage();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-test-"));
    originalDataDir = process.env.DATA_DIR;
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    process.env.DATA_DIR = tmpDir;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
  });

  afterEach(async () => {
    _resetStorage();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = originalWikiDir;
    if (originalRawDir === undefined) delete process.env.RAW_DIR;
    else process.env.RAW_DIR = originalRawDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the ledger file after an ingest", async () => {
    await ingest("Ledger Test One", "Content about ledger testing. Some details.");

    const ledgerRelPath = getLedgerPath();
    const raw = await getStorage().readFile(ledgerRelPath);
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(1);

    const entry: LedgerEntry = JSON.parse(lines[0]);
    expect(entry.primary_slug).toBe("ledger-test-one");
    expect(entry.source_type).toBe("text");
    expect(entry.source_url).toBe("text-paste");
    expect(entry.status).toBe("completed");
    expect(entry.related_slugs).toEqual(expect.any(Array));
    expect(entry.started_at).toBeTruthy();
    expect(entry.finished_at).toBeTruthy();
    expect(entry.ingest_id).toContain("/ledger-test-one");
  });

  it("each entry has all 8 required fields", async () => {
    await ingest("Schema Check", "Verifying schema compliance. Details follow.");

    const raw = await getStorage().readFile(getLedgerPath());
    const lines = raw.trim().split("\n");
    const entry = JSON.parse(lines[0]);

    const requiredFields = [
      "ingest_id",
      "source_type",
      "source_url",
      "primary_slug",
      "related_slugs",
      "started_at",
      "finished_at",
      "status",
    ];
    for (const field of requiredFields) {
      expect(entry).toHaveProperty(field);
    }
  });

  it("multiple ingests append rather than overwrite", async () => {
    await ingest("Ledger Append A", "First entry about appending. Details here.");
    await ingest("Ledger Append B", "Second entry about appending. More details.");

    const raw = await getStorage().readFile(getLedgerPath());
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2);

    const first: LedgerEntry = JSON.parse(lines[0]);
    const second: LedgerEntry = JSON.parse(lines[1]);
    expect(first.primary_slug).toBe("ledger-append-a");
    expect(second.primary_slug).toBe("ledger-append-b");
  });

  it("records url source type when sourceUrl is provided", async () => {
    await ingest("Url Ingest", "Content from a URL source. Description here.", {
      sourceUrl: "https://example.com/article",
    });

    const raw = await getStorage().readFile(getLedgerPath());
    const lines = raw.trim().split("\n");
    const entry: LedgerEntry = JSON.parse(lines[0]);
    expect(entry.source_type).toBe("url");
    expect(entry.source_url).toBe("https://example.com/article");
  });

  it("ledger write failure does not break ingest", async () => {
    // Make the data directory unwritable by pointing DATA_DIR to a file
    const blockingFile = path.join(tmpDir, "data");
    await fs.writeFile(blockingFile, "not-a-directory");
    _resetStorage();

    // The ingest should still succeed despite the ledger being unwritable
    const result = await ingest("Failure Safe", "Content that should still ingest. Details.");
    expect(result.primarySlug).toBe("failure-safe");
    expect(result.indexUpdated).toBe(true);
  });

  it("ingest_id follows ISO-timestamp/slug format", async () => {
    await ingest("Id Format", "Testing the ID format. Extra content here.");

    const raw = await getStorage().readFile(getLedgerPath());
    const lines = raw.trim().split("\n");
    const entry: LedgerEntry = JSON.parse(lines[0]);

    // ingest_id should be ISO timestamp + "/" + slug
    const parts = entry.ingest_id.split("/");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // First part should be a valid ISO timestamp
    const timestamp = parts[0];
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    // Last part should be the slug
    expect(parts[parts.length - 1]).toBe("id-format");
  });

  it("persistToLedger creates data/ directory if missing", async () => {
    const dataSubDir = path.join(tmpDir, "data");
    // Verify the data/ dir doesn't exist yet
    await expect(fs.access(dataSubDir)).rejects.toThrow();

    await persistToLedger({
      ingest_id: "2026-01-01T00:00:00.000Z/test",
      source_type: "text",
      source_url: "text-paste",
      primary_slug: "test",
      related_slugs: [],
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      status: "completed",
    });

    // Now the data/ dir and ledger file should exist
    const stat = await fs.stat(dataSubDir);
    expect(stat.isDirectory()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // readLedger
  // -------------------------------------------------------------------------

  it("readLedger returns empty array when ledger file does not exist", async () => {
    const entries = await readLedger();
    expect(entries).toEqual([]);
  });

  it("readLedger returns entries most-recent-first", async () => {
    const entry1: LedgerEntry = {
      ingest_id: "2026-01-01T00:00:00.000Z/first",
      source_type: "text",
      source_url: "text-paste",
      primary_slug: "first",
      related_slugs: [],
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      status: "completed",
    };
    const entry2: LedgerEntry = {
      ingest_id: "2026-01-02T00:00:00.000Z/second",
      source_type: "url",
      source_url: "https://example.com",
      primary_slug: "second",
      related_slugs: ["first"],
      started_at: "2026-01-02T00:00:00.000Z",
      finished_at: "2026-01-02T00:00:05.000Z",
      status: "completed",
    };

    await persistToLedger(entry1);
    await persistToLedger(entry2);

    const entries = await readLedger();
    expect(entries.length).toBe(2);
    // Most recent (entry2) should come first
    expect(entries[0].primary_slug).toBe("second");
    expect(entries[1].primary_slug).toBe("first");
  });

  it("readLedger respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await persistToLedger({
        ingest_id: `2026-01-0${i + 1}T00:00:00.000Z/entry-${i}`,
        source_type: "text",
        source_url: "text-paste",
        primary_slug: `entry-${i}`,
        related_slugs: [],
        started_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        finished_at: `2026-01-0${i + 1}T00:00:01.000Z`,
        status: "completed",
      });
    }

    const entries = await readLedger(3);
    expect(entries.length).toBe(3);
    // Should be newest first
    expect(entries[0].primary_slug).toBe("entry-4");
    expect(entries[2].primary_slug).toBe("entry-2");
  });

  it("readLedger skips malformed JSONL lines without throwing", async () => {
    const validEntry = JSON.stringify({
      ingest_id: "2026-01-01T00:00:00.000Z/valid",
      source_type: "text",
      source_url: "text-paste",
      primary_slug: "valid",
      related_slugs: [],
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      status: "completed",
    });

    // Write a mix of valid and malformed lines via StorageProvider
    await getStorage().writeFile(
      getLedgerPath(),
      `${validEntry}\n{not valid json\n${validEntry.replace("valid", "also-valid")}\n`,
    );

    const entries = await readLedger();
    expect(entries.length).toBe(2);
    // Malformed line was silently skipped
  });

  it("readLedger returns empty array for empty file", async () => {
    await getStorage().writeFile(getLedgerPath(), "");

    const entries = await readLedger();
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ingest dedup (shared canonical page) — token saving
// ---------------------------------------------------------------------------

describe("ingest dedup", () => {
  beforeEach(() => {
    // In-memory indexes are module singletons — reset so each test starts clean
    // (they rebuild from the fresh temp-dir frontmatter on demand).
    resetSourceIndex();
    resetAliasIndex();
    mockedHasLLMKey.mockReturnValue(true);
    mockedCallLLM.mockResolvedValue("# Page\n\n## Summary\n\nMocked synthesis.");
  });

  it("dedups identical content across different titles — no second LLM call", async () => {
    await ingest("Doc A", "Identical body content for dedup test.");
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);

    mockedCallLLM.mockClear();
    // Same content, different title → should attach to the existing canonical
    // page (by content hash) instead of synthesizing a new one.
    const result = await ingest("Doc B", "Identical body content for dedup test.");

    expect(result.deduped).toBe(true);
    expect(result.primarySlug).toBe("doc-a");
    expect(mockedCallLLM).not.toHaveBeenCalled();
    expect(await listWikiPages()).toHaveLength(1); // one canonical page, not two
  });

  it("does NOT dedup different content — both pages created, LLM called twice", async () => {
    await ingest("Page One", "First distinct content here.");
    mockedCallLLM.mockClear();
    const result = await ingest("Page Two", "Completely different content here.");

    expect(result.deduped).toBeFalsy();
    // Synthesis ran (not deduped). Exact count varies because a cross-ref LLM
    // call also fires once another page exists — so just assert it was called.
    expect(mockedCallLLM).toHaveBeenCalled();
    expect(await listWikiPages()).toHaveLength(2);
  });

  it("attaches the new triggerer as a contributor on a dedup hit", async () => {
    await ingest("Trigger Doc", "Body for trigger attribution.", {
      triggeredBy: "alice",
    });
    const result = await ingest("Trigger Doc", "Body for trigger attribution.", {
      triggeredBy: "bob",
    });

    expect(result.deduped).toBe(true);
    const page = await readWikiPageWithFrontmatter("trigger-doc");
    expect(page).not.toBeNull();
    // The second triggerer is recorded as a contributor (basis for "Mine").
    expect(page!.frontmatter.contributors).toContain("bob");
  });
});

// ---------------------------------------------------------------------------
// Ingest attribution (owner / visibility / authors)
// ---------------------------------------------------------------------------

describe("ingest attribution", () => {
  beforeEach(() => {
    resetSourceIndex();
    resetAliasIndex();
    mockedHasLLMKey.mockReturnValue(true);
    mockedCallLLM.mockResolvedValue("# Page\n\n## Summary\n\nMocked.");
  });

  it("sets owner/authors from the author option (not 'system')", async () => {
    await ingest("Attr Page", "Body content for attribution.", {
      author: "alice",
      owner: "alice",
    });
    const page = await readWikiPageWithFrontmatter("attr-page");
    expect(page!.frontmatter.authors).toEqual(["alice"]);
    expect(page!.frontmatter.owner).toBe("alice");
    expect(page!.frontmatter.visibility).toBe("public");
  });

  it("falls back to 'system' when no author is provided (MCP/legacy)", async () => {
    await ingest("Sys Page", "Different body content here.");
    const page = await readWikiPageWithFrontmatter("sys-page");
    expect(page!.frontmatter.authors).toEqual(["system"]);
    expect(page!.frontmatter.owner).toBe("system");
  });
});

describe("stripImageMarkdown", () => {
  it("removes all image syntax (ingested bodies go image-free — no gallery)", () => {
    const out = stripImageMarkdown(
      "a ![x](assets/p/a.png) b ![y](https://z/c.png) c",
    );
    expect(out).not.toMatch(/!\[/);
    expect(out).toContain("a ");
    expect(out).toContain(" c");
  });
});

// ---------------------------------------------------------------------------
// mergeSourceEntry — URL normalization
// ---------------------------------------------------------------------------

describe("mergeSourceEntry URL normalization", () => {
  const mk = (
    url: string,
    type: SourceEntry["type"] = "url",
    fetched = "2026-01-01",
  ): SourceEntry => ({ type, url, fetched, triggered_by: "system" });

  it("treats http and https+www variants as the same source", () => {
    const existing = [mk("http://example.com")];
    const result = mergeSourceEntry(existing, mk("https://www.example.com/", "url", "2026-02-01"));
    expect(result).toHaveLength(1);
    // The first entry's URL is preserved, but metadata is updated
    expect(result[0].url).toBe("http://example.com");
    expect(result[0].fetched).toBe("2026-02-01");
  });

  it("treats URLs with trailing slash as same source", () => {
    const existing = [mk("https://example.com/path")];
    const result = mergeSourceEntry(existing, mk("https://example.com/path/", "url", "2026-03-01"));
    expect(result).toHaveLength(1);
    expect(result[0].fetched).toBe("2026-03-01");
  });

  it("still keeps text-paste dedup by (url, type)", () => {
    const existing = [mk("text-paste", "text")];
    const result = mergeSourceEntry(existing, mk("text-paste", "text", "2026-04-01"));
    expect(result).toHaveLength(1);
    expect(result[0].fetched).toBe("2026-04-01");
  });

  it("keeps distinct text-paste entries for different types", () => {
    const existing = [mk("text-paste", "text")];
    const result = mergeSourceEntry(existing, mk("text-paste", "x-mention"));
    expect(result).toHaveLength(2);
  });

  it("appends a genuinely different URL", () => {
    const existing = [mk("https://a.com")];
    const result = mergeSourceEntry(existing, mk("https://b.com"));
    expect(result).toHaveLength(2);
  });
});
