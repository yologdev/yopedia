import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Mocks — auth + authz (canSetPrivate is the paid-plan gate under test)
// ---------------------------------------------------------------------------

const mockPrincipal = { id: "user_alice", handle: "alice" };

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => mockPrincipal),
}));

// `canSetPrivate` is the gate we toggle between tests.  Start with "no paid
// plan" (the default, fail-closed state).
const mockCanSetPrivate = vi.fn(async () => false);

vi.mock("@/lib/authz", () => ({
  canSetPrivate: (...args: unknown[]) => mockCanSetPrivate(...args),
}));

import { POST } from "@/app/api/vaults/route";
import { listVaults } from "@/lib/vault";
import { _resetStorage } from "@/lib/storage";
import { _resetLocks } from "@/lib/lock";

// ---------------------------------------------------------------------------
// Temp storage per test — real fs-backed vault storage (no vault mock needed)
// ---------------------------------------------------------------------------

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-private-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  mockCanSetPrivate.mockReset().mockResolvedValue(false);
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postVault(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/vaults", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/vaults — private vault creation", () => {
  it("creates a public vault by default (no visibility field)", async () => {
    const res = await postVault({ name: "My Public Vault" });
    expect(res.status).toBe(201);
    const { vault } = await res.json();
    expect(vault.visibility).toBe("public");
  });

  it("creates a public vault when visibility: 'public' is explicit", async () => {
    const res = await postVault({ name: "Explicit Public", visibility: "public" });
    expect(res.status).toBe(201);
    const { vault } = await res.json();
    expect(vault.visibility).toBe("public");
  });

  it("returns 402 when a non-pro user tries to create a private vault", async () => {
    mockCanSetPrivate.mockResolvedValue(false);
    const res = await postVault({ name: "Secret Vault", visibility: "private" });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/paid plan/i);
  });

  it("creates a private vault when the user has a pro plan", async () => {
    mockCanSetPrivate.mockResolvedValue(true);
    const res = await postVault({ name: "Pro Vault", visibility: "private" });
    expect(res.status).toBe(201);
    const { vault } = await res.json();
    expect(vault.visibility).toBe("private");
    expect(vault.name).toBe("Pro Vault");
  });

  it("returns 400 for an invalid visibility value", async () => {
    const res = await postVault({ name: "Bad Vis", visibility: "secret" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/visibility/i);
  });

  it("does not call canSetPrivate for public vault creation", async () => {
    await postVault({ name: "No Gate Check" });
    expect(mockCanSetPrivate).not.toHaveBeenCalled();
  });
});

describe("private vault visibility in listings", () => {
  it("private vault does not appear in a public-filtered listing", async () => {
    // Create one public and one private vault using the real vault layer.
    mockCanSetPrivate.mockResolvedValue(true);

    const res1 = await postVault({ name: "Open Collection", visibility: "public" });
    expect(res1.status).toBe(201);

    const res2 = await postVault({ name: "Hidden Collection", visibility: "private" });
    expect(res2.status).toBe(201);

    // Fetch all vaults for the owner.
    const allVaults = await listVaults("alice");
    expect(allVaults).toHaveLength(2);

    // The public profile page filters: v.visibility === "public".
    // Replicate that filter here to verify private vaults are excluded.
    const publicVaults = allVaults.filter((v) => v.visibility === "public");
    expect(publicVaults).toHaveLength(1);
    expect(publicVaults[0].name).toBe("Open Collection");

    // The private vault exists but is not in the public list.
    const privateVaults = allVaults.filter((v) => v.visibility === "private");
    expect(privateVaults).toHaveLength(1);
    expect(privateVaults[0].name).toBe("Hidden Collection");
  });
});
