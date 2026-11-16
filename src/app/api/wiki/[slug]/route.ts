import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import {
  deleteWikiPage,
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
  type Frontmatter,
} from "@/lib/wiki";
import { extractSummary } from "@/lib/ingest";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { canReadFrontmatter, canWriteFrontmatter } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { patchMetadata } from "@/lib/patch-metadata";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);

    // Realm-aware write ACL: a private page may be deleted only by its owner
    // (or their agents / the service principal); public commons pages stay
    // collectively manageable. (The middleware already blocks unauthenticated
    // mutations; this is the per-page check on top.)
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);

    // Cost guard — wiki writes mutate storage and rebuild indexes.
    if (principal) {
      const rl = await enforceRateLimit("wiki", principal.id);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please wait before making more wiki changes." },
          { status: 429 },
        );
      }
    }

    const existing = await readWikiPageWithFrontmatter(slug);
    if (!existing) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }
    // Realm-aware write ACL. When the write is denied, CLOAK: a private page the
    // caller can't even read is 404 (no existence oracle, matching reads); a
    // readable-but-unwritable page is 403.
    if (!canWriteFrontmatter(existing.frontmatter, principal, "delete")) {
      return canReadFrontmatter(existing.frontmatter, principal)
        ? NextResponse.json(
            { error: "You don't have permission to delete this page." },
            { status: 403 },
          )
        : NextResponse.json(
            { error: `page not found: ${slug}` },
            { status: 404 },
          );
    }

    const result = await deleteWikiPage(slug, principal?.handle);
    return NextResponse.json(result);
  } catch (err) {
    const message = getErrorMessage(err);
    const status = message.startsWith("page not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * PUT /api/wiki/[slug]
 *
 * Replace the body of an existing wiki page. Returns 404 when the slug
 * doesn't exist — edit is strictly an update operation, use the ingest flow
 * (or a future create endpoint) to add new pages.
 *
 * Body: `{ content: string }` — the new markdown **body** (no YAML
 * frontmatter). The editor never exposes the YAML block to users; the
 * server owns frontmatter end-to-end.
 *
 * On save the route:
 *   1. Reads the existing page's parsed frontmatter.
 *   2. Bumps `updated` to today (YYYY-MM-DD), backfilling `created` for
 *      legacy pages that were written before frontmatter existed.
 *   3. Preserves every other key (`source_count`, `tags`, and any extras).
 *   4. Re-serializes `frontmatter + body` via {@link serializeFrontmatter}
 *      and writes through {@link writeWikiPageWithSideEffects} so the
 *      index, cross-references, and activity log all stay consistent.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    const newBody =
      body && typeof body === "object" && "content" in body
        ? (body as { content: unknown }).content
        : undefined;

    if (typeof newBody !== "string" || newBody.trim().length === 0) {
      return NextResponse.json(
        { error: "content must be a non-empty string" },
        { status: 400 },
      );
    }

    // Attribution comes from the authenticated session, never the body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);
    const authorStr = principal?.handle;

    // Cost guard — wiki writes mutate storage and rebuild indexes.
    if (principal) {
      const rl = await enforceRateLimit("wiki", principal.id);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please wait before making more wiki changes." },
          { status: 429 },
        );
      }
    }

    const existing = await readWikiPageWithFrontmatter(slug);
    if (!existing) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    // Realm-aware write ACL. Denied → cloak: a private page the caller can't
    // read is 404 (no existence oracle); readable-but-unwritable is 403.
    if (!canWriteFrontmatter(existing.frontmatter, principal, "body")) {
      return canReadFrontmatter(existing.frontmatter, principal)
        ? NextResponse.json(
            { error: "You don't have permission to edit this page." },
            { status: 403 },
          )
        : NextResponse.json(
            { error: `page not found: ${slug}` },
            { status: 404 },
          );
    }

    // Derive title from the new body's first H1, falling back to the old title.
    const titleMatch = newBody.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : existing.title;

    // Strip the leading H1 (if present) before deriving the summary so the
    // heading text doesn't end up as the summary line.
    const bodyForSummary = newBody.replace(/^#\s+.+$/m, "").trim();
    const summary = extractSummary(bodyForSummary);

    // Merge frontmatter: preserve everything the existing page had, then
    // bump `updated` (and backfill `created` for legacy pages that predate
    // frontmatter entirely). Also append the editor to `contributors` if not
    // already present.
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const mergedFrontmatter: Frontmatter = { ...existing.frontmatter };
    if (
      typeof mergedFrontmatter.created !== "string" ||
      mergedFrontmatter.created === ""
    ) {
      mergedFrontmatter.created = today;
    }
    mergedFrontmatter.updated = today;

    // Track contributors: append the editor if they're not already listed.
    if (authorStr) {
      const existingContributors = Array.isArray(mergedFrontmatter.contributors)
        ? (mergedFrontmatter.contributors as string[])
        : [];
      if (!existingContributors.includes(authorStr)) {
        mergedFrontmatter.contributors = [...existingContributors, authorStr];
      }
    }

    const mergedContent = serializeFrontmatter(mergedFrontmatter, newBody);

    const result = await writeWikiPageWithSideEffects({
      slug,
      title,
      content: mergedContent,
      summary,
      logOp: "edit",
      // Use the user-visible body as the cross-ref signal so the YAML
      // block doesn't bias related-page matching.
      crossRefSource: newBody,
      author: authorStr,
      logDetails: (ctx) =>
        `edited · updated ${ctx.updatedSlugs.length} cross-ref(s)`,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * PATCH /api/wiki/[slug]
 *
 * Update a wiki page's frontmatter metadata without replacing its body.
 * Accepts `{ metadata: Partial<Frontmatter>, author?: string }`.
 *
 * Allowed metadata keys: confidence, disputed, tags, aliases, expiry,
 * valid_from, supersedes. Lifecycle-managed keys (created, authors, sources)
 * are rejected with 400.
 *
 * On every successful PATCH the `updated` field is bumped to today. If an
 * `author` string is provided it is appended to `contributors` (deduplicated).
 *
 * Delegates to {@link patchMetadata} for the core logic.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || !("metadata" in body)) {
      return NextResponse.json(
        { error: "request body must contain a metadata object" },
        { status: 400 },
      );
    }

    const metadata = (body as { metadata: unknown }).metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return NextResponse.json(
        { error: "metadata must be a non-null object" },
        { status: 400 },
      );
    }

    // Attribution comes from the authenticated session, never the body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);

    // Cost guard — wiki writes mutate storage and rebuild indexes.
    if (principal) {
      const rl = await enforceRateLimit("wiki", principal.id);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please wait before making more wiki changes." },
          { status: 429 },
        );
      }
    }

    const result = await patchMetadata({
      slug,
      metadata: metadata as Record<string, unknown>,
      author: principal?.handle,
      principal,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = getErrorMessage(err);
    const code = (err as NodeJS.ErrnoException).code;
    let status = 500;
    if (code === "LIFECYCLE_FIELD") status = 400;
    else if (code === "PLAN_REQUIRED") status = 402;
    else if (code === "NOT_OWNER") status = 403;
    else if (code === "NOT_FOUND") status = 404;
    else if (message.toLowerCase().startsWith("invalid slug")) status = 400;
    return NextResponse.json({ error: message }, { status });
  }
}
