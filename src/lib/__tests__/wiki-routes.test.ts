import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "test-user", handle: "test-user" })),
  // The write routes resolve a service principal as a fallback; default to none.
  getServicePrincipal: vi.fn(() => null),
}));

import {
  ensureDirectories,
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
} from "../wiki";
import type { Frontmatter } from "../frontmatter";
import { getPrincipal } from "@/lib/auth";

const mockedGetPrincipal = vi.mocked(getPrincipal);

// ---------------------------------------------------------------------------
// Temp directory setup — mirrors lifecycle.test.ts approach
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-routes-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  await ensureDirectories();
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
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /api/wiki — manual page creation metadata
// ---------------------------------------------------------------------------

describe("POST /api/wiki — yopedia metadata", () => {
  // We import the route handler lazily so env vars are set first
  async function callPost(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/wiki/route");
    const req = new Request("http://localhost:3000/api/wiki", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("sets default yopedia frontmatter on new page", async () => {
    const res = await callPost({
      slug: "test-meta",
      content: "# Test Meta\n\nSome content.",
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("test-meta");
    expect(page).not.toBeNull();
    const fm = page!.frontmatter;

    const today = new Date().toISOString().slice(0, 10);

    // Core yopedia fields
    expect(fm.title).toBe("Test Meta");
    expect(fm.confidence).toBe(0.5);
    // Author/owner come from the authenticated session (mocked test-user).
    expect(fm.authors).toEqual(["test-user"]);
    expect(fm.owner).toBe("test-user");
    expect(fm.visibility).toBe("public");
    expect(fm.contributors).toEqual([]);
    expect(fm.sources).toEqual([]);

    // Date fields
    expect(fm.created).toBe(today);
    expect(fm.updated).toBe(today);
    expect(fm.valid_from).toBe(today);

    // Schema defaults
    expect(fm.disputed).toBe(false);
    expect(fm.aliases).toEqual([]);
    expect(fm.tags).toEqual([]);

    // expiry should be ~90 days from now (YYYY-MM-DD format)
    expect(typeof fm.expiry).toBe("string");
    const expiryStr = fm.expiry as string;
    expect(expiryStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Verify expiry is in the future
    expect(new Date(expiryStr).getTime()).toBeGreaterThan(Date.now());
  });

  it("sets default expiry to ~90 days from creation date", async () => {
    const res = await callPost({
      slug: "expiry-check",
      content: "# Expiry Check\n\nVerify 90-day default.",
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("expiry-check");
    expect(page).not.toBeNull();
    const fm = page!.frontmatter;

    const expiryStr = fm.expiry as string;
    const expiryMs = new Date(expiryStr).getTime();
    const nowMs = Date.now();
    const diffDays = (expiryMs - nowMs) / (1000 * 60 * 60 * 24);

    // Should be ~90 days (allow ±1 day for test execution time)
    expect(diffDays).toBeGreaterThanOrEqual(89);
    expect(diffDays).toBeLessThanOrEqual(91);
  });

  it("attributes the authenticated principal, ignoring any client-supplied author", async () => {
    const res = await callPost({
      slug: "authored-page",
      content: "# Authored\n\nBy someone.",
      author: "alice", // spoof attempt — must be ignored in favor of the session
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("authored-page");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.authors).toEqual(["test-user"]);
    expect(page!.frontmatter.owner).toBe("test-user");
  });

  it("ignores a client-supplied empty author and uses the session principal", async () => {
    const res = await callPost({
      slug: "empty-author",
      content: "# Empty Author\n\nContent.",
      author: "   ",
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("empty-author");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.authors).toEqual(["test-user"]);
  });

  it("accepts optional tags from request body", async () => {
    const res = await callPost({
      slug: "tagged-page",
      content: "# Tagged Page\n\nContent with tags.",
      tags: ["rust", "agent"],
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("tagged-page");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.tags).toEqual(["rust", "agent"]);
  });

  it("ignores non-string-array tags and defaults to empty", async () => {
    const res = await callPost({
      slug: "bad-tags",
      content: "# Bad Tags\n\nContent.",
      tags: [1, 2, 3],
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("bad-tags");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.tags).toEqual([]);
  });

  it("pages created via POST do not trigger unmigrated-page lint", async () => {
    await callPost({
      slug: "lint-safe",
      content: "# Lint Safe\n\nShould pass lint.",
    });

    const page = await readWikiPageWithFrontmatter("lint-safe");
    expect(page).not.toBeNull();
    const fm = page!.frontmatter;

    // The unmigrated-page check flags pages missing ALL THREE of these
    const hasConfidence = "confidence" in fm;
    const hasAuthors = "authors" in fm;
    const hasExpiry = "expiry" in fm;
    expect(hasConfidence).toBe(true);
    expect(hasAuthors).toBe(true);
    expect(hasExpiry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/wiki/[slug] — edit metadata tracking
// ---------------------------------------------------------------------------

describe("PUT /api/wiki/[slug] — contributors and updated", () => {
  async function callPut(slug: string, body: Record<string, unknown>) {
    const mod = await import("@/app/api/wiki/[slug]/route");
    const req = new Request(`http://localhost:3000/api/wiki/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return mod.PUT(req, { params: Promise.resolve({ slug }) });
  }

  /** Create a page with full yopedia metadata so PUT has something to edit.
   *  Defaults to a private page owned by "test-user" so the mocked principal
   *  (test-user) can body-write it — commons pages block human body writes. */
  async function seedPage(slug: string, fm: Frontmatter = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const defaults: Frontmatter = {
      created: today,
      confidence: 0.5,
      authors: ["original-author"],
      owner: "test-user",
      visibility: "private",
      contributors: [],
      expiry: "2099-01-01",
      sources: [],
      ...fm,
    };
    const content = serializeFrontmatter(defaults, `# ${slug}\n\nOriginal content.`);
    await writeWikiPageWithSideEffects({
      slug,
      title: slug,
      content,
      summary: "A test page",
      logOp: "ingest",
      crossRefSource: null,
    });
  }

  it("sets updated timestamp on edit", async () => {
    await seedPage("edit-test");

    const res = await callPut("edit-test", {
      content: "# Edit Test\n\nUpdated content.",
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("edit-test");
    expect(page).not.toBeNull();
    const fm = page!.frontmatter;

    const today = new Date().toISOString().slice(0, 10);
    expect(fm.updated).toBe(today);
  });

  it("appends the authenticated editor to contributors on edit", async () => {
    await seedPage("contrib-test");

    const res = await callPut("contrib-test", {
      content: "# Contrib Test\n\nEdited.",
      author: "editor-bob", // ignored — session principal is used
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("contrib-test");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.contributors).toEqual(["test-user"]);
  });

  it("does not duplicate contributors on repeated edits", async () => {
    await seedPage("no-dup-test");

    // First edit
    await callPut("no-dup-test", {
      content: "# No Dup Test\n\nFirst edit.",
    });

    // Second edit by the same (session) person
    const res = await callPut("no-dup-test", {
      content: "# No Dup Test\n\nSecond edit.",
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("no-dup-test");
    expect(page).not.toBeNull();

    const contributors = page!.frontmatter.contributors as string[];
    expect(contributors.filter((c) => c === "test-user")).toHaveLength(1);
  });

  it("preserves existing contributors when adding new one", async () => {
    await seedPage("multi-contrib", { contributors: ["first-editor"] });

    const res = await callPut("multi-contrib", {
      content: "# Multi Contrib\n\nAnother edit.",
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("multi-contrib");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.contributors).toEqual([
      "first-editor",
      "test-user",
    ]);
  });

  it("preserves existing frontmatter fields on edit", async () => {
    await seedPage("preserve-test", {
      confidence: 0.8,
      authors: ["original"],
      expiry: "2099-06-15",
    });

    const res = await callPut("preserve-test", {
      content: "# Preserve Test\n\nNew content.",
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("preserve-test");
    expect(page).not.toBeNull();
    const fm = page!.frontmatter;

    // Original fields should be preserved
    expect(fm.confidence).toBe(0.8);
    expect(fm.authors).toEqual(["original"]);
    expect(fm.expiry).toBe("2099-06-15");
  });

  it("adds the authenticated editor to contributors (writes are always authed)", async () => {
    await seedPage("no-author-edit", { contributors: ["existing"] });

    const res = await callPut("no-author-edit", {
      content: "# No Author Edit\n\nEdited by the signed-in user.",
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("no-author-edit");
    expect(page).not.toBeNull();
    // Writes require auth, so the session principal is appended.
    expect(page!.frontmatter.contributors).toEqual(["existing", "test-user"]);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/wiki/[slug] — frontmatter-only metadata updates
// ---------------------------------------------------------------------------

describe("PATCH /api/wiki/[slug] — metadata updates", () => {
  async function callPatch(slug: string, body: Record<string, unknown>) {
    const mod = await import("@/app/api/wiki/[slug]/route");
    const req = new Request(`http://localhost:3000/api/wiki/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return mod.PATCH(req, { params: Promise.resolve({ slug }) });
  }

  /** Create a page with full yopedia metadata so PATCH has something to edit. */
  async function seedPage(slug: string, fm: Frontmatter = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const defaults: Frontmatter = {
      created: today,
      confidence: 0.5,
      authors: ["original-author"],
      contributors: [],
      expiry: "2099-01-01",
      sources: [],
      ...fm,
    };
    const content = serializeFrontmatter(defaults, `# ${slug}\n\nOriginal content.`);
    await writeWikiPageWithSideEffects({
      slug,
      title: slug,
      content,
      summary: "A test page",
      logOp: "ingest",
      crossRefSource: null,
    });
  }

  it("updates confidence without changing body", async () => {
    await seedPage("patch-conf");

    const res = await callPatch("patch-conf", {
      metadata: { confidence: 0.9 },
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("patch-conf");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.confidence).toBe(0.9);
    // Body should be unchanged
    expect(page!.body).toContain("Original content.");
    // Other metadata preserved
    expect(page!.frontmatter.authors).toEqual(["original-author"]);
    expect(page!.frontmatter.expiry).toBe("2099-01-01");
  });

  it("adds tags to existing page", async () => {
    await seedPage("patch-tags");

    const res = await callPatch("patch-tags", {
      metadata: { tags: ["rust"] },
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("patch-tags");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.tags).toEqual(["rust"]);
  });

  it("bumps updated timestamp on metadata change", async () => {
    await seedPage("patch-updated");

    const res = await callPatch("patch-updated", {
      metadata: { disputed: true },
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("patch-updated");
    expect(page).not.toBeNull();
    const today = new Date().toISOString().slice(0, 10);
    expect(page!.frontmatter.updated).toBe(today);
  });

  it("rejects lifecycle-managed field: created", async () => {
    await seedPage("patch-reject-created");

    const res = await callPatch("patch-reject-created", {
      metadata: { created: "2020-01-01" },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("created");
  });

  it("rejects lifecycle-managed field: sources", async () => {
    await seedPage("patch-reject-sources");

    const res = await callPatch("patch-reject-sources", {
      metadata: { sources: ["http://example.com"] },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("sources");
  });

  it("rejects lifecycle-managed field: authors", async () => {
    await seedPage("patch-reject-authors");

    const res = await callPatch("patch-reject-authors", {
      metadata: { authors: ["hacker"] },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("authors");
  });

  it("returns 404 for missing page", async () => {
    const res = await callPatch("nonexistent-page-xyz", {
      metadata: { confidence: 0.9 },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when metadata is missing", async () => {
    await seedPage("patch-no-meta");

    const res = await callPatch("patch-no-meta", { foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when metadata is not an object", async () => {
    await seedPage("patch-bad-meta");

    const res = await callPatch("patch-bad-meta", { metadata: "not-object" });
    expect(res.status).toBe(400);
  });

  it("appends author to contributors", async () => {
    await seedPage("patch-contrib", { contributors: ["alice"] });

    const res = await callPatch("patch-contrib", {
      metadata: { confidence: 0.8 },
      author: "bob", // ignored — session principal is used
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("patch-contrib");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.contributors).toEqual(["alice", "test-user"]);
  });

  it("updates multiple metadata fields at once", async () => {
    await seedPage("patch-multi");

    const res = await callPatch("patch-multi", {
      metadata: {
        confidence: 0.95,
        disputed: true,
        aliases: ["multi-alias"],
        supersedes: "old-page",
      },
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("patch-multi");
    expect(page).not.toBeNull();
    const fm = page!.frontmatter;
    expect(fm.confidence).toBe(0.95);
    expect(fm.disputed).toBe(true);
    expect(fm.aliases).toEqual(["multi-alias"]);
    expect(fm.supersedes).toBe("old-page");
  });

  it("clears a field when null is sent", async () => {
    await seedPage("patch-clear", {
      confidence: 0.7,
      expiry: "2099-06-01",
      supersedes: "old-slug",
    });

    const res = await callPatch("patch-clear", {
      metadata: { confidence: null, expiry: null, supersedes: null },
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("patch-clear");
    expect(page).not.toBeNull();
    // null values should remove the key from frontmatter
    expect(page!.frontmatter.confidence).toBeUndefined();
    expect(page!.frontmatter.expiry).toBeUndefined();
    expect(page!.frontmatter.supersedes).toBeUndefined();
    // Other fields preserved
    expect(page!.frontmatter.authors).toEqual(["original-author"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wiki — agent-identity filtering
// ---------------------------------------------------------------------------

describe("realm-aware write ACL — /api/wiki/[slug]", () => {
  async function seed(slug: string, fm: Frontmatter) {
    const today = new Date().toISOString().slice(0, 10);
    const full: Frontmatter = {
      created: today,
      confidence: 0.5,
      authors: [typeof fm.owner === "string" ? fm.owner : "system"],
      contributors: [],
      expiry: "2099-01-01",
      sources: [],
      ...fm,
    };
    await writeWikiPageWithSideEffects({
      slug,
      title: slug,
      content: serializeFrontmatter(full, `# ${slug}\n\nOriginal secret.`),
      summary: "a test page",
      logOp: "ingest",
      crossRefSource: null,
    });
  }
  async function put(slug: string) {
    const { PUT } = await import("@/app/api/wiki/[slug]/route");
    return PUT(
      new Request(`http://localhost/api/wiki/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `# ${slug}\n\nEdited.` }),
      }),
      { params: Promise.resolve({ slug }) },
    );
  }
  async function del(slug: string) {
    const { DELETE } = await import("@/app/api/wiki/[slug]/route");
    return DELETE(
      new Request(`http://localhost/api/wiki/${slug}`, { method: "DELETE" }),
      { params: Promise.resolve({ slug }) },
    );
  }
  async function patch(slug: string) {
    const { PATCH } = await import("@/app/api/wiki/[slug]/route");
    return PATCH(
      new Request(`http://localhost/api/wiki/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { confidence: 0.9 } }),
      }),
      { params: Promise.resolve({ slug }) },
    );
  }

  it("cloaks a non-owner editing a private page (PUT 404, no oracle); body unchanged", async () => {
    await seed("alice-secret", { owner: "alice", visibility: "private" });
    // Default mock principal is "test-user" — not the owner. A private page they
    // can't read is 404 (indistinguishable from missing), not a 403 oracle.
    const res = await put("alice-secret");
    expect(res.status).toBe(404);
    const page = await readWikiPageWithFrontmatter("alice-secret");
    expect(page!.body).toContain("Original secret.");
  });

  it("cloaks a non-owner deleting a private page (DELETE 404)", async () => {
    await seed("alice-secret-del", { owner: "alice", visibility: "private" });
    const res = await del("alice-secret-del");
    expect(res.status).toBe(404);
    expect(await readWikiPageWithFrontmatter("alice-secret-del")).not.toBeNull();
  });

  it("cloaks a non-owner patching a private page's metadata (PATCH 404)", async () => {
    await seed("alice-secret-patch", { owner: "alice", visibility: "private" });
    const res = await patch("alice-secret-patch");
    expect(res.status).toBe(404);
  });

  it("allows the owner to edit their own private page (PUT 200)", async () => {
    await seed("alice-own", { owner: "alice", visibility: "private" });
    mockedGetPrincipal.mockResolvedValueOnce({ id: "u_alice", handle: "alice" });
    const res = await put("alice-own");
    expect(res.status).toBe(200);
  });

  it("allows a private agent-owned page to be edited by the agent's human owner", async () => {
    await seed("alice-agent-note", { owner: "alice--yoyo", visibility: "private" });
    mockedGetPrincipal.mockResolvedValueOnce({ id: "u_alice", handle: "alice" });
    const res = await put("alice-agent-note");
    expect(res.status).toBe(200);
  });

  it("blocks body writes by a human on a PUBLIC commons page (PUT 403)", async () => {
    // A public commons page's prose is maintained by agents; humans steer via
    // metadata patches and talk threads. Body writes → 403.
    await seed("shared-public", { owner: "alice", visibility: "public" });
    const res = await put("shared-public"); // principal = test-user (non-owner)
    expect(res.status).toBe(403);
  });

  it("blocks deletion by a human on a PUBLIC commons page (DELETE 403)", async () => {
    await seed("shared-public-del", { owner: "alice", visibility: "public" });
    const res = await del("shared-public-del");
    expect(res.status).toBe(403);
    // Page should still exist.
    expect(await readWikiPageWithFrontmatter("shared-public-del")).not.toBeNull();
  });

  it("keeps PUBLIC commons pages collectively patchable by any signed-in user (PATCH 200)", async () => {
    // Metadata patches remain allowed on commons pages — only body/delete are gated.
    await seed("shared-public-patch", { owner: "alice", visibility: "public" });
    const res = await patch("shared-public-patch");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/wiki — agent-identity filtering", () => {
  async function seedPage(slug: string, fm: Frontmatter = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const defaults: Frontmatter = {
      created: today,
      confidence: 0.5,
      authors: ["test-user"],
      contributors: [],
      expiry: "2099-01-01",
      sources: [],
      ...fm,
    };
    const content = serializeFrontmatter(defaults, `# ${slug}\n\nSome content.`);
    await writeWikiPageWithSideEffects({
      slug,
      title: slug,
      content,
      summary: `Summary of ${slug}`,
      logOp: "ingest",
      crossRefSource: null,
    });
  }

  async function callGet(params = "") {
    const { GET } = await import("@/app/api/wiki/route");
    const req = new Request(`http://localhost:3000/api/wiki${params}`);
    return GET(req);
  }

  it("excludes agent-identity pages from default response", async () => {
    await seedPage("human-page");
    await seedPage("agent-page", { type: "agent-identity" });

    const res = await callGet();
    expect(res.status).toBe(200);

    const data = await res.json();
    const slugs = data.pages.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("human-page");
    expect(slugs).not.toContain("agent-page");
  });

  it("includes agent-identity pages when includeAgentPages=true", async () => {
    await seedPage("human-page-b");
    await seedPage("agent-page-b", { type: "agent-identity" });

    const res = await callGet("?includeAgentPages=true");
    expect(res.status).toBe(200);

    const data = await res.json();
    const slugs = data.pages.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("human-page-b");
    expect(slugs).toContain("agent-page-b");
  });

  it("enriches type field in index entries", async () => {
    await seedPage("typed-page", { type: "agent-identity" });

    const res = await callGet("?includeAgentPages=true");
    expect(res.status).toBe(200);

    const data = await res.json();
    const typed = data.pages.find(
      (p: { slug: string }) => p.slug === "typed-page",
    );
    expect(typed).toBeDefined();
    expect(typed.type).toBe("agent-identity");
  });

  it("does not add type field for normal pages", async () => {
    await seedPage("normal-page");

    const res = await callGet();
    expect(res.status).toBe(200);

    const data = await res.json();
    const normal = data.pages.find(
      (p: { slug: string }) => p.slug === "normal-page",
    );
    expect(normal).toBeDefined();
    expect(normal.type).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Realm-aware ACL — discussion routes + revision revert
// ---------------------------------------------------------------------------

describe("realm-aware ACL — discussion and revision-revert routes", () => {
  async function seed(slug: string, fm: Frontmatter) {
    const today = new Date().toISOString().slice(0, 10);
    const full: Frontmatter = {
      created: today,
      confidence: 0.5,
      authors: [typeof fm.owner === "string" ? fm.owner : "system"],
      contributors: [],
      expiry: "2099-01-01",
      sources: [],
      ...fm,
    };
    await writeWikiPageWithSideEffects({
      slug,
      title: slug,
      content: serializeFrontmatter(full, `# ${slug}\n\nOriginal secret.`),
      summary: "a test page",
      logOp: "ingest",
      crossRefSource: null,
    });
  }

  // --- Discussion: create thread ---

  async function postDiscuss(slug: string) {
    const { POST } = await import("@/app/api/wiki/[slug]/discuss/route");
    return POST(
      new Request(`http://localhost/api/wiki/${slug}/discuss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Question", body: "Is this right?" }),
      }),
      { params: Promise.resolve({ slug }) },
    );
  }

  it("cloaks a non-owner creating a discussion on a private page (POST discuss 404)", async () => {
    await seed("alice-priv-disc", { owner: "alice", visibility: "private" });
    const res = await postDiscuss("alice-priv-disc");
    expect(res.status).toBe(404);
  });

  it("allows the owner to create a discussion on their private page", async () => {
    await seed("alice-own-disc", { owner: "alice", visibility: "private" });
    mockedGetPrincipal.mockResolvedValueOnce({ id: "u_alice", handle: "alice" });
    const res = await postDiscuss("alice-own-disc");
    expect(res.status).toBe(201);
  });

  it("allows any signed-in user to create a discussion on a public page", async () => {
    await seed("pub-disc", { owner: "alice", visibility: "public" });
    const res = await postDiscuss("pub-disc");
    expect(res.status).toBe(201);
  });

  // --- Discussion: resolve/reopen thread ---

  async function patchDiscuss(slug: string) {
    const { PATCH } = await import(
      "@/app/api/wiki/[slug]/discuss/[threadIndex]/route"
    );
    return PATCH(
      new Request(`http://localhost/api/wiki/${slug}/discuss/0`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      }),
      { params: Promise.resolve({ slug, threadIndex: "0" }) },
    );
  }

  it("cloaks a non-owner resolving a discussion on a private page (PATCH discuss 404)", async () => {
    await seed("alice-priv-resolve", { owner: "alice", visibility: "private" });
    const res = await patchDiscuss("alice-priv-resolve");
    expect(res.status).toBe(404);
  });

  // --- Discussion: add comment ---

  async function postComment(slug: string) {
    const { POST } = await import(
      "@/app/api/wiki/[slug]/discuss/[threadIndex]/comments/route"
    );
    return POST(
      new Request(`http://localhost/api/wiki/${slug}/discuss/0/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Nice page!" }),
      }),
      { params: Promise.resolve({ slug, threadIndex: "0" }) },
    );
  }

  it("cloaks a non-owner commenting on a private page (POST comment 404)", async () => {
    await seed("alice-priv-comment", { owner: "alice", visibility: "private" });
    const res = await postComment("alice-priv-comment");
    expect(res.status).toBe(404);
  });

  // --- Revision revert ---

  async function postRevert(slug: string, timestamp = 1000000) {
    const { POST } = await import("@/app/api/wiki/[slug]/revisions/route");
    return POST(
      new Request(`http://localhost/api/wiki/${slug}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revert", timestamp }),
      }),
      { params: Promise.resolve({ slug }) },
    );
  }

  it("cloaks a non-owner reverting a private page (POST revert 404)", async () => {
    await seed("alice-priv-revert", { owner: "alice", visibility: "private" });
    const res = await postRevert("alice-priv-revert");
    expect(res.status).toBe(404);
  });

  it("allows the owner to revert their own private page", async () => {
    await seed("alice-own-revert", { owner: "alice", visibility: "private" });
    // Create a revision so the revert has something to restore.
    const { saveRevision } = await import("@/lib/revisions");
    await saveRevision("alice-own-revert", "# alice-own-revert\n\nOld content.", undefined, undefined, "alice");
    const { listRevisions } = await import("@/lib/revisions");
    const revs = await listRevisions("alice-own-revert", "alice");
    expect(revs.length).toBeGreaterThan(0);

    mockedGetPrincipal.mockResolvedValueOnce({ id: "u_alice", handle: "alice" });
    const res = await postRevert("alice-own-revert", revs[0].timestamp);
    expect(res.status).toBe(200);
  });

  it("allows a service principal to revert a private page", async () => {
    await seed("svc-priv-revert", { owner: "alice", visibility: "private" });
    const { saveRevision } = await import("@/lib/revisions");
    await saveRevision("svc-priv-revert", "# svc-priv-revert\n\nOld content.", undefined, undefined, "alice");
    const { listRevisions } = await import("@/lib/revisions");
    const revs = await listRevisions("svc-priv-revert", "alice");
    expect(revs.length).toBeGreaterThan(0);

    // Simulate a service principal — getPrincipal returns null, but
    // getServicePrincipal returns the trusted automated caller.
    mockedGetPrincipal.mockResolvedValueOnce(null);
    const { getServicePrincipal } = await import("@/lib/auth");
    const mockedGetService = vi.mocked(getServicePrincipal);
    mockedGetService.mockReturnValueOnce({ id: "service:alice", handle: "alice" });

    const res = await postRevert("svc-priv-revert", revs[0].timestamp);
    expect(res.status).toBe(200);
  });

  it("blocks human revert on a PUBLIC commons page (POST revert 403)", async () => {
    // Reverts replace the body — same realm gate as PUT.
    await seed("pub-revert", { owner: "alice", visibility: "public" });
    const { saveRevision } = await import("@/lib/revisions");
    await saveRevision("pub-revert", "# pub-revert\n\nOld content.", undefined, undefined, "alice");
    const { listRevisions } = await import("@/lib/revisions");
    const revs = await listRevisions("pub-revert", "alice");
    expect(revs.length).toBeGreaterThan(0);

    const res = await postRevert("pub-revert", revs[0].timestamp);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Service-token auth — PATCH /api/wiki/[slug] and POST /api/wiki
// ---------------------------------------------------------------------------

describe("PATCH /api/wiki/[slug] — service-token auth", () => {
  async function callPatch(slug: string, body: Record<string, unknown>) {
    const mod = await import("@/app/api/wiki/[slug]/route");
    const req = new Request(`http://localhost:3000/api/wiki/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return mod.PATCH(req, { params: Promise.resolve({ slug }) });
  }

  async function seedPage(slug: string, fm: Frontmatter = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const defaults: Frontmatter = {
      created: today,
      confidence: 0.5,
      authors: ["original-author"],
      owner: "svc-user",
      contributors: [],
      expiry: "2099-01-01",
      sources: [],
      ...fm,
    };
    const content = serializeFrontmatter(defaults, `# ${slug}\n\nOriginal content.`);
    await writeWikiPageWithSideEffects({
      slug,
      title: slug,
      content,
      summary: "A test page",
      logOp: "ingest",
      crossRefSource: null,
    });
  }

  it("allows a service principal to PATCH metadata when Clerk session is absent", async () => {
    await seedPage("svc-patch-test");

    // Simulate service-token caller: no Clerk session, but valid service token.
    mockedGetPrincipal.mockResolvedValueOnce(null);
    const { getServicePrincipal } = await import("@/lib/auth");
    const mockedGetService = vi.mocked(getServicePrincipal);
    mockedGetService.mockReturnValueOnce({ id: "service:svc-user", handle: "svc-user" });

    const res = await callPatch("svc-patch-test", {
      metadata: { confidence: 0.9 },
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("svc-patch-test");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.confidence).toBe(0.9);
  });

  it("still works with a normal Clerk session (no service token needed)", async () => {
    await seedPage("clerk-patch-test");

    // Default mock returns test-user via getPrincipal — no service token.
    const res = await callPatch("clerk-patch-test", {
      metadata: { tags: ["test-tag"] },
    });
    expect(res.status).toBe(200);

    const page = await readWikiPageWithFrontmatter("clerk-patch-test");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.tags).toContain("test-tag");
  });
});

describe("POST /api/wiki — service-token auth", () => {
  async function callPost(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/wiki/route");
    const req = new Request("http://localhost:3000/api/wiki", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("allows a service principal to create a page when Clerk session is absent", async () => {
    // Simulate service-token caller: no Clerk session, but valid service token.
    mockedGetPrincipal.mockResolvedValueOnce(null);
    const { getServicePrincipal } = await import("@/lib/auth");
    const mockedGetService = vi.mocked(getServicePrincipal);
    mockedGetService.mockReturnValueOnce({ id: "service:bot", handle: "bot" });

    const res = await callPost({
      slug: "svc-created-page",
      content: "# SVC Created\n\nAgent-created page.",
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("svc-created-page");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.owner).toBe("bot");
    expect(page!.frontmatter.authors).toEqual(["bot"]);
  });

  it("returns 401 when neither Clerk session nor service token is present", async () => {
    mockedGetPrincipal.mockResolvedValueOnce(null);
    // getServicePrincipal default mock already returns null

    const res = await callPost({
      slug: "no-auth-page",
      content: "# No Auth\n\nShould fail.",
    });
    expect(res.status).toBe(401);
  });

  it("still works with a normal Clerk session (no service token needed)", async () => {
    // Default mock returns test-user via getPrincipal.
    const res = await callPost({
      slug: "clerk-created-page",
      content: "# Clerk Created\n\nUser-created page.",
    });
    expect(res.status).toBe(201);

    const page = await readWikiPageWithFrontmatter("clerk-created-page");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.owner).toBe("test-user");
  });
});
