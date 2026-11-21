# Clerk Billing Setup — Private Tier

yopedia's private tier lets paid users create `visibility: "private"` pages and
private vaults. The authorization gate is already built and fail-closed:

- `canSetPrivate()` in `src/lib/authz.ts` calls `hasPaidPlan()`
- `hasPaidPlan()` reads Clerk `publicMetadata.plan === "pro"`
- No billing checkout → no user can create private content (safe default)

This document tells the **site owner** how to wire up billing so users can
purchase the "pro" plan and unlock private features.

---

## Prerequisites

- A running yopedia instance with Clerk auth configured (see `.env.example`)
- A Clerk account with access to **Clerk Billing** (or a separate Stripe account)

---

## Option A: Clerk Billing (recommended)

Clerk Billing manages subscriptions and automatically sets user metadata on
payment.

### Steps

1. **Open your Clerk Dashboard → Billing.**

2. **Create a plan** called `pro` (the exact string matters — the code checks
   `publicMetadata.plan === "pro"`).
   - Set the price you want (e.g. $5/month, $50/year — your call).
   - Under "Plan metadata", configure it to set:
     ```json
     { "plan": "pro" }
     ```
     on the user's `publicMetadata` when the subscription is active.

3. **Add the Clerk Billing portal** to your app (optional but recommended for
   self-service plan management). The `<UserProfile />` component from
   `@clerk/nextjs` shows billing automatically when Clerk Billing is enabled.

4. **No extra env vars are needed** — Clerk Billing uses your existing
   `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.

### How it works

When a user subscribes:
- Clerk sets `publicMetadata.plan = "pro"` on their user record.
- `hasPaidPlan()` reads this via `currentUser()` and returns `true`.
- `canSetPrivate()` opens the gate for that user.

When a subscription lapses or is cancelled:
- Clerk removes or changes the plan in `publicMetadata`.
- `hasPaidPlan()` returns `false` — the user can no longer create new private
  content. Existing private pages stay private (they don't auto-downgrade).

---

## Option B: Stripe + webhook

If you prefer Stripe directly instead of Clerk Billing:

### Steps

1. **Create a Stripe product/price** for your pro plan.

2. **Add a webhook endpoint** that listens for `checkout.session.completed` (and
   optionally `customer.subscription.deleted` for downgrades). The webhook
   handler should call the Clerk Backend API to set the user's metadata:

   ```ts
   import { clerkClient } from "@clerk/nextjs/server";

   // On successful payment:
   const client = await clerkClient();
   await client.users.updateUserMetadata(clerkUserId, {
     publicMetadata: { plan: "pro" },
   });

   // On cancellation:
   const client = await clerkClient();
   await client.users.updateUserMetadata(clerkUserId, {
     publicMetadata: { plan: "free" },
   });
   ```

3. **Store the Stripe↔Clerk mapping.** When creating a Stripe Checkout Session,
   pass the Clerk user id in `metadata` or `client_reference_id` so the webhook
   can look it up.

4. **Env vars** (add to your Worker secrets):

   | Variable | Description |
   |---|---|
   | `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` or `sk_test_...`) |
   | `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |

### Downgrade behavior

The codebase checks the plan at read time (`hasPaidPlan()`), so removing
`plan: "pro"` from `publicMetadata` immediately prevents NEW private content
creation. Existing private pages are unaffected — they remain private and
readable by their owner.

---

## Option C: Manual (dashboard only)

For testing or a small number of users, you can set the plan manually:

1. Open the **Clerk Dashboard → Users → select a user → Metadata**.
2. Under **Public metadata**, set:
   ```json
   { "plan": "pro" }
   ```
3. Save. The user can now create private content.

This requires no code changes or additional env vars.

---

## Verifying the setup

After configuring billing:

1. Sign in as a test user with the `pro` plan.
2. Try creating a page with `visibility: "private"` — should succeed.
3. Sign in as a user WITHOUT the plan — the private option should be gated.

---

## Status

**Not yet configured.** The authorization code is live and fail-closed (no user
can create private content until billing is set up). The agent team can build
the checkout UI and clone-to-private flow once this setup is complete and issue
[#958](https://github.com/yologdev/yopedia/issues/958) is closed.
