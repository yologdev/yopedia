import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  dispatchMcp,
  MCP_TOOLS,
  MCP_MAX_BATCH,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  _internal,
} from "../mcp-http";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { saveRevision } from "../revisions";
import { _resetStorage } from "../storage";
import { createVault, vaultSlugs } from "../vault";
import { registerAgent } from "../agents";
import type { Principal } from "../auth";
import type { Frontmatter } from "../frontmatter";

const ALICE: Principal = { id: "agent:a--yoyo", handle: "alice" };
const BOB: Principal = { id: "user:bob", handle: "bob" };

// Most cases exercise the JSON-RPC envelope + auth gating, which need no
// storage/LLM (a write tool is rejected BEFORE its handler runs when there's no
// principal). The reingest-ACL case touches storage, so set up a temp wiki.
let tmpDir: string;
let prevWiki: string | undefined;
let prevRaw: string | undefined;
let prevData: string | undefined;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-test-"));
  prevWiki = process.env.WIKI_DIR;
  prevRaw = process.env.RAW_DIR;
  prevData = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
});
afterEach(async () => {
  process.env.WIKI_DIR = prevWiki;
  process.env.RAW_DIR = prevRaw;
  process.env.DATA_DIR = prevData;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("dispatchMcp — protocol", () => {
  it("initialize returns protocol version + serverInfo + tools capability", async () => {
    const res = await dispatchMcp({ id: 1, method: "initialize" }, null);
    expect(res).not.toBeNull();
    expect(res!.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: MCP_SERVER_INFO,
      capabilities: { tools: {} },
    });
  });

  it("ping returns an empty result", async () => {
    const res = await dispatchMcp({ id: 2, method: "ping" }, null);
    expect(res!.result).toEqual({
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
      },
    });
  });

  it("notifications get no response (null)", async () => {
    expect(await dispatchMcp({ method: "notifications/initialized" }, null)).toBeNull();
  });

  it("unknown method is a JSON-RPC method-not-found error", async () => {
    const res = await dispatchMcp({ id: 3, method: "frobnicate" }, null);
    expect(res!.error?.code).toBe(-32601);
  });

  it("echoes the request id (incl. null)", async () => {
    const res = await dispatchMcp({ id: "abc", method: "ping" }, null);
    expect(res!.id).toBe("abc");
  });
});

describe("dispatchMcp — tools/list", () => {
  it("lists the curated tools with name/description/inputSchema", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_wiki");
    expect(names).toContain("query_wiki");
    expect(names).toContain("ingest_url");
    expect(names).toContain("ingest_text");
    expect(names).toContain("agent_context");
    expect(names).toContain("dataview_query");
    expect(names).toContain("wiki_graph");
    expect(names).toContain("activity_trail");
    expect(names).toContain("ingest_history");
    expect(names).toContain("list_contributors");
    expect(names).toContain("get_contributor");
    expect(names).toContain("delete_agent");
    expect(names).toContain("vault_delete");
    expect(names).toContain("vault_rename");
    expect(names).toContain("query_history");
    expect(names).toContain("ingest_image");
    expect(names).toContain("ingest_pdf");
    expect(names).toContain("ingest_x_mention");
    // Every descriptor carries a schema; the internal `write`/`run` fields are
    // NOT leaked to the wire.
    for (const t of tools) {
      expect(t.inputSchema).toBeTypeOf("object");
      expect(t).not.toHaveProperty("write");
      expect(t).not.toHaveProperty("run");
    }
  });
});

