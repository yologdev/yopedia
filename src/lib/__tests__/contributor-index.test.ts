import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getContributorIndex,
  recordEditForAuthor,
  reverseEditForAuthor,
  recordTalkForAuthor,
  rebuildContributorIndex,
  profilesFromIndex,
} from "../contributor-index";
import { listContributors } from "../contributors";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { saveRevision } from "../revisions";
import { createThread, _resetTimestamp } from "../talk";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contributor-index-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetTimestamp();
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createPage(slug: string, title: string, content: string) {
  await ensureDirectories();
  await writeWikiPage(slug, content);
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch { /* none */ }
  const line = `- [${title}](${slug}.md) — ${title}`;
  if (!existing.includes(line)) {
    await fs.writeFile(
      indexPath,
      existing ? `${existing.trimEnd()}\n${line}\n` : `# Wiki Index\n\n${line}\n`,
      "utf-8",
    );
  }
}

describe("incremental maintenance (seeded index)", () => {
  beforeEach(async () => {
    // The incremental hooks are no-ops until the index exists (the daily rebuild
    // seeds it). Seed an empty index by rebuilding over an empty wiki.
    await ensureDirectories();
    await rebuildContributorIndex();
  });

  it("recordEditForAuthor bumps editCount + pagesEdited", async () => {
    await recordEditForAuthor("alice", "p1", "2026-01-01T00:00:00Z");
    await recordEditForAuthor("alice", "p2", "2026-01-02T00:00:00Z");
    await recordEditForAuthor("alice", "p1", "2026-01-03T00:00:00Z"); // same page again
    const idx = (await getContributorIndex())!;
    expect(idx.authors.alice.editCount).toBe(3);
    expect(new Set(idx.authors.alice.pagesEdited)).toEqual(new Set(["p1", "p2"]));
    expect(idx.authors.alice.firstSeen).toBe("2026-01-01T00:00:00Z");
    expect(idx.authors.alice.lastSeen).toBe("2026-01-03T00:00:00Z");
    expect(idx.totals.revisionCount).toBe(3);
    expect(idx.totals.contributorCount).toBe(1);
  });

  it("reverseEditForAuthor decrements editCount + drops the slug", async () => {
    await recordEditForAuthor("alice", "p1");
    await recordEditForAuthor("alice", "p2");
    await reverseEditForAuthor("alice", "p1");
    const idx = (await getContributorIndex())!;
    expect(idx.authors.alice.editCount).toBe(1);
    expect(idx.authors.alice.pagesEdited).toEqual(["p2"]);
  });

  it("recordTalkForAuthor bumps comment / thread counts", async () => {
    await recordTalkForAuthor("bob", { comment: true, thread: true });
    await recordTalkForAuthor("bob", { comment: true });
    const idx = (await getContributorIndex())!;
    expect(idx.authors.bob.commentCount).toBe(2);
    expect(idx.authors.bob.threadsCreated).toBe(1);
  });
});

describe("rebuildContributorIndex + read parity", () => {
  it("rebuild serializes the scan; listContributors fast path == fallback scan", async () => {
    await createPage("p1", "P1", "# P1\n\nbody");
    await createPage("p2", "P2", "# P2\n\nbody");
    await saveRevision("p1", "# P1\n\nv1", "alice", undefined, "yopedia");
    await saveRevision("p1", "# P1\n\nv2 longer content here", "alice", undefined, "yopedia");
    await saveRevision("p2", "# P2\n\nv1", "bob", undefined, "yopedia");
    await createThread("p1", "Q", "bob", "a question");

    // Fallback: no index yet → listContributors does the full scan.
    expect(await getContributorIndex()).toBeNull();
    const fallback = await listContributors(null);

    // Rebuild → fast path → SAME profiles (same set + counts + trust).
    await rebuildContributorIndex();
    expect(await getContributorIndex()).not.toBeNull();
    const fast = await listContributors(null);

    expect(fast.map((c) => c.handle)).toEqual(fallback.map((c) => c.handle));
    for (let i = 0; i < fast.length; i++) {
      expect(fast[i]).toEqual(fallback[i]);
    }
  });

  it("profilesFromIndex applies the trust formula and sorts by editCount", async () => {
    await createPage("p1", "P1", "# P1\n\nbody");
    await saveRevision("p1", "# P1\n\nv1", "alice", undefined, "yopedia");
    await saveRevision("p1", "# P1\n\nv2", "alice", undefined, "yopedia");
    await saveRevision("p1", "# P1\n\nv3", "bob", undefined, "yopedia");
    const idx = await rebuildContributorIndex();
    const profiles = profilesFromIndex(idx);
    // alice has more edits → sorts first.
    expect(profiles[0].handle).toBe("alice");
    expect(profiles[0].editCount).toBe(2);
    expect(profiles.every((p) => p.trustScore >= 0 && p.trustScore <= 1)).toBe(true);
  });
});
