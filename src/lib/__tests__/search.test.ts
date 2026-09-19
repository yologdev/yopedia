import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Mock the LLM module — search.ts imports callLLM/hasLLMKey at module level for
// findRelatedPages (default off; the findRelatedPages tests opt in).
vi.mock("../llm", () => ({
  hasLLMKey: vi.fn(() => false),
  callLLM: vi.fn(async () => "[]"),
}));

// Stub the vector primitives so findSimilarPages / findRelatedPages tests control
// the ranking without a real embedding store; keep every other export real.
vi.mock("../embeddings", async (orig) => {
  const actual = await orig<typeof import("../embeddings")>();
  return {
    ...actual,
    relatedByVector: vi.fn(async () => []),
    searchByVector: vi.fn(async () => []),
  };
});

import {
  writeWikiPage,
  ensureDirectories,
  readWikiPage,
  updateIndex,
} from "../wiki";
import { listRevisions, readRevisionMeta } from "../revisions";
import {
  searchWikiContent,
  findBacklinks,
  findSimilarPages,
  findRelatedPages,
  updateRelatedPages,
  fuzzyMatch,
  levenshteinDistance,
  fuzzySearchWikiContent,
  resolveScope,
  expandMineScope,
  resolveScopeSlugs,
} from "../search";
import type { SearchScope } from "../search";
import type { Principal } from "../auth";
import type { IndexEntry } from "../types";
import { registerAgent, ensureAgentsDir } from "../agents";
import { createVault, addToVault, vaultIdFor } from "../vault";
import { serializeFrontmatter } from "../frontmatter";
import { isAgentScopedType, isArtifactType } from "../wiki";
import type { AgentProfile } from "../types";
import { _resetStorage } from "../storage";
import { relatedByVector, searchByVector } from "../embeddings";
import { hasLLMKey, callLLM } from "../llm";

const mockedRelatedByVector = vi.mocked(relatedByVector);
const mockedSearchByVector = vi.mocked(searchByVector);
const mockedHasLLMKey = vi.mocked(hasLLMKey);
const mockedCallLLM = vi.mocked(callLLM);

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
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

// ---------------------------------------------------------------------------
// searchWikiContent
// ---------------------------------------------------------------------------

describe("isAgentScopedType", () => {
  it("is true only for agent-* types", () => {
    expect(isAgentScopedType("agent-knowledge")).toBe(true);
    expect(isAgentScopedType("agent-identity")).toBe(true);
    expect(isAgentScopedType(undefined)).toBe(false);
    expect(isAgentScopedType("")).toBe(false);
    expect(isAgentScopedType("prose")).toBe(false);
    // "agent" must be a prefix, not just contained.
    expect(isAgentScopedType("my-agent-notes")).toBe(false);
  });
});

describe("isArtifactType", () => {
  it("is true only for saved-artifact types (html, slides)", () => {
    expect(isArtifactType("html")).toBe(true);
    expect(isArtifactType("slides")).toBe(true);
    expect(isArtifactType("wiki")).toBe(false);
    expect(isArtifactType("agent-knowledge")).toBe(false);
    expect(isArtifactType(undefined)).toBe(false);
    expect(isArtifactType("")).toBe(false);
  });
});

