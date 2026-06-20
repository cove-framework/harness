# Phase 11 — Channels + storage-adapter collapse
> Port the channel integrations (Slack, Discord, GitHub, Teams, Telegram, Google Chat, Linear, Notion, …) onto the P8 HTTP submit surface via one shared inbound model — verify, dedup, `payload → submitPrompt`, reply — and collapse the five SQL storage adapters into the single Convex adapter. Design-of-record: [06 — Roadmap](../design/06-phase-roadmap.md) + [05 — Public API](../design/05-public-api-and-sdk.md), [08 — Conventions](../design/08-conventions-and-execution-boundary.md). Decisions: [D1, D14](../design/07-risks-and-decisions.md).

## Goal & scope

Channels are inbound webhooks that turn an external event (a Slack message, a GitHub issue comment) into an agent run and post the result back. flue shipped ~17 channel packages; cove ports them onto the **existing** P8 submit surface with **no new engine work** — every channel is the same four-step pipeline (D14), differing only in signature verification and payload shape.

- A **shared inbound model** (`convex/channels/inbound.ts`): per-channel signature verification → idempotent webhook dedup → `payload → submitPrompt` (reuse `agentRequests`, no separate inbound table) → outbound reply on the originating channel.
- **Per-channel modules** (`convex/channels/<name>/`): the signature-verify + payload-map + reply-post specifics, each registering one or more `httpAction` routes on the P8 router.
- The **`authorize` hook (P8) gates channel inbound** like any other transport.
- **Storage-adapter collapse (D1):** the SQL adapters (`postgres`/`libsql`/`mysql`/`mongodb`/`redis`) are **obsolete** — Convex *is* the DB. Confirm there is exactly **one** Convex adapter and record the drop; do not port any SQL adapter code.

**Ship-first set (this phase):** Slack, Discord, GitHub, Teams, Telegram, Google Chat, Linear, Notion.
**Deferred (later):** Intercom, Resend, Salesforce Marketing Cloud, Zendesk.
**TBD (not scheduled):** Messenger, WhatsApp, Twilio, Shopify, Stripe.

**Out of scope:** any change to the engine/loop, the SDK, or the auth provider. A channel that needs richer inbound state than `agentRequests` provides (D14) is a follow-up — start with the shared path.

## Dependencies

| Must land first | Why |
| --- | --- |
| **P8 — HTTP + auth** | Channels are `httpAction` routes on the P8 `httpRouter`; inbound calls `invoke.submitPrompt`; `authorize` gates them; `toHttpResponse`/`CoveApiError` render failures. The webhook ack (200/202) uses the P8 response helpers. |
| **P6 — Harness/invoke** | `payload → submitPrompt` is the admission mutation P6 built; the run terminalizes via the P4 loop; the channel reads the terminal result to post a reply. |
| **P9 — Events/SDK** (soft) | A channel that streams partial output back (e.g. "typing…") subscribes to the reactive `events`; the **minimum** path (post the final result) needs only the terminal status, so P9 is optional for the ship-first set. |
| P5 (done by here) | Idempotent dedup keys a `meta`/dedup row (or a unique index on provider-event-id) to drop replayed webhooks; reuses the SOR. |

## Deliverables

| File / dir | Purpose |
| --- | --- |
| `convex/channels/inbound.ts` | The shared 4-step pipeline: `verifyThenAdmit(channel, req)` — calls the channel's `verify` + `dedup` + maps `payload→submitPrompt` + schedules the reply. The single place the inbound contract lives. |
| `convex/channels/dedup.ts` | Idempotent webhook dedup — a unique key per `(provider, eventId)`; a replayed delivery is a no-op 200. |
| `convex/channels/reply.ts` | Outbound reply dispatch — given a terminal run result + the originating channel ref, post back via the channel's `postReply`. |
| `convex/channels/slack/` | `index.ts` (routes + `verify` HMAC + `mapPayload` + `postReply`), ported from flue [`slack`](../../../flue/packages/slack/src/). |
| `convex/channels/discord/` · `github/` · `teams/` · `telegram/` · `google-chat/` · `linear/` · `notion/` | Same shape per channel (ship-first set). `teams`/`google-chat` also port their `auth.ts`. `github`/`telegram`/`linear`/`notion` are `webhook.ts`-style; `slack`/`discord`/`teams`/`google-chat` are `routes.ts`-style. |
| `convex/channels/index.ts` | Registers all ship-first channel routes onto the P8 `httpRouter`; the `channelRegistry` (name → `{verify, mapPayload, postReply}`). |
| `convex/channels/*.test.ts` | Per-channel: signature-verify pass/fail, replay dedup, `payload→submitPrompt`, reply. At least Slack end-to-end (the 06 acceptance bar). |

