import { NextResponse } from "next/server";
import { readWikiPageWithFrontmatter, writeWikiPageWithSideEffects, tenantForOwner } from "@/lib/wiki";
import { listRevisions, readRevision, readRevisionMeta } from "@/lib/revisions";
import { extractSummary } from "@/lib/ingest";
import { serializeFrontmatter } from "@/lib/frontmatter";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { canReadSlug, canWriteFrontmatter, canReadFrontmatter } from "@/lib/authz";
import { getErrorMessage } from "@/lib/errors";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * GET /api/wiki/[slug]/revisions
 *
 * Without query params: returns `{ revisions: Revision[] }`.
 * With `?timestamp=<ms>`: returns `{ content: string, revision: Revision }` for
 * a specific revision.
 *
 * 404 if the page doesn't exist.
 * 200 with empty array if the page exists but has no revisions.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    // Check the page exists first (and grab frontmatter for tenant resolution).
    const page = await readWikiPageWithFrontmatter(slug);
    if (!page) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    // A private page's revision history is owner-only (404 otherwise).
    if (!(await canReadSlug(slug, await getPrincipal()))) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    const url = new URL(req.url);
    const timestampParam = url.searchParams.get("timestamp");
    const owner = typeof page.frontmatter.owner === "string" ? page.frontmatter.owner : undefined;
    const tenant = tenantForOwner(owner);

    if (timestampParam !== null) {
      // Fetch a specific revision's content.
      const timestamp = Number(timestampParam);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return NextResponse.json(
          { error: "timestamp must be a positive number" },
          { status: 400 },
        );
      }

      const content = await readRevision(slug, timestamp, tenant);
      if (content === null) {
        return NextResponse.json(
          { error: `revision not found: ${timestamp}` },
          { status: 404 },
        );
      }

      // Read optional author/reason sidecar.
      const meta = await readRevisionMeta(slug, timestamp, tenant);

      return NextResponse.json({
        content,
        revision: {
          timestamp,
          date: new Date(timestamp).toISOString(),
          slug,
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          ...(meta?.author !== undefined && { author: meta.author }),
          ...(meta?.reason !== undefined && { reason: meta.reason }),
        },
      });
    }

    // List all revisions.
    const revisions = await listRevisions(slug, tenant);
    return NextResponse.json({ revisions });
  } catch (err) {
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * POST /api/wiki/[slug]/revisions
 *
 * Body: `{ action: "revert", timestamp: number }`
 *
 * Reverts the page to the content from the given revision. Uses
 * `writeWikiPageWithSideEffects` so index, cross-refs, and log stay consistent.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    if (
      !body ||
      typeof body !== "object" ||
      !("action" in body) ||
      (body as { action: unknown }).action !== "revert"
    ) {
      return NextResponse.json(
        { error: 'action must be "revert"' },
        { status: 400 },
      );
    }

    const timestamp = (body as { timestamp?: unknown }).timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
      return NextResponse.json(
        { error: "timestamp must be a positive number" },
        { status: 400 },
      );
    }

    // Ensure the page exists.
    const existing = await readWikiPageWithFrontmatter(slug);
    if (!existing) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    // Realm-aware write ACL. A revert is a write — use the same cloak pattern
    // as PUT: private page non-reader → 404, readable-but-unwritable → 403.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);
    if (!canWriteFrontmatter(existing.frontmatter, principal, "body")) {
      return canReadFrontmatter(existing.frontmatter, principal)
        ? NextResponse.json(
            { error: "You don't have permission to revert this page." },
            { status: 403 },
          )
        : NextResponse.json(
            { error: `page not found: ${slug}` },
            { status: 404 },
          );
    }

    // Load the revision content.
    const existingOwner = typeof existing.frontmatter.owner === "string" ? existing.frontmatter.owner : undefined;
    const tenant = tenantForOwner(existingOwner);
    const revisionContent = await readRevision(slug, timestamp, tenant);
    if (revisionContent === null) {
      return NextResponse.json(
        { error: `revision not found: ${timestamp}` },
        { status: 404 },
      );
    }

    // Derive title from the revision content's first H1, falling back to
    // the existing page title.
    const titleMatch = revisionContent.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : existing.title;

    // Strip the leading H1 before deriving the summary.
    const bodyForSummary = revisionContent.replace(/^#\s+.+$/m, "").trim();
    const summary = extractSummary(bodyForSummary);

    // Merge frontmatter: use the existing page's frontmatter but bump the
    // `updated` date to today so the timeline reflects the revert.
    const today = new Date().toISOString().slice(0, 10);
    const mergedFrontmatter = { ...existing.frontmatter };
    if (
      typeof mergedFrontmatter.created !== "string" ||
      mergedFrontmatter.created === ""
    ) {
      mergedFrontmatter.created = today;
    }
    mergedFrontmatter.updated = today;

    // If the revision content already has its own frontmatter block we use
    // it as-is (the old snapshot is the full page including YAML). Otherwise
    // we prepend the merged frontmatter.
    const hasYamlBlock = revisionContent.trimStart().startsWith("---");
    const finalContent = hasYamlBlock
      ? revisionContent
      : serializeFrontmatter(mergedFrontmatter, revisionContent);

    const result = await writeWikiPageWithSideEffects({
      slug,
      title,
      content: finalContent,
      summary,
      logOp: "edit",
      crossRefSource: revisionContent,
      author: principal?.handle,
      logDetails: (ctx) =>
        `reverted to revision ${new Date(timestamp).toISOString()} · updated ${ctx.updatedSlugs.length} cross-ref(s)`,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
