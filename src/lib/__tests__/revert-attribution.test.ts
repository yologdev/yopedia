/**
 * Tests that the POST /api/wiki/[slug]/revisions revert route correctly passes
 * the authenticated principal's handle as `author` through the write pipeline.
 *
 * Covers issue #500:
 * - Revision sidecar carries the reverter's handle
 * - Service principal fallback works for service-token reverts
 * - Contributor index reflects the reverter's edit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Mock auth before any imports that transitively pull it in
// ---------------------------------------------------------------------------
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "user-1", handle: "alice" })),
  getServicePrincipal: vi.fn(() => null),
}));

import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { listRevisions, readRevisionMeta } from "../revisions";
import {
  getContributorIndex,
  rebuildContributorIndex,
} from "../contributor-index";
import { _resetStorage } from "../storage";
import { _resetLocks } from "../lock";
import { serializeFrontmatter } from "../frontmatter";

const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedGetServicePrincipal = vi.mocked(getServicePrincipal);

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------
let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "revert-attr-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  await ensureDirectories();

  // Reset mocks to defaults
  mockedGetPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedGetServicePrincipal.mockReturnValue(null);
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a page with frontmatter so the revert route can read it.
 *  Defaults to private so the mocked owner can body-write (commons pages
 *  block human body writes after the realm gate).
 *  Writes to flat path (for readWikiPage fallback) and also to the tenant
 *  silo (so overwrites create revisions in the tenant path). */
async function seedPage(slug: string, body: string, owner = "alice") {
  const fm = { title: slug, created: "2025-01-01", updated: "2025-01-01", owner, visibility: "private" };
  const content = serializeFrontmatter(fm, body);
  // Write flat (so readWikiPage can find it without a page index).
  await writeWikiPage(slug, content);
  // Write silo (so subsequent overwrites with tenant create revisions there).
  await writeWikiPage(slug, content, undefined, undefined, owner);
}

/** Call the POST revert route handler. */
async function callRevert(slug: string, timestamp: number) {
  const { POST } = await import("@/app/api/wiki/[slug]/revisions/route");
  const req = new Request("http://localhost:3000/api/wiki/" + slug + "/revisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "revert", timestamp }),
  });
  return POST(req, { params: Promise.resolve({ slug }) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/wiki/[slug]/revisions — revert attribution", () => {
  it("revision sidecar carries the authenticated user's handle as author", async () => {
    // Seed a page with initial content, then overwrite to create a revision.
    await seedPage("attr-test", "# Attr Test\n\nOriginal content.");
    // Overwrite to create a revision snapshot of the original.
    const updatedContent = serializeFrontmatter(
      { title: "attr-test", created: "2025-01-01", updated: "2025-01-02", owner: "alice", visibility: "private" },
      "# Attr Test\n\nUpdated content.",
    );
    await writeWikiPage("attr-test", updatedContent, undefined, undefined, "alice");
    // Keep flat copy in sync so readWikiPageWithFrontmatter finds the page.
    await writeWikiPage("attr-test", updatedContent);

    // The revision of the original should now exist.
    const revisions = await listRevisions("attr-test", "alice");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const oldTimestamp = revisions[0].timestamp;

    // Revert as "alice"
    mockedGetPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
    const res = await callRevert("attr-test", oldTimestamp);
    expect(res.status).toBe(200);

    // The revert creates a new revision (snapshot of the content before revert).
    // Check the newest revision sidecar for the author.
    const postRevisions = await listRevisions("attr-test", "alice");
    expect(postRevisions.length).toBeGreaterThan(revisions.length);
    const newestTs = postRevisions[0].timestamp;

    const meta = await readRevisionMeta("attr-test", newestTs, "alice");
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("alice");
  });

  it("revision sidecar carries the service principal's handle when no session", async () => {
    // No Clerk session → getPrincipal returns null, service token resolves.
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue({ id: "service:bot", handle: "bot" });

    // Seed + overwrite to create a revision.
    await seedPage("svc-test", "# Svc Test\n\nOriginal.", "bot");
    const updatedContent = serializeFrontmatter(
      { title: "svc-test", created: "2025-01-01", updated: "2025-01-02", owner: "bot" },
      "# Svc Test\n\nUpdated.",
    );
    await writeWikiPage("svc-test", updatedContent, undefined, undefined, "bot");
    // Keep flat copy in sync so readWikiPageWithFrontmatter finds the page.
    await writeWikiPage("svc-test", updatedContent);

    const revisions = await listRevisions("svc-test", "bot");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const oldTimestamp = revisions[0].timestamp;

    const res = await callRevert("svc-test", oldTimestamp);
    expect(res.status).toBe(200);

    const postRevisions = await listRevisions("svc-test", "bot");
    const newestTs = postRevisions[0].timestamp;
    const meta = await readRevisionMeta("svc-test", newestTs, "bot");
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("bot");
  });

  it("contributor index reflects the reverter's edit", async () => {
    // Seed + overwrite.
    await seedPage("contrib-test", "# Contrib Test\n\nOriginal.");
    const updatedContent = serializeFrontmatter(
      { title: "contrib-test", created: "2025-01-01", updated: "2025-01-02", owner: "alice", visibility: "private" },
      "# Contrib Test\n\nUpdated.",
    );
    await writeWikiPage("contrib-test", updatedContent, undefined, undefined, "alice");
    // Keep flat copy in sync so readWikiPageWithFrontmatter finds the page.
    await writeWikiPage("contrib-test", updatedContent);

    // Bootstrap a contributor index so recordEditForAuthor has something to update.
    await rebuildContributorIndex();

    const revisions = await listRevisions("contrib-test", "alice");
    const oldTimestamp = revisions[0].timestamp;

    // Grab pre-revert state.
    const priorIdx = await getContributorIndex();
    const priorEdit = priorIdx?.authors["alice"]?.editCount ?? 0;

    // Revert as "alice"
    mockedGetPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
    const res = await callRevert("contrib-test", oldTimestamp);
    expect(res.status).toBe(200);

    // The contributor index should have incremented alice's edit count.
    const updatedIdx = await getContributorIndex();
    expect(updatedIdx).not.toBeNull();
    const postEdit = updatedIdx!.authors["alice"]?.editCount ?? 0;
    expect(postEdit).toBeGreaterThan(priorEdit);
    expect(updatedIdx!.authors["alice"]?.pagesEdited).toContain("contrib-test");
  });
});
