import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  saveRevision,
  listRevisions,
  listRevisionAuthors,
  readRevision,
  readRevisionMeta,
  deleteRevisions,
  getRevisionsDir,
} from "../revisions";
import { writeWikiPage, ensureDirectories } from "../wiki";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "revisions-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
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

describe("saveRevision", () => {
  it("creates a timestamped file in the correct directory", async () => {
    await ensureDirectories();
    const content = "# Test\n\nOriginal content.";
    await saveRevision("test-page", content);

    const dir = getRevisionsDir("test-page");
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+\.md$/);

    // Verify the content was saved correctly.
    const saved = await fs.readFile(path.join(dir, files[0]), "utf-8");
    expect(saved).toBe(content);
  });
});

describe("listRevisions", () => {
  it("returns revisions newest-first", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("multi");
    await fs.mkdir(dir, { recursive: true });

    // Write revisions with known timestamps (older first).
    await fs.writeFile(path.join(dir, "1000000000000.md"), "v1", "utf-8");
    await fs.writeFile(path.join(dir, "2000000000000.md"), "v2", "utf-8");
    await fs.writeFile(path.join(dir, "3000000000000.md"), "v3", "utf-8");

    const revisions = await listRevisions("multi");
    expect(revisions).toHaveLength(3);
    // Newest first.
    expect(revisions[0].timestamp).toBe(3000000000000);
    expect(revisions[1].timestamp).toBe(2000000000000);
    expect(revisions[2].timestamp).toBe(1000000000000);

    // Check metadata shape.
    expect(revisions[0].slug).toBe("multi");
    expect(revisions[0].date).toBe(new Date(3000000000000).toISOString());
    expect(revisions[0].sizeBytes).toBe(Buffer.byteLength("v3", "utf-8"));
  });

  it("returns empty array for pages with no revisions", async () => {
    await ensureDirectories();
    const revisions = await listRevisions("no-history");
    expect(revisions).toEqual([]);
  });

  it("keeps no-sidecar revisions alongside sidecar ones (mixed), newest-first; skips non-revision entries", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("mixed");
    await fs.mkdir(dir, { recursive: true });
    // Three real revisions; only the MIDDLE one carries an author sidecar.
    await fs.writeFile(path.join(dir, "1000000000000.md"), "v1", "utf-8");
    await fs.writeFile(path.join(dir, "2000000000000.md"), "v2", "utf-8");
    await fs.writeFile(
      path.join(dir, "2000000000000.meta.json"),
      JSON.stringify({ author: "alice" }),
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "3000000000000.md"), "v3", "utf-8");
    // Entries that must be skipped, not counted (and not drop the real ones).
    await fs.writeFile(path.join(dir, "README.txt"), "ignore", "utf-8");
    await fs.writeFile(path.join(dir, "notanumber.md"), "ignore", "utf-8");

    const revisions = await listRevisions("mixed");
    // All three real revisions survive (the null-filter must not over-drop the
    // no-sidecar ones), newest-first; the invalid entries are excluded.
    expect(revisions.map((r) => r.timestamp)).toEqual([
      3000000000000, 2000000000000, 1000000000000,
    ]);
    // The sidecar author lands ONLY on the middle revision.
    expect(revisions[0].author).toBeUndefined();
    expect(revisions[1].author).toBe("alice");
    expect(revisions[2].author).toBeUndefined();
  });
});

