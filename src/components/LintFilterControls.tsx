import type { LintIssue } from "@/lib/types";

export type SeverityFilter = "all" | "warning" | "error";

export const ALL_CHECK_TYPES: LintIssue["type"][] = [
  "orphan-page",
  "stale-index",
  "empty-page",
  "missing-crossref",
  "broken-link",
  "contradiction",
  "missing-concept-page",
  "stale-page",
  "low-confidence",
  "unmigrated-page",
  "duplicate-entity",
  "unresolved-discussions",
];

const checkTypeLabels: Record<LintIssue["type"], string> = {
  "orphan-page": "Orphan pages",
  "stale-index": "Stale index",
  "empty-page": "Empty pages",
  "missing-crossref": "Missing cross-refs",
  "broken-link": "Broken links",
  "contradiction": "Contradictions",
  "missing-concept-page": "Missing concepts",
  "stale-page": "Stale pages",
  "low-confidence": "Low confidence",
  "unmigrated-page": "Unmigrated pages",
  "duplicate-entity": "Duplicate entities",
  "uncited-claims": "Uncited claims",
  "unresolved-discussions": "Unresolved discussions",
  "disputed-page": "Disputed pages",
  "supersedes-dangling": "Dangling supersedes",
  "incomplete-coverage": "Incomplete coverage",
  "dead-source": "Dead sources",
};

const severityFilterLabels: Record<SeverityFilter, string> = {
  all: "All severities",
  warning: "Error + Warning",
  error: "Error only",
};

export interface LintFilterControlsProps {
  enabledChecks: Set<LintIssue["type"]>;
  onToggleCheck: (type: LintIssue["type"]) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  severityFilter: SeverityFilter;
  onSeverityChange: (filter: SeverityFilter) => void;
  onRunLint: () => void;
  loading: boolean;
}

export function LintFilterControls({
  enabledChecks,
  onToggleCheck,
  onSelectAll,
  onClearAll,
  severityFilter,
  onSeverityChange,
  onRunLint,
  loading,
}: LintFilterControlsProps) {
  return (
    <>
      {/* Filter controls */}
      <div className="mt-6 space-y-4 rounded-lg border border-foreground/10 p-4">
        {/* Check type toggles */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-foreground/70">
              Checks
            </span>
            <span className="space-x-2 text-xs">
              <button
                onClick={onSelectAll}
                aria-label="Select all lint checks"
                className="text-foreground/50 hover:text-foreground transition-colors underline underline-offset-2"
              >
                All
              </button>
              <button
                onClick={onClearAll}
                aria-label="Clear all lint checks"
                className="text-foreground/50 hover:text-foreground transition-colors underline underline-offset-2"
              >
                None
              </button>
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_CHECK_TYPES.map((type) => {
              const active = enabledChecks.has(type);
              return (
                <button
                  key={type}
                  onClick={() => onToggleCheck(type)}
                  aria-pressed={active}
                  aria-label={`Toggle ${checkTypeLabels[type]} check`}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "border-foreground/30 bg-foreground/10 text-foreground"
                      : "border-foreground/10 bg-transparent text-foreground/40 hover:text-foreground/60"
                  }`}
                >
                  {checkTypeLabels[type]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Severity filter */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-foreground/70">
            Severity
          </span>
          <select
            value={severityFilter}
            onChange={(e) =>
              onSeverityChange(e.target.value as SeverityFilter)
            }
            className="rounded border border-foreground/20 bg-background px-2 py-1 text-sm text-foreground"
          >
            {(Object.keys(severityFilterLabels) as SeverityFilter[]).map(
              (key) => (
                <option key={key} value={key}>
                  {severityFilterLabels[key]}
                </option>
              ),
            )}
          </select>
        </div>
      </div>

      <div className="mt-6">
        <button
          onClick={onRunLint}
          disabled={loading}
          className="rounded-lg bg-foreground px-6 py-3 text-sm font-medium text-background hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Checking..." : "Run Lint"}
        </button>
      </div>
    </>
  );
}
