import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getVault, renameVault, deleteVault, vaultOwnedBy } from "@/lib/vault";
import { enforceRateLimit } from "@/lib/rate-limit";

interface Params {
  params: Promise<{ id: string }>;
}

/** Resolve the signed-in owner of `vaultId`, or an error Response. */
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

/** PATCH /api/vaults/[id] { name } — rename (id stays stable). */
export async function PATCH(req: Request, { params }: Params) {
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
  let name: unknown;
  try {
    name = ((await req.json()) as { name?: unknown })?.name;
  } catch {
    /* 400 below */
  }
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Missing or invalid 'name'." }, { status: 400 });
  }
  await renameVault(id, name.trim());
  return NextResponse.json({ ok: true });
}

/** DELETE /api/vaults/[id] — delete the vault (its referenced pages are untouched). */
export async function DELETE(_req: Request, { params }: Params) {
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

  await deleteVault(id);
  return NextResponse.json({ ok: true });
}