> No new tables. Channels reuse `agentRequests` (D14); dedup uses a unique index / a small `meta`-style row. The SQL adapter packages are **not** ported — they have no place under Convex.

## Source map (flue/pi → cove)

| flue/pi file | target cove file | port / transform notes |
| --- | --- | --- |
| [`packages/slack/src/{index,routes,errors}.ts`](../../../flue/packages/slack/src/) | `convex/channels/slack/index.ts` | Port the **signature verification** (Slack signing-secret HMAC + timestamp window) and **payload→message** mapping; the route handler becomes a P8 `httpAction`. Drop any Hono/DS-specific plumbing. |
| [`packages/discord/src/{index,routes}.ts`](../../../flue/packages/discord/src/) | `convex/channels/discord/index.ts` | Ed25519 interaction signature verify; `mapPayload`/`postReply` over the Discord interaction model. |
| [`packages/github/src/{index,webhook}.ts`](../../../flue/packages/github/src/) | `convex/channels/github/index.ts` | `X-Hub-Signature-256` HMAC verify; event-type routing (issue/PR comment → prompt). |
| [`packages/teams/src/{index,routes,auth}.ts`](../../../flue/packages/teams/src/) | `convex/channels/teams/` | Bot Framework JWT validation (port `auth.ts`); activity→prompt mapping. |
| [`packages/telegram/src/{index,webhook}.ts`](../../../flue/packages/telegram/src/) | `convex/channels/telegram/index.ts` | Secret-token header verify; update→prompt mapping. |
| [`packages/google-chat/src/{index,routes,auth}.ts`](../../../flue/packages/google-chat/src/) | `convex/channels/google-chat/` | Google JWT verify (port `auth.ts`); event→prompt mapping. |
| [`packages/linear/src/{index,webhook}.ts`](../../../flue/packages/linear/src/) | `convex/channels/linear/index.ts` | Linear webhook signature verify; issue/comment→prompt mapping. |
| [`packages/notion/src/{index,webhook}.ts`](../../../flue/packages/notion/src/) | `convex/channels/notion/index.ts` | Notion verification token; event→prompt mapping. |
| `packages/{postgres,libsql,mysql,mongodb,redis}/src/*` | — (**obsolete**, [D1](../design/07-risks-and-decisions.md)) | **Not ported.** The SQL `SessionStore`/`RunStore`/`EventStreamStore` implementations collapse into the single Convex adapter ([08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit), [02 mapping](../design/02-architecture-and-mapping.md)). Confirm the drop is cited; write zero adapter code. |
| `packages/{intercom,resend,salesforce-marketing-cloud,zendesk}` | — (**deferred**) | Same shape; scheduled after the ship-first set. Leave a stub note in `channels/index.ts`. |

## Hardened-contract obligations

- **[D14 — reuse `agentRequests` + HTTP submit](../design/07-risks-and-decisions.md).** Channels land through the **existing** P8 submit `httpAction` into `agentRequests`; **no separate inbound table** unless a channel proves it needs richer state. The four steps are fixed: verify → dedup → `submitPrompt` → reply.
- **Per-channel signature verification (security).** Every inbound route verifies the provider signature **before** admission — Slack signing secret + timestamp window, GitHub `X-Hub-Signature-256`, Discord Ed25519, Telegram secret token, Teams/Google-Chat JWT. A failed verify → 401 via `toHttpResponse`, **no** admission.
- **Idempotent dedup.** A replayed webhook (same provider event id) is a **no-op 200** — never a second run. Key dedup on `(provider, eventId)` with a unique index; the admission is downstream of the dedup gate.
- **[P8 `authorize`](phase-08-http-auth-workflows.md) gates inbound.** The channel route runs through the same `authorize` seam as every other transport (D3) — channel-secret verification is the channel's own step; `authorize` is the framework gate in front of the engine.
- **[D1 — SQL adapters obsolete](../design/07-risks-and-decisions.md).** One Convex adapter only; the SQL backends are dropped, not ported. Cite in [08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit) if not already.
- **[08 §3 — boundary](../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy).** Channel `httpAction`s admit + reply; they do not run the loop or touch the box inline.

## Implementation tasks

