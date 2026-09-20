/**
 * Test fixtures for writing wiki pages straight to storage.
 *
 * Flat retirement (#869) made the silo the only place a page lives, so a test
 * that drops a file into `wiki/<slug>.md` writes somewhere nothing reads.
 * These helpers put fixtures where production puts them — and, crucially,
 * derive the tenant the same way `readWikiPage` does, so a fixture and the
 * read path can never disagree about which silo a page belongs to.
 *
 * `wiki/index.md` and `wiki/log.md` stay flat: they are infrastructure files,
 * not pages, and `wikiRelPath` still addresses them.
 */
import fs from "fs/promises";
import path from "path";
import { getTenantWikiDir } from "../../paths";
import { ownerToTenant, DEFAULT_TENANT } from "../../links";

/** Absolute path of a tenant's wiki directory (defaults to the seed tenant). */
export function siloWikiDir(tenant: string = DEFAULT_TENANT): string {
  return getTenantWikiDir(tenant);
}

/**
 * Absolute path a page fixture should be written to.
 *
 * Pass `owner` (not a tenant) to mirror how the read path resolves: it reads
 * the page-index entry's `owner` and runs it through `ownerToTenant`.
 */
export function siloPagePath(slug: string, owner?: string): string {
  return path.join(siloWikiDir(ownerToTenant(owner)), `${slug}.md`);
}

/**
 * Write a page fixture into the silo the read path will look in.
 *
 * `owner` must match the `owner` on the page's page-index entry (and its
 * frontmatter) when the test seeds one — otherwise the read resolves to a
 * different tenant and the page reads as missing, exactly as it would in
 * production.
 */
export async function writePageFixture(
  slug: string,
  content: string,
  owner?: string,
): Promise<void> {
  const target = siloPagePath(slug, owner);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
}

/** List the slugs present in a tenant's silo (`[]` when it doesn't exist). */
export async function listSiloSlugs(tenant: string = DEFAULT_TENANT): Promise<string[]> {
  try {
    const files = await fs.readdir(siloWikiDir(tenant));
    return files.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

/**
 * Write the commons index (`wiki/index.md`).
 *
 * `index.md` and `log.md` are infrastructure, not pages: `readIndexBaseEntries`
 * and `appendToLog` address them through `wikiRelPath`, so they stay flat even
 * after flat retirement. Writing them with `writeWikiPage` would file them into
 * a tenant silo where nothing looks.
 */
export async function writeIndexFixture(markdown: string): Promise<void> {
  const { getStorage } = await import("../../storage");
  const { wikiRelPath } = await import("../../wiki");
  await getStorage().writeFile(wikiRelPath("index.md"), markdown);
}

/** Write a flat infrastructure file (`index.md`, `log.md`) by filename. */
export async function writeInfraFixture(filename: string, markdown: string): Promise<void> {
  const { getStorage } = await import("../../storage");
  const { wikiRelPath } = await import("../../wiki");
  await getStorage().writeFile(wikiRelPath(filename), markdown);
}