describe("searchWikiContent", () => {
  it("returns empty array for empty query", async () => {
    await ensureDirectories();
    const results = await searchWikiContent("");
    expect(results).toEqual([]);
  });

  it("returns empty array for whitespace-only query", async () => {
    await ensureDirectories();
    const results = await searchWikiContent("   \t\n  ");
    expect(results).toEqual([]);
  });

  it("returns empty array when wiki directory does not exist", async () => {
    // Don't call ensureDirectories — directory doesn't exist
    const results = await searchWikiContent("anything");
    expect(results).toEqual([]);
  });

  it("finds pages matching a single term (case-insensitive)", async () => {
    await ensureDirectories();
    await writeWikiPage("neural-networks", "# Neural Networks\n\nArtificial neural networks are computing systems.");
    await writeWikiPage("transformers", "# Transformers\n\nA transformer is a deep learning architecture.");
    await updateIndex([
      { title: "Neural Networks", slug: "neural-networks", summary: "s" },
      { title: "Transformers", slug: "transformers", summary: "s" },
    ]);

    const results = await searchWikiContent("neural");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("neural-networks");
    expect(results[0].title).toBe("Neural Networks");
  });

  it("skips a page with malformed frontmatter instead of failing the search", async () => {
    // Regression: one unparseable page used to throw out of the result loop and
    // 500 the whole request — for every query whose terms matched that page.
    await ensureDirectories();
    await writeWikiPage(
      "good-note",
      "# Good Note\n\nAttention mechanisms explained here.",
    );
    await writeWikiPage(
      "broken-note",
      '---\ntags: [a, "b, c]\n---\n\n# Broken Note\n\nAttention mechanisms explained here.',
    );
    await writeWikiPage(
      "index",
      "# Index\n\n- [Good Note](good-note.md) — g\n- [Broken Note](broken-note.md) — b",
    );

    const slugs = (await searchWikiContent("attention")).map((r) => r.slug);
    expect(slugs).toContain("good-note");
    expect(slugs).not.toContain("broken-note");
  });

  it("skips a page with malformed frontmatter in the fuzzy pass too", async () => {
    await ensureDirectories();
    // Both pages spell the term with a typo, so the exact pass finds nothing
    // and the fuzzy pass is what actually reads them.
    await writeWikiPage(
      "good-fuzzy",
      "# Good Fuzzy\n\nAttnetion mechanisms explained here.",
    );
    await writeWikiPage(
      "broken-fuzzy",
      '---\ntags: [a, "b, c]\n---\n\n# Broken Fuzzy\n\nAttnetion mechanisms explained here.',
    );
    await writeWikiPage(
      "index",
      "# Index\n\n- [Good Fuzzy](good-fuzzy.md) — g\n- [Broken Fuzzy](broken-fuzzy.md) — b",
    );

    const slugs = (await fuzzySearchWikiContent("attention")).map((r) => r.slug);
    expect(slugs).toContain("good-fuzzy");
    expect(slugs).not.toContain("broken-fuzzy");
  });

  it("excludes agent-scoped pages from general (unscoped) search", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "normal-note",
      "# Normal\n\nAttention mechanisms explained here.",
    );
    await writeWikiPage(
      "agent-note",
      serializeFrontmatter(
        { type: "agent-knowledge" },
        "# Agent Note\n\nAttention mechanisms explained here.",
      ),
    );
    // Both must be in the index so the type-based exclusion can see them.
    await writeWikiPage(
      "index",
      "# Index\n\n- [Normal](normal-note.md) — n\n- [Agent Note](agent-note.md) — a",
    );

    const slugs = (await searchWikiContent("attention")).map((r) => r.slug);
    expect(slugs).toContain("normal-note");
    expect(slugs).not.toContain("agent-note");
  });

  it("excludes artifacts even WITHIN a scope (vault/owner) — markup is never query knowledge", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "note-x",
      "# Note X\n\nAttention mechanisms explained here.",
    );
    await writeWikiPage(
      "artifact-x",
      serializeFrontmatter(
        { type: "html" },
        "# Artifact X\n\nAttention mechanisms explained here.",
      ),
    );
    await writeWikiPage(
      "deck-x",
      serializeFrontmatter(
        { type: "slides" },
        "# Deck X\n\nAttention mechanisms explained here.",
      ),
    );
    await writeWikiPage(
      "index",
      "# Index\n\n- [Note](note-x.md) — n\n- [Artifact](artifact-x.md) — a\n- [Deck](deck-x.md) — d",
    );
    // All slugs are in the scope (as if a vault curated the artifacts), but the
    // artifacts (html AND slides) must still NOT surface as search hits.
    const scope = { agentId: "vault:v1", slugs: ["note-x", "artifact-x", "deck-x"] };
    const slugs = (await searchWikiContent("attention", 10, scope)).map(
      (r) => r.slug,
    );
    expect(slugs).toContain("note-x");
    expect(slugs).not.toContain("artifact-x");
    expect(slugs).not.toContain("deck-x");
  });

  it("an `agent:` scope STILL surfaces agent-typed pages (only unscoped excludes them)", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "ak",
      serializeFrontmatter(
        { type: "agent-knowledge" },
        "# AK\n\nAttention mechanisms explained here.",
      ),
    );
    await writeWikiPage("index", "# Index\n\n- [AK](ak.md) — a");
    // Unscoped: agent-scoped page excluded.
    expect((await searchWikiContent("attention")).map((r) => r.slug)).not.toContain("ak");
    // Scoped (the agent's own lens): it MUST surface — guards the scope-aware
    // includeAgentScoped:!scope refactor.
    const scope = { agentId: "agent:x", slugs: ["ak"] };
    expect(
      (await searchWikiContent("attention", 10, scope)).map((r) => r.slug),
    ).toContain("ak");
  });

  it("is case-insensitive", async () => {
    await ensureDirectories();
    await writeWikiPage("test-page", "# Test Page\n\nHello WORLD.");
    await updateIndex([{ title: "Test Page", slug: "test-page", summary: "s" }]);

    const results = await searchWikiContent("world");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("test-page");

    const results2 = await searchWikiContent("HELLO");
    expect(results2).toHaveLength(1);
    expect(results2[0].slug).toBe("test-page");
  });

  it("scores by number of matching terms (OR semantics)", async () => {
    await ensureDirectories();
    await writeWikiPage("both-terms", "# Both Terms\n\nThis page has alpha and beta content.");
    await writeWikiPage("one-term", "# One Term\n\nThis page only has alpha content.");
    await updateIndex([
      { title: "Both Terms", slug: "both-terms", summary: "s" },
      { title: "One Term", slug: "one-term", summary: "s" },
    ]);

    const results = await searchWikiContent("alpha beta");
    expect(results).toHaveLength(2);
    // "both-terms" should rank first (score 2 vs score 1)
    expect(results[0].slug).toBe("both-terms");
    expect(results[1].slug).toBe("one-term");
  });

  it("sorts alphabetically by title when scores are equal", async () => {
    await ensureDirectories();
    await writeWikiPage("zebra", "# Zebra\n\nAnimal with stripes.");
    await writeWikiPage("alpha", "# Alpha\n\nAnimal with fur.");
    await updateIndex([
      { title: "Zebra", slug: "zebra", summary: "s" },
      { title: "Alpha", slug: "alpha", summary: "s" },
    ]);

    const results = await searchWikiContent("animal");
    expect(results).toHaveLength(2);
    // Equal score — alphabetical: Alpha before Zebra
    expect(results[0].slug).toBe("alpha");
    expect(results[1].slug).toBe("zebra");
  });

  it("skips index.md and log.md", async () => {
    await ensureDirectories();
    await writeWikiPage("index", "# Index\n\nThis is the wiki index.");
    await writeWikiPage("log", "# Log\n\nThis is the wiki log.");
    await writeWikiPage("real-page", "# Real Page\n\nThis is a real wiki page.");
    await updateIndex([{ title: "Real Page", slug: "real-page", summary: "s" }]);

    const results = await searchWikiContent("wiki");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("real-page");
  });

  it("respects maxResults limit", async () => {
    await ensureDirectories();
    for (let i = 0; i < 5; i++) {
      await writeWikiPage(`page-${i}`, `# Page ${i}\n\nCommon keyword here.`);
    }
    await updateIndex(Array.from({ length: 5 }, (_, i) => ({ title: `Page ${i}`, slug: `page-${i}`, summary: "s" })));

    const results = await searchWikiContent("keyword", 3);
    expect(results).toHaveLength(3);
  });

  it("defaults maxResults to 10", async () => {
    await ensureDirectories();
    for (let i = 0; i < 15; i++) {
      await writeWikiPage(`page-${String(i).padStart(2, "0")}`, `# Page ${i}\n\nShared term here.`);
    }
    await updateIndex(Array.from({ length: 15 }, (_, i) => ({ title: `Page ${i}`, slug: `page-${String(i).padStart(2, "0")}`, summary: "s" })));

    const results = await searchWikiContent("shared");
    expect(results).toHaveLength(10);
  });

  it("builds snippet around first match with ellipsis", async () => {
    await ensureDirectories();
    const longPrefix = "A".repeat(100);
    const longSuffix = "B".repeat(100);
    await writeWikiPage("snippet-test", `# Snippet Test\n\n${longPrefix} keyword ${longSuffix}`);
    await updateIndex([{ title: "Snippet Test", slug: "snippet-test", summary: "s" }]);

    const results = await searchWikiContent("keyword");
    expect(results).toHaveLength(1);
    const snippet = results[0].snippet;
    // Should have leading ellipsis (match is far from start)
    expect(snippet.startsWith("…")).toBe(true);
    // Should have trailing ellipsis (match is far from end)
    expect(snippet.endsWith("…")).toBe(true);
    // Should contain the keyword
    expect(snippet).toContain("keyword");
  });

  it("snippet has no leading ellipsis when match is near the start", async () => {
    await ensureDirectories();
    await writeWikiPage("near-start", "# Match Near Start\n\nkeyword here and more.");
    await updateIndex([{ title: "Match Near Start", slug: "near-start", summary: "s" }]);

    const results = await searchWikiContent("Match");
    expect(results).toHaveLength(1);
    // "Match" appears at position 2 (after "# "), which is within snippet radius
    expect(results[0].snippet.startsWith("…")).toBe(false);
  });

  it("never leaks YAML frontmatter into the snippet", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "fm-leak",
      `---\ntags: [agentics, ml]\nsource_count: 1\nupdated: 2026-06-08\n---\n# Poke Assistant\n\nPoke is an AI assistant that uses an agent to triage notifications.`,
    );
    await updateIndex([{ title: "Poke Assistant", slug: "fm-leak", summary: "s" }]);

    const results = await searchWikiContent("agent");
    expect(results).toHaveLength(1);
    const snippet = results[0].snippet;
    // The term also appears in the `tags:` frontmatter, but the window must be
    // drawn from the body — no frontmatter keys/values may appear.
    expect(snippet).not.toContain("source_count");
    expect(snippet).not.toContain("tags:");
    expect(snippet).not.toContain("2026-06-08");
    expect(snippet.toLowerCase()).toContain("agent");
  });

  it("cuts snippets on word boundaries (no mid-word fragments)", async () => {
    await ensureDirectories();
    const filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    await writeWikiPage("word-cut", `# Word Cut\n\n${filler} keyword ${filler}`);
    await updateIndex([{ title: "Word Cut", slug: "word-cut", summary: "s" }]);

    const results = await searchWikiContent("keyword");
    const snippet = results[0].snippet.replace(/…/g, "");
    const sourceWords = new Set(`Word Cut ${filler} keyword`.split(/\s+/));
    // Every token in the snippet is a whole word from the source (nothing clipped).
    for (const w of snippet.split(/\s+/).filter(Boolean)) {
      expect(sourceWords.has(w)).toBe(true);
    }
    expect(snippet).toContain("keyword");
  });

  it("falls back to the clean summary when the term matched only in frontmatter", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "fm-only",
      `---\ntags: [serverless]\n---\n# Cloud Topic\n\nA concise overview of deployment models.`,
    );
    await updateIndex([{ title: "Cloud Topic", slug: "fm-only", summary: "s" }]);

    const results = await searchWikiContent("serverless");
    expect(results).toHaveLength(1);
    // "serverless" is only in the frontmatter, so there's no body match to centre
    // on — the snippet is the clean summary, not an empty/odd window.
    expect(results[0].snippet).toBe(results[0].summary);
    expect(results[0].snippet).toContain("concise overview");
  });

  it("extracts title from first heading", async () => {
    await ensureDirectories();
    await writeWikiPage("heading-page", "# My Great Title\n\nSome content here.");
    await updateIndex([{ title: "My Great Title", slug: "heading-page", summary: "s" }]);

    const results = await searchWikiContent("content");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("My Great Title");
  });

  it("falls back to slug when no heading present", async () => {
    await ensureDirectories();
    await writeWikiPage("no-heading", "Just plain text with a search term.");
    await updateIndex([{ title: "no-heading", slug: "no-heading", summary: "s" }]);

    const results = await searchWikiContent("search");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("no-heading");
  });

  it("returns no results when no pages match", async () => {
    await ensureDirectories();
    await writeWikiPage("page-a", "# Page A\n\nHello world.");
    await updateIndex([{ title: "Page A", slug: "page-a", summary: "s" }]);

    const results = await searchWikiContent("nonexistent");
    expect(results).toEqual([]);
  });

  it("extracts summary from first paragraph after heading", async () => {
    await ensureDirectories();
    await writeWikiPage("summary-page", "# Summary Page\n\nThis is the summary line.\n\nMore content here.");
    await updateIndex([{ title: "Summary Page", slug: "summary-page", summary: "s" }]);

    const results = await searchWikiContent("summary");
    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain("This is the summary line.");
  });
});

