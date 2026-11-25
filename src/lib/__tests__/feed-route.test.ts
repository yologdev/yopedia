import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub getTrail so the route handler doesn't hit real storage.
vi.mock("@/lib/trail", () => ({ getTrail: vi.fn() }));

import { GET } from "@/app/feed.xml/route";
import { renderAtomFeed } from "@/lib/feed";
import { getTrail } from "@/lib/trail";
import type { TrailEvent } from "@/lib/trail";

const mockedGetTrail = vi.mocked(getTrail);

function makeEvent(overrides: Partial<TrailEvent> = {}): TrailEvent {
  return {
    ts: 1_700_000_000_000,
    when: "2026-06-10T00:00:00.000Z",
    actor: "alice",
    isAgent: false,
    action: "ingested",
    slug: "about-poke",
    title: "About Poke",
    tenant: "commons",
    commons: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /feed.xml", () => {
  it("returns valid Atom XML with correct content type and caching", async () => {
    mockedGetTrail.mockResolvedValue([makeEvent()]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/atom+xml; charset=utf-8",
    );
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=");

    const xml = await res.text();
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<feed xmlns=");
    expect(xml).toContain("<entry>");
    expect(xml).toContain("<title>About Poke</title>");
    expect(xml).toContain("/wiki/about-poke");
    expect(xml).toContain("<name>alice</name>");
  });

  it("filters out non-commons events", async () => {
    mockedGetTrail.mockResolvedValue([
      makeEvent({ slug: "public-page", title: "Public", commons: true }),
      makeEvent({ slug: "private-page", title: "Private", commons: false }),
      makeEvent({
        slug: "agent-page",
        title: "Agent Scoped",
        commons: undefined,
      }),
    ]);

    const res = await GET();
    const xml = await res.text();

    expect(xml).toContain("public-page");
    expect(xml).not.toContain("private-page");
    expect(xml).not.toContain("agent-page");
  });

  it("calls getTrail with null principal (anonymous / public only)", async () => {
    mockedGetTrail.mockResolvedValue([]);

    await GET();

    expect(mockedGetTrail).toHaveBeenCalledWith(30, null);
  });

  it("produces a valid feed with zero events", async () => {
    mockedGetTrail.mockResolvedValue([]);

    const res = await GET();
    const xml = await res.text();

    expect(xml).toContain("<feed xmlns=");
    expect(xml).not.toContain("<entry>");
    // Updated should still be a valid ISO date.
    expect(xml).toMatch(/<updated>\d{4}-\d{2}-\d{2}T/);
  });
});

describe("renderAtomFeed", () => {
  it("escapes XML special characters in titles and actors", () => {
    const event = makeEvent({
      title: 'Foo & Bar <Baz> "Qux"',
      actor: "agent&co",
    });
    const xml = renderAtomFeed([event], event.when);

    expect(xml).toContain("Foo &amp; Bar &lt;Baz&gt; &quot;Qux&quot;");
    expect(xml).toContain("<name>agent&amp;co</name>");
    // Raw special characters must not appear unescaped.
    expect(xml).not.toContain("<Baz>");
  });

  it("includes source type in action summary for ingests", () => {
    const event = makeEvent({ sourceType: "youtube" });
    const xml = renderAtomFeed([event], event.when);

    expect(xml).toContain("(youtube)");
  });

  it("includes self link and alternate link in feed header", () => {
    const xml = renderAtomFeed([], new Date().toISOString());

    expect(xml).toContain('rel="self"');
    expect(xml).toContain('type="application/atom+xml"');
    expect(xml).toContain('rel="alternate"');
    expect(xml).toContain("/feed.xml");
  });

  it("generates stable tag-URI entry ids", () => {
    const event = makeEvent({ slug: "test-page", action: "edited", ts: 12345 });
    const xml = renderAtomFeed([event], event.when);

    expect(xml).toContain("tag:yopedia.yolog.dev,2026:trail/test-page/edited/12345");
  });
});
