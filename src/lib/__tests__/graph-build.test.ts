import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildWikiGraph } from "../graph-build";
import {
  ensureDirectories,
  writeWikiPage,
} from "../wiki";
import { syncCommonsForPage } from "../commons";
import { createVault, addToVault } from "../vault";
import { _resetStorage } from "../storage";
import { serializeFrontmatter } from "../frontmatter";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-build-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"])
    saved[k] = process.env[k];
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

/** Write a wiki page with optional frontmatter and sync it into the commons. */
async function seedPage(
  slug: string,
  body: string,
  fm: Record<string, unknown> = {},
): Promise<void> {
  const title = fm.title ?? slug;
  const owner = (fm.owner as string) ?? "system";
  const content = serializeFrontmatter(
    {
      title: title as string,
      owner,
      ...(fm.tags ? { tags: fm.tags } : {}),
      ...(fm.type ? { type: fm.type } : {}),
      ...(fm.visibility ? { visibility: fm.visibility } : {}),
    },
    body,
  );
  await writeWikiPage(slug, content);
  // Sync into commons so unscoped graph picks it up.
  await syncCommonsForPage(slug, {
    owner,
    title: title as string,
    summary: "",
    ...(fm.type ? { type: fm.type as string } : {}),
    ...(fm.visibility ? { visibility: fm.visibility as string } : {}),
  });
}

describe("buildWikiGraph", () => {
  it("returns empty nodes and edges for an empty wiki", async () => {
    const { nodes, edges } = await buildWikiGraph(null, null);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("builds an unscoped graph from commons pages", async () => {
    await seedPage("alpha", "# Alpha\n\nSee [Beta](beta.md).");
    await seedPage("beta", "# Beta\n\nSee [Alpha](alpha.md).");

    const { nodes, edges } = await buildWikiGraph(null, null);

    expect(nodes).toHaveLength(2);
    const slugs = nodes.map((n) => n.id).sort();
    expect(slugs).toEqual(["alpha", "beta"]);

    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ source: "alpha", target: "beta" });
    expect(edges).toContainEqual({ source: "beta", target: "alpha" });
  });

  it("extracts links and excludes self-links", async () => {
    await seedPage(
      "hub",
      "Links: [A](spoke-a.md), [B](spoke-b.md), [self](hub.md).",
    );
    await seedPage("spoke-a", "# Spoke A");
    await seedPage("spoke-b", "# Spoke B");

    const { nodes, edges } = await buildWikiGraph(null, null);

    expect(nodes).toHaveLength(3);
    // hub→spoke-a and hub→spoke-b, but NOT hub→hub
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ source: "hub", target: "spoke-a" });
    expect(edges).toContainEqual({ source: "hub", target: "spoke-b" });
    // No self-link
    expect(edges).not.toContainEqual({ source: "hub", target: "hub" });
  });

  it("excludes artifact and agent-scoped pages from all scopes", async () => {
    await seedPage("concept", "# Concept\n\nSee [art](art-page.md).", {
      type: "wiki",
    });
    await seedPage("art-page", "# Art\n\nRendered artifact.", {
      type: "html",
    });
    await seedPage("agent-page", "# Agent", { type: "agent-identity" });
    await seedPage("slides-page", "# Slides", { type: "slides" });

    const { nodes, edges } = await buildWikiGraph(null, null);

    // Only the "concept" page should survive — commons already excludes
    // artifacts and agent-scoped types via belongsInCommons.
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("concept");
    expect(slugs).not.toContain("art-page");
    expect(slugs).not.toContain("agent-page");
    expect(slugs).not.toContain("slides-page");

    // The link from concept → art-page should be absent because art-page
    // isn't in the slug set.
    expect(edges).toHaveLength(0);
  });

  it("computes linkCount as inbound + outbound", async () => {
    // hub links to A and B; A links back to hub.
    // hub: 2 outbound + 1 inbound = 3
    // spoke-a: 1 inbound + 1 outbound = 2
    // spoke-b: 1 inbound + 0 outbound = 1
    await seedPage(
      "hub",
      "Links: [A](spoke-a.md) and [B](spoke-b.md).",
    );
    await seedPage("spoke-a", "Back to [hub](hub.md).");
    await seedPage("spoke-b", "# Spoke B\n\nNo links.");

    const { nodes, edges } = await buildWikiGraph(null, null);

    expect(edges).toHaveLength(3);

    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["hub"].linkCount).toBe(3);
    expect(byId["spoke-a"].linkCount).toBe(2);
    expect(byId["spoke-b"].linkCount).toBe(1);
  });

  it("builds a scoped graph filtering to vault slugs", async () => {
    // Seed three commons pages.
    await seedPage("in-vault", "See [out](outside.md).");
    await seedPage("also-in", "See [in](in-vault.md).");
    await seedPage("outside", "# Outside");

    // Create a public vault containing only two of the three.
    const vault = await createVault("alice", "Curated");
    await addToVault(vault.id, "in-vault");
    await addToVault(vault.id, "also-in");

    // Write the pages to the wiki dir so listReadableWikiPages can discover them.
    // (Already done by seedPage above via writeWikiPage.)

    // Write an index file so listWikiPages can discover pages.
    const indexLines = [
      `- [in-vault](in-vault.md) — ...`,
      `- [also-in](also-in.md) — ...`,
      `- [outside](outside.md) — ...`,
    ];
    await writeWikiPage("index", indexLines.join("\n"));

    const { nodes, edges } = await buildWikiGraph(
      `vault:${vault.id}`,
      null,
    );

    const slugs = nodes.map((n) => n.id).sort();
    expect(slugs).toEqual(["also-in", "in-vault"]);

    // in-vault links to "outside" which is not in the vault scope, so no edge.
    // also-in links to "in-vault" which IS in the vault scope, so one edge.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ source: "also-in", target: "in-vault" });
  });

  it("excludes artifact pages even within a vault scope", async () => {
    await seedPage("normal", "# Normal page");
    await seedPage("artifact", "# Rendered artifact", { type: "html" });

    // Create vault that includes both.
    const vault = await createVault("bob", "Mixed");
    await addToVault(vault.id, "normal");
    await addToVault(vault.id, "artifact");

    // Write an index so listWikiPages discovers these pages.
    const indexContent = [
      `- [normal](normal.md) — ...`,
      `- [artifact](artifact.md) — ...`,
    ].join("\n");
    await writeWikiPage("index", indexContent);

    const { nodes } = await buildWikiGraph(`vault:${vault.id}`, null);

    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("normal");
    expect(slugs).not.toContain("artifact");
  });

  it("carries tags from frontmatter into graph nodes", async () => {
    await seedPage("tagged", "# Tagged page", {
      tags: ["ai", "wiki"],
    });

    const { nodes } = await buildWikiGraph(null, null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].tags).toEqual(["ai", "wiki"]);
  });

  it("ignores links to pages not in the slug set", async () => {
    await seedPage(
      "page-a",
      "See [nonexistent](nonexistent.md) and [page-b](page-b.md).",
    );
    await seedPage("page-b", "# B");

    const { nodes, edges } = await buildWikiGraph(null, null);

    expect(nodes).toHaveLength(2);
    // Only page-a→page-b; the link to nonexistent is dropped.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ source: "page-a", target: "page-b" });
  });
});