describe("dispatchMcp — tools/call auth gating", () => {
  it("rejects an unknown tool as an isError result (not a crash)", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/i);
  });

  it("blocks a WRITE tool when unauthenticated (principal=null) before running it", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "ingest_url", arguments: { url: "https://example.com" } } },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("reingest denies (cloaked) a missing/unauthorized page before any fetch", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "reingest", arguments: { slug: "does-not-exist" } } },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found or you don't have permission/i);
  });

  it("every write tool is gated and every read tool is open", () => {
    const writes = MCP_TOOLS.filter((t) => t.write).map((t) => t.name);
    const reads = MCP_TOOLS.filter((t) => !t.write).map((t) => t.name);
    expect(writes).toEqual(
      expect.arrayContaining(["ingest_url", "batch_ingest_urls", "ingest_text", "ingest_image", "ingest_pdf", "ingest_x_mention", "create_page", "update_page", "delete_page", "save_query_answer", "reingest", "update_metadata", "fix_lint_issue", "reconcile_page", "merge_pages", "delete_agent", "vault_delete", "vault_rename"]),
    );
    expect(reads).toEqual(
      expect.arrayContaining(["search_wiki", "read_page", "list_pages", "query_wiki", "lint_wiki", "query_history"]),
    );
  });

  it("exposes a batch cap constant", () => {
    expect(MCP_MAX_BATCH).toBeGreaterThan(0);
  });
});

describe("dispatchMcp — per-agent target vault", () => {
  const VAULT = { id: "alice--inbox", name: "Inbox" };

  it("initialize surfaces the target vault in instructions (and omits it without one)", async () => {
    const withVault = await dispatchMcp({ id: 1, method: "initialize" }, ALICE, VAULT);
    expect((withVault!.result as { instructions?: string }).instructions).toMatch(/Inbox/);
    const without = await dispatchMcp({ id: 1, method: "initialize" }, ALICE, null);
    expect((without!.result as { instructions?: string }).instructions).toBeUndefined();
  });

  it("tools/list appends the vault destination to WRITE tool descriptions only", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, ALICE, VAULT);
    const tools = (res!.result as { tools: { name: string; description: string }[] }).tools;
    const ingest = tools.find((t) => t.name === "ingest_url")!;
    const search = tools.find((t) => t.name === "search_wiki")!;
    expect(ingest.description).toMatch(/Inbox/);
    expect(search.description).not.toMatch(/Inbox/);
  });

  it("files a created page into the target vault and notes it in the result", async () => {
    const vault = await createVault("alice", "Inbox", "public");
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "create_page", arguments: { slug: "from-agent", content: "# From Agent\n\nbody." } },
      },
      ALICE,
      { id: vault.id, name: vault.name },
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    // The new page is referenced into the vault, and the result records it.
    expect(await vaultSlugs(vault.id)).toContain("from-agent");
    expect(r.content[0].text).toContain("filedIntoVault");
  });

  it("resultSlug reads `slug` (most write tools) and `primarySlug` (reingest)", () => {
    // Guards the reingest filing path: reingest returns IngestResult with
    // primarySlug and no top-level slug.
    expect(_internal.resultSlug({ slug: "a" })).toBe("a");
    expect(_internal.resultSlug({ primarySlug: "b" })).toBe("b");
    expect(_internal.resultSlug({ slug: "a", primarySlug: "b" })).toBe("a");
    expect(_internal.resultSlug({})).toBeNull();
    expect(_internal.resultSlug("nope")).toBeNull();
  });

  it("a vault-filing failure does not fail the write (fail-soft)", async () => {
    // No such vault → addToVault's mutate is a no-op/throws internally; the page
    // is still created and the call succeeds.
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "create_page", arguments: { slug: "still-created", content: "# X\n\nbody." } },
      },
      ALICE,
      { id: "alice--ghost", name: "Ghost" },
    );
    const r = res!.result as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    const { readWikiPage } = await import("../wiki");
    expect(await readWikiPage("still-created")).not.toBeNull();
  });
});