describe("listRevisionAuthors", () => {
  it("caps to the newest `max` revisions (by filename timestamp), newest-first", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("capped");
    await fs.mkdir(dir, { recursive: true });
    // Five revisions; the cap must keep only the three newest, without reading
    // the older two at all (ranking is by filename, so this needs no content).
    for (const ts of [1, 2, 3, 4, 5]) {
      await fs.writeFile(path.join(dir, `${ts}000000000000.md`), `v${ts}`, "utf-8");
    }
    const revs = await listRevisionAuthors("capped", 3);
    expect(revs.map((r) => r.timestamp)).toEqual([
      5000000000000, 4000000000000, 3000000000000,
    ]);
    // Shape: timestamp + ISO date, no sizeBytes (the stat is intentionally skipped).
    expect(revs[0].date).toBe(new Date(5000000000000).toISOString());
    expect(revs[0]).not.toHaveProperty("sizeBytes");
  });

  it("ranks by NUMERIC timestamp, not lexicographically", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("numsort");
    await fs.mkdir(dir, { recursive: true });
    // 14-digit 1e13 is newer than 13-digit 9e12, but as STRINGS "10000000000000"
    // sorts BEFORE "9000000000000" — a lexicographic sort would pick the wrong
    // newest. cap=1 forces the ranking to decide the single winner.
    await fs.writeFile(path.join(dir, "9000000000000.md"), "older", "utf-8");
    await fs.writeFile(path.join(dir, "10000000000000.md"), "newer", "utf-8");
    const revs = await listRevisionAuthors("numsort", 1);
    expect(revs.map((r) => r.timestamp)).toEqual([10000000000000]);
  });

  it("returns [] for max <= 0 (reads no sidecars)", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("zerocap");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "1000000000000.md"), "v1", "utf-8");
    expect(await listRevisionAuthors("zerocap", 0)).toEqual([]);
  });

  it("reads author/reason from sidecars and leaves them undefined when absent", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("attrib");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "1000000000000.md"), "v1", "utf-8"); // no sidecar
    await fs.writeFile(path.join(dir, "2000000000000.md"), "v2", "utf-8");
    await fs.writeFile(
      path.join(dir, "2000000000000.meta.json"),
      JSON.stringify({ author: "alice", reason: "fix typo" }),
      "utf-8",
    );
    const revs = await listRevisionAuthors("attrib", 20);
    expect(revs[0]).toMatchObject({ timestamp: 2000000000000, author: "alice", reason: "fix typo" });
    expect(revs[1].author).toBeUndefined();
    expect(revs[1].reason).toBeUndefined();
  });

  it("returns empty for a page with no revisions, and skips non-revision entries", async () => {
    await ensureDirectories();
    expect(await listRevisionAuthors("none", 20)).toEqual([]);

    const dir = getRevisionsDir("noise");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "1000000000000.md"), "v1", "utf-8");
    await fs.writeFile(path.join(dir, "README.txt"), "ignore", "utf-8");
    await fs.writeFile(path.join(dir, "notanumber.md"), "ignore", "utf-8");
    const revs = await listRevisionAuthors("noise", 20);
    expect(revs.map((r) => r.timestamp)).toEqual([1000000000000]);
  });
});

describe("readRevision", () => {
  it("returns content for a valid timestamp", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("readable");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "1713150000000.md"), "hello revision", "utf-8");

    const content = await readRevision("readable", 1713150000000);
    expect(content).toBe("hello revision");
  });

  it("returns null for nonexistent timestamp", async () => {
    await ensureDirectories();
    const content = await readRevision("readable", 9999999999999);
    expect(content).toBeNull();
  });
});

describe("deleteRevisions", () => {
  it("removes the revision directory", async () => {
    await ensureDirectories();
    const dir = getRevisionsDir("deletable");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "1000000000000.md"), "v1", "utf-8");

    // Verify it exists first.
    const before = await fs.readdir(dir);
    expect(before).toHaveLength(1);

    await deleteRevisions("deletable");

    // The directory should be gone.
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it("does not throw when revisions directory does not exist", async () => {
    await ensureDirectories();
    // Should complete without error.
    await expect(deleteRevisions("nonexistent")).resolves.toBeUndefined();
  });
});