// ---------------------------------------------------------------------------
// findBacklinks
// ---------------------------------------------------------------------------

describe("findBacklinks", () => {
  it("finds pages that link to the target slug", async () => {
    await ensureDirectories();
    await writeWikiPage("target", "# Target\n\nTarget page content.");
    await writeWikiPage("linker", "# Linker\n\nSee [Target](target.md) for more.");
    await writeWikiPage("no-link", "# No Link\n\nUnrelated content.");
    await updateIndex([
      { title: "Target", slug: "target", summary: "Target page." },
      { title: "Linker", slug: "linker", summary: "Links to target." },
      { title: "No Link", slug: "no-link", summary: "Unrelated." },
    ]);

    const backlinks = await findBacklinks("target");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].slug).toBe("linker");
    expect(backlinks[0].title).toBe("Linker");
  });

  it("skips index and log pages", async () => {
    await ensureDirectories();
    await writeWikiPage("target", "# Target\n\nContent.");
    await writeWikiPage("index", "# Index\n\n- [Target](target.md)");
    await writeWikiPage("log", "# Log\n\n- Ingested [Target](target.md)");
    await writeWikiPage("real-linker", "# Real\n\nSee [Target](target.md).");
    await updateIndex([
      { title: "Target", slug: "target", summary: "Content." },
      { title: "Real", slug: "real-linker", summary: "Links to target." },
    ]);

    const backlinks = await findBacklinks("target");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].slug).toBe("real-linker");
  });

  it("skips the target page itself", async () => {
    await ensureDirectories();
    await writeWikiPage("self-ref", "# Self Ref\n\nSee [Self Ref](self-ref.md) for recursion.");
    await updateIndex([
      { title: "Self Ref", slug: "self-ref", summary: "Self-referencing." },
    ]);

    const backlinks = await findBacklinks("self-ref");
    expect(backlinks).toEqual([]);
  });

  it("returns empty array when no pages link to target", async () => {
    await ensureDirectories();
    await writeWikiPage("lonely", "# Lonely\n\nNo one links here.");
    await writeWikiPage("other", "# Other\n\nSome unrelated content.");
    await updateIndex([
      { title: "Lonely", slug: "lonely", summary: "No links." },
      { title: "Other", slug: "other", summary: "Unrelated." },
    ]);

    const backlinks = await findBacklinks("lonely");
    expect(backlinks).toEqual([]);
  });

  it("returns empty array when wiki is empty", async () => {
    await ensureDirectories();
    const backlinks = await findBacklinks("nonexistent");
    expect(backlinks).toEqual([]);
  });

  it("detects multiple backlinks", async () => {
    await ensureDirectories();
    await writeWikiPage("target", "# Target\n\nContent.");
    await writeWikiPage("page-a", "# Page A\n\nLinks to [Target](target.md).");
    await writeWikiPage("page-b", "# Page B\n\nAlso links to [Target](target.md).");
    await writeWikiPage("page-c", "# Page C\n\nAnd [Target](target.md) here too.");
    await updateIndex([
      { title: "Target", slug: "target", summary: "Content." },
      { title: "Page A", slug: "page-a", summary: "A." },
      { title: "Page B", slug: "page-b", summary: "B." },
      { title: "Page C", slug: "page-c", summary: "C." },
    ]);

    const backlinks = await findBacklinks("target");
    expect(backlinks).toHaveLength(3);
    const slugs = backlinks.map((b) => b.slug).sort();
    expect(slugs).toEqual(["page-a", "page-b", "page-c"]);
  });

  it("excludes agent-scoped pages from a wiki page's backlinks", async () => {
    await ensureDirectories();
    await writeWikiPage("target", "# Target\n\nContent.");
    await writeWikiPage("real-linker", "# Real\n\nSee [Target](target.md).");
    await writeWikiPage(
      "agent-linker",
      "---\ntype: agent-knowledge\n---\n\n# Agent Linker\n\nSee [Target](target.md).",
    );
    await updateIndex([
      { title: "Target", slug: "target", summary: "Content." },
      { title: "Real", slug: "real-linker", summary: "Links." },
      { title: "Agent Linker", slug: "agent-linker", summary: "Agent." },
    ]);

    const backlinks = await findBacklinks("target");
    expect(backlinks.map((b) => b.slug)).toEqual(["real-linker"]); // agent excluded
  });

  it("excludes agent-scoped backlinks via the precomputed index (fast path)", async () => {
    await ensureDirectories();
    await writeWikiPage("target", "# Target\n\nContent.");
    await writeWikiPage("real-linker", "# Real\n\nSee [Target](target.md).");
    await writeWikiPage(
      "agent-linker",
      "---\ntype: agent-knowledge\n---\n\n# Agent\n\nSee [Target](target.md).",
    );
    await updateIndex([
      { title: "Target", slug: "target", summary: "t" },
      { title: "Real", slug: "real-linker", summary: "r" },
      { title: "Agent", slug: "agent-linker", summary: "a" },
    ]);
    // Seed the reverse-link index so findBacklinks takes the FAST path, not the scan.
    const { rebuildBacklinkIndex } = await import("../backlink-index");
    await rebuildBacklinkIndex();

    const backlinks = await findBacklinks("target");
    expect(backlinks.map((b) => b.slug)).toEqual(["real-linker"]);
  });
});

