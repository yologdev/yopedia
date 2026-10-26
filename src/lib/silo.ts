/**
 * Per-tenant silo utilities (tenant-silos P5a).
 *
 * Each tenant's folder `tenants/<tenant>/…` is the SOLE storage location
 * for that owner's pages — a self-contained vault (Obsidian-servable).
 * Flat retirement is complete (#869, #930): there is no legacy flat path
 * and no fallback. lifecycle.ts writes silo-only and readWikiPage reads
 * silo-only.
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
 * — overwrites). Returns the count of artifacts copied.
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
  /** Silo pages with no corresponding index entry — cleaned up. */
  removed: number;
  errors: string[];
}

/** Infrastructure slugs that are not real pages — skip during orphan cleanup. */
const SKIP = new Set(["index", "log"]);

/**
 * Orphan cleanup: find silo files that have no corresponding page-index
 * entry and remove them. After flat retirement (#869) this is the sole
 * purpose of reconciliation — the forward sync pass has been removed.
 */
export async function reconcileSilos(): Promise<ReconcileResult> {
  const { listWikiPages } = await import("./wiki");
  const pages = await listWikiPages();
  const result: ReconcileResult = {
    removed: 0,
    errors: [],
  };

  // Build the set of known page slugs from the index.
  const pageSlugs = new Set(pages.map((p) => p.slug));

  // Reverse pass: find silo files with no index entry (ghosts).
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
        if (pageSlugs.has(slug)) continue;
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
