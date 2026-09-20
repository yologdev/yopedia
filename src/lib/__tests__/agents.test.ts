import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getAgentsDir,
  ensureAgentsDir,
  listAgents,
  listAgentsForOwner,
  getAgent,
  getAgentByOwnerName,
  registerAgent,
  deleteAgent,
  seedAgent,
  updateAgent,
  assertCanMutateAgent,
  AgentOwnershipError,
  agentIdFor,
  agentShortName,
  forkAgent,
  resolveAgentPages,
  generateAgentToken,
  verifyAgentToken,
  revokeAgentToken,
  agentTokenInfo,
  addAgentLearningPage,
} from "../agents";
import type { UpdateAgentPage } from "../agents";
import { readWikiPage, readWikiPageWithFrontmatter } from "../wiki";
import { writePageFixture } from "./helpers/wiki-fixtures";
import type { AgentProfile } from "../types";
import { createVault } from "../vault";
import { _resetStorage, getStorage } from "../storage";

// ---------------------------------------------------------------------------
// Test setup — temp directory with DATA_DIR override
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalDataDir: string | undefined;
let originalWikiDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-test-"));
  originalDataDir = process.env.DATA_DIR;
  originalWikiDir = process.env.WIKI_DIR;
  process.env.DATA_DIR = tmpDir;
  // Point WIKI_DIR to tmpDir/wiki so readWikiPage finds our test pages
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  await fs.mkdir(path.join(tmpDir, "wiki"), { recursive: true });
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent for unit tests",
    identityPages: [],
    learningPages: [],
    socialPages: [],
    registered: "2026-05-03T00:00:00.000Z",
    lastUpdated: "2026-05-03T00:00:00.000Z",
    ...overrides,
  };
}

/** Write a wiki page where the read path will look for it (#869: silo-only). */
async function writeTestWikiPage(slug: string, content: string): Promise<void> {
  await writePageFixture(slug, content);
}

// ---------------------------------------------------------------------------
// Data layer tests
// ---------------------------------------------------------------------------

describe("getAgentsDir", () => {
  it("returns <dataDir>/agents", () => {
    expect(getAgentsDir()).toBe(path.join(tmpDir, "agents"));
  });
});

describe("ensureAgentsDir", () => {
  it("is a no-op (storage creates dirs on write)", async () => {
    // ensureAgentsDir is now a no-op since the storage provider creates
    // parent directories automatically on write. Just verify it doesn't throw.
    await ensureAgentsDir();
  });

  it("is idempotent", async () => {
    await ensureAgentsDir();
    await ensureAgentsDir(); // should not throw
  });
});

describe("listAgents", () => {
  it("returns empty array when agents dir does not exist", async () => {
    const agents = await listAgents();
    expect(agents).toEqual([]);
  });

  it("returns empty array when agents dir is empty", async () => {
    await ensureAgentsDir();
    const agents = await listAgents();
    expect(agents).toEqual([]);
  });

  it("returns all registered agents sorted by ID", async () => {
    const profileB = makeProfile({ id: "beta", name: "Beta Agent" });
    const profileA = makeProfile({ id: "alpha", name: "Alpha Agent" });
    await registerAgent(profileB);
    await registerAgent(profileA);

    const agents = await listAgents();
    expect(agents).toHaveLength(2);
    expect(agents[0].id).toBe("alpha");
    expect(agents[1].id).toBe("beta");
  });

  it("skips non-JSON files in agents dir", async () => {
    const storage = getStorage();
    await storage.writeFile("agents/README.md", "hello");
    await registerAgent(makeProfile());

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
  });

  it("skips malformed JSON files gracefully", async () => {
    const storage = getStorage();
    await storage.writeFile("agents/bad.json", "not valid json {{{");
    await registerAgent(makeProfile());

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("test-agent");
  });
});

describe("getAgent", () => {
  it("returns null for non-existent agent", async () => {
    const agent = await getAgent("nope");
    expect(agent).toBeNull();
  });

  it("returns the profile after registration", async () => {
    const profile = makeProfile({ id: "yoyo", name: "Yoyo" });
    await registerAgent(profile);

    const agent = await getAgent("yoyo");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("yoyo");
    expect(agent!.name).toBe("Yoyo");
  });

  it("throws on invalid ID", async () => {
    await expect(getAgent("INVALID")).rejects.toThrow(/Invalid agent ID/);
    await expect(getAgent("")).rejects.toThrow(/Invalid agent ID/);
    await expect(getAgent("-bad")).rejects.toThrow(/Invalid agent ID/);
  });
});

describe("updateAgent — defaultVault", () => {
  async function aliceAgent(): Promise<AgentProfile> {
    const profile = makeProfile({ id: "alice--yoyo", owner: "alice" });
    await registerAgent(profile);
    return profile;
  }

  it("sets a target vault the owner owns", async () => {
    await aliceAgent();
    const vault = await createVault("alice", "Inbox", "public");
    const updated = await updateAgent("alice--yoyo", { defaultVault: vault.id });
    expect(updated!.defaultVault).toBe(vault.id);
    // Persisted.
    expect((await getAgent("alice--yoyo"))!.defaultVault).toBe(vault.id);
  });

  it("rejects a vault the owner does not own", async () => {
    await aliceAgent();
    const foreign = await createVault("bob", "Stuff", "public");
    await expect(
      updateAgent("alice--yoyo", { defaultVault: foreign.id }),
    ).rejects.toThrow(/vault you own/i);
  });

  it("rejects a non-existent vault (even with the owner's prefix)", async () => {
    await aliceAgent();
    await expect(
      updateAgent("alice--yoyo", { defaultVault: "alice--ghost" }),
    ).rejects.toThrow(/vault you own/i);
  });

  it("clears the target vault with an empty string", async () => {
    await aliceAgent();
    const vault = await createVault("alice", "Inbox", "public");
    await updateAgent("alice--yoyo", { defaultVault: vault.id });
    const cleared = await updateAgent("alice--yoyo", { defaultVault: "" });
    expect(cleared!.defaultVault).toBeUndefined();
  });
});