describe("dispatchMcp — update_metadata", () => {
  it("tools/list returns update_metadata", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("update_metadata");
  });

  it("rejects update_metadata without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "update_metadata", arguments: { slug: "test", metadata: { disputed: true } } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("forwards the principal to patchMetadata (updates metadata on an owned page)", async () => {
    // Create a page owned by alice first.
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = { title: "Meta Test", owner: "alice", created: "2025-01-01" };
    await writeWikiPage("meta-test", serializeFrontmatter(fm, "# Meta Test\n\nBody."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_metadata",
          arguments: { slug: "meta-test", metadata: { disputed: true, confidence: 0.5 } },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.updated).toBe(true);

    // Verify the metadata was actually applied.
    const { readWikiPageWithFrontmatter: readFm } = await import("../wiki");
    const page = await readFm("meta-test");
    expect(page!.frontmatter.disputed).toBe(true);
    expect(page!.frontmatter.confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// update_page
// ---------------------------------------------------------------------------
describe("dispatchMcp — update_page", () => {
  it("tools/list returns update_page with correct schema", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string; inputSchema: { required?: string[] } }[] }).tools;
    const tool = tools.find((t) => t.name === "update_page");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["slug", "content"]));
  });

  it("rejects update_page without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "update_page", arguments: { slug: "test", content: "# New\n\nBody." } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("updates a page owned by the caller (ACL + success)", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    // Use agent-scoped type so the page is NOT commons (commons body writes are
    // agent-only via service principals — the realm gate is intentional).
    const fm = { title: "Update Test", owner: "alice", created: "2025-01-01", type: "agent-knowledge" };
    await writeWikiPage("update-test", serializeFrontmatter(fm, "# Update Test\n\nOld body."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_page",
          arguments: { slug: "update-test", content: "# Update Test\n\nNew body." },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.updated).toBe(true);
    expect(parsed.slug).toBe("update-test");

    // Verify the content was actually updated.
    const { readWikiPageWithFrontmatter: readFm } = await import("../wiki");
    const page = await readFm("update-test");
    expect(page).not.toBeNull();
    expect(page!.body).toContain("New body.");
  });

  it("rejects update_page when caller cannot write the page (ACL)", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = { title: "Alice Only", owner: "alice", created: "2025-01-01", visibility: "private" };
    await writeWikiPage("alice-only", serializeFrontmatter(fm as Frontmatter, "# Alice Only\n\nPrivate."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_page",
          arguments: { slug: "alice-only", content: "# Hacked\n\nEvil." },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete_page
// ---------------------------------------------------------------------------
describe("dispatchMcp — delete_page", () => {
  it("tools/list returns delete_page with correct schema", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string; inputSchema: { required?: string[] } }[] }).tools;
    const tool = tools.find((t) => t.name === "delete_page");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["slug"]));
  });

  it("rejects delete_page without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_page", arguments: { slug: "test" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("deletes a page owned by the caller (ACL + success)", async () => {
    const { writeWikiPage, serializeFrontmatter, readWikiPage } = await import("../wiki");
    // Use agent-scoped type so the page is NOT commons (commons delete writes
    // require a service principal — the realm gate is intentional).
    const fm = { title: "Delete Test", owner: "alice", created: "2025-01-01", type: "agent-knowledge" };
    await writeWikiPage("delete-test", serializeFrontmatter(fm, "# Delete Test\n\nWill be deleted."));

    // Confirm the page exists.
    expect(await readWikiPage("delete-test")).toBeTruthy();

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "delete_page",
          arguments: { slug: "delete-test" },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("delete-test");

    // Verify the page was actually deleted.
    expect(await readWikiPage("delete-test")).toBeNull();
  });

  it("rejects delete_page when caller cannot write the page (ACL)", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = { title: "Alice Private", owner: "alice", created: "2025-01-01", visibility: "private" };
    await writeWikiPage("alice-private", serializeFrontmatter(fm as Frontmatter, "# Alice Private\n\nPrivate."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "delete_page",
          arguments: { slug: "alice-private" },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
  });
});

describe("dispatchMcp — publish_to_commons ownership check", () => {
  it("rejects publish_to_commons when caller does not own the agent", async () => {
    // Register an agent owned by alice.
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    // Bob tries to publish alice's agent page — should be rejected.
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "publish_to_commons",
          arguments: { slug: "some-page", agentId: "alice--yoyo" },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ownership mismatch/i);
  });

  it("allows publish_to_commons when caller owns the agent", async () => {
    // Register an agent owned by alice.
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    // Create an agent-knowledge page owned by the agent.
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = {
      title: "Agent Knowledge",
      owner: "alice--yoyo",
      type: "agent-knowledge",
      created: "2025-01-01",
    };
    await writeWikiPage(
      "agent-topic",
      serializeFrontmatter(fm, "# Agent Knowledge\n\nBody."),
    );

    // Alice (the agent's owner) publishes — should succeed.
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "publish_to_commons",
          arguments: { slug: "agent-topic", agentId: "alice--yoyo" },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.published).toBe(true);
    expect(parsed.owner).toBe("alice");
  });

  it("rejects publish_to_commons for a nonexistent agent", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "publish_to_commons",
          arguments: { slug: "some-page", agentId: "ghost--yoyo" },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/agent not found/i);
  });
});