// ---------------------------------------------------------------------------
// findSimilarPages — semantic "Related pages"
// ---------------------------------------------------------------------------

describe("findSimilarPages", () => {
  async function seed(slugs: string[]) {
    await ensureDirectories();
    for (const s of slugs) await writeWikiPage(s, `# ${s}\n\nBody of ${s}.`);
    await updateIndex(slugs.map((s) => ({ title: s.toUpperCase(), slug: s, summary: s })));
  }

  it("resolves titles and drops below-threshold matches", async () => {
    await seed(["anchor", "a", "b", "c"]);
    mockedRelatedByVector.mockResolvedValueOnce([
      { slug: "a", score: 0.8 },
      { slug: "b", score: 0.5 },
      { slug: "c", score: 0.2 }, // below default 0.45 → dropped
    ]);

    const related = await findSimilarPages("anchor");
    expect(related.map((r) => r.slug)).toEqual(["a", "b"]);
    expect(related[0]).toMatchObject({ slug: "a", title: "A", score: 0.8 });
  });

  it("skips the page itself, index, and log", async () => {
    await seed(["anchor", "real"]);
    mockedRelatedByVector.mockResolvedValueOnce([
      { slug: "anchor", score: 0.9 },
      { slug: "index", score: 0.9 },
      { slug: "log", score: 0.9 },
      { slug: "real", score: 0.7 },
    ]);

    const related = await findSimilarPages("anchor");
    expect(related.map((r) => r.slug)).toEqual(["real"]);
  });

  it("excludes agent-scoped pages from a wiki page's related list", async () => {
    await ensureDirectories();
    await writeWikiPage("anchor", "# anchor\n\nBody.");
    await writeWikiPage("real", "# real\n\nBody.");
    await writeWikiPage(
      "agent-pg",
      "---\ntype: agent-knowledge\n---\n\n# Agent Page\n\nAgent body.",
    );
    await updateIndex([
      { title: "Anchor", slug: "anchor", summary: "a" },
      { title: "Real", slug: "real", summary: "r" },
      { title: "Agent Page", slug: "agent-pg", summary: "ag" },
    ]);
    mockedRelatedByVector.mockResolvedValueOnce([
      { slug: "agent-pg", score: 0.9 }, // agent content — must be excluded
      { slug: "real", score: 0.8 },
    ]);

    const related = await findSimilarPages("anchor");
    expect(related.map((r) => r.slug)).toEqual(["real"]);
  });

  it("an agent page's related list excludes commons (wiki) pages", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "agent-anchor",
      "---\ntype: agent-knowledge\n---\n\n# Agent Anchor\n\nBody.",
    );
    await writeWikiPage(
      "agent-other",
      "---\ntype: agent-knowledge\n---\n\n# Agent Other\n\nBody.",
    );
    await writeWikiPage("commons-pg", "# Commons\n\nBody.");
    await updateIndex([
      { title: "Agent Anchor", slug: "agent-anchor", summary: "a" },
      { title: "Agent Other", slug: "agent-other", summary: "o" },
      { title: "Commons", slug: "commons-pg", summary: "c" },
    ]);
    mockedRelatedByVector.mockResolvedValueOnce([
      { slug: "commons-pg", score: 0.9 }, // wiki content — excluded for an agent anchor
      { slug: "agent-other", score: 0.8 },
    ]);

    const related = await findSimilarPages("agent-anchor");
    expect(related.map((r) => r.slug)).toEqual(["agent-other"]);
  });

  it("excludes pages not in the reader's readable set", async () => {
    await seed(["anchor", "visible"]);
    mockedRelatedByVector.mockResolvedValueOnce([
      { slug: "ghost", score: 0.9 }, // not in the index → unreadable → excluded
      { slug: "visible", score: 0.8 },
    ]);

    const related = await findSimilarPages("anchor");
    expect(related.map((r) => r.slug)).toEqual(["visible"]);
  });

  it("enforces visibility: a private page is hidden from non-owners, shown to its owner", async () => {
    await ensureDirectories();
    await writeWikiPage("anchor", "# Anchor\n\nBody.");
    await writeWikiPage("pub", "# Pub\n\nbody");
    await writeWikiPage(
      "secret",
      serializeFrontmatter({ owner: "alice", visibility: "private" }, "# Secret\n\nbody"),
    );
    await updateIndex([
      { title: "Anchor", slug: "anchor", summary: "a" },
      { title: "Pub", slug: "pub", summary: "p" },
      { title: "Secret", slug: "secret", summary: "s", owner: "alice", visibility: "private" },
    ]);
    // Ranking puts the private page above the public one — only the visibility
    // filter (not ordering) should keep it out for non-owners.
    mockedRelatedByVector.mockResolvedValue([
      { slug: "secret", score: 0.9 },
      { slug: "pub", score: 0.8 },
    ]);

    // Anonymous reader and a different signed-in user: private excluded.
    expect((await findSimilarPages("anchor", null)).map((r) => r.slug)).toEqual(["pub"]);
    expect(
      (await findSimilarPages("anchor", { id: "bob", handle: "bob" })).map((r) => r.slug),
    ).toEqual(["pub"]);
    // The owner sees their own private page.
    expect(
      (await findSimilarPages("anchor", { id: "alice", handle: "alice" }))
        .map((r) => r.slug)
        .sort(),
    ).toEqual(["pub", "secret"]);

    mockedRelatedByVector.mockResolvedValue([]); // reset default for later tests
  });

  it("respects the limit", async () => {
    await seed(["anchor", "a", "b", "c", "d"]);
    mockedRelatedByVector.mockResolvedValueOnce([
      { slug: "a", score: 0.9 },
      { slug: "b", score: 0.85 },
      { slug: "c", score: 0.8 },
      { slug: "d", score: 0.75 },
    ]);

    const related = await findSimilarPages("anchor", null, 2);
    expect(related).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// updateRelatedPages
// ---------------------------------------------------------------------------

describe("updateRelatedPages", () => {
  it("appends 'See also' links to related pages", async () => {
    await ensureDirectories();
    await writeWikiPage("existing", "# Existing Page\n\nSome content here.");

    const modified = await updateRelatedPages("new-page", "New Page", ["existing"]);
    expect(modified).toEqual(["existing"]);

    const page = await readWikiPage("existing");
    expect(page).not.toBeNull();
    expect(page!.content).toContain("**See also:** [New Page](new-page.md)");
  });

  it("creates a revision with author 'system' when injecting See-also", async () => {
    await ensureDirectories();
    await writeWikiPage("target-page", "# Target Page\n\nSome content here.");

    await updateRelatedPages("source-page", "Source Page", ["target-page"]);

    const revs = await listRevisions("target-page");
    expect(revs.length).toBeGreaterThanOrEqual(1);
    const meta = await readRevisionMeta("target-page", revs[0].timestamp);
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("system");
  });

  it("PRESERVES the page's frontmatter when appending a See-also", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "owned",
      '---\nowner: alice\nvisibility: private\ntags: ["x"]\n---\n\n# Owned\n\nBody.',
    );

    await updateRelatedPages("new-page", "New Page", ["owned"]);

    const page = await readWikiPage("owned");
    // The frontmatter block must survive the write-back (regression: building
    // the update from the frontmatter-stripped body silently dropped it).
    expect(page!.content).toContain("owner: alice");
    expect(page!.content).toContain("visibility: private");
    expect(page!.content).toContain("**See also:** [New Page](new-page.md)");
  });

  it("never appends a See-also to an HTML artifact", async () => {
    await ensureDirectories();
    await writeWikiPage(
      "artifact",
      "---\ntype: html\n---\n\n<!doctype html><html><body>x</body></html>",
    );

    const modified = await updateRelatedPages("new-page", "New Page", ["artifact"]);
    expect(modified).toEqual([]);

    const page = await readWikiPage("artifact");
    expect(page!.content).not.toContain("See also");
  });

  it("keeps the backlink index fresh for the appended See-also link", async () => {
    await ensureDirectories();
    await writeWikiPage("existing", "# Existing\n\nBody.");
    await updateIndex([{ title: "Existing", slug: "existing", summary: "x" }]);
    const { rebuildBacklinkIndex, getBacklinkIndex } = await import("../backlink-index");
    await rebuildBacklinkIndex(); // a present (empty) index — sync no-ops without one

    await updateRelatedPages("new-page", "New Page", ["existing"]);

    // The appended `[New Page](new-page.md)` in `existing` must register as a
    // backlink so findBacklinks (which trusts the index) surfaces it.
    const idx = await getBacklinkIndex();
    expect(idx?.["new-page"]).toContain("existing");
  });

  it("skips pages that already link to the new slug", async () => {
    await ensureDirectories();
    await writeWikiPage("already-linked", "# Already Linked\n\nSee [New Page](new-page.md) for details.");

    const modified = await updateRelatedPages("new-page", "New Page", ["already-linked"]);
    expect(modified).toEqual([]);
  });

  it("extends existing 'See also' section rather than creating duplicate", async () => {
    await ensureDirectories();
    await writeWikiPage("has-see-also", "# Has See Also\n\nContent.\n\n**See also:** [Old Page](old-page.md)");

    const modified = await updateRelatedPages("new-page", "New Page", ["has-see-also"]);
    expect(modified).toEqual(["has-see-also"]);

    const page = await readWikiPage("has-see-also");
    expect(page).not.toBeNull();
    // Should have both links on the same "See also" line
    expect(page!.content).toContain("**See also:** [Old Page](old-page.md), [New Page](new-page.md)");
    // Should NOT have two separate "See also" lines
    const seeAlsoCount = (page!.content.match(/\*\*See also:\*\*/g) || []).length;
    expect(seeAlsoCount).toBe(1);
  });

  it("returns array of actually modified slugs", async () => {
    await ensureDirectories();
    await writeWikiPage("will-modify", "# Will Modify\n\nContent.");
    await writeWikiPage("already-links", "# Already Links\n\nSee [Target](target.md).");
    await writeWikiPage("also-modify", "# Also Modify\n\nMore content.");

    const modified = await updateRelatedPages("target", "Target", [
      "will-modify",
      "already-links",
      "also-modify",
    ]);
    expect(modified.sort()).toEqual(["also-modify", "will-modify"]);
  });

  it("skips slugs that do not exist as wiki pages", async () => {
    await ensureDirectories();

    const modified = await updateRelatedPages("new-page", "New Page", ["nonexistent"]);
    expect(modified).toEqual([]);
  });

  it("handles empty relatedSlugs array", async () => {
    await ensureDirectories();
    const modified = await updateRelatedPages("new-page", "New Page", []);
    expect(modified).toEqual([]);
  });

  it("handles multiple related slugs with mixed existing See-also", async () => {
    await ensureDirectories();
    await writeWikiPage("page-with-seealso", "# Page With SeeAlso\n\nContent.\n\n**See also:** [Other](other.md)");
    await writeWikiPage("page-without", "# Page Without\n\nContent.");

    const modified = await updateRelatedPages("new-topic", "New Topic", [
      "page-with-seealso",
      "page-without",
    ]);
    expect(modified.sort()).toEqual(["page-with-seealso", "page-without"]);

    const p1 = await readWikiPage("page-with-seealso");
    expect(p1!.content).toContain("**See also:** [Other](other.md), [New Topic](new-topic.md)");

    const p2 = await readWikiPage("page-without");
    expect(p2!.content).toContain("**See also:** [New Topic](new-topic.md)");
  });
});

