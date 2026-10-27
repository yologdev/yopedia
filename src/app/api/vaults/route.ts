import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listVaults, createVault, vaultsContaining } from "@/lib/vault";
import { canSetPrivate } from "@/lib/authz";
import type { VaultVisibility } from "@/lib/vault";

/**
 * GET /api/vaults  → { vaults: Vault[] } — the signed-in user's own vaults.
 *   GET /api/vaults?slug=<slug> → { vaults, containing } — also returns the ids
 *   of the caller's vaults that already reference `slug` (drives the picker's
 *   checkbox state).
 * POST /api/vaults { name, visibility? } → { vault } — create a vault.
 *   `visibility` defaults to `"public"`. `"private"` requires a paid plan (402).
 *
 * Signed-in only (also enforced by the middleware write-gate for POST). Vaults
 * are always the caller's own — owner is the session principal, never the body.
 */
export async function GET(req: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const vaults = await listVaults(principal.handle);
  const slug = new URL(req.url).searchParams.get("slug");
  if (slug) {
    return NextResponse.json({
      vaults,
      containing: await vaultsContaining(principal.handle, slug),
    });
  }
  return NextResponse.json({ vaults });
}

export async function POST(req: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let name: unknown;
  let visibility: unknown;
  try {
    const body = (await req.json()) as { name?: unknown; visibility?: unknown };
    name = body?.name;
    visibility = body?.visibility;
  } catch {
    /* invalid body → 400 below */
  }
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json(
      { error: "Missing or invalid 'name'." },
      { status: 400 },
    );
  }

  // Default to public; validate the value if supplied.
  const vis: VaultVisibility =
    visibility === "private" ? "private" : "public";
  if (visibility !== undefined && visibility !== "public" && visibility !== "private") {
    return NextResponse.json(
      { error: "Invalid visibility — must be 'public' or 'private'." },
      { status: 400 },
    );
  }

  // Private vaults require a paid plan.
  if (vis === "private" && !(await canSetPrivate(principal))) {
    return NextResponse.json(
      { error: "Creating a private vault requires a paid plan." },
      { status: 402 },
    );
  }

  const vault = await createVault(principal.handle, name.trim(), vis);
  return NextResponse.json({ vault }, { status: 201 });
}