describe("writeWikiPage integration", () => {
  it("writing over an existing page creates a revision", async () => {
    await ensureDirectories();
    const originalContent = "# Page\n\nVersion 1.";
    await writeWikiPage("integrated", originalContent);

    // Now overwrite — this should snapshot v1.
    const updatedContent = "# Page\n\nVersion 2.";
    await writeWikiPage("integrated", updatedContent);

    const revisions = await listRevisions("integrated", "yopedia");
    expect(revisions).toHaveLength(1);

    // The revision should contain the original content (v1).
    const revContent = await readRevision("integrated", revisions[0].timestamp, "yopedia");
    expect(revContent).toBe(originalContent);

    // The current file should be v2 (now in the DEFAULT_TENANT silo).
    const current = await fs.readFile(
      path.join(tmpDir, "tenants", "yopedia", "wiki", "integrated.md"),
      "utf-8",
    );
    expect(current).toBe(updatedContent);
  });

  it("writing a new page does NOT create a revision", async () => {
    await ensureDirectories();
    await writeWikiPage("brand-new", "# Brand New\n\nFirst version.");

    const revisions = await listRevisions("brand-new", "yopedia");
    expect(revisions).toEqual([]);
  });

  it("multiple writes create multiple revisions", async () => {
    await ensureDirectories();
    await writeWikiPage("multi-edit", "# V1\n\nFirst.");
    await writeWikiPage("multi-edit", "# V2\n\nSecond.");
    await writeWikiPage("multi-edit", "# V3\n\nThird.");

    const revisions = await listRevisions("multi-edit", "yopedia");
    // Two overwrites → two revisions (v1 and v2 are snapshots).
    expect(revisions).toHaveLength(2);

    // Newest revision should be v2 (the one just before v3 was written).
    const newest = await readRevision("multi-edit", revisions[0].timestamp, "yopedia");
    expect(newest).toBe("# V2\n\nSecond.");

    // Oldest revision should be v1.
    const oldest = await readRevision("multi-edit", revisions[1].timestamp, "yopedia");
    expect(oldest).toBe("# V1\n\nFirst.");
  });
});

describe("author attribution", () => {
  it("saveRevision with author creates .meta.json sidecar", async () => {
    await ensureDirectories();
    const content = "# Authored\n\nSome content.";
    await saveRevision("authored-page", content, "yoyo");

    const dir = getRevisionsDir("authored-page");
    const files = await fs.readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));

    expect(mdFiles).toHaveLength(1);
    expect(metaFiles).toHaveLength(1);

    // The meta filename should match the md filename stem.
    const stem = mdFiles[0].slice(0, -3);
    expect(metaFiles[0]).toBe(`${stem}.meta.json`);

    // The sidecar should contain the author.
    const meta = JSON.parse(
      await fs.readFile(path.join(dir, metaFiles[0]), "utf-8"),
    );
    expect(meta).toEqual({ author: "yoyo" });
  });

  it("listRevisions returns author when sidecar exists", async () => {
    await ensureDirectories();
    await saveRevision("with-author", "# Page\n\nContent.", "alice");

    const revisions = await listRevisions("with-author");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].author).toBe("alice");
  });

  it("listRevisions returns undefined author when no sidecar (backward compat)", async () => {
    await ensureDirectories();
    // Save without author — no sidecar created.
    await saveRevision("no-author", "# Page\n\nContent.");

    const revisions = await listRevisions("no-author");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].author).toBeUndefined();
  });

  it("saveRevision without author does not create sidecar", async () => {
    await ensureDirectories();
    await saveRevision("no-meta", "# Page\n\nContent.");

    const dir = getRevisionsDir("no-meta");
    const files = await fs.readdir(dir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    expect(metaFiles).toHaveLength(0);
  });
});

