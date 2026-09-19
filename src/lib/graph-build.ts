/**
 * Shared graph-building logic for the wiki knowledge graph.
 *
 * Used by both the HTTP API (`GET /api/wiki/graph`) and the MCP `wiki_graph`
 * tool so the node/edge shape stays consistent across surfaces.
 *
 * This module is server-only (imports from wiki/commons/search which depend on
 * Clerk and storage). The pure `detectCommunities` algorithm stays in
 * `./graph.ts` so client components can import it without pulling in server
 * dependencies.
 */

import {
  tryReadWikiPageWithFrontmatter,
  listReadableWikiPages,
  isAgentScopedType,
  isArtifactType,
} from "./wiki";
import { ownerToTenant } from "./links";
import { listCommonsPages } from "./commons";
import { expandMineScope, resolveScope } from "./search";
import type { Principal } from "./auth";

export interface GraphNode {
  id: string;
  label: string;
  /** Canonical tenant for the node, so clicks navigate to `/u/<tenant>/<slug>`. */
  tenant: string;
  linkCount: number;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
}

/**
 * Build the wiki knowledge graph for a given scope.
 *
 * @param scope     - `null`/`undefined` → commons graph; `"mine"` → current
 *                    user's pages; `"owner:<handle>"` / `"vault:<id>"` → that
 *                    silo.
 * @param principal - The authenticated user (needed to resolve `"mine"` scope).
 * @returns `{ nodes, edges }` — every page as a node, every cross-reference as
 *          an edge, with `linkCount` computed (inbound + outbound).
 */
export async function buildWikiGraph(
  scope: string | null,
  principal: Principal | null,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const expanded = expandMineScope(scope ?? undefined, principal);

  let pages;
  if (expanded) {
    const resolved = await resolveScope(expanded);
    const scopeSet = new Set(resolved?.slugs ?? []);
    // Artifacts are excluded from the graph at every scope (incl. a vault that
    // curated one) — they're rendered outputs, not knowledge nodes. The commons
    // (unscoped) branch is already artifact-free via listCommonsPages.
    pages = (await listReadableWikiPages(principal)).filter(
      (p) =>
        scopeSet.has(p.slug) &&
        !isAgentScopedType(p.type) &&
        !isArtifactType(p.type),
    );
  } else {
    pages = await listCommonsPages();
  }
  const slugSet = new Set(pages.map((p) => p.slug));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // First pass: build nodes (with tags) and collect edges
  for (const page of pages) {
    const wp = await tryReadWikiPageWithFrontmatter(page.slug, "graph");
    const rawTags = wp?.frontmatter?.tags;
    const tags: string[] = Array.isArray(rawTags)
      ? rawTags.map(String)
      : typeof rawTags === "string"
        ? [rawTags]
        : [];

    nodes.push({
      id: page.slug,
      label: wp?.title ?? page.title,
      tenant: ownerToTenant(page.owner),
      linkCount: 0, // computed below
      tags,
    });

    if (!wp) continue;

    const linkRe = /\[([^\]]*)\]\(([^)]+)\.md\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(wp.body)) !== null) {
      const target = match[2];
      if (target !== page.slug && slugSet.has(target)) {
        edges.push({ source: page.slug, target });
      }
    }
  }

  // Second pass: compute linkCount (inbound + outbound) per node
  const countMap = new Map<string, number>();
  for (const edge of edges) {
    countMap.set(edge.source, (countMap.get(edge.source) ?? 0) + 1);
    countMap.set(edge.target, (countMap.get(edge.target) ?? 0) + 1);
  }
  for (const node of nodes) {
    node.linkCount = countMap.get(node.id) ?? 0;
  }

  return { nodes, edges };
}
