import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  buildAliasIndex,
  resolveAlias,
  resetAliasIndex,
  updateAliasIndexForPage,
  removeAliasForPage,
  findDuplicateEntities,
} from "../alias-index";
import { writeWikiPage, ensureDirectories, updateIndex } from "../wiki";
import { _resetStorage } from "../storage";
import { listSiloSlugs, siloPagePath } from "./helpers/wiki-fixtures";
import { serializeFrontmatter } from "../frontmatter";
import type { IndexEntry } from "../types";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "alias-index-test-"));
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
  await fs.rm(tmpDir, { recursive: true, force: true });
  resetAliasIndex();
});

// ---------------------------------------------------------------------------
// Helper: create a wiki page with frontmatter
// ---------------------------------------------------------------------------
async function createPage(
  slug: string,
  title: string,
  aliases: string[] = [],
): Promise<void> {
  const fm = {
    created: "2026-01-01",
    updated: "2026-01-01",
    aliases,
  };
  const content = serializeFrontmatter(fm, `# ${title}\n\nContent about ${title}.`);
  await writeWikiPage(slug, content);
  // Update index so listWikiPages sees it
  const entries: IndexEntry[] = [{ slug, title, summary: `About ${title}` }];
  // Read existing index entries and append
  const allEntries: IndexEntry[] = [];
  for (const s of await listSiloSlugs()) {
    if (s === slug) continue; // we'll add it below
    const raw = await fs.readFile(siloPagePath(s), "utf-8");
    const titleMatch = raw.match(/^# (.+)$/m);
    allEntries.push({ slug: s, title: titleMatch?.[1] ?? s, summary: `About ${s}` });
  }
  allEntries.push(...entries);
  await updateIndex(allEntries);
}

// ---------------------------------------------------------------------------
// buildAliasIndex
// ---------------------------------------------------------------------------
describe("buildAliasIndex", () => {
  it("indexes page titles by lowercase", async () => {
    await createPage("react", "React");
    const index = await buildAliasIndex();
    expect(index.byAlias.get("react")).toBe("react");
  });

  it("indexes aliases from frontmatter", async () => {
    await createPage("react", "React", ["React.js", "ReactJS"]);
    const index = await buildAliasIndex();
    expect(index.byAlias.get("react.js")).toBe("react");
    expect(index.byAlias.get("reactjs")).toBe("react");
  });

  it("indexes slugified aliases in bySlug", async () => {
    await createPage("react", "React", ["React.js"]);
    const index = await buildAliasIndex();
    // "React.js" slugified = "react-js"
    expect(index.bySlug.get("react-js")).toBe("react");
  });

  it("skips infrastructure pages (index, log)", async () => {
    await createPage("react", "React");
    const index = await buildAliasIndex();
    expect(index.bySlug.has("index")).toBeFalsy();
    expect(index.bySlug.has("log")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// resolveAlias
// ---------------------------------------------------------------------------
describe("resolveAlias", () => {
  it("resolves exact alias match", async () => {
    await createPage("react", "React", ["React.js", "ReactJS"]);
    // Force rebuild
    resetAliasIndex();
    const result = await resolveAlias("React.js");
    expect(result).toBe("react");
  });

  it("resolves via slugified alias (fuzzy slug match)", async () => {
    await createPage("react", "React", ["React.js"]);
    resetAliasIndex();
    // "React JS" slugifies to "react-js", which matches the alias "React.js" slugified
    const result = await resolveAlias("React JS");
    expect(result).toBe("react");
  });

  it("resolves via page title match", async () => {
    await createPage("react", "React");
    resetAliasIndex();
    const result = await resolveAlias("React");
    expect(result).toBe("react");
  });

  it("returns null when no match exists", async () => {
    await createPage("react", "React");
    resetAliasIndex();
    const result = await resolveAlias("Vue.js");
    expect(result).toBeNull();
  });

  it("is case-insensitive for alias matching", async () => {
    await createPage("react", "React", ["REACT.JS"]);
    resetAliasIndex();
    const result = await resolveAlias("react.js");
    expect(result).toBe("react");
  });
});

// ---------------------------------------------------------------------------
// updateAliasIndexForPage (incremental update)
// ---------------------------------------------------------------------------
describe("updateAliasIndexForPage", () => {
  it("updates cached index without full rebuild", async () => {
    await createPage("react", "React", ["React.js"]);
    // Build initial index
    await buildAliasIndex();

    // Simulate adding a new page — update index incrementally
    updateAliasIndexForPage("vue", "Vue", ["Vue.js", "VueJS"]);

    // Now resolve should find the new page without rebuilding
    const result = await resolveAlias("Vue.js");
    expect(result).toBe("vue");
  });

  it("does nothing if no cached index exists", () => {
    // Should not throw
    resetAliasIndex();
    updateAliasIndexForPage("test", "Test", ["TestAlias"]);
  });
});

// ---------------------------------------------------------------------------
// removeAliasForPage
// ---------------------------------------------------------------------------
describe("removeAliasForPage", () => {
  it("removes title and aliases from cached index", async () => {
    await createPage("react", "React", ["React.js", "ReactJS"]);
    // Build the index so it's cached
    await buildAliasIndex();

    // Verify aliases resolve before removal
    expect(await resolveAlias("React")).toBe("react");
    expect(await resolveAlias("React.js")).toBe("react");
    expect(await resolveAlias("ReactJS")).toBe("react");

    // Remove the page's aliases
    removeAliasForPage("react");

    // All aliases should now return null
    expect(await resolveAlias("React")).toBeNull();
    expect(await resolveAlias("React.js")).toBeNull();
    expect(await resolveAlias("ReactJS")).toBeNull();
  });

  it("does not affect entries for other pages", async () => {
    await createPage("react", "React", ["React.js"]);
    await createPage("vue", "Vue", ["Vue.js"]);
    await buildAliasIndex();

    // Remove only react
    removeAliasForPage("react");

    // Vue should still resolve
    expect(await resolveAlias("Vue")).toBe("vue");
    expect(await resolveAlias("Vue.js")).toBe("vue");
    // React should not
    expect(await resolveAlias("React")).toBeNull();
  });

  it("does nothing if no cached index exists", () => {
    // Should not throw
    resetAliasIndex();
    removeAliasForPage("nonexistent");
  });

  it("removes slugified alias entries from bySlug", async () => {
    await createPage("react", "React", ["React JS"]);
    await buildAliasIndex();

    // "React JS" slugifies to "react-js"
    expect(await resolveAlias("React JS")).toBe("react");

    removeAliasForPage("react");

    // Slugified alias should also be gone
    expect(await resolveAlias("React JS")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findDuplicateEntities
// ---------------------------------------------------------------------------
describe("findDuplicateEntities", () => {
  it("detects overlap when title of one page is alias of another", async () => {
    await createPage("javascript", "JavaScript", ["JS", "ECMAScript"]);
    await createPage("ecmascript", "ECMAScript", []);
    resetAliasIndex();

    const dupes = await findDuplicateEntities();
    expect(dupes.length).toBe(1);
    const slugs = [dupes[0].slugA, dupes[0].slugB].sort();
    expect(slugs).toEqual(["ecmascript", "javascript"]);
    expect(dupes[0].overlappingName.toLowerCase()).toBe("ecmascript");
  });

  it("detects overlap when two pages share the same alias", async () => {
    await createPage("react", "React", ["UI Library"]);
    await createPage("vue", "Vue", ["UI Library"]);
    resetAliasIndex();

    const dupes = await findDuplicateEntities();
    expect(dupes.length).toBe(1);
    expect(dupes[0].overlappingName).toBe("ui library");
  });

  it("detects overlap when slug from alias matches another page slug", async () => {
    // "react" page has alias "Vue JS" which slugifies to "vue-js"
    // "vue-js" page exists
    await createPage("react", "React", ["Vue JS"]);
    await createPage("vue-js", "Vue JS", []);
    resetAliasIndex();

    const dupes = await findDuplicateEntities();
    expect(dupes.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for non-overlapping pages", async () => {
    await createPage("react", "React", ["React.js"]);
    await createPage("vue", "Vue", ["Vue.js"]);
    resetAliasIndex();

    const dupes = await findDuplicateEntities();
    expect(dupes.length).toBe(0);
  });

  it("does not report self-matches", async () => {
    await createPage("react", "React", ["React"]);
    resetAliasIndex();

    const dupes = await findDuplicateEntities();
    expect(dupes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: ingest with alias resolution
// ---------------------------------------------------------------------------
describe("ingest with alias resolution", () => {
  // We test the resolveAlias function directly here since ingest() requires
  // mocking the LLM. The integration is: ingest calls resolveAlias(title)
  // and uses the returned slug instead of slugify(title).

  it("resolveAlias returns existing slug when title matches an alias", async () => {
    await createPage("react", "React", ["React.js", "ReactJS"]);
    resetAliasIndex();

    // If someone ingests "React.js", alias resolution should find "react"
    const resolved = await resolveAlias("React.js");
    expect(resolved).toBe("react");
  });

  it("resolveAlias returns null for genuinely new content", async () => {
    await createPage("react", "React", ["React.js"]);
    resetAliasIndex();

    const resolved = await resolveAlias("Svelte");
    expect(resolved).toBeNull();
  });
});