describe("reason attribution", () => {
  it("saveRevision with author and reason writes both to sidecar", async () => {
    await ensureDirectories();
    const content = "# Reasoned\n\nSome content.";
    await saveRevision("reason-page", content, "yoyo", "fix typo in heading");

    const dir = getRevisionsDir("reason-page");
    const files = await fs.readdir(dir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    expect(metaFiles).toHaveLength(1);

    const meta = JSON.parse(
      await fs.readFile(path.join(dir, metaFiles[0]), "utf-8"),
    );
    expect(meta).toEqual({ author: "yoyo", reason: "fix typo in heading" });
  });

  it("listRevisions returns reason when sidecar contains it", async () => {
    await ensureDirectories();
    await saveRevision("with-reason", "# Page\n\nContent.", "alice", "added examples");

    const revisions = await listRevisions("with-reason");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].author).toBe("alice");
    expect(revisions[0].reason).toBe("added examples");
  });

  it("listRevisions returns undefined reason when sidecar has no reason (backward compat)", async () => {
    await ensureDirectories();
    // Save with author only — sidecar has author but no reason.
    await saveRevision("author-only", "# Page\n\nContent.", "bob");

    const revisions = await listRevisions("author-only");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].author).toBe("bob");
    expect(revisions[0].reason).toBeUndefined();
  });

  it("saveRevision with reason but no author writes only reason to sidecar", async () => {
    await ensureDirectories();
    await saveRevision("reason-no-author", "# Page\n\nContent.", undefined, "automated cleanup");

    const dir = getRevisionsDir("reason-no-author");
    const files = await fs.readdir(dir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    expect(metaFiles).toHaveLength(1);

    const meta = JSON.parse(
      await fs.readFile(path.join(dir, metaFiles[0]), "utf-8"),
    );
    expect(meta).toEqual({ reason: "automated cleanup" });

    const revisions = await listRevisions("reason-no-author");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].author).toBeUndefined();
    expect(revisions[0].reason).toBe("automated cleanup");
  });

  it("omitting both author and reason does not create sidecar", async () => {
    await ensureDirectories();
    await saveRevision("bare", "# Page\n\nContent.");

    const dir = getRevisionsDir("bare");
    const files = await fs.readdir(dir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    expect(metaFiles).toHaveLength(0);
  });
});

describe("readRevisionMeta", () => {
  it("returns author and reason when sidecar exists", async () => {
    await ensureDirectories();
    await saveRevision("meta-test", "# Page\n\nContent.", "alice", "initial draft");

    const revisions = await listRevisions("meta-test");
    expect(revisions).toHaveLength(1);
    const ts = revisions[0].timestamp;

    const meta = await readRevisionMeta("meta-test", ts);
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("alice");
    expect(meta!.reason).toBe("initial draft");
  });

  it("returns only author when reason is not present", async () => {
    await ensureDirectories();
    await saveRevision("meta-author-only", "# Page\n\nContent.", "bob");

    const revisions = await listRevisions("meta-author-only");
    const ts = revisions[0].timestamp;

    const meta = await readRevisionMeta("meta-author-only", ts);
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("bob");
    expect(meta!.reason).toBeUndefined();
  });

  it("returns only reason when author is not present", async () => {
    await ensureDirectories();
    await saveRevision("meta-reason-only", "# Page\n\nContent.", undefined, "cleanup");

    const revisions = await listRevisions("meta-reason-only");
    const ts = revisions[0].timestamp;

    const meta = await readRevisionMeta("meta-reason-only", ts);
    expect(meta).not.toBeNull();
    expect(meta!.author).toBeUndefined();
    expect(meta!.reason).toBe("cleanup");
  });

  it("returns null when no sidecar exists", async () => {
    await ensureDirectories();
    await saveRevision("meta-none", "# Page\n\nContent.");

    const revisions = await listRevisions("meta-none");
    const ts = revisions[0].timestamp;

    const meta = await readRevisionMeta("meta-none", ts);
    expect(meta).toBeNull();
  });

  it("returns null for nonexistent revision timestamp", async () => {
    await ensureDirectories();
    const meta = await readRevisionMeta("meta-none", 9999999999999);
    expect(meta).toBeNull();
  });

  it("throws for invalid slug", async () => {
    await expect(readRevisionMeta("BAD SLUG!", 123)).rejects.toThrow(/invalid slug/i);
  });
});