describe("dispatchMcp — lint_wiki", () => {
  it("tools/list returns lint_wiki", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("lint_wiki");
  });

  it("lint_wiki works without authentication (read-only)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "lint_wiki", arguments: {} },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toHaveProperty("issues");
    expect(Array.isArray(parsed.issues)).toBe(true);
  });
});

describe("dispatchMcp — fix_lint_issue", () => {
  it("tools/list returns fix_lint_issue", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("fix_lint_issue");
  });

  it("rejects fix_lint_issue without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "fix_lint_issue", arguments: { type: "orphan-page", slug: "test" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });
});

describe("dispatchMcp — reconcile_page", () => {
  it("tools/list returns reconcile_page", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("reconcile_page");
  });

  it("rejects reconcile_page without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "reconcile_page", arguments: { pageSlug: "test", threadIndex: 0 } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });
});

// ---------------------------------------------------------------------------
// merge_pages tool
// ---------------------------------------------------------------------------

describe("dispatchMcp — merge_pages", () => {
  it("tools/list includes merge_pages", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("merge_pages");
  });

  it("merge_pages is write-gated (rejects without auth)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "merge_pages", arguments: { from: "page-a", into: "page-b" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("merge_pages dispatches with actor from principal", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "merge_pages");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discussion tools
// ---------------------------------------------------------------------------

describe("dispatchMcp — list_discussions", () => {
  it("tools/list returns list_discussions", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("list_discussions");
  });

  it("list_discussions works without auth (read-only)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_discussions", arguments: { pageSlug: "nonexistent" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.pageSlug).toBe("nonexistent");
    expect(parsed.threads).toEqual([]);
  });
});

describe("dispatchMcp — read_discussion", () => {
  it("tools/list returns read_discussion", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("read_discussion");
  });

  it("read_discussion works without auth (read-only, returns error for missing thread)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "read_discussion", arguments: { pageSlug: "test", threadIndex: 0 } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    // Handler throws for missing thread — surfaced as isError tool result, NOT a 401.
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/thread not found/i);
  });
});

describe("dispatchMcp — create_discussion", () => {
  it("tools/list returns create_discussion", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("create_discussion");
  });

  it("rejects create_discussion without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "create_discussion",
          arguments: { pageSlug: "test", title: "Bug?", body: "Something looks wrong" },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("sets author from principal handle when authenticated", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "create_discussion",
          arguments: { pageSlug: "test-page", title: "Question", body: "Is this right?" },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.comments[0].author).toBe("alice");
  });
});

describe("dispatchMcp — add_comment", () => {
  it("tools/list returns add_comment", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("add_comment");
  });

  it("rejects add_comment without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "add_comment",
          arguments: { pageSlug: "test", threadIndex: 0, content: "I agree" },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("sets author from principal handle when authenticated", async () => {
    // First create a thread to comment on
    await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "create_discussion",
          arguments: { pageSlug: "comment-test", title: "Topic", body: "Start" },
        },
      },
      ALICE,
    );
    // Now add a comment as BOB
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "add_comment",
          arguments: { pageSlug: "comment-test", threadIndex: 0, content: "Good point" },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.author).toBe("bob");
  });
});

