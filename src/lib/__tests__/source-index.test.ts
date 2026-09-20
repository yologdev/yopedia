import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  buildSourceIndex,
  getSourceIndex,
  resetSourceIndex,
  resolveSourceUrl,
  resolveContentHash,
  updateSourceIndexForPage,
  removeSourceForPage,
  normalizeUrl,
} from "../source-index";
import { writeWikiPage, ensureDirectories, updateIndex } from "../wiki";
import { _resetStorage } from "../storage";
import { listSiloSlugs } from "./helpers/wiki-fixtures";
import { serializeFrontmatter } from "../frontmatter";
import type { IndexEntry } from "../types";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "source-index-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  // Silo paths resolve against DATA_DIR (default: cwd), so a test that only
  // overrides WIKI_DIR writes its pages outside its own tmpDir.
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
  resetSourceIndex();
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
  resetSourceIndex();
});

// ---------------------------------------------------------------------------
// Helper: create a wiki page with frontmatter including source_url / content_hash
// ---------------------------------------------------------------------------
async function createPage(
  slug: string,
  title: string,
  opts: { source_url?: string; content_hash?: string } = {},
): Promise<void> {
  const fm: Record<string, string> = {
    created: "2026-01-01",
    updated: "2026-01-01",
  };
  if (opts.source_url !== undefined) fm.source_url = opts.source_url;
  if (opts.content_hash !== undefined) fm.content_hash = opts.content_hash;

  const content = serializeFrontmatter(fm, `# ${title}\n\nContent about ${title}.`);
  await writeWikiPage(slug, content);

  // Update index so listWikiPages sees the page. Pages live in the silo now
  // (#869), so enumerate that — the flat dir holds only index.md / log.md.
  const allEntries: IndexEntry[] = (await listSiloSlugs()).map((s) => ({
    slug: s,
    title: s,
    summary: `About ${s}`,
  }));
  await updateIndex(allEntries);
}

