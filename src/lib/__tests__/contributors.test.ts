import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildContributorProfile, buildContributorProfiles, listContributors, computeScanData, reduceReverts } from "../contributors";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { saveRevision, type Revision } from "../revisions";
import { createThread, addComment, _resetTimestamp } from "../talk";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contributors-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetTimestamp();
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  if (originalRawDir === undefined) {
    delete process.env.RAW_DIR;
  } else {
    process.env.RAW_DIR = originalRawDir;
  }
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Helper: create a wiki page and register it in the index. */
async function createPage(slug: string, title: string, content: string) {
  await ensureDirectories();
  await writeWikiPage(slug, content);
  // updateIndex replaces the whole index, so we need to read existing entries first.
  // For tests, just write a single-entry index — tests create pages sequentially.
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch { /* doesn't exist yet */ }
  const line = `- [${title}](${slug}.md) — Summary of ${title}`;
  if (!existing.includes(line)) {
    const newContent = existing
      ? `${existing.trimEnd()}\n${line}\n`
      : `# Wiki Index\n\n${line}\n`;
    await fs.writeFile(indexPath, newContent, "utf-8");
  }
}

describe("contributors data layer", () => {
  describe("listContributors", () => {
    it("returns empty array when no revisions exist", async () => {
      await ensureDirectories();
      const result = await listContributors();
      expect(result).toEqual([]);
    });

    it("aggregates multiple authors correctly", async () => {
      await createPage("page-a", "Page A", "# Page A\n\nContent.");
      await createPage("page-b", "Page B", "# Page B\n\nContent.");

      // Alice edits page-a twice, bob edits page-b once
      await saveRevision("page-a", "# Page A\n\nv1", "alice", undefined, "yopedia");
      await saveRevision("page-a", "# Page A\n\nv2", "alice", undefined, "yopedia");
      await saveRevision("page-b", "# Page B\n\nv1", "bob", undefined, "yopedia");

      const contributors = await listContributors();
      expect(contributors).toHaveLength(2);
      // Alice first (2 edits > 1)
      expect(contributors[0].handle).toBe("alice");
      expect(contributors[0].editCount).toBe(2);
      expect(contributors[1].handle).toBe("bob");
      expect(contributors[1].editCount).toBe(1);
    });

    it("excludes agent-scoped pages so agents aren't listed as contributors", async () => {
      // A human page edited by a human...
      await createPage("page-a", "Page A", "# Page A\n\nContent.");
      await saveRevision("page-a", "# Page A\n\nv1", "alice", undefined, "yopedia");

      // ...and an agent-scoped page authored by the agent itself. Its author
      // (the agent's composite id) must NOT surface as a human contributor.
      await createPage(
        "agent-note",
        "Agent Note",
        "---\ntype: agent-knowledge\n---\n\n# Agent Note\n\nLearned.",
      );
      await saveRevision("agent-note", "# Agent Note\n\nv1", "yuanhao--yoyo", undefined, "yopedia");

      const contributors = await listContributors();
      expect(contributors.map((c) => c.handle)).toEqual(["alice"]);
    });

    it("folds automation authors (system/lint-fix) into the agent, not their own handles", async () => {
      await createPage(
        "page-a",
        "Page A",
        "---\nowner: alice\nvisibility: public\n---\n\n# Page A\n\nc.",
      );
      await saveRevision("page-a", "# Page A\n\nv1", "alice", undefined, "yopedia");
      await saveRevision("page-a", "# Page A\n\nv2", "system", undefined, "yopedia");
      await saveRevision("page-a", "# Page A\n\nv3", "lint-fix", undefined, "yopedia");
      // ...and a talk comment by an automation actor (the mergeTalkActivity path).
      await createThread("page-a", "T", "alice", "post");
      await addComment("page-a", 0, "lint-fix", "auto comment");

      // Live-scan path: system/lint-fix are credited to the agent (yoyo), never
      // shown as their own contributors.
      const scanned = await listContributors({ id: "alice", handle: "alice" });
      const handles = scanned.map((c) => c.handle);
      expect(handles).toContain("alice");
      expect(handles).toContain("yoyo");
      expect(handles).not.toContain("system");
      expect(handles).not.toContain("lint-fix");
      // The lint-fix comment counts toward yoyo, not its own handle.
      expect(scanned.find((c) => c.handle === "yoyo")?.commentCount).toBe(1);

      // Index fast path (anonymous) stays clean too.
      const { rebuildContributorIndex } = await import("../contributor-index");
      await rebuildContributorIndex();
      const anon = await listContributors(null).then((cs) => cs.map((c) => c.handle));
      expect(anon).not.toContain("system");
      expect(anon).not.toContain("lint-fix");
    });

    it("takes the contributor-index fast path ONLY for an anonymous viewer; a non-null principal uses the per-principal scan (sees their own private pages)", async () => {
      // A PUBLIC page edited by alice (visible to everyone, in the anon index).
      await createPage(
        "pub",
        "Pub",
        "---\nowner: alice\nvisibility: public\n---\n\n# Pub\n\nc.",
      );
      await saveRevision("pub", "# Pub\n\nv1", "alice", undefined, "alice");

      // A PRIVATE page owned+edited by bob (invisible to anon → NOT in index).
      await createPage(
        "priv",
        "Priv",
        "---\nowner: bob\nvisibility: private\n---\n\n# Priv\n\nc.",
      );
      await saveRevision("priv", "# Priv\n\nv1", "bob", undefined, "bob");

      // Build the index from the ANONYMOUS scan: only alice/pub.
      const { rebuildContributorIndex, getContributorIndex } = await import(
        "../contributor-index"
      );
      await rebuildContributorIndex();
      expect(await getContributorIndex()).not.toBeNull();

      // Anonymous: fast path → index only → bob (private) absent.
      const anon = await listContributors(null);
      expect(anon.map((c) => c.handle)).toEqual(["alice"]);

      // bob as principal: must NOT take the anon fast path; the per-principal
      // scan sees bob's own private page, so bob shows up.
      const asBob = await listContributors({ id: "bob", handle: "bob" });
      expect(asBob.map((c) => c.handle).sort()).toEqual(["alice", "bob"]);
    });
  });

  describe("buildContributorProfile", () => {
    it("counts edits correctly across multiple pages", async () => {
      await createPage("page-x", "Page X", "# Page X\n\nContent.");
      await createPage("page-y", "Page Y", "# Page Y\n\nContent.");

      // Alice edits both pages
      await saveRevision("page-x", "# Page X\n\nv1", "alice", undefined, "yopedia");
      await saveRevision("page-x", "# Page X\n\nv2", "alice", undefined, "yopedia");
      await saveRevision("page-y", "# Page Y\n\nv1", "alice", undefined, "yopedia");

      const profile = await buildContributorProfile("alice");
      expect(profile.handle).toBe("alice");
      expect(profile.editCount).toBe(3);
      expect(profile.pagesEdited).toBe(2);
    });

    it("uses the contributor index when present (O(1) fast-path, not a live scan)", async () => {
      await createPage("idx-page", "Idx", "# Idx\n\nc");
      await saveRevision("idx-page", "# Idx\n\nv1", "alice", undefined, "yopedia");
      // Seed the index from the current on-disk state → alice has 1 edit.
      const { rebuildContributorIndex } = await import("../contributor-index");
      await rebuildContributorIndex();
      // Add MORE on-disk activity the index doesn't know about.
      await saveRevision("idx-page", "# Idx\n\nv2", "alice", undefined, "yopedia");
      // The profile must come from the (now-stale) index, not a fresh scan — so
      // it still reports 1 edit. A re-scan would read the revisions → 2.
      const profile = await buildContributorProfile("alice");
      expect(profile.editCount).toBe(1);
    });

    it("returns an empty profile (no scan) for a handle absent from a present index", async () => {
      await createPage("idx-page2", "Idx2", "# Idx2\n\nc");
      await saveRevision("idx-page2", "# Idx2\n\nv1", "alice", undefined, "yopedia");
      const { rebuildContributorIndex } = await import("../contributor-index");
      await rebuildContributorIndex(); // index present, knows only alice
      // bob isn't in the index; give him on-disk activity a scan WOULD find.
      await saveRevision("idx-page2", "# Idx2\n\nv2", "bob", undefined, "yopedia");
      // Index present → bob short-circuits to a zeroed profile, NOT a scan
      // (which would report editCount 1). Guards the "absent handle still skips
      // the scan" contract against a regression that re-scans unknown handles.
      const profile = await buildContributorProfile("bob");
      expect(profile.handle).toBe("bob");
      expect(profile.editCount).toBe(0);
    });

    it("counts talk comments and threads", async () => {
      await ensureDirectories();

      // Create a thread (alice creates it — 1 thread, 1 comment)
      await createThread("some-page", "Discussion", "alice", "Initial post");

      // Bob adds a comment (1 comment, 0 threads)
      await addComment("some-page", 0, "bob", "Reply to alice");

      // Alice adds another comment (now 2 comments total)
      await addComment("some-page", 0, "alice", "Follow-up");

      const aliceProfile = await buildContributorProfile("alice");
      expect(aliceProfile.commentCount).toBe(2);
      expect(aliceProfile.threadsCreated).toBe(1);

      const bobProfile = await buildContributorProfile("bob");
      expect(bobProfile.commentCount).toBe(1);
      expect(bobProfile.threadsCreated).toBe(0);
    });

    it("returns a zeroed-out profile for unknown handle", async () => {
      await ensureDirectories();
      const profile = await buildContributorProfile("nobody");
      expect(profile.handle).toBe("nobody");
      expect(profile.editCount).toBe(0);
      expect(profile.pagesEdited).toBe(0);
      expect(profile.commentCount).toBe(0);
      expect(profile.threadsCreated).toBe(0);
      expect(profile.revertCount).toBe(0);
      expect(profile.trustScore).toBe(0);
    });
  });

  describe("trust score", () => {
    it("caps at 1.0 for prolific contributors", async () => {
      await createPage("page-trust", "Trust Page", "# Trust\n\nContent.");

      // Create 60 revisions by "prolific" (well above the /50 threshold)
      for (let i = 0; i < 60; i++) {
        await saveRevision("page-trust", `# Trust\n\nv${i}`, "prolific", undefined, "yopedia");
      }

      const profile = await buildContributorProfile("prolific");
      expect(profile.editCount).toBe(60);
      expect(profile.trustScore).toBe(1);
    });

    it("computes trust proportionally for low activity", async () => {
      await createPage("page-low", "Low Page", "# Low\n\nContent.");

      // 10 edits → trust = min(1, 10/50) = 0.2
      for (let i = 0; i < 10; i++) {
        await saveRevision("page-low", `# Low\n\nv${i}`, "newcomer", undefined, "yopedia");
      }

      const profile = await buildContributorProfile("newcomer");
      expect(profile.editCount).toBe(10);
      expect(profile.trustScore).toBeCloseTo(0.2);
    });

    it("includes comment count in trust calculation", async () => {
      await ensureDirectories();

      // 5 comments, 0 edits → trust = min(1, 5/50) = 0.1
      await createThread("discuss-page", "Thread 1", "commenter", "post 1");
      await addComment("discuss-page", 0, "commenter", "post 2");
      await addComment("discuss-page", 0, "commenter", "post 3");
      await addComment("discuss-page", 0, "commenter", "post 4");
      await addComment("discuss-page", 0, "commenter", "post 5");

      const profile = await buildContributorProfile("commenter");
      expect(profile.commentCount).toBe(5);
      expect(profile.editCount).toBe(0);
      expect(profile.trustScore).toBeCloseTo(0.1);
    });
  });

  describe("firstSeen and lastSeen", () => {
    it("reflects actual date range from revisions", async () => {
      await createPage("page-dates", "Dates", "# Dates\n\nContent.");

      // Create revisions with known timestamps by writing files directly.
      // Page has no owner → tenantForOwner(undefined) = "yopedia", so
      // revisions must live in the tenant silo path.
      const revisionsDir = path.join(
        tmpDir, "tenants", "yopedia", "wiki", ".revisions", "page-dates",
      );
      await fs.mkdir(revisionsDir, { recursive: true });

      const earlyTs = 1700000000000; // 2023-11-14
      const lateTs  = 1800000000000; // 2027-01-15

      await fs.writeFile(path.join(revisionsDir, `${earlyTs}.md`), "v1", "utf-8");
      await fs.writeFile(
        path.join(revisionsDir, `${earlyTs}.meta.json`),
        JSON.stringify({ author: "timekeeper" }),
        "utf-8",
      );

      await fs.writeFile(path.join(revisionsDir, `${lateTs}.md`), "v2", "utf-8");
      await fs.writeFile(
        path.join(revisionsDir, `${lateTs}.meta.json`),
        JSON.stringify({ author: "timekeeper" }),
        "utf-8",
      );

      const profile = await buildContributorProfile("timekeeper");
      expect(profile.firstSeen).toBe(new Date(earlyTs).toISOString());
      expect(profile.lastSeen).toBe(new Date(lateTs).toISOString());
    });

    it("uses epoch for unknown handle with no activity", async () => {
      await ensureDirectories();
      const profile = await buildContributorProfile("ghost");
      expect(profile.firstSeen).toBe(new Date(0).toISOString());
      expect(profile.lastSeen).toBe(new Date(0).toISOString());
    });
  });

  describe("revert detection", () => {
    it("contributor with no reverts gets full trust score", async () => {
      await createPage("page-norevert", "No Revert", "# No Revert\n\nContent.");

      // Alice makes several edits, no one reverts
      for (let i = 0; i < 10; i++) {
        await saveRevision("page-norevert", `# No Revert\n\nv${i} ${"x".repeat(100)}`, "alice", undefined, "yopedia");
      }

      const profile = await buildContributorProfile("alice");
      expect(profile.revertCount).toBe(0);
      // trust = min(1, 10/50) * (1 - min(0.5, 0*0.1)) = 0.2 * 1 = 0.2
      expect(profile.trustScore).toBeCloseTo(0.2);
    });

    it("contributor whose content was reverted gets reduced trust score", async () => {
      await createPage("page-reverted", "Reverted", "# Reverted\n\nContent.");

      // Alice writes a long revision
      await saveRevision("page-reverted", "# Reverted\n\n" + "x".repeat(1000), "alice", undefined, "yopedia");
      // Bob substantially reduces it (>50% reduction = revert of alice)
      await saveRevision("page-reverted", "# Reverted\n\nShort.", "bob", undefined, "yopedia");

      const aliceProfile = await buildContributorProfile("alice");
      expect(aliceProfile.revertCount).toBe(1);
      // trust = min(1, 1/50) * (1 - min(0.5, 1*0.1)) = 0.02 * 0.9 = 0.018
      expect(aliceProfile.trustScore).toBeCloseTo(0.018);

      // Bob should have 0 reverts (his content wasn't reverted)
      const bobProfile = await buildContributorProfile("bob");
      expect(bobProfile.revertCount).toBe(0);
    });

    it("revert detection only triggers when different author reverts", async () => {
      await createPage("page-self", "Self Edit", "# Self\n\nContent.");

      // Alice writes a long revision then shortens it herself
      await saveRevision("page-self", "# Self\n\n" + "x".repeat(1000), "alice", undefined, "yopedia");
      await saveRevision("page-self", "# Self\n\nShort.", "alice", undefined, "yopedia");

      const profile = await buildContributorProfile("alice");
      // Same author reducing own content is NOT a revert
      expect(profile.revertCount).toBe(0);
    });

    it("revert detection requires >50% size reduction", async () => {
      await createPage("page-small-edit", "Small Edit", "# Small\n\nContent.");

      // Alice writes 100 chars
      await saveRevision("page-small-edit", "# Small\n\n" + "x".repeat(100), "alice", undefined, "yopedia");
      // Bob trims only 30% (not enough to count as revert)
      await saveRevision("page-small-edit", "# Small\n\n" + "x".repeat(77), "bob", undefined, "yopedia");

      const profile = await buildContributorProfile("alice");
      expect(profile.revertCount).toBe(0);
    });

    it("multiple reverts accumulate and cap trust penalty at 50%", async () => {
      await createPage("page-multi", "Multi Revert", "# Multi\n\nContent.");

      // Alice writes and bob reverts 6 times (above the 5-revert cap)
      for (let i = 0; i < 6; i++) {
        await saveRevision("page-multi", `# Multi\n\n${"x".repeat(1000)} round ${i}`, "alice", undefined, "yopedia");
        await saveRevision("page-multi", "# Multi\n\nReverted.", "bob", undefined, "yopedia");
      }

      const aliceProfile = await buildContributorProfile("alice");
      expect(aliceProfile.revertCount).toBe(6);
      // trust = min(1, 6/50) * (1 - min(0.5, 6*0.1)) = 0.12 * 0.5 = 0.06
      // (penalty capped at 0.5 even though 6*0.1 = 0.6)
      expect(aliceProfile.trustScore).toBeCloseTo(0.06);
    });

    it("revert counts show up in listContributors", async () => {
      await createPage("page-list", "List Test", "# List\n\nContent.");

      // Alice writes, bob reverts
      await saveRevision("page-list", "# List\n\n" + "x".repeat(500), "alice", undefined, "yopedia");
      await saveRevision("page-list", "# List\n\nShort.", "bob", undefined, "yopedia");

      const contributors = await listContributors();
      const alice = contributors.find(c => c.handle === "alice");
      const bob = contributors.find(c => c.handle === "bob");

      expect(alice).toBeDefined();
      expect(alice!.revertCount).toBe(1);
      expect(bob).toBeDefined();
      expect(bob!.revertCount).toBe(0);
    });
  });

  describe("batch lookup — buildContributorProfiles", () => {
    it("returns profiles for multiple handles in one call", async () => {
      await createPage("page-batch", "Batch", "# Batch\n\nContent.");

      await saveRevision("page-batch", "# Batch\n\nv1", "alice", undefined, "yopedia");
      await saveRevision("page-batch", "# Batch\n\nv2", "alice", undefined, "yopedia");
      await saveRevision("page-batch", "# Batch\n\nv3", "bob", undefined, "yopedia");

      const profiles = await buildContributorProfiles(["alice", "bob"]);
      expect(profiles).toHaveLength(2);
      expect(profiles[0].handle).toBe("alice");
      expect(profiles[0].editCount).toBe(2);
      expect(profiles[1].handle).toBe("bob");
      expect(profiles[1].editCount).toBe(1);
    });

    it("returns zeroed-out profile for unknown handles in batch", async () => {
      await ensureDirectories();

      const profiles = await buildContributorProfiles(["ghost", "phantom"]);
      expect(profiles).toHaveLength(2);
      expect(profiles[0].handle).toBe("ghost");
      expect(profiles[0].editCount).toBe(0);
      expect(profiles[0].trustScore).toBe(0);
      expect(profiles[1].handle).toBe("phantom");
      expect(profiles[1].editCount).toBe(0);
    });

    it("mixes known and unknown handles correctly", async () => {
      await createPage("page-mix", "Mix", "# Mix\n\nContent.");
      await saveRevision("page-mix", "# Mix\n\nv1", "alice", undefined, "yopedia");

      const profiles = await buildContributorProfiles(["alice", "nobody"]);
      expect(profiles).toHaveLength(2);
      expect(profiles[0].handle).toBe("alice");
      expect(profiles[0].editCount).toBe(1);
      expect(profiles[1].handle).toBe("nobody");
      expect(profiles[1].editCount).toBe(0);
    });

    it("preserves order matching input handles", async () => {
      await createPage("page-order", "Order", "# Order\n\nContent.");
      await saveRevision("page-order", "# Order\n\nv1", "zara", undefined, "yopedia");
      await saveRevision("page-order", "# Order\n\nv2", "alice", undefined, "yopedia");

      const profiles = await buildContributorProfiles(["zara", "alice"]);
      expect(profiles[0].handle).toBe("zara");
      expect(profiles[1].handle).toBe("alice");
    });
  });

  describe("shared scan data — computeScanData", () => {
    it("computes scan data that can be shared across multiple profile builds", async () => {
      await createPage("page-shared", "Shared", "# Shared\n\nContent.");
      await saveRevision("page-shared", "# Shared\n\nv1", "alice", undefined, "yopedia");
      await saveRevision("page-shared", "# Shared\n\nv2", "bob", undefined, "yopedia");

      // Compute scan data once
      const scanData = await computeScanData();

      // Build profiles using the shared scan data
      const aliceProfile = await buildContributorProfile("alice", scanData);
      const bobProfile = await buildContributorProfile("bob", scanData);

      expect(aliceProfile.handle).toBe("alice");
      expect(aliceProfile.editCount).toBe(1);
      expect(bobProfile.handle).toBe("bob");
      expect(bobProfile.editCount).toBe(1);
    });

    it("shared scan data includes talk activity", async () => {
      await ensureDirectories();
      await createThread("discuss-page", "Thread", "alice", "Post");
      await addComment("discuss-page", 0, "bob", "Reply");

      const scanData = await computeScanData();
      const aliceProfile = await buildContributorProfile("alice", scanData);
      const bobProfile = await buildContributorProfile("bob", scanData);

      expect(aliceProfile.commentCount).toBe(1);
      expect(aliceProfile.threadsCreated).toBe(1);
      expect(bobProfile.commentCount).toBe(1);
      expect(bobProfile.threadsCreated).toBe(0);
    });

    it("shared scan data includes revert detection", async () => {
      await createPage("page-scan-revert", "Scan Revert", "# Scan\n\nContent.");
      await saveRevision("page-scan-revert", "# Scan\n\n" + "x".repeat(1000), "alice", undefined, "yopedia");
      await saveRevision("page-scan-revert", "# Scan\n\nShort.", "bob", undefined, "yopedia");

      const scanData = await computeScanData();
      const aliceProfile = await buildContributorProfile("alice", scanData);

      expect(aliceProfile.revertCount).toBe(1);
    });

    it("batch profiles with shared scan data match individual builds", async () => {
      await createPage("page-match", "Match", "# Match\n\nContent.");
      await saveRevision("page-match", "# Match\n\nv1", "alice", undefined, "yopedia");
      await saveRevision("page-match", "# Match\n\nv2", "bob", undefined, "yopedia");

      const scanData = await computeScanData();

      const batch = await buildContributorProfiles(["alice", "bob"], scanData);
      const aliceSingle = await buildContributorProfile("alice", scanData);
      const bobSingle = await buildContributorProfile("bob", scanData);

      expect(batch[0]).toEqual(aliceSingle);
      expect(batch[1]).toEqual(bobSingle);
    });
  });

  describe("reduceReverts normalizeActor", () => {
    /** Helper to build a minimal Revision object for unit tests. */
    function rev(author: string, sizeBytes: number, timestamp = 0): Revision {
      return { timestamp, date: new Date(timestamp).toISOString(), slug: "test-page", sizeBytes, author };
    }

    it("treats different automation handles as same-author (no false revert)", () => {
      // "system" writes 1000 bytes, then "lint-fix" shrinks to 100 bytes.
      // Both normalise to "yoyo", so this is a same-author edit, NOT a revert.
      const revisions: Revision[][] = [
        [rev("lint-fix", 100, 2), rev("system", 1000, 1)], // newest-first
      ];
      const counts = reduceReverts(revisions);
      // No revert should be counted — same normalized author.
      expect(counts.size).toBe(0);
    });

    it("keys revert counts on the normalized handle", () => {
      // "system" writes 1000 bytes, then "alice" shrinks to 100 (>50% reduction).
      // The revert count should be keyed as "yoyo" (normalized "system"), not "system".
      const revisions: Revision[][] = [
        [rev("alice", 100, 2), rev("system", 1000, 1)], // newest-first
      ];
      const counts = reduceReverts(revisions);
      expect(counts.get("yoyo")).toBe(1);
      expect(counts.has("system")).toBe(false);
    });

    it("trust score for yoyo reflects revert penalties from automation actors", async () => {
      await createPage("page-auto-revert", "Auto Revert", "# Auto\n\nContent.");
      // "system" writes a large revision...
      await saveRevision("page-auto-revert", "# Auto\n\n" + "x".repeat(1000), "system", undefined, "yopedia");
      // ...then a human substantially shrinks it (>50% reduction = revert).
      await saveRevision("page-auto-revert", "# Auto\n\nShort.", "alice", undefined, "yopedia");

      const scanData = await computeScanData();
      // The normalized handle "yoyo" should appear in activityMap (from reduceActivity)
      // and revertCounts (from reduceReverts) with matching keys.
      const yoyoProfile = await buildContributorProfile("yoyo", scanData);
      expect(yoyoProfile.revertCount).toBe(1);
      expect(yoyoProfile.trustScore).toBeLessThan(1.0);
    });
  });
});
