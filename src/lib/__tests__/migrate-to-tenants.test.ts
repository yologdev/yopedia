import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { migrateToTenants, getRedirectMap } from "../migrate-to-tenants";
import { getCommonsIndex } from "../commons";
import { ensureDirectories, rawRelPath, wikiRelPath } from "../wiki";
import { createThread } from "../talk";
import { getStorage, _resetStorage } from "../storage";
import { saveRevision } from "../revisions";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
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

async function createPage(slug: string, frontmatter: string, title: string) {
  await ensureDirectories();
  // migrateToTenants reads the FLAT tree — that is its whole job — so plant the
  // source there directly. writeWikiPage now writes to a silo (#869).
  await getStorage().writeFile(
    wikiRelPath(`${slug}.md`),
    `---\n${frontmatter}\n---\n\n# ${title}\n\nBody of ${title}.`,
  );
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch {
    /* none */
  }
  const line = `- [${title}](${slug}.md) — ${title}`;
  await fs.writeFile(
    indexPath,
    existing ? `${existing.trimEnd()}\n${line}\n` : `# Wiki Index\n\n${line}\n`,
    "utf-8",
  );
}

const exists = async (rel: string) =>
  fs.access(path.join(tmpDir, rel)).then(() => true).catch(() => false);

async function seedThreePages() {
  await createPage("pub", "owner: alice\nvisibility: public", "Public");
  await createPage("priv", "owner: bob\nvisibility: private", "Private");
  await createPage("seed", "# no owner here", "Seed"); // ownerless
}

describe("migrateToTenants — dry run", () => {
  it("reports the plan without writing anything", async () => {
    await seedThreePages();
    const r = await migrateToTenants({ dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.totalPages).toBe(3);
    expect(r.tenants).toEqual({ alice: 1, bob: 1, yopedia: 1 });
    expect(r.redirectCount).toBe(3);
    expect(r.artifactsCopied).toBe(0);
    expect(r.errors).toEqual([]);

    // Nothing written to tenant folders, no redirect map persisted.
    expect(await exists("tenants/alice/wiki/pub.md")).toBe(false);
    expect(await getRedirectMap()).toEqual([]);
  });

  it("dry run is the default (must opt in to write)", async () => {
    await seedThreePages();
    const r = await migrateToTenants();
    expect(r.dryRun).toBe(true);
    expect(await exists("tenants/alice/wiki/pub.md")).toBe(false);
  });
});

describe("migrateToTenants — live", () => {
  it("copies pages into tenant silos, builds per-tenant indexes + commons + redirect map", async () => {
    await seedThreePages();
    const r = await migrateToTenants({ dryRun: false });

    expect(r.dryRun).toBe(false);
    expect(r.totalPages).toBe(3);
    expect(r.errors).toEqual([]);

    // Pages copied into their owner's silo (ownerless → yopedia).
    expect(await exists("tenants/alice/wiki/pub.md")).toBe(true);
    expect(await exists("tenants/bob/wiki/priv.md")).toBe(true);
    expect(await exists("tenants/yopedia/wiki/seed.md")).toBe(true);

    // Flat originals are untouched (copy, not move).
    expect(await exists("wiki/pub.md")).toBe(true);

    // Per-tenant index.md written.
    const aliceIndex = await fs.readFile(
      path.join(tmpDir, "tenants/alice/wiki/index.md"),
      "utf-8",
    );
    expect(aliceIndex).toContain("(pub.md)");

    // Commons holds the public pages (pub + the ownerless seed); the private
    // "priv" is excluded.
    const commons = await getCommonsIndex();
    expect(commons.map((e) => e.slug).sort()).toEqual(["pub", "seed"]);
    expect(commons.find((e) => e.slug === "pub")?.tenant).toBe("alice");
    expect(commons.find((e) => e.slug === "seed")?.tenant).toBe("yopedia");

    // Redirect map persisted, old → new.
    const map = await getRedirectMap();
    expect(map).toContainEqual({ from: "/wiki/pub", to: "/u/alice/pub" });
    expect(map).toContainEqual({ from: "/wiki/seed", to: "/u/yopedia/seed" });
  });

  it("is idempotent (re-running overwrites, same result)", async () => {
    await seedThreePages();
    await migrateToTenants({ dryRun: false });
    const r2 = await migrateToTenants({ dryRun: false });
    expect(r2.errors).toEqual([]);
    expect(await exists("tenants/alice/wiki/pub.md")).toBe(true);
  });

  it("normalizes the tenant from the owner handle (case-insensitive)", async () => {
    await createPage("p", "owner: Alice\nvisibility: public", "P");
    const r = await migrateToTenants({ dryRun: false });
    expect(r.tenants).toEqual({ alice: 1 });
    expect(await exists("tenants/alice/wiki/p.md")).toBe(true);
  });

  it("copies every per-page artifact (revisions, discuss, assets) into the silo", async () => {
    await createPage("doc", "owner: alice\nvisibility: public", "Doc");
    // Plant a FLAT revision (what a pre-migration edit left behind) plus the
    // updated page. saveRevision without a tenant targets the flat archive,
    // which is exactly the content this migration has to carry over.
    await saveRevision("doc", "---\nowner: alice\nvisibility: public\n---\n\n# Doc\n\nv1.");
    await getStorage().writeFile(
      wikiRelPath("doc.md"),
      "---\nowner: alice\nvisibility: public\n---\n\n# Doc\n\nv2.",
    );
    // A discussion thread + a binary asset.
    await createThread("doc", "Re: Doc", "alice", "first comment");
    await getStorage().writeAsset(
      rawRelPath("assets/doc/img.png"),
      new Uint8Array([1, 2, 3, 4]).buffer,
    );

    const r = await migrateToTenants({ dryRun: false });
    expect(r.errors).toEqual([]);

    // Revision snapshot, discuss thread, and asset all land in alice's silo.
    const revs = await fs.readdir(
      path.join(tmpDir, "tenants/alice/wiki/.revisions/doc"),
    );
    expect(revs.length).toBeGreaterThan(0);
    expect(await exists("tenants/alice/discuss/doc.json")).toBe(true);
    expect(await exists("tenants/alice/raw/assets/doc/img.png")).toBe(true);
  });
});
