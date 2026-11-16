import { NextResponse } from "next/server";
import { verifyAgentToken, getAgent } from "@/lib/agents";
import { getServicePrincipal } from "@/lib/auth";
import { publishToCommons, PublishError } from "@/lib/publish";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/agents/[id]/publish — publish an agent-scoped page to the commons.
 *
 * Authenticated by a Bearer token (NOT a human session). Two credentials are
 * accepted:
 *   - the **agent's own token** — self-scoping; can only publish from the agent
 *     whose id it carries (mismatch → 403).
 *   - the **system token** — trusted automation; can target any agent, but the
 *     agent must EXIST (404 otherwise).
 *
 * Body: `{ slug: string }`
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    // --- Auth: dual bearer-token pattern (same as ingest route) ---
    const bearer = req.headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) {
      return NextResponse.json(
        { error: "Agent token required (Authorization: Bearer <token>)." },
        { status: 401 },
      );
    }

    const tokenAgentId = await verifyAgentToken(bearer);
    if (tokenAgentId) {
      // Per-agent token: can only publish from its own agent.
      if (tokenAgentId !== id) {
        return NextResponse.json(
          { error: "This token does not authenticate that agent." },
          { status: 403 },
        );
      }
    } else if (getServicePrincipal(req)) {
      // System token: trusted to target any agent, but it must exist.
      let agentRecord;
      try {
        agentRecord = await getAgent(id);
      } catch (err) {
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

    // Cost guard — publish mutates storage and rebuilds indexes; key by agent id.
    const rl = await enforceRateLimit("wiki", id);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait before publishing again." },
        { status: 429 },
      );
    }

    // --- Body parsing ---
    let body: { slug?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) {
      return NextResponse.json(
        { error: "Provide a 'slug' to publish." },
        { status: 400 },
      );
    }

    // --- Publish ---
    const result = await publishToCommons(slug, id);

    return NextResponse.json({
      published: true,
      slug: result.slug,
      owner: result.owner,
      agent: result.agent,
      previousType: result.previousType,
    });
  } catch (err) {
    if (err instanceof PublishError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error("agents", "agent publish failed:", err);
    return NextResponse.json({ error: "Publish failed." }, { status: 500 });
  }
}
