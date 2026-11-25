import type { MetadataRoute } from "next";
import { getCommonsIndex } from "@/lib/commons";

const BASE_URL = "https://yopedia.yolog.dev";

/** Sitemap spec cap — a single sitemap file may contain at most 50,000 URLs. */
const SITEMAP_URL_CAP = 50_000;

/** Static pages that should always appear in the sitemap. */
const STATIC_PAGES: MetadataRoute.Sitemap = [
  { url: `${BASE_URL}/`, changeFrequency: "daily", priority: 1.0 },
  { url: `${BASE_URL}/about`, changeFrequency: "monthly", priority: 0.5 },
  { url: `${BASE_URL}/wiki`, changeFrequency: "daily", priority: 0.8 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries = await getCommonsIndex();

  const wikiPages: MetadataRoute.Sitemap = entries.map((entry) => ({
    url: `${BASE_URL}/wiki/${entry.slug}`,
    ...(entry.updated ? { lastModified: entry.updated } : {}),
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  const all = [...STATIC_PAGES, ...wikiPages];
  return all.slice(0, SITEMAP_URL_CAP);
}