describe("registerAgent", () => {
  it("creates a JSON file on disk", async () => {
    const profile = makeProfile({ id: "yoyo" });
    await registerAgent(profile);

    const filePath = path.join(getAgentsDir(), "yoyo.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("yoyo");
    expect(parsed.name).toBe("Test Agent");
  });

  it("overwrites existing profile on re-registration", async () => {
    await registerAgent(makeProfile({ id: "yoyo", name: "V1" }));
    await registerAgent(makeProfile({ id: "yoyo", name: "V2" }));

    const agent = await getAgent("yoyo");
    expect(agent!.name).toBe("V2");
  });

  it("round-trips all fields correctly", async () => {
    const profile = makeProfile({
      id: "yoyo",
      name: "Yoyo",
      description: "A small octopus growing up in public",
      identityPages: ["yoyo-identity", "yoyo-personality"],
      learningPages: ["yoyo-learnings"],
      socialPages: ["yoyo-social-wisdom"],
      registered: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-05-03T02:14:00.000Z",
    });
    await registerAgent(profile);

    const agent = await getAgent("yoyo");
    expect(agent).toEqual(profile);
  });

  it("defaults array fields to empty arrays", async () => {
    // Cast to simulate a profile without array fields set
    const sparse = {
      id: "minimal",
      name: "Minimal",
      description: "Bare minimum",
      registered: "2026-05-03T00:00:00.000Z",
      lastUpdated: "2026-05-03T00:00:00.000Z",
    } as AgentProfile;

    await registerAgent(sparse);
    const agent = await getAgent("minimal");
    expect(agent!.identityPages).toEqual([]);
    expect(agent!.learningPages).toEqual([]);
    expect(agent!.socialPages).toEqual([]);
  });
});

describe("registerAgent validation", () => {
  it("rejects empty ID", async () => {
    await expect(registerAgent(makeProfile({ id: "" }))).rejects.toThrow(
      /Invalid agent ID/,
    );
  });

  it("rejects ID starting with hyphen", async () => {
    await expect(registerAgent(makeProfile({ id: "-bad" }))).rejects.toThrow(
      /Invalid agent ID/,
    );
  });

  it("rejects ID with uppercase letters", async () => {
    await expect(registerAgent(makeProfile({ id: "Bad" }))).rejects.toThrow(
      /Invalid agent ID/,
    );
  });

  it("rejects ID with spaces", async () => {
    await expect(
      registerAgent(makeProfile({ id: "bad agent" })),
    ).rejects.toThrow(/Invalid agent ID/);
  });

  it("rejects missing name", async () => {
    await expect(registerAgent(makeProfile({ name: "" }))).rejects.toThrow(
      /non-empty 'name'/,
    );
  });

  it("rejects missing description", async () => {
    await expect(
      registerAgent(makeProfile({ description: "" })),
    ).rejects.toThrow(/non-empty 'description'/);
  });

  it("accepts valid IDs", async () => {
    // All these should succeed without throwing
    await registerAgent(makeProfile({ id: "a" }));
    await registerAgent(makeProfile({ id: "yoyo" }));
    await registerAgent(makeProfile({ id: "agent-1" }));
    await registerAgent(makeProfile({ id: "0day" }));

    const agents = await listAgents();
    expect(agents).toHaveLength(4);
  });
});

describe("deleteAgent", () => {
  it("returns false for non-existent agent", async () => {
    const result = await deleteAgent("nope");
    expect(result).toBe(false);
  });

  it("deletes an existing agent and returns true", async () => {
    await registerAgent(makeProfile({ id: "doomed" }));
    expect(await getAgent("doomed")).not.toBeNull();

    const result = await deleteAgent("doomed");
    expect(result).toBe(true);
    expect(await getAgent("doomed")).toBeNull();
  });

  it("throws on invalid ID", async () => {
    await expect(deleteAgent("INVALID")).rejects.toThrow(/Invalid agent ID/);
  });

  it("does not affect other agents", async () => {
    await registerAgent(makeProfile({ id: "keep" }));
    await registerAgent(makeProfile({ id: "remove" }));

    await deleteAgent("remove");
    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("keep");
  });
});

// ---------------------------------------------------------------------------
// Context aggregation tests — the core logic behind GET /api/agents/:id/context
// ---------------------------------------------------------------------------

describe("agent context aggregation", () => {
  it("reads wiki pages referenced in agent profile", async () => {
    // Create wiki pages on disk
    await writeTestWikiPage("yoyo-identity", "# Identity\n\nI am yoyo.");
    await writeTestWikiPage("yoyo-learnings", "# Learnings\n\nLesson 1.");

    // Register an agent pointing to those pages
    const profile = makeProfile({
      id: "yoyo",
      name: "Yoyo",
      identityPages: ["yoyo-identity"],
      learningPages: ["yoyo-learnings"],
      socialPages: [],
    });
    await registerAgent(profile);

    // Read pages as the context endpoint would
    const agent = await getAgent("yoyo");
    expect(agent).not.toBeNull();

    const identityPage = await readWikiPage("yoyo-identity");
    expect(identityPage).not.toBeNull();
    expect(identityPage!.content).toContain("I am yoyo.");

    const learningsPage = await readWikiPage("yoyo-learnings");
    expect(learningsPage).not.toBeNull();
    expect(learningsPage!.content).toContain("Lesson 1.");
  });

  it("gracefully handles missing wiki pages", async () => {
    // Register agent referencing a page that doesn't exist
    const profile = makeProfile({
      id: "ghost",
      name: "Ghost Agent",
      identityPages: ["nonexistent-page"],
    });
    await registerAgent(profile);

    const page = await readWikiPage("nonexistent-page");
    expect(page).toBeNull(); // Should return null, not throw
  });

  it("concatenates multiple pages with separator", async () => {
    await writeTestWikiPage("page-a", "# Page A\n\nContent A.");
    await writeTestWikiPage("page-b", "# Page B\n\nContent B.");

    const separator = "\n\n---\n\n";
    const slugs = ["page-a", "page-b"];
    const contents: string[] = [];
    for (const slug of slugs) {
      const page = await readWikiPage(slug);
      if (page) contents.push(page.content);
    }
    const concatenated = contents.join(separator);

    expect(concatenated).toContain("Content A.");
    expect(concatenated).toContain("---");
    expect(concatenated).toContain("Content B.");
  });

  it("skips missing pages during concatenation", async () => {
    await writeTestWikiPage("exists", "# Exists\n\nReal content.");

    const slugs = ["exists", "does-not-exist"];
    const contents: string[] = [];
    for (const slug of slugs) {
      const page = await readWikiPage(slug);
      if (page) contents.push(page.content);
    }

    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("Real content.");
  });

  it("computes correct metadata for context response", async () => {
    await writeTestWikiPage("id-page", "# Identity\n\nWho I am.");
    await writeTestWikiPage("learn-page", "# Learnings\n\nWhat I learned.");
    await writeTestWikiPage("social-page", "# Social\n\nWhat I know about people.");

    const profile = makeProfile({
      id: "meta-test",
      name: "Meta Test",
      identityPages: ["id-page"],
      learningPages: ["learn-page"],
      socialPages: ["social-page"],
    });
    await registerAgent(profile);

    // Simulate the context endpoint logic
    const separator = "\n\n---\n\n";
    const sections = [
      profile.identityPages,
      profile.learningPages,
      profile.socialPages,
    ];

    let totalChars = 0;
    let pageCount = 0;
    const contextParts: string[] = [];

    for (const slugs of sections) {
      const contents: string[] = [];
      for (const slug of slugs) {
        const page = await readWikiPage(slug);
        if (page) {
          contents.push(page.content);
          pageCount++;
        }
      }
      const sectionContent = contents.join(separator);
      totalChars += sectionContent.length;
      contextParts.push(sectionContent);
    }

    expect(pageCount).toBe(3);
    expect(totalChars).toBeGreaterThan(0);
    expect(contextParts[0]).toContain("Who I am.");
    expect(contextParts[1]).toContain("What I learned.");
    expect(contextParts[2]).toContain("What I know about people.");
  });

  it("returns empty strings for sections with no pages", async () => {
    const profile = makeProfile({
      id: "empty",
      name: "Empty Agent",
      identityPages: [],
      learningPages: [],
      socialPages: [],
    });
    await registerAgent(profile);

    // With no slugs, each section should be empty
    for (const slugs of [profile.identityPages, profile.learningPages, profile.socialPages]) {
      const contents: string[] = [];
      for (const slug of slugs) {
        const page = await readWikiPage(slug);
        if (page) contents.push(page.content);
      }
      expect(contents.join("\n\n---\n\n")).toBe("");
    }
  });

  it("POST + GET round-trip preserves all fields", async () => {
    // Simulate the full POST → GET round trip as the API routes do it
    const profile: AgentProfile = {
      id: "roundtrip",
      name: "Round Trip Agent",
      description: "Testing the full lifecycle",
      identityPages: ["rt-identity"],
      learningPages: ["rt-learn-1", "rt-learn-2"],
      socialPages: ["rt-social"],
      registered: "2026-05-03T00:00:00.000Z",
      lastUpdated: "2026-05-03T02:14:00.000Z",
    };

    await registerAgent(profile);
    const agents = await listAgents();
    expect(agents.some((a) => a.id === "roundtrip")).toBe(true);

    const fetched = await getAgent("roundtrip");
    expect(fetched).toEqual(profile);
  });
});

// ---------------------------------------------------------------------------
// seedAgent tests — creating wiki pages + registering agent in one call
// ---------------------------------------------------------------------------

describe("seedAgent", () => {
  it("creates wiki pages with correct frontmatter and registers agent", async () => {
    const result = await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "A small octopus growing up in public",
      sections: [
        {
          type: "identity",
          slug: "yoyo-identity",
          title: "Yoyo Identity",
          content: "I am yoyo, a self-evolving coding agent.",
        },
        {
          type: "learnings",
          slug: "yoyo-learnings",
          title: "Yoyo Learnings",
          content: "Lesson 1: Tests before features.",
        },
        {
          type: "social",
          slug: "yoyo-social",
          title: "Yoyo Social Wisdom",
          content: "People ask questions in different ways.",
        },
      ],
    });

    // Agent profile is returned and persisted
    expect(result.id).toBe("yoyo");
    expect(result.name).toBe("Yoyo");
    expect(result.identityPages).toEqual(["yoyo-identity"]);
    expect(result.learningPages).toEqual(["yoyo-learnings"]);
    expect(result.socialPages).toEqual(["yoyo-social"]);

    // Agent is retrievable
    const agent = await getAgent("yoyo");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("yoyo");

    // Wiki pages exist with correct content
    const identityPage = await readWikiPage("yoyo-identity");
    expect(identityPage).not.toBeNull();
    expect(identityPage!.content).toContain("I am yoyo, a self-evolving coding agent.");

    const learningsPage = await readWikiPage("yoyo-learnings");
    expect(learningsPage).not.toBeNull();
    expect(learningsPage!.content).toContain("Lesson 1: Tests before features.");

    const socialPage = await readWikiPage("yoyo-social");
    expect(socialPage).not.toBeNull();
    expect(socialPage!.content).toContain("People ask questions in different ways.");
  });

  it("sets correct frontmatter on created pages", async () => {
    await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "A small octopus",
      sections: [
        {
          type: "identity",
          slug: "yoyo-id",
          title: "Yoyo Identity",
          content: "Who I am.",
        },
      ],
    });

    const page = await readWikiPageWithFrontmatter("yoyo-id");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.type).toBe("agent-identity");
    expect(page!.frontmatter.authors).toEqual(["yoyo"]);
    expect(page!.frontmatter.confidence).toBe(0.9);
    expect(page!.frontmatter.expiry).toBeDefined();
    expect(page!.frontmatter.contributors).toEqual(["yoyo"]);
    // Expiry should be roughly 1 year from now
    const expiry = new Date(page!.frontmatter.expiry as string);
    const now = new Date();
    const diffDays = (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(360);
    expect(diffDays).toBeLessThan(370);
  });

  it("is idempotent — second call updates rather than duplicates", async () => {
    const opts = {
      id: "yoyo",
      name: "Yoyo",
      description: "A small octopus",
      sections: [
        {
          type: "identity" as const,
          slug: "yoyo-id",
          title: "Yoyo Identity",
          content: "Version 1.",
        },
      ],
    };

    const first = await seedAgent(opts);

    // Update content on second call
    const updatedOpts = {
      ...opts,
      sections: [
        {
          type: "identity" as const,
          slug: "yoyo-id",
          title: "Yoyo Identity",
          content: "Version 2 — updated.",
        },
      ],
    };
    const second = await seedAgent(updatedOpts);

    // Should still be one agent, not two
    const agents = await listAgents();
    expect(agents.filter((a) => a.id === "yoyo")).toHaveLength(1);

    // The page should contain updated content
    const page = await readWikiPage("yoyo-id");
    expect(page).not.toBeNull();
    expect(page!.content).toContain("Version 2 — updated.");
    expect(page!.content).not.toContain("Version 1.");

    // Second call should preserve the original registration date
    expect(second.registered).toBe(first.registered);
  });

  it("preserves original created date on re-seed", async () => {
    // First seed
    await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "A small octopus",
      sections: [
        {
          type: "identity",
          slug: "yoyo-id",
          title: "Yoyo Identity",
          content: "Original.",
        },
      ],
    });

    const firstPage = await readWikiPageWithFrontmatter("yoyo-id");
    const originalCreated = firstPage!.frontmatter.created;

    // Wait a tiny bit to get a different timestamp
    await new Promise((r) => setTimeout(r, 10));

    // Re-seed
    await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "A small octopus",
      sections: [
        {
          type: "identity",
          slug: "yoyo-id",
          title: "Yoyo Identity",
          content: "Updated.",
        },
      ],
    });

    const secondPage = await readWikiPageWithFrontmatter("yoyo-id");
    expect(secondPage!.frontmatter.created).toBe(originalCreated);
  });

  it("validates required fields", async () => {
    await expect(
      seedAgent({
        id: "",
        name: "Test",
        description: "Test",
        sections: [],
      }),
    ).rejects.toThrow(/Invalid agent ID/);

    await expect(
      seedAgent({
        id: "test",
        name: "",
        description: "Test",
        sections: [],
      }),
    ).rejects.toThrow(/non-empty 'name'/);

    await expect(
      seedAgent({
        id: "test",
        name: "Test",
        description: "",
        sections: [],
      }),
    ).rejects.toThrow(/non-empty 'description'/);
  });

  it("works with no sections (registers agent only)", async () => {
    const result = await seedAgent({
      id: "empty-agent",
      name: "Empty",
      description: "Agent with no sections",
      sections: [],
    });

    expect(result.identityPages).toEqual([]);
    expect(result.learningPages).toEqual([]);
    expect(result.socialPages).toEqual([]);

    const agent = await getAgent("empty-agent");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Empty");
  });
});

