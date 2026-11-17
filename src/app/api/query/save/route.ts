import { NextRequest, NextResponse } from "next/server";
import { saveAnswerToWiki } from "@/lib/query";
import { getPrincipal } from "@/lib/auth";
import { commonsPath, pagePath, ownerToTenant } from "@/lib/links";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    // Resolve principal once — reused for rate limiting and artifact ownership.
    const principal = await getPrincipal();

    // Cost guard — saves mutate storage + rebuild indexes.
    if (principal) {
      const rl = await enforceRateLimit("wiki", principal.id);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please wait before saving again." },
          { status: 429 },
        );
      }
    }

    const body = await request.json();

    const { title, content, sources, format } = body;

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return NextResponse.json(
        { error: "title is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    if (
      !content ||
      typeof content !== "string" ||
      content.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "content is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    // Validate sources if provided — must be an array of strings
    let validatedSources: string[] | undefined;
    if (sources !== undefined) {
      if (
        Array.isArray(sources) &&
        sources.every((s: unknown) => typeof s === "string")
      ) {
        validatedSources = sources as string[];
      } else {
        return NextResponse.json(
          { error: "sources must be an array of strings (wiki page slugs)" },
          { status: 400 },
        );
      }
    }

    // HTML and slides answers are saved as personal, owned artifacts (a sandboxed
    // iframe / a slide deck) attributed to the asker. Writes are middleware-gated
    // to a signed-in user; if the principal can't be resolved here (a transient
    // auth failure) we must NOT silently write a mis-attributed system-owned page
    // — surface it. Prose/table save as markdown (unchanged, system-owned commons).
    const isArtifact = format === "html" || format === "slides";
    let owner: string | undefined;
    if (isArtifact) {
      if (!principal) {
        logger.error("query", "Artifact save: could not resolve principal despite write-gate");
        return NextResponse.json(
          { error: "Could not resolve your account — sign in again and retry." },
          { status: 401 },
        );
      }
      owner = principal.handle;
    }

    const contentType =
      format === "html" ? "html" : format === "slides" ? "slides" : "markdown";

    const result = await saveAnswerToWiki(
      title.trim(),
      content.trim(),
      undefined,
      validatedSources,
      contentType,
      owner,
      owner,  // author — same as owner for web saves
    );

    // Return the CANONICAL url so the client links correctly. An owned artifact
    // (html/slides) lives at `/u/<tenant>/<slug>` and 404s at the commons
    // `/wiki/<slug>`. A markdown save is a public commons page.
    const url =
      isArtifact && owner
        ? pagePath(ownerToTenant(owner), result.slug)
        : commonsPath(result.slug);

    return NextResponse.json({ slug: result.slug, url, success: true });
  } catch (error) {
    logger.error("query", "Save answer error", error);
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
