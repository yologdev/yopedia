/**
 * Per-tenant silo utilities (tenant-silos P5a).
 *
 * Each tenant's folder `tenants/<tenant>/…` is the PRIMARY storage location
 * for that owner's pages — a self-contained vault (Obsidian-servable).
 * lifecycle.ts writes silo-primary (tenants/<tenant>/wiki/<slug>.md) and
 * readWikiPage tries the silo path first, falling back to the legacy flat
 * path during the transition (#869). A redundant flat copy is still written
 * during the transition but will be removed once flat retirement completes.
 *
 * Artifacts stored per page: wiki md, raw source, revision history, discussion
 * threads, and binary assets. The embedding vector store is internal (not part
 * of the vault) and stays global.
 */

import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import {
  wikiRelPath,
  rawRelPath,
  tenantWikiRelPath,
  tenantRawRelPath,
  tenantForOwner,
  validateTenant,
} from "./wiki";
import { logger } from "./logger";

async function copyText(src: string, dst: string): Promise<boolean> {
  const storage = getStorage();
  let content: string;
  try {
    content = await storage.readFile(src);
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
  await storage.writeFile(dst, content);
  return true;
}

async function copyAsset(src: string, dst: string): Promise<boolean> {
  const storage = getStorage();
  let data: ArrayBuffer;
  try {
    data = await storage.readAsset(src);
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
  await storage.writeAsset(dst, data);
  return true;
}

async function listSafe(prefix: string) {
  try {
    return await getStorage().listFiles(prefix);
  } catch (e) {
    if (isEnoent(e)) return [];
    throw e;
  }
}

async function deleteSafe(path: string): Promise<void> {
  try {
    await getStorage().deleteFile(path);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

async function deleteDirSafe(path: string): Promise<void> {
  try {
    await getStorage().deleteDirectory(path);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

/**
 * Mirror every per-page artifact for one slug into its tenant silo (idempotent
 * — overwrites). Reads from flat (the write primary), so call AFTER the flat
 * write completes. Returns the count of artifacts copied.
 */
export async function syncSiloForPage(
  slug: string,
  tenant: string,
): Promise<number> {
  validateTenant(tenant);
  let n = 0;
  // wiki page + raw source
  if (await copyText(wikiRelPath(`${slug}.md`), tenantWikiRelPath(tenant, `${slug}.md`)))
    n++;
  if (await copyText(rawRelPath(`${slug}.md`), tenantRawRelPath(tenant, `${slug}.md`)))
    n++;

  // Revision history + assets are IMMUTABLE (append-only, never rewritten), so
  // copy only the ones not already mirrored. This bounds a per-write sync to the
  // new files instead of re-copying the whole (unbounded) history each time —
  // critical on the Workers runtime (subrequest budget). One list of the silo
  // side does the diff; the migration's first run (empty silo) still copies all.

  // revision history: wiki/.revisions/<slug>/{<ts>.md,<ts>.meta.json}
  const revRel = `.revisions/${slug}`;
  const mirroredRevs = new Set(
    (await listSafe(tenantWikiRelPath(tenant, revRel))).map((f) => f.name),
  );
  for (const f of await listSafe(wikiRelPath(revRel))) {
    if (f.isDirectory || mirroredRevs.has(f.name)) continue;
    if (
      await copyText(
        wikiRelPath(`${revRel}/${f.name}`),
        tenantWikiRelPath(tenant, `${revRel}/${f.name}`),
      )
    )
      n++;
  }

  // discussion threads: discuss/<slug>.json (mutable — always overwrite)
  if (
    await copyText(
      `discuss/${slug}.json`,
      `tenants/${tenant}/discuss/${slug}.json`,
    )
  )
    n++;

  // binary assets: raw/assets/<slug>/<file> (immutable — copy only new)
  const assetRel = `assets/${slug}`;
  const mirroredAssets = new Set(
    (await listSafe(tenantRawRelPath(tenant, assetRel))).map((f) => f.name),
  );
  for (const f of await listSafe(rawRelPath(assetRel))) {
    if (f.isDirectory || mirroredAssets.has(f.name)) continue;
    if (
      await copyAsset(
        rawRelPath(`${assetRel}/${f.name}`),
        tenantRawRelPath(tenant, `${assetRel}/${f.name}`),
      )
    )
      n++;
  }
  return n;
}

/** Remove every per-page artifact for one slug from its tenant silo. */
export async function removeSiloForPage(
  slug: string,
  tenant: string,
): Promise<void> {
  validateTenant(tenant);
  await Promise.all([
    deleteSafe(tenantWikiRelPath(tenant, `${slug}.md`)),
    deleteSafe(tenantRawRelPath(tenant, `${slug}.md`)),
    deleteSafe(`tenants/${tenant}/discuss/${slug}.json`),
    deleteDirSafe(tenantWikiRelPath(tenant, `.revisions/${slug}`)),
    deleteDirSafe(tenantRawRelPath(tenant, `assets/${slug}`)),
  ]);
}

// ---------------------------------------------------------------------------
// Silo reconciliation — verify and repair silo consistency
// ---------------------------------------------------------------------------

/** Summary returned by {@link reconcileSilos}. */
export interface ReconcileResult {
  total: number;
  /** Pages found under the wrong tenant and moved to the one their index
   *  entry names — the repair that keeps a page reachable. */
  synced: number;
  /** Pages present in the index but in no silo at all (also reported in
   *  `errors`, since nothing can be done for them here). */
  stale: number;
  /** Pages already in the right silo. */
  alreadyCurrent: number;
  /** Silo pages with no corresponding index entry — cleaned up. */
  removed: number;
  errors: string[];
}

/** Infrastructure slugs that are not real pages — never synced to silos. */
const SKIP = new Set(["index", "log"]);

/**
 * Verify every indexed page sits in the silo its index entry points to, and
 * repair the ones that don't.
 *
 * The old forward pass copied flat → silo. Flat retirement (#869) made the silo
 * the only write target, so there is no flat source left to copy from and that
 * pass became dead code. What replaces it matters more: reads now DERIVE a
 * page's location from its index entry's owner, so a page whose file sits under
 * a different tenant than its entry claims is invisible — not corrupt, just
 * unreachable. This pass finds those and relocates them.
 *
 * Runs at the END of {@link rebuildDerivedIndexes} (so the index it trusts is
 * fresh) and is also available from the admin migrate endpoint.
 */
export async function reconcileSilos(): Promise<ReconcileResult> {
  const { listWikiPages } = await import("./wiki");
  const pages = await listWikiPages();
  const storage = getStorage();
  const result: ReconcileResult = {
    total: 0,
    synced: 0,
    stale: 0,
    alreadyCurrent: 0,
    removed: 0,
    errors: [],
  };

  // Tenant directories, listed once and reused by the misplaced-page search.
  const tenantNames: string[] = [];
  try {
    for (const td of await listSafe("tenants")) {
      if (td.isDirectory) tenantNames.push(td.name);
    }
  } catch (e) {
    logger.warn("silo", "tenant listing failed:", e);
  }

  for (const page of pages) {
    if (SKIP.has(page.slug)) continue;
    result.total++;
    const tenant = tenantForOwner(page.owner);
    try {
      const siloPath = tenantWikiRelPath(tenant, `${page.slug}.md`);
      if (await storage.fileExists(siloPath)) {
        result.alreadyCurrent++;
        continue;
      }

      // Not where the index says it should be. Look for it under another
      // tenant — the signature of an ownership change whose move didn't
      // complete — and put it back where readers will look.
      let relocated = false;
      for (const other of tenantNames) {
        if (other === tenant) continue;
        let fromPath: string;
        try {
          fromPath = tenantWikiRelPath(other, `${page.slug}.md`);
        } catch {
          continue; // invalid tenant dir name — skip
        }
        if (!(await storage.fileExists(fromPath))) continue;
        await storage.writeFile(siloPath, await storage.readFile(fromPath));
        await removeSiloForPage(page.slug, other);
        result.synced++;
        relocated = true;
        logger.warn(
          "silo",
          `relocated "${page.slug}" from tenant "${other}" to "${tenant}" (index owner)`,
        );
        break;
      }

      if (!relocated) {
        // Indexed but present in no silo at all — a genuinely missing page.
        // Report it; the index rebuild will drop the entry if it stays gone.
        result.stale++;
        result.errors.push(`${page.slug}: indexed but missing from every silo`);
      }
    } catch (e) {
      result.errors.push(`${page.slug}: ${String(e)}`);
      logger.warn("silo", `reconcile failed for "${page.slug}":`, e);
    }
  }

  // ── Reverse pass: remove silo files nothing can reach ──
  //
  // Two kinds: a GHOST (no index entry at all) and a STALE DUPLICATE (the slug
  // is indexed, but its entry resolves to a different tenant — so this copy is
  // unreachable and will drift out of date). The forward pass has already put
  // every indexed page where its entry says, so anything left over here is
  // genuinely surplus.
  const pageSlugs = new Set(pages.map((p) => p.slug));
  const tenantOf = new Map(pages.map((p) => [p.slug, tenantForOwner(p.owner)]));
  try {
    const tenantDirs = await listSafe("tenants");
    for (const td of tenantDirs) {
      if (!td.isDirectory) continue;
      const tenant = td.name;
      let wikiPrefix: string;
      try {
        wikiPrefix = tenantWikiRelPath(tenant, "");
      } catch {
        continue; // invalid tenant dir name — skip
      }
      let siloFiles: Awaited<ReturnType<typeof listSafe>>;
      try {
        siloFiles = await listSafe(wikiPrefix);
      } catch {
        continue;
      }
      for (const f of siloFiles) {
        if (f.isDirectory || !f.name.endsWith(".md")) continue;
        const slug = f.name.replace(/\.md$/, "");
        if (SKIP.has(slug)) continue;
        // Keep it only when this tenant is the one the page resolves to.
        if (pageSlugs.has(slug) && tenantOf.get(slug) === tenant) continue;
        try {
          await removeSiloForPage(slug, tenant);
          result.removed++;
        } catch (e) {
          result.errors.push(`reverse-orphan ${tenant}/${slug}: ${String(e)}`);
          logger.warn("silo", `reverse-orphan cleanup failed for "${tenant}/${slug}":`, e);
        }
      }
    }
  } catch (e) {
    logger.warn("silo", "reverse-orphan scan failed:", e);
  }

  return result;
}
