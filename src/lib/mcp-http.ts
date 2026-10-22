/**
 * Stateless JSON-RPC dispatch for the REMOTE (HTTP) MCP endpoint at
 * `/api/mcp`. yopedia's MCP server is otherwise stdio-only; this exposes the
 * same tools to external agents (Claude Desktop/Code, Cursor, OpenClaw) over
 * HTTP so they can read and ingest into a DEPLOYED instance.
 *
 * Transport: Streamable-HTTP in **stateless** mode — supports both MCP v1
 * (initialize/initialized handshake) and v2 (2026-07-28 spec: server/discover,
 * per-request _meta, resultType) during the transition period. Each POST is one
 * self-contained JSON-RPC message (no SSE, no session). That's the only viable
 * shape on this stack (Cloudflare Workers, no Durable Objects for the SDK's
 * session-backed transport), and it's enough for `initialize` → `tools/list` →
 * `tools/call`.
 *
 * Tool handlers are REUSED from the stdio server (`@/mcp`) — single source of
 * truth, no parallel write-path to drift (see `.yoyo/learnings.md`). All 49
 * tools are exposed — full parity with the stdio MCP server.
 *
 * Auth/attribution lives in the route (`src/app/api/mcp/route.ts`): a Bearer
 * token resolves to an `owner` handle; WRITE tools require it and attribute the
 * page to that owner. Reads run unauthenticated against the public commons.
 */
import {
  handleSearchWiki,
  handleReadPage,
  handleListPages,
  handleQueryWiki,
  handleIngestUrl,
  handleBatchIngest,
  handleIngestText,
  handleReingest,
  handleCreatePage,
  handleUpdatePage,
  handleDeletePage,
  handleSaveQueryAnswer,
  handleMaintenanceScan,
  handlePublishToCommons,
  handleUpdateMetadata,
  handleLintWiki,
  handleFixLintIssue,
  handleReconcilePage,
  handleListDiscussions,
  handleReadDiscussion,
  handleCreateDiscussion,
  handleAddComment,
  handleResolveDiscussion,
  handleListRevisions,
  handleReadRevision,
  handleRevertRevision,
  handleListVaults,
  handleVaultPages,
  handleVaultCurate,
  handleVaultUncurate,
  handleVaultCreate,
  handleVaultRename,
  handleVaultDelete,
  handleAgentContext,
  handleListAgents,
  handleUpdateAgent,
  handleDeleteAgent,
  handleSeedAgent,
  handleQueryHistory,
  handleDataviewQuery,
  handleWikiGraph,
  handleActivityTrail,
  handleIngestHistory,
  handleIngestImage,
  handleIngestPdf,
  handleIngestXMention,
  handleListContributors,
  handleGetContributor,
} from "@/mcp";
import { mergePages } from "@/lib/merge";
import { readWikiPageWithFrontmatter } from "@/lib/wiki";
import { canWriteFrontmatter } from "@/lib/authz";
import { addToVault, vaultOwnedBy } from "@/lib/vault";
import { getAgent, agentIdFor, assertCanMutateAgent } from "@/lib/agents";
import { logger } from "@/lib/logger";
import type { Principal } from "@/lib/auth";

/** The resolved vault that an authenticated caller's ingests are filed into. */
export interface TargetVault {
  id: string;
  name: string;
}

