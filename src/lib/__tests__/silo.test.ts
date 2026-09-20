import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { syncSiloForPage, removeSiloForPage, reconcileSilos } from "../silo";
import { writeWikiPage, ensureDirectories, updateIndex } from "../wiki";
import { getStorage, _resetStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "silo-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("syncSiloForPage", () => {
  it("mirrors the page md into tenants/<tenant>/wiki", async () => {
    // syncSiloForPage migrates FLAT → silo, so plant a flat source directly;
    // writeWikiPage now writes to the silo and would leave nothing to migrate.
    await getStorage().writeFile("wiki/alpha.md", "# Alpha\n\nBody.");
    const n = await syncSiloForPage("alpha", "alice");
    expect(n).toBe(1); // just the wiki md (no raw/revisions/discuss/assets)
    expect(await getStorage().readFile("tenants/alice/wiki/alpha.md")).toContain(
      "# Alpha",
    );
  });

  it("re-copies the mutable md but SKIPS already-mirrored immutable revisions", async () => {
    await getStorage().writeFile("wiki/beta.md", "# Beta\n\nv1");
    // Plant two immutable revision files (as saveRevision would).
    await getStorage().writeFile("wiki/.revisions/beta/1.md", "# Beta\n\nv0");
    await getStorage().writeFile(
      "wiki/.revisions/beta/1.meta.json",
      '{"author":"a"}',
    );

    // First sync copies md + both revision files.
    expect(await syncSiloForPage("beta", "bob")).toBe(3);

    // Second sync (no new revisions) copies ONLY the mutable md again — the two
    // already-mirrored revisions are skipped (the O(N) re-copy fix).
    expect(await syncSiloForPage("beta", "bob")).toBe(1);

    // A newly-added revision IS picked up next sync.
    await getStorage().writeFile("wiki/.revisions/beta/2.md", "# Beta\n\nv1");
    expect(await syncSiloForPage("beta", "bob")).toBe(2); // md + the new revision
  });

  it("removeSiloForPage clears the page from its silo", async () => {
    await getStorage().writeFile("wiki/gamma.md", "# Gamma");
    await syncSiloForPage("gamma", "alice");
    expect(await getStorage().fileExists("tenants/alice/wiki/gamma.md")).toBe(
      true,
    );
    await removeSiloForPage("gamma", "alice");
    expect(await getStorage().fileExists("tenants/alice/wiki/gamma.md")).toBe(
      false,
    );
  });
});

describe("reconcileSilos", () => {
  /** Write a page straight into a specific tenant's silo. */
  async function plant(tenant: string, slug: string, body: string): Promise<void> {
    await getStorage().writeFile(`tenants/${tenant}/wiki/${slug}.md`, body);
  }

  it("leaves a page that is already in the silo its index entry names", async () => {
    await writeWikiPage(
      "page-c",
      "---\nowner: carol\n---\n# Page C\n\nContent C.",
      undefined,
      undefined,
      "carol",
    );
    await updateIndex([{ slug: "page-c", title: "Page C", summary: "C" }]);
    await getStorage().putIndex("pages", {
      "page-c": { slug: "page-c", title: "Page C", summary: "C", owner: "carol" },
    });

    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.alreadyCurrent).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("relocates a page sitting under the wrong tenant", async () => {
    // The repair that matters: reads derive the location from the index entry's
    // owner, so a page under any other tenant is unreachable until it moves.
    const storage = getStorage();
    await plant("yopedia", "moved-page", "---\nowner: erin\n---\n# Moved\n\nBody.");
    await updateIndex([{ slug: "moved-page", title: "Moved", summary: "m" }]);
    await storage.putIndex("pages", {
      "moved-page": { slug: "moved-page", title: "Moved", summary: "m", owner: "erin" },
    });

    const result = await reconcileSilos();
    expect(result.synced).toBe(1);
    expect(result.errors).toEqual([]);
    expect(await storage.fileExists("tenants/erin/wiki/moved-page.md")).toBe(true);
    expect(await storage.readFile("tenants/erin/wiki/moved-page.md")).toContain("Body.");
    // The stale copy is gone — a page lives at exactly one path.
    expect(await storage.fileExists("tenants/yopedia/wiki/moved-page.md")).toBe(false);
  });

  it("reports a page that is indexed but present in no silo", async () => {
    await updateIndex([{ slug: "vanished", title: "Vanished", summary: "v" }]);
    await getStorage().putIndex("pages", {
      vanished: { slug: "vanished", title: "Vanished", summary: "v", owner: "alice" },
    });

    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("vanished");
  });

  it("resolves an ownerless page to DEFAULT_TENANT", async () => {
    await plant("yopedia", "orphan", "# Orphan\n\nNo owner frontmatter.");
    await updateIndex([{ slug: "orphan", title: "Orphan", summary: "No owner" }]);

    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.alreadyCurrent).toBe(1);
    expect(await getStorage().fileExists("tenants/yopedia/wiki/orphan.md")).toBe(true);
  });

  it("skips infrastructure slugs (index, log)", async () => {
    await plant("dan", "real-page", "---\nowner: dan\n---\n# Real\n\nContent.");
    await updateIndex([
      { slug: "index", title: "Index", summary: "Index" },
      { slug: "log", title: "Log", summary: "Log" },
      { slug: "real-page", title: "Real", summary: "Content" },
    ]);
    await getStorage().putIndex("pages", {
      "real-page": { slug: "real-page", title: "Real", summary: "Content", owner: "dan" },
    });

    const result = await reconcileSilos();
    expect(result.total).toBe(1); // only real-page counted
    expect(result.alreadyCurrent).toBe(1);
  });

  it("removes a stale duplicate left in a tenant the page no longer resolves to", async () => {
    // The page moved silos but a copy stayed behind. It is indexed, so the
    // ghost check alone would keep it — yet nothing can reach it, and it will
    // drift out of date.
    const storage = getStorage();
    await plant("erin", "dup-page", "---\nowner: erin\n---\n# Dup\n\nCurrent.");
    await plant("yopedia", "dup-page", "---\nowner: erin\n---\n# Dup\n\nStale copy.");
    await updateIndex([{ slug: "dup-page", title: "Dup", summary: "d" }]);
    await storage.putIndex("pages", {
      "dup-page": { slug: "dup-page", title: "Dup", summary: "d", owner: "erin" },
    });

    const result = await reconcileSilos();
    expect(result.alreadyCurrent).toBe(1);
    expect(result.removed).toBe(1);
    // The reachable copy survives untouched; the unreachable one is gone.
    expect(await storage.readFile("tenants/erin/wiki/dup-page.md")).toContain("Current.");
    expect(await storage.fileExists("tenants/yopedia/wiki/dup-page.md")).toBe(false);
  });

  it("removes ghost silo files that have no index entry", async () => {
    const storage = getStorage();
    await plant("alice", "real", "---\nowner: alice\n---\n# Real\n\nContent.");
    await updateIndex([{ slug: "real", title: "Real", summary: "Content" }]);
    await storage.putIndex("pages", {
      real: { slug: "real", title: "Real", summary: "Content", owner: "alice" },
    });

    // A ghost: silo file exists but NO index entry.
    await storage.writeFile("tenants/alice/wiki/ghost.md", "# Ghost");

    const result = await reconcileSilos();
    expect(result.removed).toBe(1);
    expect(await storage.fileExists("tenants/alice/wiki/ghost.md")).toBe(false);
    // Real page's silo is untouched.
    expect(await storage.fileExists("tenants/alice/wiki/real.md")).toBe(true);
  });
});
