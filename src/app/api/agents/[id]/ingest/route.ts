import { NextResponse } from "next/server";
import { verifyAgentToken, addAgentLearningPage, getAgent } from "@/lib/agents";
import { getServicePrincipal } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  ingestUrl,
  ingest,
  ingestImage,
  deriveTitleFromContent,
  type IngestOptions,
} from "@/lib/ingest";
import { type Task } from "@/lib/tasks";
import { createIngestJob } from "@/lib/ingest-jobs";
import { enqueueOrInline } from "@/lib/ingest-async";
import { stageText } from "@/lib/ingest-staging";
import { logger } from "@/lib/logger";
import { addToVault, vaultOwnedBy } from "@/lib/vault";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Page `type` that marks ingested content as the agent's scoped knowledge. */
const AGENT_KNOWLEDGE_TYPE = "agent-knowledge";

/** Text larger than this is staged to R2 instead of riding in the queue message
 *  (Cloudflare Queues cap a message at 128 KB). Matches the interactive route. */
const MAX_INLINE_CONTENT_CHARS = 96000;

/** Pattern matching x.com or twitter.com post URLs. */
const X_URL_PATTERN = /^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i;

/** Derive `sourceType`: X/Twitter URL → "x-mention", other URL → "url", else "text". */
function deriveSourceType(url: string): "x-mention" | "url" | "text" {
  if (url) return X_URL_PATTERN.test(url) ? "x-mention" : "url";
  return "text";
}