describe("dispatchMcp — resolve_discussion", () => {
  it("tools/list returns resolve_discussion", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("resolve_discussion");
  });

  it("rejects resolve_discussion without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "resolve_discussion",
          arguments: { pageSlug: "test", threadIndex: 0, resolution: "resolved" },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });
});

// ---------------------------------------------------------------------------
// Revision tools
// ---------------------------------------------------------------------------

describe("dispatchMcp — list_revisions", () => {
  it("tools/list returns list_revisions", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("list_revisions");
  });

  it("returns revisions for a valid slug without auth (read-only)", async () => {
    // Create a page then update it so a revision exists
    await writeWikiPage("rev-list-test", "# Rev\nOriginal content");
    await saveRevision("rev-list-test", "# Rev\nOriginal content");
    await writeWikiPage("rev-list-test", "# Rev\nUpdated content");
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_revisions", arguments: { slug: "rev-list-test" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("rev-list-test");
    expect(parsed.revisions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("dispatchMcp — read_revision", () => {
  it("tools/list returns read_revision", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("read_revision");
  });

  it("returns revision content for a valid slug + timestamp without auth", async () => {
    // Set up a page with a revision
    await writeWikiPage("rev-read-test", "# Rev\nFirst version");
    await saveRevision("rev-read-test", "# Rev\nFirst version");
    await writeWikiPage("rev-read-test", "# Rev\nSecond version");

    // Get the timestamp from list_revisions
    const listRes = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_revisions", arguments: { slug: "rev-read-test" } },
      },
      null,
    );
    const listParsed = JSON.parse(
      (listRes!.result as { content: { text: string }[] }).content[0].text,
    );
    const ts = listParsed.revisions[0].timestamp;

    // Read that revision
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: { name: "read_revision", arguments: { slug: "rev-read-test", timestamp: ts } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("rev-read-test");
    expect(parsed.content).toContain("First version");
  });
});

describe("dispatchMcp — revert_revision", () => {
  it("tools/list returns revert_revision", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("revert_revision");
  });

  it("rejects revert_revision without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "revert_revision",
          arguments: { slug: "test", timestamp: 1234567890 },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("passes principal.handle as author to handleRevertRevision", async () => {
    // Create a page with a revision to revert to
    await writeWikiPage("rev-revert-test", "# Revert\nOriginal");
    await saveRevision("rev-revert-test", "# Revert\nOriginal");
    await writeWikiPage("rev-revert-test", "# Revert\nChanged");

    // Get the timestamp
    const listRes = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_revisions", arguments: { slug: "rev-revert-test" } },
      },
      null,
    );
    const listParsed = JSON.parse(
      (listRes!.result as { content: { text: string }[] }).content[0].text,
    );
    const ts = listParsed.revisions[0].timestamp;

    // Revert as ALICE
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "revert_revision",
          arguments: { slug: "rev-revert-test", timestamp: ts },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("rev-revert-test");
  });
});

