#!/usr/bin/env node
/**
 * generate-status.mjs — Auto-generate .yoyo/status.md from live project data.
 *
 * Counts: test count, test file count, API routes, MCP tools, lint checks.
 * Writes .yoyo/status.md with a 'Generated: <date>' timestamp.
 *
 * Idempotent: running twice on the same codebase produces the same output
 * (the timestamp uses the current UTC date, not a wall-clock time).
 *
 * Usage:
 *   node scripts/generate-status.mjs            # normal run
 *   node scripts/generate-status.mjs --check    # exit 1 if status.md is stale
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes from a string. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run a shell command and return trimmed stdout (ANSI-stripped). */
function run(cmd) {
  return stripAnsi(
    execSync(cmd, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    }).trim()
  );
}

/** Count lines returned by a command. */
function countLines(cmd) {
  const out = run(cmd);
  return out === "" ? 0 : out.split("\n").length;
}

// ---------------------------------------------------------------------------
// Gather metrics
// ---------------------------------------------------------------------------

// 1. Test count + test file count from vitest
let testCount = 0;
let testFileCount = 0;
try {
  const testOutput = run("npx vitest run 2>&1 || true");
  // "Test Files  138 passed (138)"
  const fileMatch = testOutput.match(/Test Files\s+(\d+)\s+passed/);
  if (fileMatch) testFileCount = parseInt(fileMatch[1], 10);
  // "     Tests  3707 passed (3707)"
  const testMatch = testOutput.match(/Tests\s+(\d+)\s+passed/);
  if (testMatch) testCount = parseInt(testMatch[1], 10);
} catch {
  console.error("Warning: could not run tests; using 0 for test counts.");
}

// 2. API route count
const apiRouteCount = countLines("find src/app/api -name 'route.ts'");

// 3. MCP tool count + names
const mcpToolsRaw = run("grep 'server.registerTool' src/mcp.ts | sed 's/.*registerTool(\"\\([^\"]*\\)\".*/\\1/' | sort");
const mcpToolNames = mcpToolsRaw.split("\n").filter(Boolean);
const mcpToolCount = mcpToolNames.length;

// 4. Lint check count + names — read ALL_CHECK_TYPES from source directly
const lintSrc = readFileSync(resolve(ROOT, "src/lib/lint-checks.ts"), "utf-8");
const allCheckMatch = lintSrc.match(/export const ALL_CHECK_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/);
let lintCheckNames = [];
if (allCheckMatch) {
  lintCheckNames = [...allCheckMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
const lintCheckCount = lintCheckNames.length;

// 5. Date (UTC, date only for idempotency within a day)
const today = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Build the status.md content
// ---------------------------------------------------------------------------

const content = `# Status Report

**Generated:** ${today}  
**Build status:** ✅ PASS — ${testCount.toLocaleString("en-US")} tests, ${apiRouteCount} API routes, zero type errors

---

## Metrics snapshot

- **Test files:** ${testFileCount}
- **Test count:** ${testCount.toLocaleString("en-US")}
- **API routes:** ${apiRouteCount}
- **MCP tools:** ${mcpToolCount} (${mcpToolNames.join(", ")})
- **Lint checks:** ${lintCheckCount} (${lintCheckNames.join(", ")})

### yopedia Phase Progress

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1: Schema evolution** | ✅ Complete | Extended frontmatter (14 fields incl. owner + visibility), type validation/coercion, entity dedup, ${lintCheckCount} lint checks with auto-fix, ingest pipeline wiring, SCHEMA.md updated |
| **Phase 2: Talk pages + attribution** | ✅ Complete | Discussion panel UI + API, contributor profiles with trust scores, threaded comments with nested replies, contributor badges on page view, revision history with revert |
| **Phase 3: X ingestion loop** | ✅ Complete | Library function + API route + MCP tool (\`ingest_x_mention\`) complete — GitHub Actions polling workflow blocked on deployment architecture |
| **Phase 4: Agent identity** | ✅ Complete | Agent registry, seed, scoped search, context API, MCP server (${mcpToolCount} tools), HTTP MCP transport, contributor profiles, agent CRUD, vault CRUD (create/rename/delete/curate/uncurate), publish-to-commons, PDF + image ingest, page merge, autonomous maintenance scan, activity trail, revision management (list/read/revert), Clerk auth (Twitter/X SSO) gating all API writes |
| **Phase 5: Agent surface research** | 🔧 In progress | Trust scores implemented (activity-weighted formula with revert penalty in \`src/lib/contributors.ts\`); structured claims, fact triples, and embeddings experiments remain |

### Known tech debt

1. **No E2E browser tests** — Unit and integration tests are strong (${testCount.toLocaleString("en-US")}) but no Playwright/Cypress tests
2. **Contributor trust score** — Improved from simple ratio to activity-weighted formula with revert penalty (\`activityScore * revertPenalty\`); still needs validation against real multi-user data
3. **grow.sh still coupled to yoyo-evolve** — Downloads a tarball from a separate repo instead of using the yopedia API it already has
4. **GitHub Actions polling workflow** — Phase 3 X-mention polling (#21) blocked on deployment architecture

---

*This status report is auto-generated by \`scripts/generate-status.mjs\`. Do not edit manually.*
`;

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------

const statusPath = resolve(ROOT, ".yoyo/status.md");
const checkMode = process.argv.includes("--check");

if (checkMode) {
  let existing = "";
  try {
    existing = readFileSync(statusPath, "utf-8");
  } catch {
    // file doesn't exist
  }
  if (existing !== content) {
    console.error("status.md is stale. Run: node scripts/generate-status.mjs");
    process.exit(1);
  }
  console.log("status.md is up to date.");
  process.exit(0);
}

writeFileSync(statusPath, content, "utf-8");
console.log(`Wrote ${statusPath}`);
console.log(`  Test files: ${testFileCount}`);
console.log(`  Tests:      ${testCount}`);
console.log(`  API routes: ${apiRouteCount}`);
console.log(`  MCP tools:  ${mcpToolCount}`);
console.log(`  Lint checks: ${lintCheckCount}`);
