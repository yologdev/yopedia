/**
 * Read-path authorization — the single, fail-closed predicate for "may this
 * principal read this page?", applied at every read surface (mirroring how
 * `middleware.ts` is the single write-gate).
 *
 * Model (decided with the owner):
 *   - Everything is PUBLIC by default (human pages AND agent knowledge).
 *   - `visibility: "private"` is an opt-in paid feature; a private page is
 *     readable by the OWNER ONLY. For an agent-owned page (`<user>--<name>`),
 *     the human `<user>` is the owner.
 */

import { agentOwnerHandle } from "./agents";
import { belongsInCommons } from "./commons";
import { slugify } from "./slugify";
import { isOwnerHandle } from "./owner";
import type { IndexEntry } from "./types";
import type { Principal } from "./auth";

/** The minimal page metadata needed to authorize a read. */
export interface PageReadMeta {
  owner?: string;
  visibility?: string;
  type?: string;
}

/** The kind of write being attempted. */
export type WriteKind = "body" | "metadata" | "delete";

/** A reader identity (id is used for the spoof-proof admin match). */
type Reader = { id?: string; handle: string } | null;

/**
 * Admins — listed in the comma-separated `ADMIN_HANDLES` Worker var — may READ,
 * WRITE, and DELETE every **page**, including other users' private pages. Unset/
 * empty → no admins; a null/handleless principal is never an admin.
 *
 * Each entry matches EITHER:
 *  - a **Clerk user id** (`user_…`), compared exactly — spoof-proof, use this if
 *    your Clerk instance lets users edit their username; or
 *  - a **handle** (Twitter/X username), compared case-insensitively — convenient,
 *    but only as trustworthy as the handle: it assumes a non-admin cannot set
 *    their Clerk username to an admin's handle (true when usernames come from
 *    Twitter SSO and aren't user-editable).
 *
 * Scope is pages only — it does NOT grant managing others' agents, vaults, or
 * discussion moderation (those keep their own owner checks).
 *
 * Examples: `ADMIN_HANDLES=yuanhao` or `ADMIN_HANDLES=user_2abc...,alice`.
 */
export function isAdmin(
  principal: { id?: string; handle?: string } | null | undefined,
): boolean {
  // The site owner runs the instance, so they ARE the operator/admin — they may
  // delete commons pages and manage any page. Matched by handle (case-insensitive)
  // against the deploy-configured NEXT_PUBLIC_OWNER_HANDLE — the SAME handle-trust
  // caveat as the ADMIN_HANDLES path below (it assumes Clerk usernames aren't
  // user-editable; registration here is invite-only + owner-controlled, which
  // closes that gap). This is the one place owner ⇒ admin is granted for PAGE
  // authz; the admin/tenant + admin/migrate routes do their own owner checks.
  if (isOwnerHandle(principal?.handle)) return true;

  const raw = process.env.ADMIN_HANDLES;
  if (!raw) return false;
  const admins = raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (admins.length === 0) return false;

  // `user_…` entries are Clerk ids — matched ONLY against principal.id (exact),
  // never as a handle, so setting a handle to the id string can't grant admin.
  const ids = admins.filter((a) => a.startsWith("user_"));
  if (principal?.id && ids.includes(principal.id)) return true;

  // Everything else is a handle — case-insensitive match.
  const handle = principal?.handle?.trim().toLowerCase();
  if (!handle) return false;
  return admins.some((a) => !a.startsWith("user_") && a.toLowerCase() === handle);
}

/**
 * True iff `principal` may read a page with the given metadata. Fail-closed:
 * only an explicit `visibility: "private"` ever denies; anything else is public.
 */
export function canReadPage(meta: PageReadMeta, principal: Reader): boolean {
  // Public (or no explicit private flag) — always readable.
  if (meta.visibility !== "private") return true;

  // Private — requires an authenticated owner.
  if (!principal) return false;
  // Admins read every page, including others' private pages.
  if (isAdmin(principal)) return true;
  const owner = meta.owner;
  if (!owner) return false; // private but unowned — fail closed

  // Direct ownership.
  if (principal.handle === owner) return true;

  // Agent ownership: the human behind an agent-owned page is the owner. The id
  // is `slugify(owner)--slugify(name)`, so compare the slugified handle against
  // the slugified owner prefix (handles with caps/underscores slugify away).
  const agentHuman = agentOwnerHandle(owner);
  if (agentHuman !== null && agentHuman === slugify(principal.handle)) {
    return true;
  }

  return false;
}

/** {@link canReadPage} over an index entry. */
export function canReadEntry(entry: IndexEntry, principal: Reader): boolean {
  return canReadPage(
    { owner: entry.owner, visibility: entry.visibility, type: entry.type },
    principal,
  );
}

