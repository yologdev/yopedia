import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildWikiGraph } from "../graph-build";
import { writeWikiPage, ensureDirectories, updateIndex } from "../wiki";
import { syncCommonsForPage } from "../commons";
import { _resetStorage } from "../storage";
import type { IndexEntry } from "../types";

// ---------------------------------------------------------------------------
// Temp-directory scaffolding (same pattern as commons.test.ts)
// ---------------------------------------------------------------------------

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-build-test-"));
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a wiki page to disk, register it in the flat index (so listWikiPages
 * finds it) AND in the commons index (so the unscoped graph path works).
 */
async function createPage(
  slug: string,
  body: string,
  meta: {
    owner?: string;
    type?: string;
    tags?: string[];
    visibility?: string;
    title?: string;
  } = {},
) {
  await ensureDirectories();

  // Build frontmatter
  const fmLines: string[] = [];
  if (meta.owner) fmLines.push(`owner: ${meta.owner}`);
  if (meta.type) fmLines.push(`type: ${meta.type}`);
  if (meta.visibility) fmLines.push(`visibility: ${meta.visibility}`);
  if (meta.tags && meta.tags.length > 0) {
    fmLines.push(`tags: [${meta.tags.join(", ")}]`);
  }

  const title = meta.title ?? slug;
  const fm = fmLines.length > 0 ? `---\n${fmLines.join("\n")}\n---\n\n` : "";
  const content = `${fm}# ${title}\n\n${body}`;
  await writeWikiPage(slug, content);

  // Register in commons index (the unscoped buildWikiGraph path uses
  // listCommonsPages which reads this).
  await syncCommonsForPage(slug, {
    owner: meta.owner,
    visibility: meta.visibility ?? "public",
    type: meta.type,
    title,
    summary: body.slice(0, 60),
    tags: meta.tags,
  });
}

/**
 * Update the flat wiki index.md so that listWikiPages returns the given
 * entries. Required for the scoped (owner:) graph path which reads via
 * listReadableWikiPages → listWikiPages → index.md.
 */
