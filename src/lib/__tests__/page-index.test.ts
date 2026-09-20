import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getPageIndex,
  syncPageIndexForPage,
  removePageIndexForSlug,
  rebuildPageIndex,
} from "../page-index";
import {
  listWikiPages,
  scanWikiPagesUncached,
  ensureDirectories,
  writeWikiPage,
} from "../wiki";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-index-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Create a page with frontmatter + register it in index.md. */
async function createPage(slug: string, frontmatter: string, title = slug) {
  await ensureDirectories();
  await writeWikiPage(slug, `---\n${frontmatter}\n---\n\n# ${title}\n\nBody.`);
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch {
    /* none */
  }
  const line = `- [${title}](${slug}.md) — ${title} summary`;
  await fs.writeFile(
    indexPath,
    existing ? `${existing.trimEnd()}\n${line}\n` : `# Wiki Index\n\n${line}\n`,
    "utf-8",
  );
}

describe("page-index", () => {
  it("getPageIndex returns null when the key is absent (not seeded)", async () => {
    await createPage("a", "owner: alice\ntags: [x]");
    expect(await getPageIndex()).toBeNull();
  });

  it("syncPageIndexForPage seeds the index when it is absent", async () => {
    // Silo-only reads derive a page's tenant from its index entry, so the very
    // first write has to leave an entry behind — not wait for a rebuild.
    await createPage("a", "owner: alice");
    await syncPageIndexForPage({ slug: "a", title: "A", summary: "s", owner: "alice" });

    const idx = await getPageIndex();
    expect(idx).not.toBeNull();
    expect(idx!.a).toEqual({ slug: "a", title: "A", summary: "s", owner: "alice" });
  });

  it("removePageIndexForSlug still NO-OPs when the index is absent", async () => {
    // Removal must not fabricate an empty map — absent stays absent.
    await createPage("a", "owner: alice");
    await removePageIndexForSlug("a");
    expect(await getPageIndex()).toBeNull();
  });

  it("listWikiPages fast-path (seeded) equals the per-page scan", async () => {
    await createPage("a", "owner: alice\ntags: [ml, ai]\ntype: note", "Alpha");
    await createPage("b", "owner: bob\nvisibility: private\nconfidence: 0.5", "Beta");

    const scan = await scanWikiPagesUncached();
    await rebuildPageIndex();
    expect(await getPageIndex()).not.toBeNull();

    const fast = await listWikiPages();
    // Same entries (order by index.md), same enriched fields.
    expect(fast).toEqual(scan);
    // Spot-check enrichment came through the index, not just base fields.
    const beta = fast.find((e) => e.slug === "b");
    expect(beta?.visibility).toBe("private");
    expect(beta?.owner).toBe("bob");
    expect(beta?.confidence).toBe(0.5);
  });

  it("falls back to the scan when the index is unseeded (identical result)", async () => {
    await createPage("a", "owner: alice\ntags: [x]", "Alpha");
    // No rebuild → index absent → listWikiPages must equal the scan.
    expect(await getPageIndex()).toBeNull();
    expect(await listWikiPages()).toEqual(await scanWikiPagesUncached());
  });

  it("after seeding, sync upserts and remove drops an entry", async () => {
    await createPage("a", "owner: alice", "Alpha");
    await rebuildPageIndex();

    await syncPageIndexForPage({ slug: "a", title: "Alpha", summary: "s", owner: "carol" });
    expect((await getPageIndex())?.["a"]?.owner).toBe("carol");

    await removePageIndexForSlug("a");
    expect((await getPageIndex())?.["a"]).toBeUndefined();
  });
});
