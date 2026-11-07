/**
 * Coarse per-key rate limiting for the abuse/cost-sensitive public surfaces
 * (remote MCP). Backed by the existing `YOPEDIA_CONFIG`
 * KV — no new infra. It's a **fixed-window counter**, so it's eventually
 * consistent and approximate (a burst may let a few extra through); that's fine
 * for a cost guard, it is NOT a precise quota. **Fail-open**: when there's no KV
 * (local dev / tests / a KV hiccup) the limiter allows the request — a limiter
 * outage must never take down legitimate traffic.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { logger } from "./logger";

/** Minimal KV surface the limiter needs (satisfied by `KVNamespace`). */
export interface RateLimitStore {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface RateLimitRule {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

/** Default limits per surface (requests per window, per key). Tunable. */
export const RATE_LIMITS = {
  /** Remote MCP: 1 unit per POST (batches are already capped at 20). */
  mcp: { limit: 60, windowSec: 60 } as RateLimitRule,
  /** Query (streaming + non-streaming): each call triggers an LLM generation. */
  query: { limit: 30, windowSec: 60 } as RateLimitRule,
  /** Ingest: each call triggers LLM synthesis + embedding. */
  ingest: { limit: 10, windowSec: 60 } as RateLimitRule,
};

/** The KV-backed store, or null outside an OpenNext Cloudflare request. */
function getStore(): RateLimitStore | null {
  let env: { YOPEDIA_CONFIG?: RateLimitStore } | undefined;
  try {
    env = getCloudflareContext().env as { YOPEDIA_CONFIG?: RateLimitStore };
  } catch {
    return null; // not in a Workers request context (local/test) — expected, silent
  }
  const kv = env?.YOPEDIA_CONFIG;
  if (!kv) {
    // We ARE in a deployed Worker but the KV binding is absent — a config defect
    // that silently disables the cost guard. Make it LOUD (error tier → alerting)
    // rather than failing open without a trace, which is how a surprise bill
    // happens. (The no-context case above stays silent — that's just local/test.)
    logger.error(
      "rate-limit",
      "YOPEDIA_CONFIG KV binding missing in a Worker request — rate limiting is DISABLED",
    );
    return null;
  }
  return kv;
}

/**
 * Fixed-window check against an explicit store (pure + injectable for tests).
 * `nowMs` defaults to the current time. Returns whether the request is allowed
 * and how many remain in the current window.
 */
export async function checkRateLimit(
  store: RateLimitStore,
  key: string,
  { limit, windowSec }: RateLimitRule,
  nowMs: number = Date.now(),
): Promise<{ allowed: boolean; remaining: number }> {
  const window = Math.floor(nowMs / 1000 / windowSec);
  const wkey = `rl:${key}:${window}`;
  const current = parseInt((await store.get(wkey)) ?? "0", 10) || 0;
  if (current >= limit) return { allowed: false, remaining: 0 };
  // Keep the counter only ~2 windows (long enough for the active window; old
  // windows expire so KV doesn't grow unbounded).
  await store.put(wkey, String(current + 1), { expirationTtl: windowSec * 2 });
  return { allowed: true, remaining: limit - current - 1 };
}

/**
 * Enforce a rate limit for `key` on the named surface. Fail-open: returns
 * `allowed: true` when there's no KV or the limiter errors (a guard must never
 * be a single point of failure for legitimate requests).
 */
export async function enforceRateLimit(
  surface: keyof typeof RATE_LIMITS,
  key: string,
): Promise<{ allowed: boolean; remaining: number }> {
  const store = getStore();
  if (!store) return { allowed: true, remaining: -1 };
  try {
    return await checkRateLimit(store, `${surface}:${key}`, RATE_LIMITS[surface]);
  } catch (err) {
    logger.warn("rate-limit", `limiter error for ${surface}:${key} — allowing`, err);
    return { allowed: true, remaining: -1 };
  }
}
