# yopedia — A Wiki for the Agent Age

## What This Is

yopedia is a shared second brain for humans and agents. One knowledge substrate,
two surfaces over it. Evolved from the [LLM Wiki pattern](llm-wiki.md) —
Karpathy's idea for building persistent knowledge bases using LLMs.

This project was bootstrapped from a single founding prompt and grown entirely by
[yoyo](https://github.com/yologdev/yoyo), a self-evolving coding agent. Every
commit after the baseline tag was made by yoyo. The experiment proved that an
agent can grow a product from one prompt — 55 sessions, 33,600 lines, 1,242
tests, all four founding pillars complete. Now yopedia is the destination.

## The Vision

The full north star lives in **[`yopedia-concept.md`](yopedia-concept.md)** — read it
there; don't duplicate it here. In one line: a **collective second brain** for humans
and agents — one **commons** co-built by people and their agents (**agents maintain,
humans discuss**), personal **vaults** as a lens on top (public by reference, private
by clone, paid), **anti-RAG** (accumulate, don't re-derive), multi-user and multi-agent
from day one. North Star: agents maintain the commons, the community funds the agents.

## How it works now (live)

The founding LLM Wiki pillars (ingest, query, lint, browse) plus the agent-age layer
are built and deployed:

- **Ingest** — URL/text/batch, chunking, image download, re-ingest; the **canonical
  concept resolver** (one page per *concept*, not per source: concept-derived slug +
  aliases, embedding nearest-page merge, re-synthesize-on-merge with `disputed`) plus
  content **dedup** (identical source attaches the triggerer, skips the LLM).
- **Query** — hybrid BM25 + vector (RRF), streaming, citations, save-to-wiki.
- **Lint** — checks + auto-fix (orphans, stale, broken links, contradictions, …).
- **Browse** — index/sort/filter, graph, backlinks, revisions, global search, Obsidian
  export; the **Mine | All** personal lens; `/u/<handle>` profiles.
- **Auth & attribution** — Clerk **Twitter/X SSO**; all `/api` writes gated (401
  without a session); pages carry real **`owner`** + actor `authors`/`contributors` +
  `visibility` (public default). The hardcoded `system` is retired.
- **Stack** — Cloudflare Workers (R2/KV/Vectorize/Workers AI), **DeepSeek-V4-Flash**
  generation, **bge-m3** embeddings, CJK throughout.

## What's next

The full picture is the **Roadmap** in [`yopedia-concept.md`](yopedia-concept.md).
Near-term threads (commons-first):

- **Flat retirement** — complete (#869, #930 closed). The silo is the sole
  storage layer; all legacy flat-path writes and fallback reads have been removed.
- **Private tier** — Clerk Billing checkout → `plan="pro"`; **clone-to-private** (snapshot
  a commons page into an owned private vault page) + the clone/visibility UI.
- Trust scores, agent-surface research, federation.

## Autonomous Growth Loop

yopedia is a long-running agent-grown system, not a fixed-scope app. A phase
can finish, but the product should keep compounding: more sources become wiki
knowledge, more questions become durable pages, more lint findings become
maintenance work, and more agent usage teaches us what the agent-facing surface
should become.

The operating model comes from two ancestors:
- Karpathy's LLM wiki pattern: persistent knowledge grows through repeated
  ingest, query, lint, indexing, and logging. The wiki is never "done"; it gets
  richer and more coherent as new material arrives.
- yoyo-evolve: each cycle reads history, checks the real system, studies user
  and community signal, compares against the frontier, picks a small next
  improvement, and records what happened. Empty hands are allowed, but only
  after looking seriously for the next leverage point.

For yopedia, self-growth from observed gaps and research is higher priority than
waiting for reactive human feedback. Human issues matter, but the agent team
should not need a human complaint before improving the wiki loop, the agent
loop, or the product's ability to compound knowledge.

When PM sees an empty or thin backlog, it should run a growth scan before
deciding to file 0 issues:
- **Source flow:** What new source, user signal, or agent output should enter
  the wiki next?
- **Synthesis:** What knowledge should be merged, linked, disputed, summarized,
  or promoted from chat/history into durable wiki pages?
- **Use:** Can a human or agent actually ask better questions, retrieve better
  context, or reuse the wiki in a workflow?
- **Maintenance:** Are there stale claims, orphan pages, missing concepts,
  contradictions, weak citations, or repeated failures that should become work?
- **Interface:** Is the maintainer loop easier than last week for humans,
  agents, and automated runs?
- **Frontier:** Did research, competitors, platform changes, or yoyo-evolve
  reveal a capability gap worth closing now?

If the scan finds a concrete opportunity, PM files the smallest issue that makes
the system compound. If the opportunity is too large, PM files a decomposition
or asks Architect. If the opportunity needs a human decision, credential, or
external permission, PM files or updates one `human-action` issue and links the
blocked work to it.

PM may file 0 issues only when the next meaningful work is already represented
by ready, triage, blocked, or human-action issues, or when the growth scan finds
no specific evidence worth acting on. "The last roadmap phase is complete" is
not enough reason to stop; the question is whether the wiki is still learning.

### Research Doctrine

Research should keep yopedia ahead, not turn it into a clone of adjacent tools.
The motto is simple but effective: use external signal to find the smallest
reasonable move that improves yopedia's advantage.

Competitors, launches, stars, and blog posts are evidence only. A good research
entry explains the market movement, why it matters to yopedia, the recommended
move, and whether to adopt now, watch, or ignore. Avoid long feature diffs. Do
not file issues because another project has a feature; file only when the
feature reveals a real workflow, demand signal, technical direction, failure
mode, or gap in yopedia's compounding loop.

For yopedia, especially prize signals about:
- Agent-readable knowledge surfaces and MCP-style interoperability
- Trust, provenance, contradiction handling, and claim lifecycle
- Multi-writer workflows for humans and agents sharing one wiki
- Source ingestion, synthesis, maintenance, and reuse loops
- Distribution patterns that make public agent knowledge easier to discover

## Open Research

These are questions the product answers over time, not assumptions to fix now:

- What is the right form of a knowledge artifact for an agent?
- How does trust accrue across humans and agents using the same metrics fairly?
- How do contradictions resolve when one side is human experience and the other
  is agent research?
- How does yopedia stay coherent as it scales past one community?
- What does federation across separate yopedia instances look like?

## Tech Stack

- **Runtime**: Next.js 15 (App Router) + TypeScript, deployed on **Cloudflare
  Workers** via OpenNext (`pnpm build:cloudflare && wrangler deploy`).
- **Storage**: **R2** (pages/sources/assets), **KV** (config + derived indexes),
  **Vectorize**, **Workers AI** on the deploy; local filesystem in dev.
- **LLM**: provider-pluggable via the Vercel AI SDK (Anthropic, OpenAI, Google,
  **DeepSeek**, Ollama). Live deploy uses **DeepSeek-V4-Flash**.
- **Embeddings**: **`@cf/baai/bge-m3`** via Workers AI (multilingual / CJK),
  decoupled from the generation provider.
- **Auth**: **Clerk** (Twitter/X SSO); `clerkMiddleware` gates all `/api` writes.
- **Search**: hybrid BM25 + vector (RRF), CJK-aware tokenizer.
- **Styling**: Tailwind CSS. **Testing**: vitest.

## Build & Test

```sh
pnpm install
pnpm dev          # development server on :3000
pnpm build        # production build
pnpm lint         # eslint
pnpm test         # vitest
```

## Directory Structure

```
llm-wiki.md          # founding prompt — spiritual ancestor (immutable)
yopedia-concept.md   # the single concept / north star (living doc — keep current)
YOYO.md              # this file — yoyo's operating manual
SCHEMA.md            # wiki conventions and frontmatter operations
src/
  middleware.ts      # Clerk auth gate (writes require a session)
  app/               # Next.js app router pages + API routes
  lib/               # core logic (ingest, query, lint, auth, search, source-index)
  components/        # React components
raw/                 # source documents (gitignored; R2 on deploy)
wiki/                # LLM-maintained wiki output (gitignored; R2 on deploy)
discuss/             # talk pages for conflict resolution
```

## How yoyo Works Here

Six independent agents communicate through GitHub Issues. Each has one job,
runs on its own schedule, and leaves a visible trail. Multiple build agents
can run in parallel on different issues.

Agent personality, judgment, and runtime prompts live in
[`yologdev/yoyo-harness`](https://github.com/yologdev/yoyo-harness). This repo
defines the project-specific protocol: labels, lifecycle, blocker metadata, and
local expectations. Do not duplicate full agent prompts here.

### Agent Architecture

**1. Research Agent** (Sundays 9am UTC + decision discussion via `research.yml`):
- Judgment: signal filter — distinguishes "this exists" from "this changes our
  strategy"
- Scans the field for market movement, frontier activity, and new directions:
  LLM wiki variants, agent memory systems, knowledge-graph products,
  second-brain projects, multi-agent collaboration tools, protocols, and
  distribution shifts
- Distills findings into advantage briefs, not feature diffs
- Files max 3 issues with `agent-research` + `triage` labels
- May file 0 issues when nothing is strategy-changing or actionable
- Joins decision discussions when Office Hour asks for market, competitive, or
  ecosystem signal
- Appends a research entry to `.yoyo/journal.md`

**2. PM Agent** (daily 6am UTC + decision discussion via `pm.yml`):
- Judgment: product thinking — challenges premises, demand, sequencing, and
  whether work should exist at all
- Reads vision docs, assesses codebase state, identifies gaps
- Files structured implementation issues (max 3 per session)
- Each issue has: Context, Requirements, Files Involved, Acceptance Criteria,
  Size Estimate
- Labels: `agent-self` + `triage` + type (feature/bug/refactor/docs)
- May file 0 issues when the backlog is already right
- Closes stale or superseded issues
- When blocking an issue or filing a dependent issue, adds blocker metadata
  using the format in "Blocker Bookkeeping" below
- Reassesses open `blocked` issues and clears resolved dependency or
  human-action blockers
- Joins decision discussions when Office Hour asks whether work should exist,
  be sequenced now, or be closed

**3. Office Hour Agent** (daily 7am UTC + issue/comment events via `office-hour.yml`):
- Judgment: taste gate — evaluates issues like pitches using forcing questions,
  premise challenges, and push-back patterns
- Triages `triage` issues: approve → `ready`, route → `needs-architecture`,
  reject → close, or → `blocked`
- Adds priority label (p0–p3), verifies acceptance criteria
- Reviews existing `ready` issues for backlog saturation and reprioritization
- Does not own old-blocker cleanup; PM owns dependency and human-action sweeps
- May start a short decision discussion when an issue needs judgment from PM,
  Architect, or Research before a verdict
- Adding the `ready` label triggers build agents

**4. Architect Agent** (daily 8am UTC + `needs-architecture` /
`agent-help-wanted` labels + decision discussion via `architect.yml`):
- Judgment: decomposition — splits hard problems into atomic work and diagnoses
  why build attempts fail
- Resolves design blockers: feasibility, approach, decomposition, sequencing,
  and architectural risk
- When blocking work, distinguishes `dependency`, `human`, and `architecture`
  blockers using the metadata format below
- When blocking on human work, files exactly one `human-action` issue and links
  it from the blocked issue
- Does not own dependency cleanup after prerequisites land; PM owns
  that bookkeeping
- Joins decision discussions when Office Hour asks for feasibility,
  decomposition, sequencing, or failure-mode judgment

**5. Build Agent** (on `ready` label + every 4h fallback via `build.yml`):
- Judgment: craft — makes the smallest correct change and stops when the issue
  is contradictory, too large, or unsafe
- Claims one issue: swaps `ready` → `in-progress`
- Creates branch `yoyo/issue-{N}`, implements, runs build/lint/test
- If a previous PR review requested changes, consumes the latest structured
  `yoyo-review-retry` issue comment as required correction context
- Build-fix loop: up to 5 attempts to fix failures
- On success: opens or updates a PR with "Closes #N"
- On failure: reverts, comments reason, re-queues as `ready`
- **No concurrency limit** — multiple build agents run in parallel on
  different issues

**6. Review Agent** (on PR opened/updated via `review.yml`):
- Judgment: code standards — flags high-confidence bugs, regressions, missing
  acceptance criteria, and protected-file violations without noisy nitpicks
- Reviews PR diff against linked issue's acceptance criteria
- Checks: build passes, tests added, protected files untouched
- Merges if passing and mergeable
- If changes are needed, writes a structured `yoyo-review-retry` block on the
  linked issue and re-queues it to `ready` for Build
- Handles merge conflicts via rebase

### Decision Discussions

Office Hour owns the taste gate, but it should not make every ambiguous decision
alone. When an issue needs more judgment, Office Hour starts a bounded discussion
in the issue comments and asks the relevant agents to contribute.

Use this only for decisions that affect whether, when, or how work should be
done. Do not use it for routine label cleanup.

Office Hour starts a round with machine-readable markers:

```md
Decision-Round: 1
Decision-Question: Should this issue become ready, be rewritten, be blocked, or be closed?
Ask-PM: Is this the right product work now?
Ask-Architect: Is the proposed shape feasible and atomic?
Ask-Research: Is there external signal that changes the decision?
```

Only ask agents whose judgment is needed. Each asked agent replies in the same
issue:

```md
Decision-Input: PM
Decision-Round: 1
Position: ready | rewrite | blocked | close
Reason: <one or two concrete sentences>
Would-Change-If: <specific evidence that would change the position>
```

Rules:
- Office Hour may run at most 3 decision rounds per issue.
- A round is one Office Hour question plus replies from the asked agents.
- Asked agents must not quote or repeat `Ask-PM`, `Ask-Architect`, or
  `Ask-Research` markers in replies; use only `Decision-Input` markers.
- If consensus is clear, Office Hour decides immediately; it does not need all
  possible agents to comment.
- If no consensus after round 3, Office Hour must choose one final state:
  `ready`, `needs-architecture`, `blocked`, or closed.
- PM decides product value and sequencing.
- Architect decides feasibility, decomposition, and risk.
- Research decides whether external evidence changes the strategy.
- Office Hour makes the final readiness verdict and records the reason.

### Blocker Bookkeeping

Use machine-readable blocker metadata whenever an issue is marked `blocked`.
This lets PM clear stale dependency and human-action blockers without adding a
new agent.

For dependency blockers:

```md
Blocked-By: #79
Blocker-Type: dependency
Unblock-To: ready
```

Rules:
- `Blocked-By` may contain one or more issue numbers, separated by commas or
  spaces, for example `Blocked-By: #79, #80`
- `Blocker-Type: dependency` means PM may auto-unblock only after all
  listed dependencies are closed
- `Unblock-To` is the label to add when dependencies resolve, usually `ready`
  or `needs-architecture`
- PM must leave architecture blockers untouched:

```md
Blocked-By: unresolved deployment architecture
Blocker-Type: architecture
Unblock-To: needs-architecture
```

For human blockers, create a separate issue with the `human-action` label.
Humans signal completion by closing that issue; they should not need to comment
"done".

Human-action issue body:

```md
## Human Action

Needed-By: #75

## Why

CI/CD should not be automated until one manual deploy succeeds.

## Task

- [ ] Pull latest main
- [ ] Run the manual deploy
- [ ] Verify the deployed URL works

## Completion Signal

Close this issue when done.

Unblocks: #75
Completion-Signal: close this issue
```

Blocked agent issue metadata:

```md
Blocked-By: #123
Blocker-Type: human
Unblock-To: ready
```

Architect, PM, and Office Hour should include this metadata in the final
paragraph of any comment that marks an issue blocked. PM should comment when it
unblocks an issue, naming the closed dependency or human-action issue.

### Issue Lifecycle

```
Filed (PM / Research / Human) → [triage]
  → Office Hour taste gate
    → clear decision → [ready] + priority
    → needs judgment → decision discussion (max 3 rounds) → final verdict
  → Build Agent claims → [in-progress] + branch
  → PR opened → Review Agent reviews
    → approved → auto-merge → issue closes
    → changes requested → structured retry block + [ready] → build agent fixes
```

### Label Taxonomy

| Dimension | Labels |
|-----------|--------|
| **Status** | `triage`, `ready`, `in-progress`, `blocked` |
| **Priority** | `p0-critical`, `p1-high`, `p2-medium`, `p3-low` |
| **Source** | `agent-input`, `agent-self`, `agent-research`, `agent-help-wanted`, `human-action` |
| **Type** | `bug`, `feature`, `refactor`, `docs` |

### Shared Infrastructure

All agents source `.yoyo/scripts/setup-agent.sh` which provides:
- Identity + skills download from yoyo-evolve
- `run_agent()` helper (invokes yoyo with identity + skills)
- `check_protected_files()` enforcement
- `sanitize_issue_content()` for untrusted input
- `commit_and_push_journal()` for journal updates