describe("dispatchMcp — vault tools", () => {
  it("list_vaults and vault_pages appear in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_vaults");
    expect(names).toContain("vault_pages");
  });

  it("list_vaults defaults to caller's handle when no owner arg", async () => {
    // Create a vault for alice
    await createVault("alice", "my-research", "public");

    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "list_vaults", arguments: {} } },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.vaults).toBeInstanceOf(Array);
    expect(parsed.vaults.length).toBeGreaterThanOrEqual(1);
    expect(parsed.vaults.some((v: { name: string }) => v.name === "my-research")).toBe(true);
  });

  it("list_vaults with explicit owner returns that user's vaults", async () => {
    await createVault("bob", "bob-notes", "public");

    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "list_vaults", arguments: { owner: "bob" } } },
      null, // no auth needed for reads
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.vaults).toBeInstanceOf(Array);
    expect(parsed.vaults.some((v: { name: string }) => v.name === "bob-notes")).toBe(true);
  });

  it("list_vaults without owner or auth returns an error", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "list_vaults", arguments: {} } },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/owner is required/i);
  });

  it("vault_pages returns enriched metadata for vault contents", async () => {
    // Create a page, then a vault, then add the page to the vault
    await writeWikiPage("vault-test-page", "---\ntitle: Vault Test\ntags: [testing]\nconfidence: 0.9\n---\n# Vault Test\nHello");
    const vault = await createVault("alice", "test-vault", "public");
    const { addToVault: addToV } = await import("../vault");
    await addToV(vault.id, "vault-test-page");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_pages", arguments: { vault: "test-vault" } },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.owner).toBe("alice");
    expect(parsed.vault).toBe("test-vault");
    expect(parsed.slugs).toContain("vault-test-page");
    expect(parsed.pages).toBeInstanceOf(Array);
    expect(parsed.pages.length).toBe(1);
    expect(parsed.pages[0].slug).toBe("vault-test-page");
    expect(parsed.pages[0].title).toBe("Vault Test");
  });

  it("vault_pages without owner or auth returns an error", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_pages", arguments: { vault: "test-vault" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/owner is required/i);
  });

  it("vault_curate, vault_create, vault_uncurate appear in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("vault_curate");
    expect(names).toContain("vault_create");
    expect(names).toContain("vault_uncurate");
  });

  it("vault_curate requires authentication", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_curate", arguments: { slug: "test", vault: "inbox" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_create requires authentication", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_create", arguments: { name: "inbox" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_uncurate requires authentication", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_uncurate", arguments: { slug: "test", vault: "inbox" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_curate forces owner from principal (ignores caller-supplied owner)", async () => {
    // Create a page for curation
    await writeWikiPage("curate-me", "---\ntitle: Curate Me\nvisibility: public\n---\n# Curate Me\nContent");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_curate",
          arguments: { slug: "curate-me", vault: "research", owner: "evil-hacker" },
        },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.curated).toBe(true);
    expect(parsed.owner).toBe("alice"); // forced from principal, not "evil-hacker"
    expect(parsed.vault).toBe("research");
  });

  it("vault_create forces owner from principal", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_create",
          arguments: { name: "my-new-vault", owner: "evil-hacker" },
        },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.vault).toBeDefined();
    expect(parsed.vault.owner).toBe("alice"); // forced from principal
  });

  it("vault_uncurate forces owner from principal", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_uncurate",
          arguments: { slug: "some-slug", vault: "inbox", owner: "evil-hacker" },
        },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.curated).toBe(false);
    expect(parsed.owner).toBe("alice"); // forced from principal
  });
});

describe("dispatchMcp — agent_context", () => {
  it("agent_context tool appears in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    const tool = tools.find((t) => t.name === "agent_context");
    expect(tool).toBeDefined();
  });

  it("agent_context is read-only (write: false) — no auth required", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "agent_context");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("agent_context returns identity, learnings, socialWisdom, and meta for a registered agent", async () => {
    // Register a test agent with some pages
    await registerAgent({
      id: "a--test-bot",
      name: "test-bot",
      description: "A test agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "agent_context", arguments: { agent_id: "a--test-bot" } },
      },
      null, // no auth required — read-only
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.agent).toBeDefined();
    expect(parsed.agent.name).toBe("test-bot");
    expect(parsed.context).toBeDefined();
    expect(parsed.context).toHaveProperty("identity");
    expect(parsed.context).toHaveProperty("learnings");
    expect(parsed.context).toHaveProperty("socialWisdom");
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta).toHaveProperty("totalChars");
    expect(parsed.meta).toHaveProperty("pageCount");
  });

  it("agent_context returns error for unknown agent", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "agent_context", arguments: { agent_id: "nonexistent" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/agent not found/i);
  });
});