/**
 * POST /api/agents/[id]/ingest — the agent ingests a source into its OWN
 * knowledge.
 *
 * Authenticated by a Bearer token (NOT a human session), so an external runtime
 * can ingest as the agent. Two credentials are accepted:
 *   - the **agent's own token** — self-scoping; can only ingest into the agent
 *     whose id it carries (mismatch → 403). Used by e.g. openclaw.
 *   - the **system token** — yopedia's trusted automation (e.g. the
 *     @yoyoevolve X-mention loop). It can target any agent, but the agent must
 *     EXIST (404 otherwise), which is how "only ingest for a registered user"
 *     is enforced — a mention from a non-user hits a 404 and is skipped.
 * This route is exempt from the middleware write-gate because it uses a token.
 *
 * ASYNC: the ingest is enqueued (Cloudflare Queue) and processed in the
 * background — the request does NOT block on fetch/LLM. It returns
 * `{ queued: true, jobId }` immediately (off-Workers it runs inline and also
 * returns `slug`). The resulting page appears under the agent profile / its vault
 * once processing finishes; the owner can watch progress in the UI.
 *
 * Body: { url } or { text, title? }, plus an optional `asOwner` flag.
 *   - Default (per-agent token, e.g. openclaw): the page is scoped
 *     (`type: agent-knowledge`, owned by the agent) and appended to the agent's
 *     learnings — surfaces under the agent profile / `agent:` scope only.
 *   - `asOwner: true` (system token OR per-agent token): the page is ingested
 *     as the agent's **human owner's own content** — a normal public page
 *     owned/authored by the owner, in their `/u/<handle>` + the commons, NOT
 *     agent knowledge. For the system token this is the @yoyoevolve "save this
 *     to my wiki" reply flow; for per-agent tokens this is the deliberate
 *     agent→commons publish path (the owner is resolved from the agent record).
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    const bearer = req.headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) {
      return NextResponse.json(
        { error: "Agent token required (Authorization: Bearer <token>)." },
        { status: 401 },
      );
    }
    // Resolved when needed: system-token path always, per-agent-token path when
    // `asOwner` is requested. Carries the agent's human owner so `asOwner`
    // ingests can attribute the page to them.
    let agentRecord: Awaited<ReturnType<typeof getAgent>> | null = null;
    const tokenAgentId = await verifyAgentToken(bearer);
    if (tokenAgentId) {
      // Per-agent token: can only ingest into its own agent.
      if (tokenAgentId !== id) {
        return NextResponse.json(
          { error: "This token does not authenticate that agent." },
          { status: 403 },
        );
      }
    } else if (getServicePrincipal(req)) {
      // System token: trusted to target any agent, but it must exist — this is
      // the "registered user only" gate for the @yoyoevolve loop.
      try {
        agentRecord = await getAgent(id);
      } catch (err) {
        // A malformed id is "not a user" (404). A real storage error must
        // surface as 500 — never masquerade as "not registered", which would
        // make an outage look like nobody who mentioned us is a yopedia user.
        if (err instanceof Error && err.message.includes("Invalid agent ID")) {
          agentRecord = null;
        } else {
          throw err;
        }
      }
      if (!agentRecord) {
        return NextResponse.json(
          { error: `Agent "${id}" not found` },
          { status: 404 },
        );
      }
    } else {
      return NextResponse.json({ error: "Invalid token." }, { status: 401 });
    }

    // Cost guard — agent ingest triggers LLM synthesis + embedding. Key on the
    // agent's human owner so a single owner can't bypass the limit by registering
    // many agents. The agent record may not be resolved yet (per-agent-token path),
    // so resolve it now (cheap local read) when needed.
    {
      if (!agentRecord) {
        try {
          agentRecord = await getAgent(id);
        } catch (err) {
          if (err instanceof Error && err.message.includes("Invalid agent ID")) {
            agentRecord = null;
          } else {
            throw err;
          }
        }
      }
      const rlKey = agentRecord?.owner ?? id;
      const rl = await enforceRateLimit("ingest", rlKey);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please wait before ingesting again." },
          { status: 429 },
        );
      }
    }

    let body: {
      url?: unknown;
      text?: unknown;
      title?: unknown;
      imageUrl?: unknown;
      sourceUrl?: unknown;
      asOwner?: unknown;
      vaultId?: unknown;
      tags?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const url = typeof body.url === "string" ? body.url.trim() : "";
    const text = typeof body.text === "string" ? body.text : "";
    const title = typeof body.title === "string" ? body.title : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    if (!url && !text && !imageUrl) {
      return NextResponse.json(
        { error: "Provide a 'url', 'text', or 'imageUrl' to ingest." },
        { status: 400 },
      );
    }

    // `asOwner` ingests into the human owner's own content. On the system-token
    // path the agent record is already resolved; on the per-agent-token path we
    // resolve it now so the owner is available for attribution.
    const asOwner = body.asOwner === true;
    if (asOwner) {
      if (!agentRecord) {
        try {
          agentRecord = await getAgent(id);
        } catch (err) {
          if (err instanceof Error && err.message.includes("Invalid agent ID")) {
            agentRecord = null;
          } else {
            throw err;
          }
        }
      }
      if (!agentRecord?.owner) {
        return NextResponse.json(
          { error: "Agent has no registered owner; cannot ingest asOwner." },
          { status: 403 },
        );
      }
    }

    // Attribution: asOwner → the human owner's own page (authored by the agent);
    // default → agent-scoped knowledge attributed to the agent.
    const owner = asOwner ? agentRecord!.owner : id;
    const author = id;
    const triggeredBy = asOwner ? agentRecord!.owner : id;
    const pageType: "agent-knowledge" | undefined = asOwner
      ? undefined
      : AGENT_KNOWLEDGE_TYPE;
    const learningFor = asOwner ? undefined : id; // attach to agent learnings
    // asOwner pages record an explicit sourceType (matches the prior behavior,
    // incl. x-mention detection); agent-knowledge ingests let the pipeline derive it.
    const sourceType = asOwner ? deriveSourceType(url) : undefined;

    // A caller-provided source URL (e.g. the original X article) is recorded as
    // the page's provenance. Only the text path uses it (url/imageUrl carry their
    // own source).
    const sourceUrl =
      typeof body.sourceUrl === "string" && /^https?:\/\//.test(body.sourceUrl.trim())
        ? body.sourceUrl.trim()
        : undefined;

    // Validate tags if provided: must be an array of strings.
    if (body.tags !== undefined) {
      if (
        !Array.isArray(body.tags) ||
        !body.tags.every((t: unknown) => typeof t === "string")
      ) {
        return NextResponse.json(
          { error: "tags must be an array of strings if provided" },
          { status: 400 },
        );
      }
    }
    const tags: string[] | undefined =
      Array.isArray(body.tags) && body.tags.length > 0
        ? (body.tags as string[])
        : undefined;

    // Resolve + validate the target vault BEFORE enqueue (ownership is a cheap,
    // synchronous prefix check): explicit vaultId → agent's defaultVault → none,
    // and only a vault the agent's owner OWNS is passed to the job (else skipped).
    let validatedVault: string | undefined;
    {
      const explicitVault =
        typeof body.vaultId === "string" && body.vaultId.trim().length > 0
          ? body.vaultId.trim()
          : undefined;
      if (!agentRecord) {
        // Same discrimination as the auth paths above: a malformed id → null
        // (no vault, no owner), but a real storage error must NOT be swallowed —
        // it would silently misattribute the job's owner (→ agent id, so the
        // human can't see it in the UI). Surface it as a 500.
        try {
          agentRecord = await getAgent(id);
        } catch (err) {
          if (err instanceof Error && err.message.includes("Invalid agent ID")) {
            agentRecord = null;
          } else {
            throw err;
          }
        }
      }
      const effectiveVault = explicitVault || agentRecord?.defaultVault || undefined;
      if (effectiveVault) {
        const ownerHandle = agentRecord?.owner;
        if (ownerHandle && vaultOwnedBy(effectiveVault, ownerHandle)) {
          validatedVault = effectiveVault;
        } else {
          logger.warn(
            "agents",
            `skipping vault filing: owner "${ownerHandle}" does not own vault "${effectiveVault}"`,
          );
        }
      }
    }

    // The job OWNER (who sees it in the UI) is the human owner when known, else
    // the agent id (legacy ownerless agent).
    const jobOwner = agentRecord?.owner ?? id;
    const displayTitle =
      (title && title.trim()) ||
      (text ? deriveTitleFromContent(text) : "") ||
      url ||
      imageUrl ||
      "Untitled";
    const jobUrl = url || imageUrl || undefined;
    const jobId = crypto.randomUUID();
    await createIngestJob({
      jobId,
      owner: jobOwner,
      ...(jobUrl ? { url: jobUrl } : {}),
      title: displayTitle,
    });

    // Shared task attribution. Text rides inline if small, else stage to R2.
    const attribution = {
      owner,
      author,
      triggeredBy,
      ...(pageType ? { pageType } : {}),
      ...(sourceType ? { sourceType } : {}),
      ...(learningFor ? { learningFor } : {}),
      ...(validatedVault ? { vaultId: validatedVault } : {}),
      ...(title && title.trim() ? { title: title.trim() } : {}),
      ...(tags ? { tags } : {}),
      jobId,
    };
    let task: Task;
    if (imageUrl) {
      task = { kind: "ingest", source: "image", url: imageUrl, ...attribution };
    } else if (url) {
      task = { kind: "ingest", url, ...attribution };
    } else if (text.length <= MAX_INLINE_CONTENT_CHARS) {
      task = { kind: "ingest", content: text, ...(sourceUrl ? { sourceUrl } : {}), ...attribution };
    } else {
      const key = await stageText(jobId, text);
      task = { kind: "ingest", staged: { key, kind: "text" }, ...(sourceUrl ? { sourceUrl } : {}), ...attribution };
    }

    // Enqueue (Workers) or run inline (off-Workers: local dev / tests). The inline
    // closure re-runs the same agent post-steps the executor does (learning-page
    // attach + vault filing), with the same fail-soft posture so the two paths
    // don't diverge.
    const opts: IngestOptions = {
      author,
      owner,
      triggeredBy,
      ...(pageType ? { pageType } : {}),
      ...(sourceType ? { sourceType } : {}),
      ...(tags ? { tags } : {}),
    };
    return await enqueueOrInline(jobId, task, async () => {
      const result = imageUrl
        ? await ingestImage({ imageUrl }, { ...opts, title: title || undefined })
        : url
          ? await ingestUrl(url, opts)
          : await ingest(title || "Untitled", text, { ...opts, sourceUrl });
      if (learningFor) {
        try { await addAgentLearningPage(learningFor, result.primarySlug); }
        catch (e) { logger.error("agents", `learning-page attach failed for ${learningFor}:`, e); }
      }
      if (validatedVault) {
        try { await addToVault(validatedVault, result.primarySlug); }
        catch (e) { logger.warn("agents", `vault filing failed for ${validatedVault}:`, e); }
      }
      return result;
    });
  } catch (err) {
    logger.error("agents", "agent ingest failed:", err);
    return NextResponse.json({ error: "Ingest failed." }, { status: 500 });
  }
}
