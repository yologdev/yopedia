import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { addToVault, removeFromVault, vaultOwnedBy, getVault } from "@/lib/vault";
import { readWikiPageWithFrontmatter } from "@/lib/wiki";
import { isVaultEligible } from "@/lib/commons";
import { enforceRateLimit } from "@/lib/rate-limit";

interface Params {
  params: Promise<{ id: string }>;
}

async function authorizeOwner(vaultId: string) {
  const principal = await getPrincipal();
  if (!principal) {
    return { error: NextResponse.json({ error: "Sign in required." }, { status: 401 }) };
  }
  if (!vaultOwnedBy(vaultId, principal.handle)) {
    return { error: NextResponse.json({ error: "Not your vault." }, { status: 403 }) };
  }
  return { principal };
}

async function readSlug(req: Request): Promise<string | null> {
  try {
    const slug = ((await req.json()) as { slug?: unknown })?.slug;
    return typeof slug === "string" && slug.trim() ? slug : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/vaults/[id]/pages — list enriched page entries in a vault.
 *
 * Returns `{ pages: VaultPageEntry[] }` with title, summary, tags, etc.
 * Auth-gated to the vault owner.
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const auth = await authorizeOwner(id);
  if (auth.error) return auth.error;

  const vault = await getVault(id);
  if (!vault) {
    return NextResponse.json({ error: "Vault not found." }, { status: 404 });
  }

  // Resolve enriched metadata for each slug via the page-metadata index
  const { getPageIndex } = await import("@/lib/page-index");
  const metaIndex = await getPageIndex();

  const pages = await Promise.all(
    vault.slugs.map(async (slug) => {
      // Fast path: page-metadata index hit
      if (metaIndex) {
        const m = metaIndex[slug];
        if (m) {
          return {
            slug: m.slug,
            title: m.title,
            ...(m.summary ? { summary: m.summary } : {}),
            ...(m.tags && m.tags.length > 0 ? { tags: m.tags } : {}),
            ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
            ...(m.updated ? { updated: m.updated } : {}),
            ...(m.type ? { type: m.type } : {}),
            ...(m.owner ? { owner: m.owner } : {}),
          };
        }
      }
      // Slow fallback: read page frontmatter directly
      const page = await readWikiPageWithFrontmatter(slug);
      if (page) {
        const fm = page.frontmatter;
        return {
          slug,
          title: typeof fm.title === "string" && fm.title ? fm.title : slug,
          ...(typeof fm.summary === "string" && fm.summary ? { summary: fm.summary } : {}),
          ...(Array.isArray(fm.tags) && fm.tags.length > 0 ? { tags: fm.tags as string[] } : {}),
          ...(typeof fm.confidence === "number" ? { confidence: fm.confidence } : {}),
          ...(typeof fm.updated === "string" && fm.updated ? { updated: fm.updated } : {}),
          ...(typeof fm.type === "string" && fm.type ? { type: fm.type } : {}),
          ...(typeof fm.owner === "string" && fm.owner ? { owner: fm.owner } : {}),
        };
      }
      // Page no longer exists
      return { slug, title: slug };
    }),
  );

  return NextResponse.json({ pages });
}

/**
 * POST /api/vaults/[id]/pages { slug } — add a page reference to a vault.
 *
 * v1 (public vaults): only a readable PUBLIC commons page can be referenced
 * (re-checked here, mirroring the MCP vault_curate gate).
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const auth = await authorizeOwner(id);
  if (auth.error) return auth.error;

  // Cost guard — vault writes mutate storage.
  const rl = await enforceRateLimit("wiki", auth.principal!.id);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please wait before making more changes." },
      { status: 429 },
    );
  }

  if (!(await getVault(id))) {
    return NextResponse.json({ error: "Vault not found." }, { status: 404 });
  }
  const slug = await readSlug(req);
  if (!slug) {
    return NextResponse.json({ error: "Missing or invalid 'slug'." }, { status: 400 });
  }
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }
  // Public, non-agent pages — INCLUDING artifacts (html/slides), which a vault
  // can collect for Browse. Private pages are excluded (a vault references by
  // slug, so a private page would leak).
  const eligible = isVaultEligible({
    visibility:
      typeof page.frontmatter.visibility === "string"
        ? page.frontmatter.visibility
        : undefined,
    type: typeof page.frontmatter.type === "string" ? page.frontmatter.type : undefined,
  });
  if (!eligible) {
    return NextResponse.json(
      { error: "Only public, non-agent pages can be added to a vault." },
      { status: 400 },
    );
  }
  await addToVault(id, slug);
  return NextResponse.json({ ok: true, added: slug });
}

/** DELETE /api/vaults/[id]/pages { slug } — remove a page reference. */
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const auth = await authorizeOwner(id);
  if (auth.error) return auth.error;

  // Cost guard — vault writes mutate storage.
  const rl = await enforceRateLimit("wiki", auth.principal!.id);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please wait before making more changes." },
      { status: 429 },
    );
  }

  const slug = await readSlug(req);
  if (!slug) {
    return NextResponse.json({ error: "Missing or invalid 'slug'." }, { status: 400 });
  }
  await removeFromVault(id, slug);
  return NextResponse.json({ ok: true, removed: slug });
}