// ---------------------------------------------------------------------------
// dataview_query dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — dataview_query", () => {
  it("returns results for a valid query (no auth required)", async () => {
    // Seed a page so the query has something to find
    await writeWikiPage(
      "dv-test-page",
      "---\ntitle: DV Test\ntags:\n  - testing\nconfidence: 0.9\n---\nDataview test content.",
    );

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "dataview_query",
          arguments: {
            filters: [{ field: "tags", op: "contains", value: "testing" }],
            limit: 5,
          },
        },
      },
      null, // no auth — read-only
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.results).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.total).toBeTypeOf("number");
  });

  it("returns empty results when no pages match filters", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "dataview_query",
          arguments: {
            filters: [{ field: "tags", op: "contains", value: "nonexistent-tag-xyz" }],
          },
        },
      },
      null,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.results).toEqual([]);
    expect(parsed.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wiki_graph dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — wiki_graph", () => {
  it("returns graph data (nodes + edges) without auth", async () => {
    // Seed a couple of pages so the graph is non-trivial
    await writeWikiPage(
      "graph-node-a",
      "---\ntitle: Node A\n---\nSee [[graph-node-b]].",
    );
    await writeWikiPage(
      "graph-node-b",
      "---\ntitle: Node B\n---\nStandalone page.",
    );

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "wiki_graph", arguments: {} },
      },
      null, // no auth — read-only
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.nodes).toBeDefined();
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.edges).toBeDefined();
    expect(Array.isArray(parsed.edges)).toBe(true);
  });

  it("returns graph with optional scope param", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "wiki_graph", arguments: { scope: "all" } },
      },
      null,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.nodes).toBeDefined();
    expect(parsed.edges).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// batch_ingest_urls dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — batch_ingest_urls", () => {
  it("is listed in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("batch_ingest_urls");
  });

  it("blocks unauthenticated calls (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "batch_ingest_urls",
          arguments: { urls: ["https://example.com"] },
        },
      },
      null, // no auth
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("rejects batch with malformed URLs (upfront validation)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "batch_ingest_urls",
          arguments: { urls: ["not-a-url", "also bad"] },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/malformed/i);
  });
});

// ---------------------------------------------------------------------------
// activity_trail dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — activity_trail", () => {
  it("returns events array without auth (read-only)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "activity_trail", arguments: {} },
      },
      null, // no auth — read-only
    );

    expect(res).not.toBeNull();
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  it("respects optional limit parameter", async () => {
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: { name: "activity_trail", arguments: { limit: 5 } },
      },
      null,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ingest_history dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_history", () => {
  it("returns entries array without auth (read-only)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "ingest_history", arguments: {} },
      },
      null, // no auth — read-only
    );

    expect(res).not.toBeNull();
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("respects optional limit parameter", async () => {
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: { name: "ingest_history", arguments: { limit: 10 } },
      },
      null,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list_contributors dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — list_contributors", () => {
  it("is registered as a read-only tool", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "list_contributors");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("returns contributors array without auth (read-only)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_contributors", arguments: {} },
      },
      null, // no auth — read-only
    );

    expect(res).not.toBeNull();
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.contributors).toBeDefined();
    expect(Array.isArray(parsed.contributors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_contributor dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — get_contributor", () => {
  it("is registered as a read-only tool", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_contributor");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("returns an error for unknown contributor (read-only, no auth needed)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "get_contributor", arguments: { handle: "nonexistent-user" } },
      },
      null, // no auth — read-only
    );

    expect(res).not.toBeNull();
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    // Unknown handles throw from handleGetContributor, surfaced as isError
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("nonexistent-user");
  });
});

// ---------------------------------------------------------------------------
// list_agents dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — list_agents", () => {
  it("is registered as a read-only tool", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "list_agents");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("returns agents array without auth (read-only)", async () => {
    // Register a test agent so there's something to list.
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_agents", arguments: {} },
      },
      null, // no auth — read-only
    );

    expect(res).not.toBeNull();
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.agents).toBeDefined();
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.agents.length).toBeGreaterThanOrEqual(1);
    expect(parsed.agents[0]).toHaveProperty("id");
    expect(parsed.agents[0]).toHaveProperty("name");
  });
});

