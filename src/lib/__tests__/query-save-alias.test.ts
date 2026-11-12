import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { saveAnswerToWiki } from "../query";
import {
  writeWikiPage,
  ensureDirectories,
  updateIndex,
  readWikiPage,
} from "../wiki";
import { serializeFrontmatter } from "../frontmatter";
import { resetAliasIndex } from "../alias-index";
import { _resetStorage } from "../storage";
import type { IndexEntry } from "../types";

// ---------------------------------------------------------------------------
// Mock LLM + embeddings so tests don't require real API keys
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

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------
let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "query-alias-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
  resetAliasIndex();
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
  resetAliasIndex();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: create a wiki page with frontmatter (title, owner, visibility, aliases)
// ---------------------------------------------------------------------------
async function createPage(
  slug: string,
  title: string,
  opts: { owner?: string; visibility?: string; aliases?: string[] } = {},
): Promise<void> {
  const fm: Record<string, string | string[] | number | boolean> = {
    created: "2026-01-01",
    updated: "2026-01-01",
  };
  if (opts.aliases && opts.aliases.length > 0) fm.aliases = opts.aliases;
  if (opts.owner) fm.owner = opts.owner;
  if (opts.visibility) fm.visibility = opts.visibility;

  const content = serializeFrontmatter(
    fm,
    `# ${title}\n\nOriginal content for ${title}.`,
  );
  await writeWikiPage(slug, content);

  // Rebuild the full index from on-disk pages so listWikiPages (and alias
  // resolution, which scans all pages) sees everything.
  const siloDir = path.join(tmpDir, "tenants", "yopedia", "wiki");
  let files: string[] = [];
  try {
    files = await fs.readdir(siloDir);
  } catch {
    /* dir may not exist yet */
  }
  const allEntries: IndexEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".md") || f === "index.md" || f === "log.md") continue;
    const s = f.replace(/\.md$/, "");
    const raw = await fs.readFile(path.join(siloDir, f), "utf-8");
    const titleMatch = raw.match(/^# (.+)$/m);
    allEntries.push({
      slug: s,
      title: titleMatch?.[1] ?? s,
      summary: `About ${s}`,
    });
  }
  await updateIndex(allEntries);
  // Reset alias index so the next resolveAlias() rebuilds from the updated pages
  resetAliasIndex();
}

// ---------------------------------------------------------------------------
// Tests: alias resolution ownership guard in saveAnswerToWiki
// ---------------------------------------------------------------------------
describe("saveAnswerToWiki alias ownership guard", () => {
  it("merges into the caller's own page when alias resolves to it", async () => {
    // alice owns a page titled "Machine Learning" with alias "ML"
    await createPage("machine-learning", "Machine Learning", {
      owner: "alice",
      aliases: ["ML"],
    });

    // alice saves a query answer titled "ML" — should merge into machine-learning
    const result = await saveAnswerToWiki(
      "ML",
      "Updated content about ML.",
      undefined, // no explicit slug
      undefined, // no sources
      "markdown",
      "alice", // owner
      "alice", // author
    );

    expect(result.slug).toBe("machine-learning");

    // The page was overwritten with the new content
    const page = await readWikiPage("machine-learning");
    expect(page).not.toBeNull();
    expect(page!.content).toContain("Updated content about ML");
  });

  it("creates a new page when alias resolves to another owner's page", async () => {
    // bob owns a page titled "Machine Learning" with alias "ML"
    await createPage("machine-learning", "Machine Learning", {
      owner: "bob",
      aliases: ["ML"],
    });

    // alice tries to save a query answer titled "ML"
    const result = await saveAnswerToWiki(
      "ML",
      "Alice's content about ML.",
      undefined,
      undefined,
      "markdown",
      "alice",
      "alice",
    );

    // Should NOT overwrite bob's page — creates a new page with slugified title
    expect(result.slug).toBe("ml");

    // bob's original page is untouched
    const bobPage = await readWikiPage("machine-learning");
    expect(bobPage).not.toBeNull();
    expect(bobPage!.content).toContain("Original content for Machine Learning");

    // alice's page was created separately
    const alicePage = await readWikiPage("ml");
    expect(alicePage).not.toBeNull();
    expect(alicePage!.content).toContain("Alice's content about ML");
  });

  it("creates a new page when alias resolves to a private page", async () => {
    // bob has a private page with alias "ML"
    await createPage("machine-learning", "Machine Learning", {
      owner: "bob",
      visibility: "private",
      aliases: ["ML"],
    });

    // bob himself tries to save — still shouldn't overwrite a private page
    const result = await saveAnswerToWiki(
      "ML",
      "Content from bob.",
      undefined,
      undefined,
      "markdown",
      "bob",
      "bob",
    );

    // Private pages are never overwritten via alias resolution
    expect(result.slug).toBe("ml");

    // Original private page is untouched
    const privatePage = await readWikiPage("machine-learning");
    expect(privatePage).not.toBeNull();
    expect(privatePage!.content).toContain("Original content for Machine Learning");
  });

  it("creates a new page when the caller is anonymous and page has an owner", async () => {
    // alice owns a page titled "Machine Learning" with alias "ML"
    await createPage("machine-learning", "Machine Learning", {
      owner: "alice",
      aliases: ["ML"],
    });

    // anonymous caller (no owner) saves a query answer titled "ML"
    const result = await saveAnswerToWiki(
      "ML",
      "Anonymous content about ML.",
      undefined,
      undefined,
      "markdown",
      // no owner — anonymous
    );

    // Should NOT overwrite alice's page
    expect(result.slug).toBe("ml");

    // alice's page is untouched
    const alicePage = await readWikiPage("machine-learning");
    expect(alicePage).not.toBeNull();
    expect(alicePage!.content).toContain("Original content for Machine Learning");
  });

  it("merges into an unowned public page (commons) for any caller", async () => {
    // Unowned public commons page with alias "ML"
    await createPage("machine-learning", "Machine Learning", {
      aliases: ["ML"],
    });

    // Any caller (even anonymous) may merge into an unowned commons page
    const result = await saveAnswerToWiki(
      "ML",
      "Updated commons content.",
      undefined,
      undefined,
      "markdown",
      // no owner
    );

    expect(result.slug).toBe("machine-learning");

    const page = await readWikiPage("machine-learning");
    expect(page).not.toBeNull();
    expect(page!.content).toContain("Updated commons content");
  });
});