// ---------------------------------------------------------------------------
// buildSourceIndex
// ---------------------------------------------------------------------------
describe("buildSourceIndex", () => {
  it("builds index from pages with source_url", async () => {
    await createPage("react", "React", {
      source_url: "https://react.dev",
    });
    const index = await buildSourceIndex();
    expect(index.byUrl.get("https://react.dev")).toBe("react");
  });

  it("builds index from pages with content_hash", async () => {
    await createPage("notes", "Notes", {
      content_hash: "abc123",
    });
    const index = await buildSourceIndex();
    expect(index.byHash.get("abc123")).toBe("notes");
  });

  it("indexes both url and hash when both are present", async () => {
    await createPage("react", "React", {
      source_url: "https://react.dev",
      content_hash: "hash-react",
    });
    const index = await buildSourceIndex();
    expect(index.byUrl.get("https://react.dev")).toBe("react");
    expect(index.byHash.get("hash-react")).toBe("react");
  });

  it("skips pages without source_url or content_hash", async () => {
    await createPage("plain", "Plain Page");
    const index = await buildSourceIndex();
    expect(index.byUrl.size).toBe(0);
    expect(index.byHash.size).toBe(0);
  });

  it("skips infrastructure pages (index, log)", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });
    const index = await buildSourceIndex();
    // index and log should not appear even if they exist
    expect(index.byUrl.has("index")).toBeFalsy();
    expect(index.byUrl.has("log")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// resolveSourceUrl
// ---------------------------------------------------------------------------
describe("resolveSourceUrl", () => {
  it("finds existing slug by URL", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://react.dev");
    expect(result).toBe("react");
  });

  it("returns null for unknown URLs", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://vue.js.org");
    expect(result).toBeNull();
  });

  it("returns null for empty string", async () => {
    const result = await resolveSourceUrl("");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------
describe("URL normalization", () => {
  it("matches URLs with trailing slash to those without", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });
    resetSourceIndex();
    // Query with trailing slash should match stored without
    const result = await resolveSourceUrl("https://react.dev/");
    expect(result).toBe("react");
  });

  it("matches URLs stored with trailing slash via query without", async () => {
    await createPage("react", "React", {
      source_url: "https://react.dev/docs/",
    });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://react.dev/docs");
    expect(result).toBe("react");
  });

  it("trims whitespace from URLs", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });
    resetSourceIndex();
    const result = await resolveSourceUrl("  https://react.dev  ");
    expect(result).toBe("react");
  });

  it("returns null for text-paste sentinel", async () => {
    const result = await resolveSourceUrl("text-paste");
    expect(result).toBeNull();
  });

  it("skips text-paste sentinel during index build", async () => {
    await createPage("notes", "Notes", { source_url: "text-paste" });
    const index = await buildSourceIndex();
    expect(index.byUrl.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeUrl — unit tests for each normalization rule
// ---------------------------------------------------------------------------
describe("normalizeUrl", () => {
  it("strips fragments", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe(
      "https://example.com/page",
    );
  });

  it("lowercases hostname but not path", () => {
    expect(normalizeUrl("https://Example.COM/CaseSensitive/Path")).toBe(
      "https://example.com/CaseSensitive/Path",
    );
  });

  it("strips default port 443 for https", () => {
    expect(normalizeUrl("https://example.com:443/path")).toBe(
      "https://example.com/path",
    );
  });

  it("strips default port 80 for http (upgraded to https)", () => {
    expect(normalizeUrl("http://example.com:80/path")).toBe(
      "https://example.com/path",
    );
  });

  it("preserves non-default ports", () => {
    expect(normalizeUrl("https://example.com:8080/path")).toBe(
      "https://example.com:8080/path",
    );
  });

  it("strips www. prefix", () => {
    expect(normalizeUrl("https://www.example.com/page")).toBe(
      "https://example.com/page",
    );
  });

  it("sorts query parameters", () => {
    expect(normalizeUrl("https://example.com/page?b=2&a=1")).toBe(
      "https://example.com/page?a=1&b=2",
    );
  });

  it("strips trailing slash from path", () => {
    expect(normalizeUrl("https://example.com/docs/")).toBe(
      "https://example.com/docs",
    );
  });

  it("strips trailing slash from root URL", () => {
    expect(normalizeUrl("https://example.com/")).toBe(
      "https://example.com",
    );
  });

  it("upgrades http to https", () => {
    expect(normalizeUrl("http://example.com/page")).toBe(
      "https://example.com/page",
    );
  });

  it("handles all normalizations together (acceptance criterion)", () => {
    expect(
      normalizeUrl("https://www.Example.COM:443/path?b=2&a=1#frag"),
    ).toBe("https://example.com/path?a=1&b=2");
  });

  it("trims whitespace", () => {
    expect(normalizeUrl("  https://example.com/path  ")).toBe(
      "https://example.com/path",
    );
  });

  it("returns empty string for empty input", () => {
    expect(normalizeUrl("")).toBe("");
  });

  it("falls back to trim+slash-strip for non-URL strings", () => {
    expect(normalizeUrl("not-a-url/")).toBe("not-a-url");
  });

  it("falls back for non-http protocols", () => {
    expect(normalizeUrl("ftp://files.example.com/data/")).toBe(
      "ftp://files.example.com/data",
    );
  });

  it("keeps query with root path", () => {
    expect(normalizeUrl("https://example.com?q=test")).toBe(
      "https://example.com/?q=test",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSourceUrl — integration tests for URL variant dedup
// ---------------------------------------------------------------------------
describe("resolveSourceUrl variant dedup", () => {
  it("matches www variant to stored non-www URL", async () => {
    await createPage("example", "Example", {
      source_url: "https://example.com/page",
    });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://www.example.com/page");
    expect(result).toBe("example");
  });

  it("matches http variant to stored https URL", async () => {
    await createPage("example", "Example", {
      source_url: "https://example.com/page",
    });
    resetSourceIndex();
    const result = await resolveSourceUrl("http://example.com/page");
    expect(result).toBe("example");
  });

  it("matches URL with fragment to stored URL without fragment", async () => {
    await createPage("example", "Example", {
      source_url: "https://example.com/page",
    });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://example.com/page#section");
    expect(result).toBe("example");
  });

  it("matches URL with different hostname casing", async () => {
    await createPage("example", "Example", {
      source_url: "https://example.com/path",
    });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://Example.COM/path");
    expect(result).toBe("example");
  });

  it("matches URL with reordered query params", async () => {
    await createPage("example", "Example", {
      source_url: "https://example.com/page?a=1&b=2",
    });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://example.com/page?b=2&a=1");
    expect(result).toBe("example");
  });

  it("matches URL with default port to stored URL without port", async () => {
    await createPage("example", "Example", {
      source_url: "https://example.com/page",
    });
    resetSourceIndex();
    const result = await resolveSourceUrl("https://example.com:443/page");
    expect(result).toBe("example");
  });
});

// ---------------------------------------------------------------------------
// resolveContentHash
// ---------------------------------------------------------------------------
describe("resolveContentHash", () => {
  it("finds existing slug by hash", async () => {
    await createPage("notes", "Notes", { content_hash: "sha256-abc" });
    resetSourceIndex();
    const result = await resolveContentHash("sha256-abc");
    expect(result).toBe("notes");
  });

  it("returns null for unknown hashes", async () => {
    await createPage("notes", "Notes", { content_hash: "sha256-abc" });
    resetSourceIndex();
    const result = await resolveContentHash("sha256-xyz");
    expect(result).toBeNull();
  });

  it("returns null for empty string", async () => {
    const result = await resolveContentHash("");
    expect(result).toBeNull();
  });

  it("returns null for whitespace-only string", async () => {
    const result = await resolveContentHash("   ");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateSourceIndexForPage (incremental cache update)
// ---------------------------------------------------------------------------
describe("updateSourceIndexForPage", () => {
  it("adds URL entry to cached index", async () => {
    // Build the index first so it's cached
    await buildSourceIndex();

    updateSourceIndexForPage("vue", "https://vuejs.org", undefined);

    const result = await resolveSourceUrl("https://vuejs.org");
    expect(result).toBe("vue");
  });

  it("adds hash entry to cached index", async () => {
    await buildSourceIndex();

    updateSourceIndexForPage("vue", undefined, "hash-vue");

    const result = await resolveContentHash("hash-vue");
    expect(result).toBe("vue");
  });

  it("adds both URL and hash in one call", async () => {
    await buildSourceIndex();

    updateSourceIndexForPage("vue", "https://vuejs.org", "hash-vue");

    expect(await resolveSourceUrl("https://vuejs.org")).toBe("vue");
    expect(await resolveContentHash("hash-vue")).toBe("vue");
  });

  it("does nothing if no cached index exists", () => {
    // Cache is reset in beforeEach; should not throw
    resetSourceIndex();
    updateSourceIndexForPage("test", "https://test.com", "hash-test");
    // No assertion needed — just verify no error
  });

  it("skips text-paste sentinel URL", async () => {
    await buildSourceIndex();
    updateSourceIndexForPage("notes", "text-paste", undefined);
    const result = await resolveSourceUrl("text-paste");
    expect(result).toBeNull();
  });

  it("skips empty URL", async () => {
    await buildSourceIndex();
    updateSourceIndexForPage("notes", "", undefined);
    const index = await getSourceIndex();
    expect(index.byUrl.size).toBe(0);
  });

  it("skips empty hash", async () => {
    await buildSourceIndex();
    updateSourceIndexForPage("notes", undefined, "");
    const index = await getSourceIndex();
    expect(index.byHash.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// removeSourceForPage
// ---------------------------------------------------------------------------
describe("removeSourceForPage", () => {
  it("removes URL and hash entries for a slug", async () => {
    await createPage("react", "React", {
      source_url: "https://react.dev",
      content_hash: "hash-react",
    });
    await buildSourceIndex();

    // Verify entries exist before removal
    expect(await resolveSourceUrl("https://react.dev")).toBe("react");
    expect(await resolveContentHash("hash-react")).toBe("react");

    removeSourceForPage("react");

    // Both should be gone
    expect(await resolveSourceUrl("https://react.dev")).toBeNull();
    expect(await resolveContentHash("hash-react")).toBeNull();
  });

  it("does not affect entries for other pages", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });
    await createPage("vue", "Vue", { source_url: "https://vuejs.org" });
    await buildSourceIndex();

    removeSourceForPage("react");

    // Vue should still resolve
    expect(await resolveSourceUrl("https://vuejs.org")).toBe("vue");
    // React should not
    expect(await resolveSourceUrl("https://react.dev")).toBeNull();
  });

  it("does nothing if no cached index exists", () => {
    resetSourceIndex();
    // Should not throw
    removeSourceForPage("nonexistent");
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------
describe("cache behavior", () => {
  it("getSourceIndex returns cached index on second call", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });

    const first = await getSourceIndex();
    const second = await getSourceIndex();

    // Same object reference — cached, not rebuilt
    expect(first).toBe(second);
  });

  it("resetSourceIndex forces rebuild on next access", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });

    const first = await getSourceIndex();
    resetSourceIndex();
    const second = await getSourceIndex();

    // Different object reference — rebuilt
    expect(first).not.toBe(second);
    // But same content
    expect(second.byUrl.get("https://react.dev")).toBe("react");
  });

  it("buildSourceIndex replaces previous cache", async () => {
    await createPage("react", "React", { source_url: "https://react.dev" });
    const first = await buildSourceIndex();

    // Add another page
    await createPage("vue", "Vue", { source_url: "https://vuejs.org" });
    const second = await buildSourceIndex();

    expect(first).not.toBe(second);
    expect(second.byUrl.get("https://vuejs.org")).toBe("vue");
  });
});