// ---------------------------------------------------------------------------
// update_agent dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — update_agent", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "update_agent", arguments: { name: "new-name" } },
      },
      null, // no auth
    );

    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Authentication required");
  });

  it("updates an agent profile when called by the owner", async () => {
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_agent",
          arguments: { description: "Updated description" },
        },
      },
      ALICE,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.description).toBe("Updated description");
  });
});

// ---------------------------------------------------------------------------
// seed_agent dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — seed_agent", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "seed_agent",
          arguments: {
            agent_id: "test-bot",
            name: "test-bot",
            description: "A test bot",
            sections: [],
          },
        },
      },
      null, // no auth
    );

    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Authentication required");
  });

  it("seeds a new agent when authenticated", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "seed_agent",
          arguments: {
            agent_id: "test-bot",
            name: "test-bot",
            description: "A test bot",
            sections: [],
          },
        },
      },
      ALICE,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.name).toBe("test-bot");
    expect(parsed.owner).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// delete_agent dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — delete_agent", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_agent", arguments: { agent_id: "alice--yoyo" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("deletes an agent when called by the owner", async () => {
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_agent", arguments: { agent_id: "alice--yoyo" } },
      },
      ALICE,
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.deleted).toBe(true);
  });

  it("rejects delete_agent when caller does not own the agent (cross-user)", async () => {
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    // Bob tries to delete Alice's agent
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_agent", arguments: { agent_id: "alice--yoyo" } },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/cannot modify/i);
  });
});

// ---------------------------------------------------------------------------
// vault_delete dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — vault_delete", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_delete", arguments: { vault_id: "alice--inbox" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("deletes a vault when called by the owner", async () => {
    const vault = await createVault("alice", "to-delete", "public");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_delete", arguments: { vault_id: vault.id } },
      },
      ALICE,
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.deleted).toBe(true);
  });

  it("rejects vault_delete when caller does not own the vault (cross-user)", async () => {
    const vault = await createVault("alice", "private-vault", "public");

    // Bob tries to delete Alice's vault
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_delete", arguments: { vault_id: vault.id } },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// vault_rename dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — vault_rename", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_rename", arguments: { vault_id: "alice--inbox", name: "new-name" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("renames a vault when called by the owner", async () => {
    const vault = await createVault("alice", "old-name", "public");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_rename", arguments: { vault_id: vault.id, name: "new-name" } },
      },
      ALICE,
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.renamed).toBe(true);
    expect(parsed.name).toBe("new-name");
  });

  it("rejects vault_rename when caller does not own the vault (cross-user)", async () => {
    const vault = await createVault("alice", "alice-vault", "public");

    // Bob tries to rename Alice's vault
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_rename", arguments: { vault_id: vault.id, name: "stolen-vault" } },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// query_history dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — query_history", () => {
  it("query_history is read-only (no auth required)", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "query_history");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("returns entries for a valid owner", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "query_history", arguments: { owner: "alice" } },
      },
      null, // no auth — read-only
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("returns entries with optional limit param", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "query_history", arguments: { owner: "alice", limit: 5 } },
      },
      null,
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
  });

  it("tools/list includes query_history", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("query_history");
  });
});

// ---------------------------------------------------------------------------
// ingest_image dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_image", () => {
  it("ingest_image is write-gated", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "ingest_image");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  it("blocks unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "ingest_image", arguments: { url: "https://example.com/img.png" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("tools/list includes ingest_image", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("ingest_image");
  });
});

// ---------------------------------------------------------------------------
// ingest_pdf dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_pdf", () => {
  it("ingest_pdf is write-gated", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "ingest_pdf");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  it("blocks unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "ingest_pdf", arguments: { pdf_url: "https://example.com/doc.pdf" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("tools/list includes ingest_pdf", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("ingest_pdf");
  });
});

// ---------------------------------------------------------------------------
// ingest_x_mention dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_x_mention", () => {
  it("ingest_x_mention is write-gated", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "ingest_x_mention");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  it("blocks unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "ingest_x_mention",
          arguments: { url: "https://x.com/user/status/123", triggered_by: "@alice" },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("tools/list includes ingest_x_mention", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("ingest_x_mention");
  });
});
