import { getTrail } from "@/lib/trail";
import { renderAtomFeed } from "@/lib/feed";

/** How many trail events to include in the feed. */
const FEED_LIMIT = 30;

export async function GET() {
  // getTrail(limit, null) returns public commons events (anonymous path —
  // no principal means only public, non-agent-scoped pages via the recent
  // index or scanTrail fallback). The trail already filters to commons and
  // deduplicates near-simultaneous events.
  const events = await getTrail(FEED_LIMIT, null);

  // Only include events explicitly marked as commons (public, non-agent-scoped).
  // The trail may include owner-scoped entries when the index has stale data;
  // this is the feed's own belt on top of getTrail's filter.
  const commonsEvents = events.filter((e) => e.commons === true);

  const updated =
    commonsEvents.length > 0
      ? commonsEvents[0].when
      : new Date().toISOString();

  const xml = renderAtomFeed(commonsEvents, updated);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=600, max-age=300",
    },
  });
}
