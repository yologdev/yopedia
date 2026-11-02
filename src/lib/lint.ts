import { appendToLog, listWikiPages, withPageCache } from "./wiki";
import { extractWikiLinks } from "./links";
import type { LintIssue, LintOptions, LintResult } from "./types";
import {
  ALL_CHECK_TYPES,
  getOnDiskSlugs,
  checkOrphanPages,
  checkStaleIndex,
  checkEmptyPages,
  checkBrokenLinks,
  checkMissingCrossRefs,
  checkContradictions,
  checkMissingConceptPages,
  checkIncompleteCoverage,
  MAX_COVERAGE_CHECKS,
  checkStalePages,
  checkLowConfidence,
  checkUnmigratedPages,
  checkDuplicateEntities,
  checkUncitedClaims,
  checkUnresolvedDiscussions,
  checkDisputedPages,
  checkSupersededDangling,
  checkDeadSources,
  MAX_DEAD_SOURCE_CHECKS,
  buildSummary,
  parseLLMJsonArray,
  extractCrossRefSlugs,
  buildClusters,
  parseContradictionResponse,
  parseMissingConceptResponse,
  parseIncompleteCoverageResponse,
} from "./lint-checks";

/** Severity ordering from most to least severe. */
const SEVERITY_RANK: Record<LintIssue["severity"], number> = {
  error: 2,
  warning: 1,
  info: 0,
};

// Re-export helpers and check functions so existing importers (tests, API routes) still work.
export {
  parseLLMJsonArray,
  extractCrossRefSlugs,
  extractWikiLinks,
  buildClusters,
  parseContradictionResponse,
  checkContradictions,
  parseMissingConceptResponse,
  checkMissingConceptPages,
  parseIncompleteCoverageResponse,
  checkIncompleteCoverage,
  MAX_COVERAGE_CHECKS,
  checkBrokenLinks,
  checkStalePages,
  checkLowConfidence,
  checkUnmigratedPages,
  checkDuplicateEntities,
  checkUncitedClaims,
  checkUnresolvedDiscussions,
  checkDisputedPages,
  checkSupersededDangling,
  checkDeadSources,
  MAX_DEAD_SOURCE_CHECKS,
  ALL_CHECK_TYPES,
};

/**
 * Run all lint checks against the wiki and return the results.
 *
 * @param options - Optional configuration for selective checks and severity filtering.
 *   - `checks`: array of check types to run (defaults to all 17)
 *   - `minSeverity`: minimum severity to include in results (defaults to "info")
 */
export async function lint(options?: LintOptions): Promise<LintResult> {
  return withPageCache(async () => {
    // Resolve which checks to run
    const enabledChecks = new Set<LintIssue["type"]>(
      options?.checks !== undefined
        ? options.checks
        : ALL_CHECK_TYPES,
    );

    // Minimum severity filter
    const minSeverity = options?.minSeverity ?? "info";
    const minSeverityRank = SEVERITY_RANK[minSeverity];

    // Gather on-disk slugs and index entries in parallel
    const [diskSlugs, indexPages] = await Promise.all([
      getOnDiskSlugs(),
      listWikiPages(),
    ]);

    const diskSlugSet = new Set(diskSlugs);
    const indexSlugs = new Set(indexPages.map((p) => p.slug));

    // Run lightweight checks in parallel
    const [orphans, stale, empty, crossRefs, brokenLinks, stalePages, lowConfidence, unmigratedPages, duplicateEntities, uncitedClaims, unresolvedDiscussions, disputedPages, supersedesDangling, deadSources] = await Promise.all([
      enabledChecks.has("orphan-page")
        ? checkOrphanPages(diskSlugs, indexSlugs)
        : [],
      enabledChecks.has("stale-index")
        ? checkStaleIndex(indexSlugs, diskSlugSet)
        : [],
      enabledChecks.has("empty-page")
        ? checkEmptyPages(diskSlugs)
        : [],
      enabledChecks.has("missing-crossref")
        ? checkMissingCrossRefs(diskSlugs)
        : [],
      enabledChecks.has("broken-link")
        ? checkBrokenLinks(diskSlugs)
        : [],
      enabledChecks.has("stale-page")
        ? checkStalePages()
        : [],
      enabledChecks.has("low-confidence")
        ? checkLowConfidence()
        : [],
      enabledChecks.has("unmigrated-page")
        ? checkUnmigratedPages()
        : [],
      enabledChecks.has("duplicate-entity")
        ? checkDuplicateEntities()
        : [],
      enabledChecks.has("uncited-claims")
        ? checkUncitedClaims()
        : [],
      enabledChecks.has("unresolved-discussions")
        ? checkUnresolvedDiscussions(diskSlugs)
        : [],
      enabledChecks.has("disputed-page")
        ? checkDisputedPages()
        : [],
      enabledChecks.has("supersedes-dangling")
        ? checkSupersededDangling(diskSlugs)
        : [],
      enabledChecks.has("dead-source")
        ? checkDeadSources(diskSlugs)
        : [],
    ]);

    // Contradiction + missing-concept + incomplete-coverage detection all require
    // LLM calls but are independent read-only checks, so run them in parallel.
    const [contradictions, missingConcepts, incompleteCoverage] = await Promise.all([
      enabledChecks.has("contradiction")
        ? checkContradictions(diskSlugs)
        : [],
      enabledChecks.has("missing-concept-page")
        ? checkMissingConceptPages(diskSlugs)
        : [],
      enabledChecks.has("incomplete-coverage")
        ? checkIncompleteCoverage(diskSlugs)
        : [],
    ]);

    let issues = [...orphans, ...stale, ...empty, ...crossRefs, ...brokenLinks, ...stalePages, ...lowConfidence, ...unmigratedPages, ...duplicateEntities, ...uncitedClaims, ...unresolvedDiscussions, ...disputedPages, ...supersedesDangling, ...deadSources, ...contradictions, ...missingConcepts, ...incompleteCoverage];

    // Filter by minimum severity
    if (minSeverityRank > 0) {
      issues = issues.filter((i) => SEVERITY_RANK[i.severity] >= minSeverityRank);
    }

    // Append a log entry so lint passes are visible in the wiki timeline.
    // The title is a stable string ("wiki lint pass") so log readers can group
    // lint rows; the details line carries a one-shot summary of issue counts.
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;
    const infoCount = issues.filter((i) => i.severity === "info").length;
    const logSummary =
      `${issues.length} issue(s): ` +
      `${errorCount} error · ${warningCount} warning · ${infoCount} info`;
    await appendToLog("lint", "wiki lint pass", logSummary);

    return {
      issues,
      summary: buildSummary(issues),
      checkedAt: new Date().toISOString(),
    };
  });
}