// ---------------------------------------------------------------------------
// levenshteinDistance
// ---------------------------------------------------------------------------

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("returns length of other string when one is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  it("handles single character difference", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
  });

  it("handles transposition (two edits for simple swap)", () => {
    expect(levenshteinDistance("ab", "ba")).toBe(2);
  });

  it("computes correct distance for real typos", () => {
    // "attnetion" vs "attention" — swap of n and t → distance 2
    expect(levenshteinDistance("attnetion", "attention")).toBe(2);
    // "transformer" vs "transformers" — extra s → distance 1
    expect(levenshteinDistance("transformer", "transformers")).toBe(1);
    // "neural" vs "neurla" — transposition → distance 2
    expect(levenshteinDistance("neural", "neurla")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatch
// ---------------------------------------------------------------------------

describe("fuzzyMatch", () => {
  it("matches 'attention' against 'attnetion' (edit distance 2, word ≥5 chars)", () => {
    expect(fuzzyMatch("attention", "attnetion")).toBe(true);
  });

  it("matches 'transformer' against 'transformers' (edit distance 1)", () => {
    expect(fuzzyMatch("transformer", "transformers")).toBe(true);
  });

  it("rejects 'AI' vs 'XY' (words ≤2 chars require exact match)", () => {
    expect(fuzzyMatch("AI", "XY")).toBe(false);
  });

  it("matches 'neural' against 'neurla' (transposition)", () => {
    expect(fuzzyMatch("neural", "neurla")).toBe(true);
  });

  it("rejects 'cat' vs 'dog' (distance 3, too high for 3-char word)", () => {
    expect(fuzzyMatch("cat", "dog")).toBe(false);
  });

  it("matches exact strings", () => {
    expect(fuzzyMatch("hello", "hello world")).toBe(true);
  });

  it("returns false for empty query", () => {
    expect(fuzzyMatch("", "some text")).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(fuzzyMatch("query", "")).toBe(false);
  });

  it("requires all query words to match (multi-word)", () => {
    expect(fuzzyMatch("neural network", "neurla networks are great")).toBe(true);
    expect(fuzzyMatch("neural quantum", "neurla networks are great")).toBe(false);
  });

  it("respects maxDistance override", () => {
    // "cat" vs "bat" is distance 1, but with maxDistance 0 it should fail
    expect(fuzzyMatch("cat", "bat", 0)).toBe(false);
    // With maxDistance 1 it should pass
    expect(fuzzyMatch("cat", "bat", 1)).toBe(true);
  });

  it("handles short words (3-4 chars) with distance 1", () => {
    // "map" (3 chars) → max distance 1
    expect(fuzzyMatch("map", "mpa")).toBe(false);  // distance 2 → exceeds limit
    expect(fuzzyMatch("map", "nap")).toBe(true);   // distance 1 → true
    expect(fuzzyMatch("map", "xyz")).toBe(false);  // distance 3 → false
  });
});

// ---------------------------------------------------------------------------
// fuzzySearchWikiContent
// ---------------------------------------------------------------------------

describe("fuzzySearchWikiContent", () => {
  it("returns exact results when enough exist", async () => {
    await ensureDirectories();
    await writeWikiPage("page-a", "# Alpha\n\nAttention mechanisms work well.");
    await writeWikiPage("page-b", "# Beta\n\nAttention is key to transformers.");
    await writeWikiPage("page-c", "# Gamma\n\nAttention layers are stacked.");
    await updateIndex([
      { title: "Alpha", slug: "page-a", summary: "s" },
      { title: "Beta", slug: "page-b", summary: "s" },
      { title: "Gamma", slug: "page-c", summary: "s" },
    ]);

    const results = await fuzzySearchWikiContent("attention");
    expect(results.length).toBe(3);
    // None should be flagged as fuzzy
    expect(results.every((r) => !r.fuzzy)).toBe(true);
  });

  it("falls back to fuzzy when exact results are sparse", async () => {
    await ensureDirectories();
    await writeWikiPage("exact-match", "# Exact\n\nAttention is important.");
    await writeWikiPage("typo-match", "# Typo\n\nAttnetion mechanisms are useful.");
    await writeWikiPage("no-match", "# Unrelated\n\nSomething completely different.");
    await updateIndex([
      { title: "Exact", slug: "exact-match", summary: "s" },
      { title: "Typo", slug: "typo-match", summary: "s" },
      { title: "Unrelated", slug: "no-match", summary: "s" },
    ]);

    const results = await fuzzySearchWikiContent("attention");
    // Should have 1 exact + 1 fuzzy
    expect(results.length).toBe(2);
    expect(results[0].slug).toBe("exact-match");
    expect(results[0].fuzzy).toBeFalsy();
    expect(results[1].slug).toBe("typo-match");
    expect(results[1].fuzzy).toBe(true);
  });

  it("returns empty array for empty query", async () => {
    await ensureDirectories();
    const results = await fuzzySearchWikiContent("");
    expect(results).toEqual([]);
  });

  it("does not duplicate pages in exact and fuzzy results", async () => {
    await ensureDirectories();
    await writeWikiPage("transformers", "# Transformers\n\nTransformer architecture details.");
    await updateIndex([{ title: "Transformers", slug: "transformers", summary: "s" }]);

    const results = await fuzzySearchWikiContent("transformer");
    const slugs = results.map((r) => r.slug);
    // Should appear only once
    expect(slugs.filter((s) => s === "transformers").length).toBe(1);
  });

  it("skips fuzzy for very short query terms", async () => {
    await ensureDirectories();
    await writeWikiPage("ai-page", "# AI\n\nArtificial intelligence overview.");
    await writeWikiPage("xy-page", "# XY\n\nSome XY content.");
    await updateIndex([
      { title: "AI", slug: "ai-page", summary: "s" },
      { title: "XY", slug: "xy-page", summary: "s" },
    ]);

    // "AI" is ≤2 chars, so fuzzy won't match "XY"
    const results = await fuzzySearchWikiContent("AI");
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("ai-page");
    expect(slugs).not.toContain("xy-page");
  });
});

// ---------------------------------------------------------------------------
// Scoped search — searchWikiContent with scope parameter
// ---------------------------------------------------------------------------

describe("searchWikiContent with scope", () => {
  it("returns all matching pages when no scope is provided", async () => {
    await ensureDirectories();
    await writeWikiPage("alpha", "# Alpha\n\nMachine learning concepts.");
    await writeWikiPage("beta", "# Beta\n\nMore machine learning.");
    await writeWikiPage("gamma", "# Gamma\n\nUnrelated content about cooking.");
    await updateIndex([
      { title: "Alpha", slug: "alpha", summary: "s" },
      { title: "Beta", slug: "beta", summary: "s" },
      { title: "Gamma", slug: "gamma", summary: "s" },
    ]);

    const results = await searchWikiContent("machine learning");
    expect(results).toHaveLength(2);
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("alpha");
    expect(slugs).toContain("beta");
  });

  it("returns only pages in the scope's slug list", async () => {
    await ensureDirectories();
    await writeWikiPage("alpha", "# Alpha\n\nMachine learning concepts.");
    await writeWikiPage("beta", "# Beta\n\nMore machine learning.");
    await writeWikiPage("gamma", "# Gamma\n\nMachine learning for cooking.");
    await updateIndex([
      { title: "Alpha", slug: "alpha", summary: "s" },
      { title: "Beta", slug: "beta", summary: "s" },
      { title: "Gamma", slug: "gamma", summary: "s" },
    ]);

    const scope: SearchScope = { agentId: "test", slugs: ["alpha", "gamma"] };
    const results = await searchWikiContent("machine learning", 10, scope);
    expect(results).toHaveLength(2);
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("alpha");
    expect(slugs).toContain("gamma");
    expect(slugs).not.toContain("beta");
  });

  it("returns empty when scope slugs don't match any existing pages", async () => {
    await ensureDirectories();
    await writeWikiPage("alpha", "# Alpha\n\nMachine learning concepts.");
    await updateIndex([{ title: "Alpha", slug: "alpha", summary: "s" }]);

    const scope: SearchScope = { agentId: "test", slugs: ["nonexistent"] };
    const results = await searchWikiContent("machine learning", 10, scope);
    expect(results).toEqual([]);
  });

  it("returns empty when scope slugs exist but don't match query", async () => {
    await ensureDirectories();
    await writeWikiPage("alpha", "# Alpha\n\nMachine learning concepts.");
    await writeWikiPage("beta", "# Beta\n\nCooking recipes.");
    await updateIndex([
      { title: "Alpha", slug: "alpha", summary: "s" },
      { title: "Beta", slug: "beta", summary: "s" },
    ]);

    const scope: SearchScope = { agentId: "test", slugs: ["beta"] };
    const results = await searchWikiContent("machine learning", 10, scope);
    expect(results).toEqual([]);
  });

  it("scope with empty slugs array returns no results", async () => {
    await ensureDirectories();
    await writeWikiPage("alpha", "# Alpha\n\nMachine learning concepts.");
    await updateIndex([{ title: "Alpha", slug: "alpha", summary: "s" }]);

    const scope: SearchScope = { agentId: "test", slugs: [] };
    const results = await searchWikiContent("machine learning", 10, scope);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scoped search — fuzzySearchWikiContent with scope parameter
// ---------------------------------------------------------------------------

describe("fuzzySearchWikiContent with scope", () => {
  it("applies scope filtering to both exact and fuzzy phases", async () => {
    await ensureDirectories();
    await writeWikiPage("exact-match", "# Exact\n\nAttention is important.");
    await writeWikiPage("typo-match", "# Typo\n\nAttnetion mechanisms are useful.");
    await writeWikiPage("excluded", "# Excluded\n\nAttention should be excluded.");
    await updateIndex([
      { title: "Exact", slug: "exact-match", summary: "s" },
      { title: "Typo", slug: "typo-match", summary: "s" },
      { title: "Excluded", slug: "excluded", summary: "s" },
    ]);

    // Scope includes exact-match and typo-match, but not excluded
    const scope: SearchScope = { agentId: "test", slugs: ["exact-match", "typo-match"] };
    const results = await fuzzySearchWikiContent("attention", 10, scope);
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("exact-match");
    expect(slugs).toContain("typo-match");
    expect(slugs).not.toContain("excluded");
  });

  it("returns no results when scope excludes all matching pages", async () => {
    await ensureDirectories();
    await writeWikiPage("match", "# Match\n\nAttention is important.");

    const scope: SearchScope = { agentId: "test", slugs: ["other-page"] };
    const results = await fuzzySearchWikiContent("attention", 10, scope);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveScope — parse scope strings and resolve to SearchScope
// ---------------------------------------------------------------------------

describe("resolveScope", () => {
  function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
    return {
      id: "yoyo",
      name: "Yoyo",
      description: "A test agent",
      identityPages: ["yoyo-identity"],
      learningPages: ["yoyo-learnings"],
      socialPages: ["yoyo-social"],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      ...overrides,
    };
  }

  it("resolves 'agent:yoyo' to the agent's page slugs", async () => {
    await ensureAgentsDir();
    await registerAgent(makeProfile());

    const result = await resolveScope("agent:yoyo");
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("yoyo");
    expect(result!.slugs).toEqual(
      expect.arrayContaining(["yoyo-identity", "yoyo-learnings", "yoyo-social"]),
    );
    expect(result!.slugs).toHaveLength(3);
  });

  it("returns null for agent that does not exist", async () => {
    await ensureAgentsDir();
    const result = await resolveScope("agent:nonexistent");
    expect(result).toBeNull();
  });

  it("resolves a fork to its INHERITED (template) pages", async () => {
    await ensureAgentsDir();
    // Base with its own pages…
    await registerAgent(
      makeProfile({
        id: "base--yoyo",
        owner: "yopedia",
        identityPages: ["yoyo-identity"],
        learningPages: ["yoyo-learnings"],
        socialPages: [],
      }),
    );
    // …and a fork that owns NO pages, only a template pointer.
    await registerAgent(
      makeProfile({
        id: "alice--yoyo",
        owner: "alice",
        template: "base--yoyo",
        identityPages: [],
        learningPages: [],
        socialPages: [],
      }),
    );

    const result = await resolveScope("agent:alice--yoyo");
    expect(result).not.toBeNull();
    // The fork's scope must include the base's inherited slugs.
    expect(result!.slugs).toEqual(
      expect.arrayContaining(["yoyo-identity", "yoyo-learnings"]),
    );
  });

  it("returns null for invalid scope format", async () => {
    const result = await resolveScope("invalid");
    expect(result).toBeNull();
  });

  it("returns null for empty string", async () => {
    const result = await resolveScope("");
    expect(result).toBeNull();
  });

  it("returns null for scope with unknown prefix", async () => {
    const result = await resolveScope("user:someone");
    expect(result).toBeNull();
  });

  it("resolves 'owner:<handle>' to a Mine-lens scope", async () => {
    await ensureDirectories();
    const result = await resolveScope("owner:alice");
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("alice");
    expect(Array.isArray(result!.slugs)).toBe(true);
  });

  it("returns null for an empty owner handle", async () => {
    expect(await resolveScope("owner:")).toBeNull();
  });

  it("resolves 'vault:<id>' for a PUBLIC vault to its member slugs", async () => {
    await ensureDirectories();
    const vault = await createVault("alice", "Reading List", "public");
    await addToVault(vault.id, "page-a");
    await addToVault(vault.id, "page-b");

    const result = await resolveScope(`vault:${vault.id}`);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe(vault.id);
    expect(result!.slugs).toEqual(["page-a", "page-b"]);
  });

  it("returns null for a PRIVATE vault (never exposed via scope)", async () => {
    await ensureDirectories();
    const vault = await createVault("alice", "Secret", "private");
    await addToVault(vault.id, "page-a");

    expect(await resolveScope(`vault:${vault.id}`)).toBeNull();
  });

  it("returns null for a vault that does not exist", async () => {
    await ensureDirectories();
    expect(await resolveScope(`vault:${vaultIdFor("alice", "ghost")}`)).toBeNull();
  });

  it("combines all three page arrays from agent profile", async () => {
    await ensureAgentsDir();
    await registerAgent(
      makeProfile({
        identityPages: ["id-1", "id-2"],
        learningPages: ["learn-1"],
        socialPages: [],
      }),
    );

    const result = await resolveScope("agent:yoyo");
    expect(result).not.toBeNull();
    expect(result!.slugs).toEqual(["id-1", "id-2", "learn-1"]);
  });

  it("returns empty slugs array when agent has no pages", async () => {
    await ensureAgentsDir();
    await registerAgent(
      makeProfile({
        identityPages: [],
        learningPages: [],
        socialPages: [],
      }),
    );

    const result = await resolveScope("agent:yoyo");
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("yoyo");
    expect(result!.slugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// expandMineScope + resolveScopeSlugs — the Mine|All lens plumbing (P3)
// ---------------------------------------------------------------------------

describe("expandMineScope", () => {
  const alice = { handle: "alice" } as Principal;

  it("expands 'mine' to owner:<handle> for a signed-in principal", () => {
    expect(expandMineScope("mine", alice)).toBe("owner:alice");
  });

  it("'mine' for a signed-out caller falls through to unscoped (undefined)", () => {
    expect(expandMineScope("mine", null)).toBeUndefined();
  });

  it("passes other scopes through unchanged; empty/undefined → undefined", () => {
    expect(expandMineScope("owner:bob", alice)).toBe("owner:bob");
    expect(expandMineScope("agent:yoyo", null)).toBe("agent:yoyo");
    expect(expandMineScope(undefined, alice)).toBeUndefined();
    expect(expandMineScope("", alice)).toBeUndefined();
  });
});

describe("resolveScopeSlugs", () => {
  const alice = { handle: "alice" } as Principal;

  it("no scope → unscoped (no slugs, no error)", async () => {
    expect(await resolveScopeSlugs(undefined, alice)).toEqual({});
  });

  it("'mine' resolves to the principal's own pages", async () => {
    await writeWikiPage(
      "alice-pg",
      serializeFrontmatter({ owner: "alice" }, "# A\n\nbody"),
    );
    await writeWikiPage("index", "# Index\n\n- [A](alice-pg.md) — body");
    const r = await resolveScopeSlugs("mine", alice);
    expect(r.error).toBeUndefined();
    expect(r.scopeSlugs).toEqual(["alice-pg"]);
  });

  it("'mine' with NO own pages falls back to the commons (unscoped), not an error", async () => {
    await ensureDirectories();
    const r = await resolveScopeSlugs("mine", { handle: "nobody" } as Principal);
    expect(r).toEqual({});
  });

  it("explicit owner:<h> with no pages IS an error (not a silent fallback)", async () => {
    await ensureDirectories();
    const r = await resolveScopeSlugs("owner:ghost", alice);
    expect(r.error).toMatch(/No pages found/);
  });

  it("an unresolvable scope → error", async () => {
    const r = await resolveScopeSlugs("user:bogus", alice);
    expect(r.error).toMatch(/Invalid scope/);
  });
});

// ---------------------------------------------------------------------------
// findRelatedPages — ingest-time candidate prefilter
// ---------------------------------------------------------------------------

describe("findRelatedPages — candidate prefilter", () => {
  beforeEach(() => {
    mockedHasLLMKey.mockReturnValue(true);
    mockedSearchByVector.mockReset();
    mockedSearchByVector.mockResolvedValue([]);
    mockedCallLLM.mockReset();
    mockedCallLLM.mockResolvedValue("[]");
  });

  afterEach(() => {
    // Restore the suite-wide default so later describes see no LLM.
    mockedHasLLMKey.mockReturnValue(false);
  });

  function makeEntries(n: number): IndexEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      slug: `page-${i}`,
      title: `Page ${i}`,
      summary: `Summary ${i}`,
    }));
  }

  const indexLines = (msg: string) => msg.match(/^- page-\d+:/gm) ?? [];

  it("narrows the LLM candidate list to the vector hits on a large wiki", async () => {
    const entries = makeEntries(100);
    // The vector store says only these three are semantically near.
    mockedSearchByVector.mockResolvedValue([
      { slug: "page-1", score: 0.9 },
      { slug: "page-2", score: 0.8 },
      { slug: "page-3", score: 0.7 },
    ]);
    mockedCallLLM.mockResolvedValue('["page-1"]');

    const related = await findRelatedPages("new-page", "some new content", entries);

    expect(mockedSearchByVector).toHaveBeenCalled();
    const userMessage = mockedCallLLM.mock.calls[0][1] as string;
    expect(userMessage).toContain("- page-1:");
    expect(userMessage).toContain("- page-3:");
    expect(userMessage).not.toContain("- page-50:");
    // Bounded by the hits — not all 100 pages.
    expect(indexLines(userMessage)).toHaveLength(3);
    expect(related).toEqual(["page-1"]);
  });

  it("falls back to the full index when the vector store is empty", async () => {
    const entries = makeEntries(100);
    mockedSearchByVector.mockResolvedValue([]); // empty / no-embedding store

    await findRelatedPages("new-page", "content", entries);

    const userMessage = mockedCallLLM.mock.calls[0][1] as string;
    expect(userMessage).toContain("- page-99:"); // a distant page is present
    expect(indexLines(userMessage)).toHaveLength(100);
  });

  it("does not prefilter a small wiki (≤ candidate pool)", async () => {
    const entries = makeEntries(10);

    await findRelatedPages("new-page", "content", entries);

    expect(mockedSearchByVector).not.toHaveBeenCalled();
    const userMessage = mockedCallLLM.mock.calls[0][1] as string;
    expect(indexLines(userMessage)).toHaveLength(10);
  });
});