/** Protocol version we advertise in `initialize`. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SERVER_INFO = { name: "yopedia", version: "1.0.0" } as const;

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  const r = result && typeof result === "object"
    ? (result as Record<string, unknown>)
    : {};
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      ...r,
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
        ...(r._meta as Record<string, unknown> ?? {}),
      },
    },
  };
}
function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** A tool result in MCP's content shape. `isError` surfaces a handled failure. */
function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: jsonText(data) }],
    ...(isError ? { isError: true } : {}),
  };
}
function jsonText(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Curated tool registry
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Write tools require an authenticated principal; reads don't. */
  write: boolean;
  run: (
    args: Record<string, unknown>,
    principal: Principal | null,
  ) => Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const schema = (
  props: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

/** Owner-attribution for writes: every write tool stamps the resolved owner. */
function attributed(
  args: Record<string, unknown>,
  owner: string,
): Record<string, unknown> {
  // Handlers destructure only the fields they accept; extra keys are ignored.
  return { ...args, owner, author: owner, triggeredBy: owner };
}

export const MCP_TOOLS: ToolDef[] = [
  {
    name: "search_wiki",
    description: "Search yopedia wiki pages by query string (public commons).",
    inputSchema: schema(
      {
        query: str("Search query"),
        limit: { type: "number", description: "Max results (default 10)" },
        scope: str("Optional scope, e.g. 'agent:yoyo' or 'vault:<id>'"),
      },
      ["query"],
    ),
    write: false,
    run: (a) => handleSearchWiki(a as Parameters<typeof handleSearchWiki>[0]),
  },
  {
    name: "read_page",
    description: "Read a single wiki page (markdown + frontmatter) by slug.",
    inputSchema: schema({ slug: str("Page slug") }, ["slug"]),
    write: false,
    run: (a) => handleReadPage(a as Parameters<typeof handleReadPage>[0]),
  },
  {
    name: "list_pages",
    description: "List wiki pages, optionally sorted.",
    inputSchema: schema({
      sort: str("title | updated | confidence"),
      limit: { type: "number", description: "Max results" },
    }),
    write: false,
    run: (a) => handleListPages(a as Parameters<typeof handleListPages>[0]),
  },
  {
    name: "query_wiki",
    description:
      "Ask a question; returns an LLM-synthesized, cited answer from the wiki.",
    inputSchema: schema(
      {
        question: str("The question to answer"),
        format: str("prose | table | slides | html (default prose)"),
        scope: str("Optional scope, e.g. 'agent:yoyo' or 'vault:<id>'"),
      },
      ["question"],
    ),
    write: false,
    run: (a) => handleQueryWiki(a as Parameters<typeof handleQueryWiki>[0]),
  },
  {
    name: "ingest_url",
    description:
      "Fetch a URL (web/YouTube/X/PDF), summarize, and save it as a wiki page in YOUR content.",
    inputSchema: schema(
      {
        url: str("The URL to ingest"),
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      ["url"],
    ),
    write: true,
    run: (a, p) =>
      handleIngestUrl(
        attributed(a, p!.handle) as Parameters<typeof handleIngestUrl>[0],
      ),
  },
  {
    name: "batch_ingest_urls",
    description:
      "Ingest multiple URLs in one call. Validates all URLs upfront (rejects the batch if any are malformed), " +
      "then ingests sequentially and returns per-URL success/failure results.",
    inputSchema: schema(
      {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "URLs to ingest (required)",
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags applied to all URLs" },
        vaultId: str("Optional vault ID to file results into"),
      },
      ["urls"],
    ),
    write: true,
    run: (a, p) =>
      handleBatchIngest(
        attributed(a, p!.handle) as Parameters<typeof handleBatchIngest>[0],
      ),
  },
  {
    name: "ingest_text",
    description: "Ingest raw text/markdown as a wiki page in YOUR content.",
    inputSchema: schema(
      {
        content: str("The text to ingest"),
        title: str("Optional title"),
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      ["content"],
    ),
    write: true,
    run: (a, p) =>
      handleIngestText(
        attributed(a, p!.handle) as Parameters<typeof handleIngestText>[0],
      ),
  },
  {
    name: "ingest_image",
    description:
      "Download an image URL, analyze it with a vision model, and save the result as a wiki page in YOUR content.",
    inputSchema: schema(
      {
        url: str("The image URL to ingest"),
        prompt: str("Optional prompt to guide the vision model analysis"),
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      ["url"],
    ),
    write: true,
    run: (a, p) =>
      handleIngestImage(
        attributed(a, p!.handle) as Parameters<typeof handleIngestImage>[0],
      ),
  },
  {
    name: "ingest_pdf",
    description:
      "Download a PDF from a URL, extract text, chunk and summarize, and save it as a wiki page in YOUR content.",
    inputSchema: schema(
      {
        pdf_url: str("The PDF URL to ingest"),
        title: str("Optional title for the page"),
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      ["pdf_url"],
    ),
    write: true,
    run: (a, p) =>
      handleIngestPdf(
        attributed(a, p!.handle) as Parameters<typeof handleIngestPdf>[0],
      ),
  },
  {
    name: "ingest_x_mention",
    description:
      "Fetch an X/Twitter post, extract its content, and save it as a wiki page with mention provenance in YOUR content.",
    inputSchema: schema(
      {
        url: str("The X/Twitter post URL to ingest"),
        triggered_by: str("The X handle that triggered this ingest (e.g. @username)"),
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      ["url", "triggered_by"],
    ),
    write: true,
    run: (a, p) =>
      handleIngestXMention(
        attributed(a, p!.handle) as Parameters<typeof handleIngestXMention>[0],
      ),
  },
  {
    name: "create_page",
    description: "Create a new wiki page (markdown) in YOUR content.",
    inputSchema: schema(
      {
        slug: str("Page slug"),
        content: str("Markdown body"),
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      ["slug", "content"],
    ),
    write: true,
    run: (a, p) =>
      handleCreatePage(
        attributed(a, p!.handle) as Parameters<typeof handleCreatePage>[0],
      ),
  },
  {
    name: "update_page",
    description:
      "Update an existing wiki page's content (markdown). Merges caller-supplied " +
      "frontmatter with the existing page's metadata. Requires write permission on the page.",
    inputSchema: schema(
      {
        slug: str("Slug of the page to update"),
        content: str("New markdown body"),
      },
      ["slug", "content"],
    ),
    write: true,
    run: (a, p) => {
      const { author, ...rest } = attributed(a, p!.handle) as Record<string, unknown>;
      return handleUpdatePage({
        ...(rest as { slug: string; content: string; owner?: string }),
        author: author as string,
        principal: p,
      });
    },
  },
  {
    name: "delete_page",
    description:
      "Delete a wiki page. Requires write permission on the page.",
    inputSchema: schema(
      {
        slug: str("Slug of the page to delete"),
      },
      ["slug"],
    ),
    write: true,
    run: (a, p) => {
      const { author } = attributed(a, p!.handle) as Record<string, unknown>;
      return handleDeletePage({
        slug: (a as { slug: string }).slug,
        author: author as string,
        principal: p,
      });
    },
  },
  {
    name: "save_query_answer",
    description: "Persist a question + answer as a wiki page in YOUR content.",
    inputSchema: schema(
      {
        question: str("The question"),
        answer: str("The answer (markdown/html/slides)"),
        slug: str("Optional explicit slug"),
        sources: { type: "array", items: { type: "string" }, description: "Cited slugs" },
        format: str("markdown | html | slides"),
      },
      ["question", "answer"],
    ),
    write: true,
    run: (a, p) =>
      handleSaveQueryAnswer(
        attributed(a, p!.handle) as Parameters<typeof handleSaveQueryAnswer>[0],
      ),
  },
  {
    name: "reingest",
    description: "Re-fetch a page's original source and refresh it.",
    inputSchema: schema({ slug: str("Page slug to re-ingest") }, ["slug"]),
    write: true,
    // Enforce the same write ACL as the REST reingest route: you can only
    // re-synthesize a page you may write (public commons = collectively
    // editable; another user's PRIVATE page = denied). Without this, any
    // token-holder could overwrite/fork others' pages. A missing/unauthorized
    // page throws a single cloaked error (no private-page existence oracle).
    run: async (a, p) => {
      const slug = typeof a.slug === "string" ? a.slug : "";
      const page = slug ? await readWikiPageWithFrontmatter(slug) : null;
      if (!page || !canWriteFrontmatter(page.frontmatter, p, "body")) {
        throw new Error(
          `Page not found or you don't have permission to re-ingest it: ${slug || "(missing slug)"}`,
        );
      }
      return handleReingest(attributed({ slug }, p!.handle) as Parameters<typeof handleReingest>[0]);
    },
  },
  {
    name: "maintenance_scan",
    description:
      "Scan the wiki for maintenance tasks (disputed pages, expired sources, orphans, broken links). Read-only — returns candidates; does not enqueue or execute work.",
    inputSchema: schema({
      cap: { type: "number", description: "Max tasks to return (default 10)" },
    }),
    write: false,
    run: (a) =>
      handleMaintenanceScan(
        a as Parameters<typeof handleMaintenanceScan>[0],
      ),
  },
  {
    name: "publish_to_commons",
    description:
      "Publish an agent-knowledge page to the public commons. Clears the agent type, " +
      "transfers ownership to the agent's human owner, preserves the agent in contributors[]. " +
      "One-way promotion — cannot be unpublished.",
    inputSchema: schema(
      {
        slug: str("Slug of the agent-knowledge page to publish"),
        agentId: str("ID of the agent that owns the page (e.g. alice--yoyo)"),
      },
      ["slug", "agentId"],
    ),
    write: true,
    run: async (a, p) => {
      const args = a as Parameters<typeof handlePublishToCommons>[0];
      // Verify the caller owns the agent whose page is being published.
      const agent = await getAgent(args.agentId);
      if (!agent) throw new Error(`Agent not found: ${args.agentId}`);
      if (!agent.owner || agent.owner !== p!.handle) {
        throw new Error(
          `Ownership mismatch: only the agent's owner can publish its pages to the commons.`,
        );
      }
      return handlePublishToCommons(args);
    },
  },
  {
    name: "update_metadata",
    description:
      "Update a wiki page's frontmatter metadata (confidence, disputed, tags, aliases, expiry) " +
      "without modifying the page body. Lifecycle-managed fields (created, authors, sources) are rejected.",
    inputSchema: schema(
      {
        slug: str("Slug of the page to update"),
        metadata: {
          type: "object",
          description:
            "Object of metadata fields to update. Allowed: confidence, disputed, tags, aliases, expiry, valid_from, supersedes, visibility.",
          additionalProperties: true,
        },
      },
      ["slug", "metadata"],
    ),
    write: true,
    run: (a, p) =>
      handleUpdateMetadata({
        ...(a as { slug: string; metadata: Record<string, unknown> }),
        author: p!.handle,
        principal: p,
      }),
  },
  {
    name: "lint_wiki",
    description:
      "Run quality checks on the wiki. Returns issues with type, severity, slug, and message. " +
      "Optionally scope to specific check types or minimum severity.",
    inputSchema: schema({
      checks: {
        type: "array",
        items: { type: "string" },
        description: "Check types to run (default: all)",
      },
      minSeverity: str("Minimum severity: error | warning | info (default: info)"),
    }),
    write: false,
    run: (a) => handleLintWiki(a as Parameters<typeof handleLintWiki>[0]),
  },
  {
    name: "fix_lint_issue",
    description:
      "Auto-fix a lint issue found by lint_wiki. Takes the issue type, slug, and optional target/message. " +
      "Not all issue types are auto-fixable.",
    inputSchema: schema(
      {
        type: str("Lint issue type (e.g. 'orphan-page', 'stale-index', 'empty-page')"),
        slug: str("Slug of the affected page"),
        target: str("Target slug for cross-ref, contradiction, broken-link, and duplicate-entity fixes"),
        message: str("Message context for contradiction or missing-concept-page fixes"),
      },
      ["type", "slug"],
    ),
    write: true,
    run: (a, p) =>
      handleFixLintIssue({
        ...(a as { type: string; slug: string; target?: string; message?: string }),
        author: p!.handle,
      }),
  },
  {
    name: "reconcile_page",
    description:
      "Reconcile a wiki page by applying valid points from a discussion thread. " +
      "Reads the page and thread, LLM-revises the page, posts a summary comment, and resolves the thread.",
    inputSchema: schema(
      {
        pageSlug: str("Slug of the wiki page to reconcile"),
        threadIndex: { type: "number", description: "Zero-based index of the discussion thread" },
      },
      ["pageSlug", "threadIndex"],
    ),
    write: true,
    run: (a, p) =>
      handleReconcilePage({
        ...(a as { pageSlug: string; threadIndex: number }),
        author: p!.handle,
      }),
  },
  {
    name: "merge_pages",
    description:
      "Merge one wiki page into another: folds both bodies into the target (LLM reconcile), " +
      "unions their sources/aliases, re-points links, records the absorbed slug as an alias " +
      "of the survivor so its URL redirects, then deletes the absorbed page. " +
      "Use to fix duplicate-entity lint issues.",
    inputSchema: schema(
      {
        from: str("Slug of the page to absorb (will be deleted)"),
        into: str("Slug of the surviving canonical page"),
      },
      ["from", "into"],
    ),
    write: true,
    run: (a, p) =>
      mergePages({
        from: (a as { from: string }).from,
        into: (a as { into: string }).into,
        actor: p!.handle,
        bypassOwnerCheck: false,
      }),
  },
  // -- Discussion tools ---------------------------------------------------
  {
    name: "list_discussions",
    description:
      "List all discussion threads for a wiki page (public, read-only).",
    inputSchema: schema(
      { pageSlug: str("Slug of the wiki page to list discussions for") },
      ["pageSlug"],
    ),
    write: false,
    run: (a) =>
      handleListDiscussions(a as Parameters<typeof handleListDiscussions>[0]),
  },
  {
    name: "read_discussion",
    description:
      "Read a single discussion thread with full comment bodies (public, read-only). " +
      "Use list_discussions first to discover thread indices.",
    inputSchema: schema(
      {
        pageSlug: str("Slug of the wiki page the discussion belongs to"),
        threadIndex: { type: "number", description: "Zero-based index of the thread (from list_discussions)" },
      },
      ["pageSlug", "threadIndex"],
    ),
    write: false,
    run: (a) =>
      handleReadDiscussion(a as Parameters<typeof handleReadDiscussion>[0]),
  },
  {
    name: "create_discussion",
    description:
      "Start a new discussion thread on a wiki page for editorial discussion.",
    inputSchema: schema(
      {
        pageSlug: str("Slug of the wiki page to discuss"),
        title: str("Title of the discussion thread"),
        body: str("Opening comment body (markdown)"),
      },
      ["pageSlug", "title", "body"],
    ),
    write: true,
    run: (a, p) =>
      handleCreateDiscussion({
        ...(a as { pageSlug: string; title: string; body: string }),
        author: p!.handle,
      }),
  },
  {
    name: "add_comment",
    description:
      "Add a comment to an existing discussion thread on a wiki page.",
    inputSchema: schema(
      {
        pageSlug: str("Slug of the wiki page the discussion belongs to"),
        threadIndex: { type: "number", description: "Zero-based index of the thread" },
        content: str("Comment body (markdown)"),
        parentId: str("Optional parent comment ID for threaded replies"),
      },
      ["pageSlug", "threadIndex", "content"],
    ),
    write: true,
    run: (a, p) =>
      handleAddComment({
        ...(a as { pageSlug: string; threadIndex: number; content: string; parentId?: string }),
        author: p!.handle,
      }),
  },
  {
    name: "resolve_discussion",
    description:
      "Resolve a discussion thread on a wiki page (mark as resolved or wontfix).",
    inputSchema: schema(
      {
        pageSlug: str("Slug of the wiki page the discussion belongs to"),
        threadIndex: { type: "number", description: "Zero-based index of the thread" },
        resolution: str("Resolution status: open | resolved | wontfix"),
      },
      ["pageSlug", "threadIndex", "resolution"],
    ),
    write: true,
    run: (a, _p) =>
      handleResolveDiscussion(
        a as Parameters<typeof handleResolveDiscussion>[0],
      ),
  },
  // -- Revision tools -----------------------------------------------------
  {
    name: "list_revisions",
    description:
      "List revision history for a wiki page (public, read-only). Returns timestamps and metadata.",
    inputSchema: schema(
      { slug: str("Slug of the wiki page") },
      ["slug"],
    ),
    write: false,
    run: (a) =>
      handleListRevisions(a as Parameters<typeof handleListRevisions>[0]),
  },
  {
    name: "read_revision",
    description:
      "Read the content of a specific revision by slug and timestamp (public, read-only). " +
      "Use list_revisions first to discover available timestamps.",
    inputSchema: schema(
      {
        slug: str("Slug of the wiki page"),
        timestamp: { type: "number", description: "Revision timestamp (from list_revisions)" },
      },
      ["slug", "timestamp"],
    ),
    write: false,
    run: (a) =>
      handleReadRevision(a as Parameters<typeof handleReadRevision>[0]),
  },
  {
    name: "revert_revision",
    description:
      "Revert a wiki page to a previous revision. Restores the page content from the specified timestamp.",
    inputSchema: schema(
      {
        slug: str("Slug of the wiki page to revert"),
        timestamp: { type: "number", description: "Revision timestamp to revert to (from list_revisions)" },
      },
      ["slug", "timestamp"],
    ),
    write: true,
    run: (a, p) =>
      handleRevertRevision({
        ...(a as { slug: string; timestamp: number }),
        author: p!.handle,
      }),
  },
  // -- Vault tools ----------------------------------------------------------
  {
    name: "list_vaults",
    description:
      "List named vaults for a user (public, read-only). " +
      "Defaults to the authenticated caller's vaults when no owner is specified.",
    inputSchema: schema({
      owner: str("Owner handle (defaults to your own handle when authenticated)"),
    }),
    write: false,
    run: (a, p) => {
      const owner = (a as { owner?: string }).owner ?? p?.handle;
      if (!owner) {
        return Promise.reject(
          new Error("owner is required when not authenticated"),
        );
      }
      return handleListVaults({ owner });
    },
  },
  {
    name: "vault_pages",
    description:
      "List enriched page metadata for a named vault (slug, title, summary, tags, confidence). " +
      "Defaults to the authenticated caller's vaults when no owner is specified.",
    inputSchema: schema(
      {
        owner: str("Owner handle (defaults to your own handle when authenticated)"),
        vault: str("Vault name"),
      },
      ["vault"],
    ),
    write: false,
    run: (a, p) => {
      const args = a as { owner?: string; vault: string };
      const owner = args.owner ?? p?.handle;
      if (!owner) {
        return Promise.reject(
          new Error("owner is required when not authenticated"),
        );
      }
      return handleVaultPages({ owner, vault: args.vault });
    },
  },
  {
    name: "vault_curate",
    description:
      "Curate a commons page into one of your named vaults. " +
      "Auto-creates the vault on first use.",
    inputSchema: schema(
      {
        slug: str("Page slug to curate"),
        vault: str("Vault name"),
      },
      ["slug", "vault"],
    ),
    write: true,
    run: (a, p) => {
      const args = a as { slug: string; vault: string };
      return handleVaultCurate({ slug: args.slug, owner: p!.handle, vault: args.vault });
    },
  },
  {
    name: "vault_create",
    description: "Create a new named vault.",
    inputSchema: schema(
      { name: str("Vault name") },
      ["name"],
    ),
    write: true,
    run: (a, p) => {
      const args = a as { name: string };
      return handleVaultCreate({ owner: p!.handle, name: args.name });
    },
  },
  {
    name: "vault_uncurate",
    description:
      "Remove a curated page from one of your named vaults.",
    inputSchema: schema(
      {
        slug: str("Page slug to remove"),
        vault: str("Vault name"),
      },
      ["slug", "vault"],
    ),
    write: true,
    run: (a, p) => {
      const args = a as { slug: string; vault: string };
      return handleVaultUncurate({ slug: args.slug, owner: p!.handle, vault: args.vault });
    },
  },
  // -- Agent context --------------------------------------------------------
  {
    name: "agent_context",
    description:
      "Bootstrap an agent's identity context — returns identity, learnings, " +
      "social wisdom, and metadata in a single payload. Call once at startup.",
    inputSchema: schema(
      { agent_id: str("Agent ID (e.g. 'yoyo')") },
      ["agent_id"],
    ),
    write: false,
    run: (a) =>
      handleAgentContext(a as Parameters<typeof handleAgentContext>[0]),
  },
  {
    name: "list_agents",
    description:
      "List all registered agents with their IDs, names, descriptions, and timestamps.",
    inputSchema: schema({}),
    write: false,
    run: () => handleListAgents(),
  },
  {
    name: "update_agent",
    description:
      "Update the authenticated caller's agent profile — modify name, description, " +
      "add or remove pages. The agent_id is scoped to the caller's identity.",
    inputSchema: schema({
      name: str("New display name"),
      description: str("New description"),
      addPages: {
        type: "array",
        description: "Pages to create and add to the agent profile",
        items: {
          type: "object",
          properties: {
            slug: str("Wiki page slug for this section"),
            title: str("Page title"),
            type: { type: "string", description: "Section type", enum: ["identity", "learnings", "social"] },
            content: str("Markdown content for this section"),
          },
          required: ["slug", "title", "type", "content"],
        },
      },
      removePages: {
        type: "array",
        description: "Page slugs to remove from the agent profile (does not delete wiki pages)",
        items: { type: "string" },
      },
    }),
    write: true,
    run: async (a, p) => {
      // Resolve the caller's agent id from their principal and verify ownership.
      const agentId = agentIdFor(p!.handle);
      const agent = await getAgent(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
      if (agent.owner && agent.owner !== p!.handle) {
        throw new Error(
          `Ownership mismatch: only the agent's owner can update its profile.`,
        );
      }
      return handleUpdateAgent({ ...a, agent_id: agentId } as Parameters<typeof handleUpdateAgent>[0]);
    },
  },
  {
    name: "seed_agent",
    description:
      "Bootstrap (create or re-seed) an agent profile with identity, learnings, " +
      "and social sections. The owner is set to the authenticated caller.",
    inputSchema: schema(
      {
        agent_id: str("Agent ID (e.g. 'yoyo')"),
        name: str("Display name"),
        description: str("Agent description"),
        sections: {
          type: "array",
          description: "Content sections to create as wiki pages",
          items: {
            type: "object",
            properties: {
              slug: str("Wiki page slug for this section"),
              title: str("Page title"),
              type: { type: "string", description: "Section type", enum: ["identity", "learnings", "social"] },
              content: str("Markdown content for this section"),
            },
            required: ["slug", "title", "type", "content"],
          },
        },
      },
      ["agent_id", "name", "description", "sections"],
    ),
    write: true,
    run: (a, p) => {
      // Stamp the authenticated caller as owner.
      const args = { ...a, owner: p!.handle } as Parameters<typeof handleSeedAgent>[0];
      return handleSeedAgent(args);
    },
  },
  {
    name: "delete_agent",
    description:
      "Delete the authenticated caller's agent profile. The agent_id must belong to the caller.",
    inputSchema: schema({ agent_id: str("Agent ID to delete") }, ["agent_id"]),
    write: true,
    run: async (a, p) => {
      const agentId = String(a.agent_id);
      await assertCanMutateAgent(agentId, p!.handle);
      return handleDeleteAgent({ agent_id: agentId });
    },
  },
  // -- Vault lifecycle (write-gated) ----------------------------------------
  {
    name: "vault_delete",
    description:
      "Delete a vault owned by the authenticated caller. The vault_id must belong to the caller.",
    inputSchema: schema({ vault_id: str("Vault ID to delete") }, ["vault_id"]),
    write: true,
    run: async (a, p) => {
      const vaultId = String(a.vault_id);
      if (!vaultOwnedBy(vaultId, p!.handle)) {
        throw new Error(
          `Permission denied: vault "${vaultId}" is not owned by @${p!.handle}.`,
        );
      }
      return handleVaultDelete({ vault_id: vaultId });
    },
  },
  {
    name: "vault_rename",
    description:
      "Rename a vault owned by the authenticated caller.",
    inputSchema: schema(
      { vault_id: str("Vault ID to rename"), name: str("New vault name") },
      ["vault_id", "name"],
    ),
    write: true,
    run: async (a, p) => {
      const vaultId = String(a.vault_id);
      if (!vaultOwnedBy(vaultId, p!.handle)) {
        throw new Error(
          `Permission denied: vault "${vaultId}" is not owned by @${p!.handle}.`,
        );
      }
      return handleVaultRename({ vault_id: vaultId, name: String(a.name) });
    },
  },
  // -- Query history (read-only) --------------------------------------------
  {
    name: "query_history",
    description:
      "View past query history for an owner. Returns a JSON array of recent queries with " +
      "timestamps, questions, answers, and save status.",
    inputSchema: schema({
      owner: str("Owner handle to look up history for"),
      limit: { type: "number", description: "Max entries to return (default 20)" },
    }, ["owner"]),
    write: false,
    run: (a) =>
      handleQueryHistory(a as Parameters<typeof handleQueryHistory>[0]),
  },
  // -- Knowledge structure (read-only) -------------------------------------
  {
    name: "dataview_query",
    description:
      "Query yopedia wiki pages by frontmatter fields with structured filters, sort, and limit. " +
      "Supports operators: eq, neq, gt, lt, gte, lte, contains, exists.",
    inputSchema: schema({
      filters: {
        type: "array",
        description: "Array of filter predicates (AND semantics — all must match)",
        items: {
          type: "object",
          properties: {
            field: str("Frontmatter field name (e.g. 'confidence', 'tags', 'created')"),
            op: {
              type: "string",
              description: "Comparison operator",
              enum: ["eq", "neq", "gt", "lt", "gte", "lte", "contains", "exists"],
            },
            value: str("Comparison value (not needed for 'exists' op)"),
          },
          required: ["field", "op"],
        },
      },
      sortBy: str("Frontmatter field to sort results by"),
      sortOrder: str("Sort direction: asc | desc (default asc)"),
      limit: { type: "number", description: "Maximum number of results (default 50, max 200)" },
    }),
    write: false,
    run: (a) =>
      handleDataviewQuery(a as Parameters<typeof handleDataviewQuery>[0]),
  },
  {
    name: "wiki_graph",
    description:
      "Return the wiki knowledge graph as nodes and edges. Each page is a node (slug, label, tags, " +
      "linkCount) and each cross-reference link is an edge (source, target). Useful for understanding " +
      "how concepts are connected, finding clusters, discovering poorly-linked pages, or navigating " +
      "neighborhoods without reading full page bodies.",
    inputSchema: schema({
      scope: str("Optional scope filter. Omit for the commons graph. Use 'vault:<id>' for vault-scoped."),
    }),
    write: false,
    run: (a) =>
      handleWikiGraph(a as Parameters<typeof handleWikiGraph>[0]),
  },
  // -- Activity awareness (read-only) ----------------------------------------
  {
    name: "activity_trail",
    description:
      "View recent wiki activity — ingests, re-ingests, and edits — with timestamps and actor " +
      "attribution. Returns a JSON array of TrailEvent objects sorted by most recent first. " +
      "Each event includes ts (epoch ms), when (ISO date), actor, action, slug, and title.",
    inputSchema: schema({
      limit: { type: "number", description: "Max events to return (default 20)" },
    }),
    write: false,
    run: (a) =>
      handleActivityTrail(a as Parameters<typeof handleActivityTrail>[0]),
  },
  {
    name: "ingest_history",
    description:
      "View ingest ledger entries for provenance auditing. Returns structured JSON array of past " +
      "ingest operations, most recent first. Each entry includes ingest_id, source_type, source_url, " +
      "primary_slug, related_slugs, timestamps, and status.",
    inputSchema: schema({
      limit: { type: "number", description: "Max entries to return (default 50)" },
    }),
    write: false,
    run: (a) =>
      handleIngestHistory(a as Parameters<typeof handleIngestHistory>[0]),
  },
  // -- Contributor trust awareness (read-only) --------------------------------
  {
    name: "list_contributors",
    description:
      "List all contributors with trust scores and activity summaries. Returns a JSON array of " +
      "contributor profiles including handle, editCount, revertCount, trustScore, and activity breakdown. " +
      "Useful for assessing contributor reliability before accepting, reverting, or escalating edits.",
    inputSchema: schema({}),
    write: false,
    run: () => handleListContributors(),
  },
  {
    name: "get_contributor",
    description:
      "Get a specific contributor's trust profile by handle. Returns a single contributor profile " +
      "including editCount, revertCount, trustScore, commentCount, and detailed activity. " +
      "Useful for checking a contributor's track record before acting on their edits.",
    inputSchema: schema({ handle: str("Contributor handle to look up") }, ["handle"]),
    write: false,
    run: (a) =>
      handleGetContributor(a as Parameters<typeof handleGetContributor>[0]),
  },
];

/** Public (transport-facing) tool descriptor for `tools/list`. */
function toolDescriptor(t: ToolDef) {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

/** Exposed for tests (the reingest→primarySlug filing contract). */
export const _internal = { resultSlug };

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Max JSON-RPC messages in one batch (cost/DoS guard — each may fan out to a
 *  network fetch + LLM call). */
export const MCP_MAX_BATCH = 20;

/** A new page's slug from a write-tool result. Most handlers return a top-level
 *  `slug` (ingest_url/ingest_text/create_page/save_query_answer); `reingest`
 *  returns the raw IngestResult with `primarySlug`. Probe both. */
function resultSlug(result: unknown): string | null {
  if (result && typeof result === "object") {
    const r = result as { slug?: unknown; primarySlug?: unknown };
    if (typeof r.slug === "string") return r.slug;
    if (typeof r.primarySlug === "string") return r.primarySlug;
  }
  return null;
}

/**
 * After a successful write, file the new page into the caller's per-agent target
 * vault (by reference). Fail-soft: the page is already written, so a vault hiccup
 * must never fail the call — log and return the result unchanged.
 */
async function fileIntoVault(
  result: unknown,
  targetVault: TargetVault | null,
): Promise<unknown> {
  if (!targetVault) return result;
  const slug = resultSlug(result);
  if (!slug) return result;
  try {
    await addToVault(targetVault.id, slug);
    return result && typeof result === "object"
      ? { ...result, filedIntoVault: targetVault.id }
      : result;
  } catch (err) {
    logger.warn("mcp", `vault filing failed for ${slug} → ${targetVault.id}`, err);
    return result;
  }
}

/**
 * Handle one JSON-RPC message. `principal` is the resolved caller (or null when
 * unauthenticated — reads still work); `targetVault` is the caller's per-agent
 * vault that successful ingests are filed into. Returns `null` for notifications
 * (no response body). Tool failures surface as an `isError` tool result, not a
 * JSON-RPC error, matching the stdio server's convention.
 */
export async function dispatchMcp(
  msg: JsonRpcRequest,
  principal: Principal | null,
  targetVault: TargetVault | null = null,
): Promise<JsonRpcResponse | null> {
  const { id, method } = msg;
  switch (method) {
    case "server/discover":
      return ok(id, {
        supportedVersions: [MCP_PROTOCOL_VERSION, "2025-06-18"],
        capabilities: { tools: {} },
        _meta: {
          "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
        },
        instructions: targetVault
          ? `Pages you save are filed into the user's "${targetVault.name}" vault, attributed to the user.`
          : "yopedia wiki — search, read, ingest, and query knowledge pages.",
      });
    // DEPRECATED in v2 spec (2026-07-28); kept for v1 backward compat.
    case "initialize": {
      // Tell the connecting agent where its saves land (the user configured a
      // target vault for this agent) — prompt-level transparency; the server
      // still enforces attribution + vault filing.
      const instructions = targetVault
        ? `Pages you save (ingest_url/ingest_text/create_page/save_query_answer) are filed into the user's "${targetVault.name}" vault, attributed to the user.`
        : undefined;
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        ...(instructions ? { instructions } : {}),
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response
    // DEPRECATED: removed in v2 spec (2026-07-28). Kept for v1 backward compat.
    case "ping":
      return ok(id, {});
    case "tools/list": {
      // Append the vault destination to write-tool descriptions so the agent
      // sees it in the schema, not just the initialize instructions.
      const suffix = targetVault ? ` Filed into the "${targetVault.name}" vault.` : "";
      const tools = MCP_TOOLS.map((t) => {
        const d = toolDescriptor(t);
        return t.write && suffix ? { ...d, description: d.description + suffix } : d;
      });
      // v2 spec: CacheableResult — tool list is static per deployment
      return ok(id, { tools, ttlMs: 3600000, cacheScope: "public" });
    }
    case "tools/call": {
      const params = (msg.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const tool = MCP_TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        return ok(id, toolResult(`Unknown tool: ${params.name}`, true));
      }
      if (tool.write && !principal) {
        return ok(
          id,
          toolResult(
            "Authentication required: this tool writes to your content. Send Authorization: Bearer <your yopedia token>.",
            true,
          ),
        );
      }
      try {
        const result = await tool.run(params.arguments ?? {}, principal);
        const filed = tool.write ? await fileIntoVault(result, targetVault) : result;
        return ok(id, toolResult(filed));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ok(id, toolResult(`Error: ${message}`, true));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method ?? "(none)"}`);
  }
}