// ---------------------------------------------------------------------------
// Tenant-aware saveRevision
// ---------------------------------------------------------------------------
describe("saveRevision with tenant parameter", () => {
  it("writes revision to tenant silo path", async () => {
    await ensureDirectories();
    const storage = (await import("../storage")).getStorage();

    await saveRevision("silo-page", "# V1\n\nContent.", "yoyo", "initial", "alice");

    // Revision should exist in silo path
    const entries = await storage.listFiles("tenants/alice/wiki/.revisions/silo-page");
    const mdFiles = entries.filter((e: { name: string }) => e.name.endsWith(".md") && !e.name.endsWith(".meta.json"));
    expect(mdFiles.length).toBe(1);

    // Content should match
    const content = await storage.readFile(`tenants/alice/wiki/.revisions/silo-page/${mdFiles[0].name}`);
    expect(content).toBe("# V1\n\nContent.");

    // Meta sidecar should also be in silo
    const metaFiles = entries.filter((e: { name: string }) => e.name.endsWith(".meta.json"));
    expect(metaFiles.length).toBe(1);
    const meta = JSON.parse(await storage.readFile(`tenants/alice/wiki/.revisions/silo-page/${metaFiles[0].name}`));
    expect(meta.author).toBe("yoyo");
    expect(meta.reason).toBe("initial");

    // No flat revisions should exist
    const flatEntries = await storage.listFiles("wiki/.revisions/silo-page");
    expect(flatEntries.length).toBe(0);
  });

  it("writes revision to flat path when tenant is omitted (backward compat)", async () => {
    await ensureDirectories();
    const storage = (await import("../storage")).getStorage();

    await saveRevision("flat-page", "# V1\n\nContent.", "yoyo", "initial");

    // Revision should exist in flat path
    const entries = await storage.listFiles("wiki/.revisions/flat-page");
    const mdFiles = entries.filter((e: { name: string }) => e.name.endsWith(".md") && !e.name.endsWith(".meta.json"));
    expect(mdFiles.length).toBe(1);

    const content = await storage.readFile(`wiki/.revisions/flat-page/${mdFiles[0].name}`);
    expect(content).toBe("# V1\n\nContent.");
  });
});