// ---------------------------------------------------------------------------
// updateAgent tests
// ---------------------------------------------------------------------------

describe("updateAgent", () => {
  const baseProfile = (): AgentProfile =>
    makeProfile({
      id: "yoyo",
      name: "Yoyo",
      description: "A small octopus",
      identityPages: ["yoyo-identity"],
      learningPages: ["yoyo-learnings"],
      socialPages: ["yoyo-social"],
    });

  it("returns null for non-existent agent", async () => {
    const result = await updateAgent("nope", { name: "New Name" });
    expect(result).toBeNull();
  });

  it("throws on invalid agent ID", async () => {
    await expect(updateAgent("INVALID", { name: "X" })).rejects.toThrow(
      /Invalid agent ID/,
    );
  });

  it("updates name without touching pages", async () => {
    await registerAgent(baseProfile());

    const result = await updateAgent("yoyo", { name: "Yoyo v2" });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Yoyo v2");
    expect(result!.description).toBe("A small octopus");
    expect(result!.identityPages).toEqual(["yoyo-identity"]);
    expect(result!.learningPages).toEqual(["yoyo-learnings"]);
    expect(result!.socialPages).toEqual(["yoyo-social"]);

    // Persisted to disk
    const onDisk = await getAgent("yoyo");
    expect(onDisk!.name).toBe("Yoyo v2");
  });

  it("updates description without touching pages", async () => {
    await registerAgent(baseProfile());

    const result = await updateAgent("yoyo", {
      description: "A big octopus now",
    });
    expect(result).not.toBeNull();
    expect(result!.description).toBe("A big octopus now");
    expect(result!.name).toBe("Yoyo");
  });

  it("rejects empty name", async () => {
    await registerAgent(baseProfile());
    await expect(updateAgent("yoyo", { name: "" })).rejects.toThrow(
      /non-empty string/,
    );
  });

  it("rejects empty description", async () => {
    await registerAgent(baseProfile());
    await expect(updateAgent("yoyo", { description: "" })).rejects.toThrow(
      /non-empty string/,
    );
  });

  it("removes pages from all lists", async () => {
    await registerAgent(baseProfile());

    const result = await updateAgent("yoyo", {
      removePages: ["yoyo-identity", "yoyo-learnings"],
    });
    expect(result).not.toBeNull();
    expect(result!.identityPages).toEqual([]);
    expect(result!.learningPages).toEqual([]);
    expect(result!.socialPages).toEqual(["yoyo-social"]);
  });

  it("removePages with non-matching slugs is a no-op", async () => {
    await registerAgent(baseProfile());

    const result = await updateAgent("yoyo", {
      removePages: ["does-not-exist"],
    });
    expect(result!.identityPages).toEqual(["yoyo-identity"]);
    expect(result!.learningPages).toEqual(["yoyo-learnings"]);
    expect(result!.socialPages).toEqual(["yoyo-social"]);
  });

  it("adds pages and creates wiki files", async () => {
    await registerAgent(baseProfile());

    const newPages: UpdateAgentPage[] = [
      {
        slug: "yoyo-new-learning",
        title: "New Learning",
        type: "learnings",
        content: "I learned something today.",
      },
      {
        slug: "yoyo-social-2",
        title: "Social Wisdom 2",
        type: "social",
        content: "People are interesting.",
      },
    ];

    const result = await updateAgent("yoyo", { addPages: newPages });
    expect(result).not.toBeNull();
    expect(result!.learningPages).toContain("yoyo-new-learning");
    expect(result!.learningPages).toContain("yoyo-learnings");
    expect(result!.socialPages).toContain("yoyo-social-2");
    expect(result!.socialPages).toContain("yoyo-social");

    // Verify wiki pages were actually created
    const page = await readWikiPageWithFrontmatter("yoyo-new-learning");
    expect(page).not.toBeNull();
    expect(page!.frontmatter.authors).toContain("yoyo");
    expect(page!.body).toContain("I learned something today.");
  });

  it("does not duplicate slugs when adding existing page", async () => {
    await registerAgent(baseProfile());

    // Write a wiki page for the slug that's already in identityPages
    await writeTestWikiPage(
      "yoyo-identity",
      "---\ntitle: Identity\n---\n# Identity\n\nOld content.",
    );

    const result = await updateAgent("yoyo", {
      addPages: [
        {
          slug: "yoyo-identity",
          title: "Identity Updated",
          type: "identity",
          content: "Updated content.",
        },
      ],
    });
    expect(result).not.toBeNull();
    // Should still have exactly one "yoyo-identity" in identityPages
    const count = result!.identityPages.filter(
      (s) => s === "yoyo-identity",
    ).length;
    expect(count).toBe(1);
  });

  it("handles combined update: name + addPages + removePages", async () => {
    await registerAgent(baseProfile());

    const result = await updateAgent("yoyo", {
      name: "Yoyo v3",
      addPages: [
        {
          slug: "yoyo-identity-2",
          title: "Identity Part 2",
          type: "identity",
          content: "More identity.",
        },
      ],
      removePages: ["yoyo-social"],
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Yoyo v3");
    expect(result!.identityPages).toContain("yoyo-identity");
    expect(result!.identityPages).toContain("yoyo-identity-2");
    expect(result!.socialPages).toEqual([]);
  });

  it("bumps lastUpdated timestamp", async () => {
    const profile = baseProfile();
    profile.lastUpdated = "2020-01-01T00:00:00.000Z";
    await registerAgent(profile);

    const result = await updateAgent("yoyo", { name: "Updated" });
    expect(result).not.toBeNull();
    // lastUpdated should be newer than the original
    expect(new Date(result!.lastUpdated).getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00.000Z").getTime(),
    );
  });

  it("preserves registered timestamp", async () => {
    const profile = baseProfile();
    profile.registered = "2020-01-01T00:00:00.000Z";
    await registerAgent(profile);

    const result = await updateAgent("yoyo", { name: "Updated" });
    expect(result).not.toBeNull();
    expect(result!.registered).toBe("2020-01-01T00:00:00.000Z");
  });

  it("empty update just bumps lastUpdated", async () => {
    const profile = baseProfile();
    profile.lastUpdated = "2020-01-01T00:00:00.000Z";
    await registerAgent(profile);

    const result = await updateAgent("yoyo", {});
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Yoyo");
    expect(result!.description).toBe("A small octopus");
    expect(new Date(result!.lastUpdated).getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00.000Z").getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// Ownership — owner field, assertCanMutateAgent, listAgentsForOwner
// ---------------------------------------------------------------------------

describe("agent ownership", () => {
  const sections = [
    {
      type: "identity" as const,
      slug: "yoyo-identity",
      title: "Yoyo Identity",
      content: "I am yoyo.",
    },
  ];

  it("seedAgent persists the owner and a composite id", async () => {
    const profile = await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "An agent",
      owner: "alice",
      sections,
    });
    expect(profile.owner).toBe("alice");
    expect(profile.id).toBe(agentIdFor("alice", "yoyo")); // "alice-yoyo"
    expect((await getAgentByOwnerName("alice", "yoyo"))!.owner).toBe("alice");
  });

  it("re-seed by the owner keeps owner; a different owner gets a separate agent", async () => {
    await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "An agent",
      owner: "alice",
      sections,
    });
    // Alice re-seeds her own yoyo — same composite id, owner stays alice.
    const aliceReseed = await seedAgent({
      id: "yoyo",
      name: "Yoyo v2",
      description: "An agent, updated",
      owner: "alice",
      sections,
    });
    expect(aliceReseed.id).toBe(agentIdFor("alice", "yoyo"));
    expect(aliceReseed.owner).toBe("alice");

    // Bob seeding "yoyo" creates a SEPARATE agent (bob-yoyo) — not a takeover.
    const bobSeed = await seedAgent({
      id: "yoyo",
      name: "Bob's Yoyo",
      description: "Bob's agent",
      owner: "bob",
      sections,
    });
    expect(bobSeed.id).toBe(agentIdFor("bob", "yoyo"));
    expect(bobSeed.owner).toBe("bob");
    expect((await getAgentByOwnerName("alice", "yoyo"))!.owner).toBe("alice");
  });

  describe("assertCanMutateAgent", () => {
    it("allows creation when the agent does not exist yet", async () => {
      await expect(
        assertCanMutateAgent(agentIdFor("alice", "yoyo"), "alice"),
      ).resolves.toBeNull();
    });

    it("allows the owner to mutate their agent", async () => {
      await seedAgent({
        id: "yoyo",
        name: "Yoyo",
        description: "An agent",
        owner: "alice",
        sections,
      });
      const existing = await assertCanMutateAgent(agentIdFor("alice", "yoyo"), "alice");
      expect(existing!.owner).toBe("alice");
    });

    it("rejects a non-owner with AgentOwnershipError", async () => {
      await seedAgent({
        id: "yoyo",
        name: "Yoyo",
        description: "An agent",
        owner: "alice",
        sections,
      });
      await expect(
        assertCanMutateAgent(agentIdFor("alice", "yoyo"), "bob"),
      ).rejects.toBeInstanceOf(AgentOwnershipError);
    });

    it("allows mutation of a legacy agent with no owner", async () => {
      // Pre-ownership record written directly (no owner field).
      await registerAgent(makeProfile({ id: "legacy" }));
      await expect(
        assertCanMutateAgent("legacy", "anyone"),
      ).resolves.not.toBeNull();
    });
  });

  describe("listAgentsForOwner", () => {
    it("returns only the agents owned by the handle", async () => {
      await seedAgent({
        id: "yoyo",
        name: "Yoyo",
        description: "Alice's agent",
        owner: "alice",
        sections,
      });
      await seedAgent({
        id: "yoyo",
        name: "Yoyo",
        description: "Bob's agent",
        owner: "bob",
        sections,
      });
      const aliceAgents = await listAgentsForOwner("alice");
      expect(aliceAgents.map((a) => a.id)).toEqual([agentIdFor("alice", "yoyo")]);
      expect(aliceAgents[0].owner).toBe("alice");
      expect(await listAgentsForOwner("carol")).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Addressing, fork + resolver
// ---------------------------------------------------------------------------

describe("agent addressing", () => {
  it("agentIdFor composes owner + name with an unambiguous '--' separator", () => {
    expect(agentIdFor("yopedia", "yoyo")).toBe("yopedia--yoyo");
    expect(agentIdFor("Alice_B", "yoyo")).toBe("alice-b--yoyo");
    expect(agentIdFor("bob")).toBe("bob--yoyo"); // default name
  });

  it("agentIdFor does not let a crafted name collide across owners", () => {
    // The classic single-hyphen collision: owner "a_b"+"yoyo" vs owner "a"+"b_yoyo".
    // With separate slugify + "--", these stay distinct.
    expect(agentIdFor("a_b", "yoyo")).not.toBe(agentIdFor("a", "b_yoyo"));
    expect(agentIdFor("a_b", "yoyo")).toBe("a-b--yoyo");
    expect(agentIdFor("a", "b_yoyo")).toBe("a--b-yoyo");
  });

  describe("agentShortName round-trips agentIdFor", () => {
    const cases: Array<[string, string]> = [
      ["alice", "yoyo"],
      ["Alice_B", "yoyo"],
      ["bob-smith", "yoyo"], // (not a real Twitter handle, but exercises hyphens)
      ["a", "yoyo"],
      ["alice", "v2"],
    ];
    for (const [owner, name] of cases) {
      it(`(${owner}, ${name})`, () => {
        const id = agentIdFor(owner, name);
        const short = agentShortName({
          ...makeProfile({ id }),
          owner,
        });
        // The short name must re-compose to the same id (URL round-trip).
        expect(agentIdFor(owner, short)).toBe(id);
      });
    }

    it("returns the full id for an unowned/legacy agent", () => {
      expect(agentShortName(makeProfile({ id: "legacy", owner: undefined }))).toBe(
        "legacy",
      );
    });
  });

  it("getAgentByOwnerName round-trips a seeded agent", async () => {
    await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "An agent",
      owner: "alice",
      sections: [
        { type: "identity", slug: "yoyo-identity", title: "Id", content: "x" },
      ],
    });
    const got = await getAgentByOwnerName("alice", "yoyo");
    expect(got!.id).toBe(agentIdFor("alice", "yoyo"));
    expect(got!.owner).toBe("alice");
  });
});

describe("forkAgent", () => {
  async function seedBase() {
    return seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "Base yoyo",
      owner: "yopedia",
      sections: [
        { type: "identity", slug: "yoyo-identity", title: "Id", content: "I am yoyo." },
        { type: "learnings", slug: "yoyo-learnings", title: "L", content: "Lesson 1." },
      ],
    });
  }

  it("creates a fork owned by the user that inherits the base by reference", async () => {
    const base = await seedBase();
    const fork = await forkAgent({ owner: "alice", templateId: base.id });
    expect(fork).not.toBeNull();
    expect(fork!.id).toBe(agentIdFor("alice", "yoyo"));
    expect(fork!.owner).toBe("alice");
    expect(fork!.template).toBe(base.id);
    // Own pages are empty — content is inherited.
    expect(fork!.identityPages).toEqual([]);
    expect(fork!.learningPages).toEqual([]);
  });

  it("is idempotent — re-forking returns the existing profile", async () => {
    const base = await seedBase();
    const first = await forkAgent({ owner: "alice", templateId: base.id });
    const second = await forkAgent({ owner: "alice", templateId: base.id });
    expect(second!.registered).toBe(first!.registered);
  });

  it("returns null when the template doesn't exist", async () => {
    expect(
      await forkAgent({ owner: "alice", templateId: "does-not-exist" }),
    ).toBeNull();
  });

  it("never returns an agent owned by someone else (collision safety)", async () => {
    // Simulate an id already taken by a different owner (e.g. an owner-slug
    // collision): forkAgent must not hand it over.
    const id = agentIdFor("alice", "yoyo");
    await registerAgent(makeProfile({ id, owner: "mallory" }));
    const base = await seedBase();
    expect(await forkAgent({ owner: "alice", templateId: base.id })).toBeNull();
  });
});

describe("resolveAgentPages cycle + depth", () => {
  // Use the injectable `load` so we can build pathological chains in memory.
  const mk = (id: string, template: string | undefined, pages: string[]) =>
    makeProfile({ id, template, identityPages: pages });

  it("terminates on a self-referential template", async () => {
    const a = mk("a--yoyo", "a--yoyo", ["a-id"]);
    const load = async () => a;
    const resolved = await resolveAgentPages(a, load);
    expect(resolved.identityPages).toEqual(["a-id"]); // once, no hang
  });

  it("terminates on a 2-node cycle and de-dupes", async () => {
    const a = mk("a--yoyo", "b--yoyo", ["a-id"]);
    const b = mk("b--yoyo", "a--yoyo", ["b-id"]);
    const load = async (id: string) => (id === a.id ? a : b);
    const resolved = await resolveAgentPages(a, load);
    expect(resolved.identityPages.sort()).toEqual(["a-id", "b-id"]);
  });

  it("unions a multi-level chain own-first", async () => {
    const a = mk("a--yoyo", "b--yoyo", ["a-id"]);
    const b = mk("b--yoyo", "c--yoyo", ["b-id"]);
    const c = mk("c--yoyo", undefined, ["c-id"]);
    const load = async (id: string) =>
      ({ [a.id]: a, [b.id]: b, [c.id]: c })[id] ?? null;
    const resolved = await resolveAgentPages(a, load);
    expect(resolved.identityPages).toEqual(["a-id", "b-id", "c-id"]);
  });
});

describe("resolveAgentPages", () => {
  it("resolves a fork's pages from its template chain", async () => {
    const base = await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "Base",
      owner: "yopedia",
      sections: [
        { type: "identity", slug: "yoyo-identity", title: "Id", content: "x" },
        { type: "learnings", slug: "yoyo-learnings", title: "L", content: "y" },
        { type: "social", slug: "yoyo-social", title: "S", content: "z" },
      ],
    });
    const fork = (await forkAgent({ owner: "alice", templateId: base.id }))!;

    const resolved = await resolveAgentPages(fork);
    expect(resolved.identityPages).toEqual(["yoyo-identity"]);
    expect(resolved.learningPages).toEqual(["yoyo-learnings"]);
    expect(resolved.socialPages).toEqual(["yoyo-social"]);
  });

  it("unions a fork's own pages on top of the inherited ones (de-duped)", async () => {
    const base = await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "Base",
      owner: "yopedia",
      sections: [
        { type: "learnings", slug: "yoyo-learnings", title: "L", content: "y" },
      ],
    });
    const fork = (await forkAgent({ owner: "alice", templateId: base.id }))!;
    fork.learningPages = ["alice-own-learning"];
    await registerAgent(fork);

    const resolved = await resolveAgentPages(fork);
    expect(resolved.learningPages).toEqual(["alice-own-learning", "yoyo-learnings"]);
  });
});

describe("agent page interlinking", () => {
  it("links sibling pages into a connected cluster (star, hub = first section)", async () => {
    await seedAgent({
      id: "yoyo",
      name: "Yoyo",
      description: "Base",
      owner: "yopedia",
      sections: [
        { type: "identity", slug: "yoyo-identity", title: "yoyo — Identity", content: "id" },
        { type: "learnings", slug: "yoyo-learnings", title: "yoyo — Learnings", content: "l" },
        { type: "social", slug: "yoyo-social", title: "yoyo — Social", content: "s" },
      ],
    });

    // Graph edges come from [text](slug.md) links. The hub links to each sibling…
    const hub = await readWikiPage("yoyo-identity");
    expect(hub!.content).toContain("](yoyo-learnings.md)");
    expect(hub!.content).toContain("](yoyo-social.md)");

    // …and each spoke links back to the hub (only).
    const spoke = await readWikiPage("yoyo-learnings");
    expect(spoke!.content).toContain("](yoyo-identity.md)");
    expect(spoke!.content).not.toContain("](yoyo-social.md)");
  });

  it("adds no Related block for a single-section agent", async () => {
    await seedAgent({
      id: "solo",
      name: "Solo",
      description: "d",
      owner: "yopedia",
      sections: [{ type: "identity", slug: "solo-id", title: "Solo", content: "x" }],
    });
    const p = await readWikiPage("solo-id");
    expect(p!.content).not.toContain("## Related");
  });
});

describe("per-agent credentials", () => {
  async function seedAgentRecord(id = "alice--yoyo", owner = "alice") {
    await registerAgent(makeProfile({ id, owner }));
  }

  it("generateAgentToken returns <id>.<secret>, and the profile carries no secret", async () => {
    await seedAgentRecord();
    const token = await generateAgentToken("alice--yoyo");
    expect(token.startsWith("alice--yoyo.")).toBe(true);
    expect(await verifyAgentToken(token)).toBe("alice--yoyo");

    // The secret lives in a SEPARATE store — never on the serializable profile.
    const agent = await getAgent("alice--yoyo");
    expect(JSON.stringify(agent)).not.toContain("tokenHash");
    expect(JSON.stringify(agent)).not.toContain(token.split(".")[1]);
  });

  it("verifyAgentToken accepts the right token and rejects others", async () => {
    await seedAgentRecord();
    const token = await generateAgentToken("alice--yoyo");

    expect(await verifyAgentToken(token)).toBe("alice--yoyo");
    expect(await verifyAgentToken("alice--yoyo.wrongsecret")).toBeNull();
    expect(await verifyAgentToken("garbage")).toBeNull();
    expect(await verifyAgentToken("bob--yoyo.whatever")).toBeNull(); // no such agent
  });

  it("rejects malformed/crafted tokens", async () => {
    await seedAgentRecord();
    await generateAgentToken("alice--yoyo");
    expect(await verifyAgentToken("")).toBeNull(); // empty
    expect(await verifyAgentToken(".secret")).toBeNull(); // empty agent id
    expect(await verifyAgentToken("alice--yoyo.")).toBeNull(); // empty secret
    expect(await verifyAgentToken("alice--yoyo")).toBeNull(); // no dot
  });

  it("rejects ids that could escape the secret store (path traversal)", async () => {
    // The id segment must pass AGENT_ID_RE before forming a storage path.
    expect(await verifyAgentToken("../../etc/passwd.secret")).toBeNull();
    expect(await verifyAgentToken("a/b.secret")).toBeNull();
    expect(await verifyAgentToken("..%2f.secret")).toBeNull();
    expect(await verifyAgentToken("UPPER.secret")).toBeNull(); // uppercase not allowed
  });

  it("fails closed on a corrupt secret file", async () => {
    await getStorage().writeFile("agent-secrets/alice--yoyo.json", "not json{{{");
    expect(await verifyAgentToken("alice--yoyo.anysecret")).toBeNull();
  });

  it("stores the hash only in the separate secret store", async () => {
    await seedAgentRecord();
    await generateAgentToken("alice--yoyo");
    // Positively: the secret store holds a hash…
    const raw = await getStorage().readFile("agent-secrets/alice--yoyo.json");
    expect(JSON.parse(raw)).toHaveProperty("tokenHash");
    // …and the profile object has no credential-bearing keys.
    const agent = await getAgent("alice--yoyo");
    expect(Object.keys(agent!)).not.toContain("tokenHash");
  });

  it("rotating invalidates the previous token", async () => {
    await seedAgentRecord();
    const first = await generateAgentToken("alice--yoyo");
    const second = await generateAgentToken("alice--yoyo");
    expect(first).not.toBe(second);
    expect(await verifyAgentToken(first)).toBeNull();
    expect(await verifyAgentToken(second)).toBe("alice--yoyo");
  });

  it("revokeAgentToken clears the credential", async () => {
    await seedAgentRecord();
    const token = await generateAgentToken("alice--yoyo");
    await revokeAgentToken("alice--yoyo");
    expect(await verifyAgentToken(token)).toBeNull();
  });

  it("agentTokenInfo reports existence + createdAt, never the secret", async () => {
    await seedAgentRecord();
    // None yet.
    expect(await agentTokenInfo("alice--yoyo")).toEqual({ exists: false });

    // After generate: exists, with an ISO createdAt, and no secret leaked.
    const token = await generateAgentToken("alice--yoyo");
    const info = await agentTokenInfo("alice--yoyo");
    expect(info.exists).toBe(true);
    expect(typeof info.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(info.createdAt!))).toBe(false);
    expect(JSON.stringify(info)).not.toContain(token.split(".")[1]);
    expect(JSON.stringify(info)).not.toContain("tokenHash");

    // After revoke: gone again.
    await revokeAgentToken("alice--yoyo");
    expect(await agentTokenInfo("alice--yoyo")).toEqual({ exists: false });
  });

  it("agentTokenInfo treats a corrupt secret file as existing (rotate fixes it)", async () => {
    await getStorage().writeFile("agent-secrets/alice--yoyo.json", "not json{{{");
    expect(await agentTokenInfo("alice--yoyo")).toEqual({ exists: true });
  });

  it("deleting an agent revokes its credential and removes the secret file", async () => {
    await seedAgentRecord();
    const token = await generateAgentToken("alice--yoyo");
    await deleteAgent("alice--yoyo");
    expect(await verifyAgentToken(token)).toBeNull();
    expect(
      await getStorage().fileExists("agent-secrets/alice--yoyo.json"),
    ).toBe(false);
  });
});

describe("addAgentLearningPage", () => {
  it("appends a slug to learningPages (idempotent)", async () => {
    await registerAgent(makeProfile({ id: "alice--yoyo", owner: "alice" }));
    await addAgentLearningPage("alice--yoyo", "some-page");
    await addAgentLearningPage("alice--yoyo", "some-page"); // no dup
    expect((await getAgent("alice--yoyo"))!.learningPages).toEqual(["some-page"]);
  });

  it("is a no-op for a missing agent", async () => {
    await expect(
      addAgentLearningPage("ghost--yoyo", "x"),
    ).resolves.toBeUndefined();
  });
})
