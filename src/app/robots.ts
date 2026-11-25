import type { MetadataRoute } from "next";

const BASE_URL = "https://yopedia.yolog.dev";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/wiki/",
        disallow: ["/api/", "/vault/", "/settings/"],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