// ---------------------------------------------------------------------------
// Tenant-aware listRevisions
// ---------------------------------------------------------------------------
describe("listRevisions with tenant parameter", () => {
  it("lists revisions from tenant silo path", async () => {
    await ensureDirectories();

    await saveRevision("tenant-list", "# V1", "yoyo", "first", "bob");
    await saveRevision("tenant-list", "# V2", "yoyo", "second", "bob");

    const revisions = await listRevisions("tenant-list", "bob");
    expect(revisions).toHaveLength(2);
    // Newest first
    expect(revisions[0].sizeBytes).toBe(Buffer.byteLength("# V2", "utf-8"));
    expect(revisions[1].sizeBytes).toBe(Buffer.byteLength("# V1", "utf-8"));
    expect(revisions[0].author).toBe("yoyo");
    expect(revisions[0].reason).toBe("second");
  });

  it("returns empty array when tenant has no revisions", async () => {
    await ensureDirectories();
    const revisions = await listRevisions("no-history", "bob");
    expect(revisions).toEqual([]);
  });

  it("does not see flat revisions when tenant is provided", async () => {
    await ensureDirectories();

    // Save to flat path (no tenant)
    await saveRevision("cross-check", "# Flat");
    // Save to tenant path
    await saveRevision("cross-check", "# Tenant", undefined, undefined, "carol");

    const flat = await listRevisions("cross-check");
    expect(flat).toHaveLength(1);

    const tenant = await listRevisions("cross-check", "carol");
    expect(tenant).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant-aware listRevisionAuthors
// ---------------------------------------------------------------------------
describe("listRevisionAuthors with tenant parameter", () => {
  it("lists revision authors from tenant silo path", async () => {
    await ensureDirectories();

    await saveRevision("tenant-authors", "# V1", "alice", "edit one", "dave");
    await saveRevision("tenant-authors", "# V2", "bob", "edit two", "dave");

    const authors = await listRevisionAuthors("tenant-authors", 10, "dave");
    expect(authors).toHaveLength(2);
    expect(authors[0].author).toBe("bob");
    expect(authors[1].author).toBe("alice");
  });

  it("returns empty array when tenant has no revisions", async () => {
    await ensureDirectories();
    const authors = await listRevisionAuthors("no-history", 10, "dave");
    expect(authors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenant-aware readRevision
// ---------------------------------------------------------------------------
describe("readRevision with tenant parameter", () => {
  it("reads revision content from tenant silo path", async () => {
    await ensureDirectories();

    await saveRevision("tenant-read", "# Silo content", undefined, undefined, "eve");

    const revisions = await listRevisions("tenant-read", "eve");
    expect(revisions).toHaveLength(1);

    const content = await readRevision("tenant-read", revisions[0].timestamp, "eve");
    expect(content).toBe("# Silo content");
  });

  it("returns null when revision does not exist in tenant", async () => {
    await ensureDirectories();
    const content = await readRevision("nonexistent", 9999999999999, "eve");
    expect(content).toBeNull();
  });

  it("does not read flat revision when tenant is provided", async () => {
    await ensureDirectories();

    await saveRevision("isolation-read", "# Flat content");
    const flatRevisions = await listRevisions("isolation-read");

    // Reading with a tenant should not find the flat revision
    const content = await readRevision("isolation-read", flatRevisions[0].timestamp, "eve");
    expect(content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tenant-aware readRevisionMeta
// ---------------------------------------------------------------------------
describe("readRevisionMeta with tenant parameter", () => {
  it("reads meta sidecar from tenant silo path", async () => {
    await ensureDirectories();

    await saveRevision("tenant-meta", "# Content", "yoyo", "silo reason", "frank");

    const revisions = await listRevisions("tenant-meta", "frank");
    expect(revisions).toHaveLength(1);

    const meta = await readRevisionMeta("tenant-meta", revisions[0].timestamp, "frank");
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("yoyo");
    expect(meta!.reason).toBe("silo reason");
  });

  it("returns null when no sidecar exists in tenant", async () => {
    await ensureDirectories();

    await saveRevision("tenant-meta-none", "# Content", undefined, undefined, "frank");

    const revisions = await listRevisions("tenant-meta-none", "frank");
    const meta = await readRevisionMeta("tenant-meta-none", revisions[0].timestamp, "frank");
    expect(meta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tenant-aware deleteRevisions
// ---------------------------------------------------------------------------
describe("deleteRevisions with tenant parameter", () => {
  it("deletes revisions from tenant silo path", async () => {
    await ensureDirectories();

    await saveRevision("tenant-del", "# V1", "yoyo", "edit", "grace");
    const before = await listRevisions("tenant-del", "grace");
    expect(before).toHaveLength(1);

    await deleteRevisions("tenant-del", "grace");

    const after = await listRevisions("tenant-del", "grace");
    expect(after).toEqual([]);
  });

  it("does not delete flat revisions when tenant is provided", async () => {
    await ensureDirectories();

    await saveRevision("tenant-del-iso", "# Flat");
    await saveRevision("tenant-del-iso", "# Silo", undefined, undefined, "grace");

    // Delete only tenant revisions
    await deleteRevisions("tenant-del-iso", "grace");

    // Flat revisions should still exist
    const flat = await listRevisions("tenant-del-iso");
    expect(flat).toHaveLength(1);

    // Tenant revisions should be gone
    const tenant = await listRevisions("tenant-del-iso", "grace");
    expect(tenant).toEqual([]);
  });

  it("handles nonexistent tenant revision directory gracefully", async () => {
    await ensureDirectories();
    // Should not throw
    await deleteRevisions("nonexistent", "grace");
  });
});
