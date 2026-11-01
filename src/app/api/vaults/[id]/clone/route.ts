import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { vaultOwnedBy, getVault, cloneToPrivate } from "@/lib/vault";
import { canSetPrivate } from "@/lib/authz";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/vaults/[id]/clone { slug } — clone a public commons page into a
 * private vault as an owner-only snapshot.
 *
 * Auth gates:
 *   - 401 if not signed in.
 *   - 403 if the vault isn't owned by the caller.
 *   - 402 if the caller lacks a paid plan (`canSetPrivate()` fails).
 *   - 404 if the vault or source page doesn't exist.
 *   - 400 if the source page is private (can't clone a private page).
 *
 * Returns `{ clone: { cloneSlug, sourceSlug, owner } }` on success.
 */
export async function POST(req: Request, { params }: Params) {
  const { id: vaultId } = await params;

  // 1. Auth — must be signed in.
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  // 2. Ownership — must own the vault.
  if (!vaultOwnedBy(vaultId, principal.handle)) {
    return NextResponse.json({ error: "Not your vault." }, { status: 403 });
  }

  // 3. Paid plan gate — cloning into private requires a pro plan.
  if (!(await canSetPrivate(principal))) {
    return NextResponse.json(
      { error: "Cloning to a private vault requires a paid plan." },
      { status: 402 },
    );
  }

  // 4. Vault existence.
  const vault = await getVault(vaultId);
  if (!vault) {
    return NextResponse.json({ error: "Vault not found." }, { status: 404 });
  }

  // 5. Parse body — expect { slug }.
  let slug: unknown;
  try {
    slug = ((await req.json()) as { slug?: unknown })?.slug;
  } catch {
    /* invalid JSON → 400 below */
  }
  if (typeof slug !== "string" || !slug.trim()) {
    return NextResponse.json(
      { error: "Missing or invalid 'slug'." },
      { status: 400 },
    );
  }

  // 6. Perform the clone.
  try {
    const result = await cloneToPrivate(slug.trim(), vaultId, principal.handle);
    return NextResponse.json({ clone: result }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.includes("private")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    // Unexpected — surface the error.
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