- [ ] **1. Build the shared inbound model** (`convex/channels/inbound.ts`, `dedup.ts`, `reply.ts`) first — the four-step pipeline parameterized by a `ChannelAdapter = {name, verify(req)→ctx|throw, mapPayload(req)→{agent,instanceId,sessionName,message,images?}, postReply(ref, result)}`. Everything channel-specific is in the adapter.
- [ ] **2. Dedup** — choose the key mechanism: a unique index on a small dedup row `(provider, eventId)` (insert-or-conflict), so a replay hits the conflict and returns 200 without admitting. Decide TTL/cleanup (or rely on idempotent insert + retention).
- [ ] **3. Port Slack** (the 06 acceptance channel) end-to-end: signing-secret HMAC + timestamp window verify; `event_callback` message → `submitPrompt`; reply via `chat.postMessage` (or response_url). Wire its route into `channels/index.ts`.
- [ ] **4. Port the rest of the ship-first set** (Discord, GitHub, Teams, Telegram, Google Chat, Linear, Notion) against the same `ChannelAdapter` contract. Port `auth.ts` for Teams + Google Chat. Reuse `inbound.ts`/`dedup.ts`/`reply.ts` — only the adapter differs.
- [ ] **5. Register routes** — `channels/index.ts` mounts each channel's `httpAction`(s) on the P8 `httpRouter`; add the `authorize` call in the inbound path.
- [ ] **6. Outbound reply** — `reply.ts` reads the terminal run result (poll terminal status / subscribe) and calls the adapter's `postReply`. Decide sync (within the webhook ack window via `?wait=result`) vs. async (ack 200 immediately, post reply when the run terminalizes via a scheduled function) — async is the safe default for long runs.
- [ ] **7. Record the SQL-adapter collapse** — confirm exactly one Convex adapter exists; ensure [08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)/[02](../design/02-architecture-and-mapping.md) cite the postgres/libsql/mysql/mongodb/redis drop. No code.
- [ ] **8. Tests** — per channel: a forged signature → 401 (no admission); a replayed delivery → single run; a valid event → `submitPrompt` with the mapped message; Slack full loop (verify → run → reply posted). Stub the engine (no live provider) and the provider HTTP client (no live Slack).
- [ ] **9. `tsc --noEmit` green;** leave clearly-marked stubs/notes for the deferred channels so the registry documents what's intentionally absent.

## Acceptance

Start from [06 P11's bar](../design/06-phase-roadmap.md) — *at least one channel (Slack) verifies an inbound event, dedups a replayed webhook, drives a run via `submitPrompt`, and posts the reply back*:

1. **Slack end-to-end.** A valid Slack `event_callback` (correct signature + timestamp) → `submitPrompt` → run completes → reply posted via the (mocked) Slack client. A **forged** signature → 401, no admission. A **replayed** delivery (same event id) → exactly **one** run (dedup no-op on the second).
2. **Shared model holds for ≥2 channels.** GitHub (`X-Hub-Signature-256`) and one JWT channel (Teams or Google Chat) pass the same verify→dedup→submit→reply path using only their adapter — proving no per-channel engine work.
3. **`authorize` gates inbound.** An inbound call that the `authorize` hook rejects never admits (channel-secret verification and framework auth are both enforced).
4. **No new inbound table.** Runs land in `agentRequests` (D14); dedup uses a unique-key row, not a bespoke inbound store.
5. **SQL adapters absent.** No `postgres`/`libsql`/`mysql`/`mongodb`/`redis` adapter code exists; the drop is cited (D1, [08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)).
6. **`tsc --noEmit` exits 0.**

## Risks & gotchas

- **Webhook ack window vs. run latency.** Most providers expect a fast 200 (Slack ≤3 s, etc.). **Do not** `?wait=result` for a full agent run inside the webhook handler — ack immediately and post the reply asynchronously when the run terminalizes (a scheduled/`runAfter` function reading the terminal status). Only trivially-fast runs can reply synchronously.
- **Signature verify needs the raw body.** HMAC/Ed25519 verification runs over the **raw** request bytes, not the parsed JSON. In a Convex `httpAction`, read `await req.text()` (or `arrayBuffer`) once for verification, then parse — re-reading/re-serializing changes bytes and breaks the signature.
- **Dedup must precede admission, not follow it.** If you admit then dedup, a replay creates a second run before the dedup check. Insert the dedup key (unique-index conflict = duplicate) **before** `submitPrompt`.
- **Per-channel secrets via Convex env.** Slack signing secret, GitHub webhook secret, bot tokens, JWT audiences — all live as Convex environment variables read inside the `"use node"` action ([05 §Environment](../design/05-public-api-and-sdk.md)), never in client code or query/mutation context.
- **Timestamp replay window (Slack/Discord).** Verify the request timestamp is within the allowed skew (e.g. ±5 min) to block replay of a captured-but-valid signature — signature verify alone isn't enough.
- **Don't port the Hono/DS plumbing.** flue's channel routes assume the Hono `flue()` app + DS; cove channels are plain `httpAction`s on the `httpRouter`. Port the **verify + map + reply logic**, not the routing framework.
- **Outbound reply identity.** Capture enough of the originating context (channel id, thread/message ts, response_url) at admission and thread it onto the run (e.g. `agentRequests.metadata`) so `reply.ts` can post back to the right place when the run finishes — the webhook request object is long gone by then.
