import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Mocks — auth + authz
// ---------------------------------------------------------------------------

const mockPrincipal = { id: "user_alice", handle: "alice" };

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => mockPrincipal),
}));

const mockCanSetPrivate = vi.fn(async () => false);

vi.mock("@/lib/authz", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
  return {
    ...actual,
    canSetPrivate: () => mockCanSetPrivate(),
  };
});

// Stub embedding (no Vectorize in tests)
vi.mock("@/lib/embeddings", () => ({
  upsertEmbedding: vi.fn(async () => {}),
  removeEmbedding: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/vaults/[id]/clone/route";
import { createVault, vaultSlugs, cloneToPrivate } from "@/lib/vault";
import { _resetStorage } from "@/lib/storage";
import { _resetLocks } from "@/lib/lock";
import {
  writeWikiPage,
  readWikiPageWithFrontmatter,
  ensureDirectories,
  updateIndex,
  serializeFrontmatter,
} from "@/lib/wiki";
import { canReadPage } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Temp storage per test — real fs-backed storage
// ---------------------------------------------------------------------------

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clone-to-private-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  mockCanSetPrivate.mockReset().mockResolvedValue(false);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a public commons page with frontmatter. */
async function seedPublicPage(slug: string, title: string, body: string) {
  const fm = {
    title,
    summary: `About ${title}`,
    created: "2026-01-01",
    updated: "2026-01-01",
    confidence: 0.8,
    tags: ["test"],
  };
  const content = serializeFrontmatter(fm, `# ${title}\n\n${body}`);
  await writeWikiPage(slug, content);
  await updateIndex([{ slug, title, summary: fm.summary }]);
}

/** Build a clone request to POST /api/vaults/[id]/clone. */
function postClone(vaultId: string, body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/vaults/${vaultId}/clone`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: vaultId }) },
  );
}

// ---------------------------------------------------------------------------
// Tests — data layer (cloneToPrivate)
// ---------------------------------------------------------------------------

describe("cloneToPrivate", () => {
  it("creates a private page with correct metadata from a public source", async () => {
    mockCanSetPrivate.mockResolvedValue(true);

    // Seed a public page.
    await seedPublicPage("quantum-computing", "Quantum Computing", "QC body.");

    // Create a private vault.
    const vault = await createVault("alice", "My Research", "private");

    // Clone the page into the vault.
    const result = await cloneToPrivate("quantum-computing", vault.id, "alice");

    expect(result.sourceSlug).toBe("quantum-computing");
    expect(result.cloneSlug).toBe("quantum-computing--private-alice");
    expect(result.owner).toBe("alice");

    // Read the cloned page and verify its frontmatter.
    const clone = await readWikiPageWithFrontmatter("quantum-computing--private-alice");
    expect(clone).not.toBeNull();
    expect(clone!.frontmatter.visibility).toBe("private");
    expect(clone!.frontmatter.owner).toBe("alice");
    expect(clone!.frontmatter.cloned_from).toBe("quantum-computing");
    expect(clone!.frontmatter.authors).toEqual(["alice"]);

    // The clone should carry over tags and confidence from the source.
    expect(clone!.frontmatter.tags).toEqual(["test"]);
    expect(clone!.frontmatter.confidence).toBe(0.8);

    // The body should match.
    expect(clone!.body).toContain("QC body.");
  });

  it("adds the cloned page to the vault's slug list", async () => {
    await seedPublicPage("neural-nets", "Neural Networks", "NN body.");
    const vault = await createVault("alice", "AI Vault", "private");

    await cloneToPrivate("neural-nets", vault.id, "alice");

    const slugs = await vaultSlugs(vault.id);
    expect(slugs).toContain("neural-nets--private-alice");
  });

  it("throws when the source page does not exist", async () => {
    const vault = await createVault("alice", "Empty Vault", "private");

    await expect(cloneToPrivate("nonexistent", vault.id, "alice")).rejects.toThrow(
      /not found/i,
    );
  });

  it("throws when the source page is private", async () => {
    // Write a private page directly.
    const fm = {
      title: "Secret",
      visibility: "private",
      owner: "bob",
      created: "2026-01-01",
    };
    const content = serializeFrontmatter(fm, "# Secret\n\nHidden.");
    await writeWikiPage("secret-page", content);
    await updateIndex([{ slug: "secret-page", title: "Secret", summary: "Hidden" }]);

    const vault = await createVault("alice", "Vault", "private");

    await expect(cloneToPrivate("secret-page", vault.id, "alice")).rejects.toThrow(
      /private/i,
    );
  });

  it("does not modify the source page", async () => {
    await seedPublicPage("original-page", "Original", "Original body.");
    const vault = await createVault("alice", "Vault", "private");

    // Read the source before cloning.
    const before = await readWikiPageWithFrontmatter("original-page");

    await cloneToPrivate("original-page", vault.id, "alice");

    // Read the source after cloning — should be identical.
    const after = await readWikiPageWithFrontmatter("original-page");
    expect(after!.frontmatter.visibility).toBeUndefined();
    expect(after!.frontmatter.owner).toBeUndefined();
    expect(after!.body).toBe(before!.body);
  });
});

// ---------------------------------------------------------------------------
// Tests — API route (POST /api/vaults/[id]/clone)
// ---------------------------------------------------------------------------

describe("POST /api/vaults/[id]/clone", () => {
  it("returns 402 when the user lacks a paid plan", async () => {
    mockCanSetPrivate.mockResolvedValue(false);

    await seedPublicPage("test-page", "Test Page", "Body.");
    const vault = await createVault("alice", "My Vault", "public");

    const res = await postClone(vault.id, { slug: "test-page" });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/paid plan/i);
  });

  it("clones successfully with a pro plan and returns 201", async () => {
    mockCanSetPrivate.mockResolvedValue(true);

    await seedPublicPage("llm-wiki", "LLM Wiki", "About LLM wikis.");
    const vault = await createVault("alice", "Private Research", "private");

    const res = await postClone(vault.id, { slug: "llm-wiki" });
    expect(res.status).toBe(201);

    const { clone } = await res.json();
    expect(clone.cloneSlug).toBe("llm-wiki--private-alice");
    expect(clone.sourceSlug).toBe("llm-wiki");
    expect(clone.owner).toBe("alice");
  });

  it("returns 404 when the source page does not exist", async () => {
    mockCanSetPrivate.mockResolvedValue(true);

    const vault = await createVault("alice", "Vault", "private");

    const res = await postClone(vault.id, { slug: "ghost-page" });
    expect(res.status).toBe(404);
  });

  it("returns 403 when the vault is not owned by the caller", async () => {
    // Create a vault owned by bob (different from the mock principal "alice").
    const vault = await createVault("bob", "Bob's Vault", "private");

    const res = await postClone(vault.id, { slug: "anything" });
    expect(res.status).toBe(403);
  });

  it("returns 400 when body is missing the slug field", async () => {
    mockCanSetPrivate.mockResolvedValue(true);
    const vault = await createVault("alice", "Vault", "private");

    const res = await postClone(vault.id, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/slug/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — read authorization
// ---------------------------------------------------------------------------

describe("cloned page read authorization", () => {
  it("cloned page is readable only by the owner", async () => {
    mockCanSetPrivate.mockResolvedValue(true);

    await seedPublicPage("public-info", "Public Info", "Everyone can see this.");
    const vault = await createVault("alice", "Private Vault", "private");
    await cloneToPrivate("public-info", vault.id, "alice");

    const clone = await readWikiPageWithFrontmatter("public-info--private-alice");
    expect(clone).not.toBeNull();

    const meta = {
      visibility: clone!.frontmatter.visibility as string,
      owner: clone!.frontmatter.owner as string,
    };

    // Owner can read.
    expect(canReadPage(meta, { handle: "alice" })).toBe(true);

    // Other user cannot.
    expect(canReadPage(meta, { handle: "bob" })).toBe(false);

    // Anonymous cannot.
    expect(canReadPage(meta, null)).toBe(false);
  });

  it("source commons page remains publicly readable after cloning", async () => {
    mockCanSetPrivate.mockResolvedValue(true);

    await seedPublicPage("open-page", "Open Page", "Public content.");
    const vault = await createVault("alice", "Vault", "private");
    await cloneToPrivate("open-page", vault.id, "alice");

    const source = await readWikiPageWithFrontmatter("open-page");
    const meta = {
      visibility: source!.frontmatter.visibility as string | undefined,
      owner: source!.frontmatter.owner as string | undefined,
    };

    // Anyone can read the source.
    expect(canReadPage(meta, { handle: "bob" })).toBe(true);
    expect(canReadPage(meta, null)).toBe(true);
  });
});
