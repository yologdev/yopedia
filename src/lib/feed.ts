import type { TrailEvent } from "./trail";

const SITE_URL = "https://yopedia.yolog.dev";
const FEED_TITLE = "yopedia — recent wiki activity";
const FEED_SUBTITLE =
  "A shared second brain for humans and agents. Recent ingests, edits, and re-ingests across the commons.";

/** Escape XML special characters in text content. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build a human-readable summary for a trail event. */
function actionSummary(e: TrailEvent): string {
  const verb =
    e.action === "ingested"
      ? "ingested"
      : e.action === "re-ingested"
        ? "re-ingested"
        : "edited";
  const source = e.sourceType ? ` (${e.sourceType})` : "";
  return `${e.actor} ${verb} "${e.title}"${source}`;
}

/** Stable per-event id — combines slug, action, actor and timestamp. */
function entryId(e: TrailEvent): string {
  return `tag:yopedia.yolog.dev,2026:trail/${e.slug}/${e.action}/${e.ts}`;
}

/** Canonical page URL for a commons trail event. */
function pageUrl(e: TrailEvent): string {
  return `${SITE_URL}/wiki/${e.slug}`;
}

/** Render an Atom XML feed from a list of trail events. */
export function renderAtomFeed(events: TrailEvent[], updated: string): string {
  const entries = events
    .map(
      (e) => `  <entry>
    <id>${escapeXml(entryId(e))}</id>
    <title>${escapeXml(e.title)}</title>
    <link href="${escapeXml(pageUrl(e))}" rel="alternate" />
    <updated>${escapeXml(e.when)}</updated>
    <author><name>${escapeXml(e.actor)}</name></author>
    <summary>${escapeXml(actionSummary(e))}</summary>
  </entry>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${SITE_URL}/feed.xml</id>
  <title>${escapeXml(FEED_TITLE)}</title>
  <subtitle>${escapeXml(FEED_SUBTITLE)}</subtitle>
  <link href="${SITE_URL}/feed.xml" rel="self" type="application/atom+xml" />
  <link href="${SITE_URL}" rel="alternate" type="text/html" />
  <updated>${escapeXml(updated)}</updated>
${entries}
</feed>
`;
}
