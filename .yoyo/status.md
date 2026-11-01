# Status Report

**Generated:** 2026-11-01  
**Build status:** ✅ PASS — 3,592 tests, 54 API routes, zero type errors

---

## Metrics snapshot

- **Total lines:** ~107,410 (lib: ~24,151, tests: ~53,462, components: ~11,006, hooks: ~2,181, mcp: 3,848)
- **Test files:** 137
- **Test count:** 3,592
- **Wiki pages (schema):** 14 frontmatter fields (title, aliases, confidence, expiry, valid_from, authors, contributors, sources, disputed, supersedes, tags, type, owner, visibility)
- **API routes:** 54
- **MCP tools:** 49 (search_wiki, read_page, list_pages, create_page, update_page, update_metadata, delete_page, merge_pages, ingest_url, batch_ingest_urls, ingest_text, ingest_x_mention, ingest_pdf, ingest_image, query_wiki, save_query_answer, query_history, agent_context, seed_agent, list_agents, update_agent, delete_agent, publish_to_commons, lint_wiki, fix_lint_issue, list_discussions, read_discussion, create_discussion, resolve_discussion, add_comment, reconcile_page, reingest, ingest_history, dataview_query, list_revisions, read_revision, revert_revision, list_contributors, get_contributor, wiki_graph, vault_curate, vault_uncurate, list_vaults, vault_pages, vault_create, vault_rename, vault_delete, maintenance_scan, activity_trail)
- **Lint checks:** 16 (orphan-page, stale-index, empty-page, missing-crossref, broken-link, contradiction, missing-concept-page, stale-page, low-confidence, unmigrated-page, duplicate-entity, uncited-claims, unresolved-discussions, disputed-page, supersedes-dangling, incomplete-coverage)

### yopedia Phase Progress

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1: Schema evolution** | ✅ Complete | Extended frontmatter (14 fields incl. owner + visibility), type validation/coercion, entity dedup, 16 lint checks with auto-fix, ingest pipeline wiring, SCHEMA.md updated |
| **Phase 2: Talk pages + attribution** | ✅ Complete | Discussion panel UI + API, contributor profiles with trust scores, threaded comments with nested replies, contributor badges on page view, revision history with revert |
| **Phase 3: X ingestion loop** | ✅ Complete | Library function + API route + MCP tool (`ingest_x_mention`) complete — GitHub Actions polling workflow blocked on deployment architecture |
| **Phase 4: Agent identity** | ✅ Complete | Agent registry, seed, scoped search, context API, MCP server (49 tools), HTTP MCP transport, contributor profiles, agent CRUD, vault CRUD (create/rename/delete/curate/uncurate), publish-to-commons, PDF + image ingest, page merge, autonomous maintenance scan, activity trail, revision management (list/read/revert), Clerk auth (Twitter/X SSO) gating all API writes |
| **Phase 5: Agent surface research** | 🔧 In progress | Trust scores implemented (activity-weighted formula with revert penalty in `src/lib/contributors.ts`); structured claims, fact triples, and embeddings experiments remain |

### Known tech debt

1. **No E2E browser tests** — Unit and integration tests are strong (3,592) but no Playwright/Cypress tests
2. **Contributor trust score** — Improved from simple ratio to activity-weighted formula with revert penalty (`activityScore * revertPenalty`); still needs validation against real multi-user data
3. **grow.sh still coupled to yoyo-evolve** — Downloads a tarball from a separate repo instead of using the yopedia API it already has
4. **GitHub Actions polling workflow** — Phase 3 X-mention polling (#21) blocked on deployment architecture

---

*This report was generated on 2026-11-01.*