async function syncFlatIndex(entries: IndexEntry[]) {
  await updateIndex(entries);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildWikiGraph", () => {
  // ----- Empty state -------------------------------------------------------

  it("returns empty nodes and edges for an empty wiki", async () => {
    await ensureDirectories();
    const { nodes, edges } = await buildWikiGraph(null, null);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  // ----- Basic node creation -----------------------------------------------

  it("creates one node per page", async () => {
    await createPage("alpha", "First page.");
    await createPage("beta", "Second page.");

    const { nodes, edges } = await buildWikiGraph(null, null);

    expect(nodes).toHaveLength(2);
    const slugs = nodes.map((n) => n.id).sort();
    expect(slugs).toEqual(["alpha", "beta"]);
    // No cross-references → no edges
    expect(edges).toHaveLength(0);
  });

  it("uses frontmatter title when the heading matches", async () => {
    await createPage("titled", "Content.", { title: "My Title" });

    const { nodes } = await buildWikiGraph(null, null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].label).toBe("My Title");
  });

  it("populates the tenant from the owner", async () => {
    await createPage("alice-page", "Hello.", { owner: "Alice" });

    const { nodes } = await buildWikiGraph(null, null);
    expect(nodes).toHaveLength(1);
    // ownerToTenant lowercases
    expect(nodes[0].tenant).toBe("alice");
  });

  it("defaults tenant to yopedia for ownerless pages", async () => {
    await createPage("unowned", "No owner.");

    const { nodes } = await buildWikiGraph(null, null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].tenant).toBe("yopedia");
  });

  // ----- Tags --------------------------------------------------------------

  it("includes tags from frontmatter", async () => {
    await createPage("tagged", "Tagged page.", { tags: ["ai", "wiki"] });

    const { nodes } = await buildWikiGraph(null, null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].tags).toEqual(["ai", "wiki"]);
  });

  it("returns empty tags array when no tags are present", async () => {
    await createPage("notags", "No tags.");

    const { nodes } = await buildWikiGraph(null, null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].tags).toEqual([]);
  });

  // ----- Edge extraction ---------------------------------------------------

  it("creates edges from markdown links between pages", async () => {
    await createPage("a", "Link to [B](b.md).");
    await createPage("b", "Link to [A](a.md).");

    const { edges } = await buildWikiGraph(null, null);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ source: "a", target: "b" });
    expect(edges).toContainEqual({ source: "b", target: "a" });
  });

  it("ignores links to slugs not in the graph", async () => {
    await createPage("only", "Link to [Ghost](ghost.md).");

    const { edges } = await buildWikiGraph(null, null);
    expect(edges).toHaveLength(0);
  });

  it("ignores self-links", async () => {
    await createPage("self", "Link to [Self](self.md).");

    const { edges } = await buildWikiGraph(null, null);
    expect(edges).toHaveLength(0);
  });

  // ----- linkCount ---------------------------------------------------------

  it("computes linkCount as inbound + outbound per node", async () => {
    // a → b, a → c, b → c  ⇒  a=2, b=2, c=2
    await createPage("a", "Links to [B](b.md) and [C](c.md).");
    await createPage("b", "Links to [C](c.md).");
    await createPage("c", "Leaf page.");

    const { nodes } = await buildWikiGraph(null, null);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

    expect(byId["a"].linkCount).toBe(2); // outbound to b + outbound to c
    expect(byId["b"].linkCount).toBe(2); // inbound from a + outbound to c
    expect(byId["c"].linkCount).toBe(2); // inbound from a + inbound from b
  });

  it("linkCount is 0 for isolated nodes", async () => {
    await createPage("lonely", "No links at all.");

    const { nodes } = await buildWikiGraph(null, null);
    expect(nodes[0].linkCount).toBe(0);
  });

  // ----- Scope filtering ---------------------------------------------------

  it("unscoped (null) graph uses commons — excludes private and agent pages", async () => {
    await createPage("pub", "Public page.", { owner: "alice" });

    // Private page — syncCommonsForPage will exclude it from the commons index
    await createPage("priv", "Private page.", {
      owner: "alice",
      visibility: "private",
    });

    // Agent-scoped page — excluded from commons
    await createPage("agent-k", "Agent knowledge.", {
      owner: "alice--yoyo",
      type: "agent-knowledge",
    });

    const { nodes } = await buildWikiGraph(null, null);
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("pub");
    expect(slugs).not.toContain("priv");
    expect(slugs).not.toContain("agent-k");
  });

  it("unscoped graph excludes artifact types (html, slides)", async () => {
    await createPage("wiki-page", "Normal wiki page.");
    await createPage("deck", "A deck.", { type: "slides" });
    await createPage("app", "An app.", { type: "html" });

    const { nodes } = await buildWikiGraph(null, null);
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("wiki-page");
    expect(slugs).not.toContain("deck");
    expect(slugs).not.toContain("app");
  });

  it("owner-scoped graph includes only that owner's pages", async () => {
    // Create pages for two different owners
    await createPage("alice-note", "Alice's note.", { owner: "alice" });
    await createPage("bob-note", "Bob's note.", { owner: "bob" });

    // For the scoped path, we need the flat index so listReadableWikiPages works
    const entries: IndexEntry[] = [
      { slug: "alice-note", title: "alice-note", summary: "Alice's note.", owner: "alice" },
      { slug: "bob-note", title: "bob-note", summary: "Bob's note.", owner: "bob" },
    ];
    await syncFlatIndex(entries);

    const principal = { id: "user_alice", handle: "alice" };
    const { nodes } = await buildWikiGraph("owner:alice", principal);
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("alice-note");
    expect(slugs).not.toContain("bob-note");
  });

  it("'mine' scope resolves to owner:<handle> for authenticated user", async () => {
    await createPage("my-page", "My page.", { owner: "alice" });
    await createPage("other", "Other page.", { owner: "bob" });

    const entries: IndexEntry[] = [
      { slug: "my-page", title: "my-page", summary: "My page.", owner: "alice" },
      { slug: "other", title: "other", summary: "Other page.", owner: "bob" },
    ];
    await syncFlatIndex(entries);

    const principal = { id: "user_alice", handle: "alice" };
    const { nodes } = await buildWikiGraph("mine", principal);
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("my-page");
    expect(slugs).not.toContain("other");
  });

  it("'mine' scope with no principal falls back to commons", async () => {
    await createPage("commons-page", "A commons page.");

    // No principal → expandMineScope returns undefined → unscoped commons
    const { nodes } = await buildWikiGraph("mine", null);
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("commons-page");
  });

  it("scoped graph excludes agent-scoped and artifact types", async () => {
    await createPage("normal", "Normal page.", { owner: "alice" });
    await createPage("ak", "Agent page.", { owner: "alice", type: "agent-knowledge" });
    await createPage("deck", "Slides.", { owner: "alice", type: "slides" });

    const entries: IndexEntry[] = [
      { slug: "normal", title: "normal", summary: "Normal page.", owner: "alice" },
      { slug: "ak", title: "ak", summary: "Agent page.", owner: "alice", type: "agent-knowledge" },
      { slug: "deck", title: "deck", summary: "Slides.", owner: "alice", type: "slides" },
    ];
    await syncFlatIndex(entries);

    const principal = { id: "user_alice", handle: "alice" };
    const { nodes } = await buildWikiGraph("owner:alice", principal);
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("normal");
    expect(slugs).not.toContain("ak");
    expect(slugs).not.toContain("deck");
  });

  // ----- Multiple links from one page --------------------------------------

  it("extracts multiple edges from a page with several links", async () => {
    await createPage("hub", "See [A](a.md), [B](b.md), and [C](c.md).");
    await createPage("a", "Page A.");
    await createPage("b", "Page B.");
    await createPage("c", "Page C.");

    const { edges } = await buildWikiGraph(null, null);
    const hubEdges = edges.filter((e) => e.source === "hub");
    expect(hubEdges).toHaveLength(3);
    expect(hubEdges.map((e) => e.target).sort()).toEqual(["a", "b", "c"]);
  });
});