/** {@link canReadPage} over a parsed frontmatter record. */
export function canReadFrontmatter(
  fm: { owner?: unknown; visibility?: unknown; type?: unknown },
  principal: Reader,
): boolean {
  return canReadPage(
    {
      owner: typeof fm.owner === "string" ? fm.owner : undefined,
      visibility: typeof fm.visibility === "string" ? fm.visibility : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
    },
    principal,
  );
}

/**
 * Read-gate by slug for surfaces that don't already hold the page's
 * frontmatter (raw, revisions, discuss…). Returns `true` when readable OR when
 * the page is missing (the caller's own not-found handling applies); returns
 * `false` only for an existing private page the principal can't read — so the
 * caller should respond 404. Dynamic import avoids a static wiki↔authz cycle.
 */
export async function canReadSlug(
  slug: string,
  principal: Reader,
): Promise<boolean> {
  const { readWikiPageWithFrontmatter } = await import("./wiki");
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) return true;
  return canReadFrontmatter(page.frontmatter, principal);
}

// ---------------------------------------------------------------------------
// Write-path authorization (realm-aware writes)
// ---------------------------------------------------------------------------

/**
 * True iff `principal` may perform a write of kind `writeKind` on a page,
 * mirroring the realm model and staying symmetric with {@link canReadPage}:
 *
 *   - The deployment-trusted **service principal** (bearer token) may write
 *     anything — it is how autonomous agents and scheduled jobs write on an
 *     owner's behalf (the caller sets `owner` explicitly).
 *   - **Admins** may write/delete/manage every page.
 *   - **Commons body/delete** writes are agent-only: a commons page's prose is
 *     maintained by agents; humans steer via metadata patches and talk threads.
 *     Body replacements and deletions by non-service, non-admin principals are
 *     denied.
 *   - **Public** (commons) metadata patches are collectively editable by any
 *     signed-in user — the commons is a shared wiki.
 *   - **Private** (vault) pages are writable ONLY by the set {@link canReadPage}
 *     admits for a private page: the owner's human and that human's agents
 *     (`<user>--<name>` resolves to `<user>`). So a user's agents can write
 *     their owner's private vault, but no one else can.
 *
 * The per-page ACL only restricts **private** pages; authentication for public
 * edits is the write-gate middleware's job (it rejects unauthenticated
 * mutations), so a public page is writable by any caller that reached here.
 * Private pages fail-closed for an anonymous principal.
 */
export function canWritePage(
  meta: PageReadMeta,
  principal: Principal | null,
  writeKind: WriteKind = "metadata",
): boolean {
  // Deployment-trusted automated caller — writes for owners (agents, cron).
  if (principal?.id.startsWith("service:")) return true;
  // Admins may write/delete/manage every page (incl. others' private pages).
  if (isAdmin(principal)) return true;

  // ── Realm gate: commons body/delete writes are agent-only ──
  // A commons page's prose is maintained by agents; humans steer via metadata
  // patches and talk threads. Body replacements and deletions by non-service,
  // non-admin principals are denied.
  if (
    (writeKind === "body" || writeKind === "delete") &&
    belongsInCommons(meta)
  ) {
    return false;
  }

  // Public / collective commons — metadata editable by any caller the write-gate admits.
  if (meta.visibility !== "private") return true;
  // Private — exactly the owner-equivalence class that may READ it (requires an
  // authenticated, matching principal).
  if (!principal) return false;
  return canReadPage(
    { owner: meta.owner, visibility: "private", type: meta.type },
    principal,
  );
}

/** {@link canWritePage} over a parsed frontmatter record. */
export function canWriteFrontmatter(
  fm: { owner?: unknown; visibility?: unknown; type?: unknown },
  principal: Principal | null,
  writeKind: WriteKind = "metadata",
): boolean {
  return canWritePage(
    {
      owner: typeof fm.owner === "string" ? fm.owner : undefined,
      visibility: typeof fm.visibility === "string" ? fm.visibility : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
    },
    principal,
    writeKind,
  );
}

/**
 * True when the principal is entitled to create private (paid) content.
 *
 * Reads Clerk `publicMetadata.plan === "pro"`. The plan is provisioned by
 * Clerk Billing once configured — see BILLING.md for setup (not yet
 * configured). Fail-closed: service/token principals and any Clerk error
 * yield `false`.
 */
export async function hasPaidPlan(principal: Principal): Promise<boolean> {
  if (principal.id.startsWith("service:")) return false;
  try {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser();
    if (!user) return false;
    const meta = user.publicMetadata as Record<string, unknown> | undefined;
    return meta?.plan === "pro";
  } catch {
    return false;
  }
}

/** Whether `principal` may set a page to `visibility: private`. */
export async function canSetPrivate(principal: Principal | null): Promise<boolean> {
  if (!principal) return false;
  return hasPaidPlan(principal);
}
