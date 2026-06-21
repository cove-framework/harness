# Channels (Slack & beyond)

A **channel** is an inbound transport that turns external messages into Cove runs. Cove ships one pre-built channel — a Slack Events webhook at `POST /channels/slack` — plus the small, channel-agnostic primitives (signature verify, payload parse, session mapping, dedup) you reuse to add your own.

This page is about *wiring* the Slack webhook and *extending* the pattern. It does not re-derive the engine: a channel is just another producer of `api.invoke.submit.submitPrompt`. For the rest of the submit/poll surface (the `/agents` and `/runs` routes, the authorize hook), see [Invoking Agents](03-invoking-agents.md). For how the resulting run is addressed and persisted, see [Sessions & Compaction](05-sessions-and-compaction.md).

> **Inbound only, for now.** The Slack route admits a prompt but does **not** post the run's answer back to Slack. Posting replies (a Slack bot token + a run-completion hook) is the documented P11 remainder and is not implemented in these files. See [The outbound-reply gap](#the-outbound-reply-gap) below.

---

## The two halves of a channel

Every channel is split across the project's [one-way layer rule](08-deployment-and-operations.md) (`convex/*` may import `src/runtime/*`, never the reverse):

1. **A pure adapter** in `src/runtime/channels/<name>.ts` — V8-safe, no Convex, no AI SDK, no `"use node"`. It only uses Web Crypto. For Slack this is `src/runtime/channels/slack.ts` and it exports four things: a signature verifier, a payload parser, a session-ref mapper, and a dedup-key builder.
2. **The HTTP wiring** in `convex/http.ts` — an `httpAction` route registered on the default-exported `httpRouter`. It reads the raw body, calls the pure adapter, and drives `submitPrompt`. The shared dedup ledger lives in `convex/channels.ts` (`markWebhookSeen`).

Keeping the adapter pure is what makes it unit-testable (with `vitest`, against `__tests__/`) without a Convex deployment — the HMAC, parsing, and mapping are all deterministic.

---

## The Slack adapter (`src/runtime/channels/slack.ts`)

The pure half exposes exactly these four exports.

### `verifySlackSignature` — request authentication

```ts
export async function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  now?: number;        // default Date.now()
  toleranceSec?: number; // default 300 (±5 min replay window)
}): Promise<boolean>
```

It computes `v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{rawBody}")` and constant-time hex-compares it against `signature`. It returns `false` (not throw) when the timestamp is not finite or `|now - ts|` exceeds `toleranceSec`. Pure Web Crypto (`crypto.subtle` HMAC SHA-256) — no Node builtins.

### `parseSlackPayload` — classify the request

```ts
export type SlackInbound =
  | { kind: "challenge"; challenge: string }
  | { kind: "event"; eventId: string; message: string; channel: string; team: string; user: string }
  | { kind: "ignore" };

export function parseSlackPayload(payload: unknown): SlackInbound;
```

Branch on `kind`:

- **`"challenge"`** — `payload.type === "url_verification"` and `payload.challenge` is a string. Answer the handshake.
- **`"event"`** — only when `payload.type === "event_callback"`, `payload.event` is an object, `event.type` is `"message"` or `"app_mention"`, `event.text` is a non-empty string, there is **no** `event.bot_id`, and `event.subtype === undefined`. Anything else (edits, joins, bot subtypes, empty text) is dropped to avoid reply loops.
- **`"ignore"`** — everything else.

On an event, `eventId` is `payload.event_id` when present, otherwise the fallback `` `${event.channel}:${event.ts}` ``; `message = event.text`; `channel = event.channel ?? "unknown"`; `team = payload.team_id ?? "unknown"`; `user = event.user ?? "unknown"`.

### `slackSessionRef` — one session per channel

```ts
export function slackSessionRef(team: string, channel: string): { instanceId: string; sessionName: string };
// → { instanceId: `slack:${team}`, sessionName: `slack:${channel}` }
```

This is the addressing decision: **one Cove session per Slack channel**. Every message in a channel reuses `instanceId = "slack:" + team_id` and `sessionName = "slack:" + channel_id`, so multi-turn continuity is automatic (reusing the tuple reattaches to the same entry tree — see [Sessions & Compaction](05-sessions-and-compaction.md#multi-turn-continuity-is-implicit-reuse-the-tuple)). The result is spread straight into `submitPrompt`.

### `slackDedupKey` — idempotency

```ts
export function slackDedupKey(eventId: string): string;
// → `webhook:slack:${eventId}`
```

A provider-scoped key for the shared dedup ledger. The `webhook:slack:` prefix namespaces Slack so it cannot collide with another channel's keys.

---

## The dedup primitive (`convex/channels.ts`)

Deduplication is channel-agnostic and shared by all channels. There is no per-channel inbound table — the `meta` key/value table is the dedup ledger.

```ts
// convex/channels.ts — call as internal.channels.markWebhookSeen
export const markWebhookSeen = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<{ isNew: boolean }> => { /* ... */ },
});
```

It queries `meta` by the `by_key` index. If the row exists it returns `{ isNew: false }` (a replayed delivery — the caller treats it as a no-op). Otherwise it inserts `{ key, value: { seenAt: Date.now() } }` and returns `{ isNew: true }`. It is an `internalMutation` with no `"use node"` — an `httpAction` reaches it via `ctx.runMutation`.

---

## The Slack route (`convex/http.ts`)

The route is registered on the default-exported router with an **exact** path (`path`, not `pathPrefix`) and method `POST`:

```ts
// convex/http.ts
http.route({
  path: "/channels/slack",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const rawBody = await req.text();              // RAW body — used for BOTH parse and HMAC
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw new InvalidJsonError();
      }
      const parsed = parseSlackPayload(payload);

      // 1) Answer the handshake FIRST — before signature verification.
      if (parsed.kind === "challenge") {
        return Response.json({ challenge: parsed.challenge });
      }

      // 2) Verify the signature (every non-challenge request).
      const secret = process.env.SLACK_SIGNING_SECRET;
      if (!secret) throw new UnauthorizedError("[cove] Slack signing secret not configured.");
      const verified = await verifySlackSignature({
        signingSecret: secret,
        timestamp: req.headers.get("x-slack-request-timestamp") ?? "",
        rawBody,
        signature: req.headers.get("x-slack-signature") ?? "",
      });
      if (!verified) throw new UnauthorizedError("[cove] invalid Slack signature.");

      if (parsed.kind === "ignore") return new Response("ok");

      // 3) Idempotent dedup — replayed deliveries are no-ops.
      const { isNew } = await ctx.runMutation(internal.channels.markWebhookSeen, {
        key: slackDedupKey(parsed.eventId),
      });
      if (!isNew) return new Response("ok (duplicate)");

      // 4) Map to a session and submit.
      const ref = slackSessionRef(parsed.team, parsed.channel);
      await ctx.runMutation(api.invoke.submit.submitPrompt, {
        prompt: parsed.message,
        instanceId: ref.instanceId,
        sessionName: ref.sessionName,
      });
      return new Response("ok");
    } catch (err) {
      const { status, body } = renderHttpError(err);
      return Response.json(body, { status });
    }
  }),
});
```

The order of operations is load-bearing. Note these specifics:

- **The handshake is answered before signature verification.** `url_verification` returns `Response.json({ challenge })` immediately, so it succeeds even before you have set the signing secret. A malformed or non-challenge body still requires a valid signature.
- **Verification is over the raw bytes.** `req.text()` is read once and used both for `JSON.parse(rawBody)` (the payload) and as `rawBody` to `verifySlackSignature`. Never re-serialize the parsed object for HMAC — Slack signs the exact bytes it sent.
- **No `model` is passed.** Unlike the `/agents` route, the Slack path calls `submitPrompt({ prompt, instanceId, sessionName })` only. It relies on the engine's default model (`cove-test/mock` if you have not configured a real one — see [Deployment & Operations](08-deployment-and-operations.md)). Pass a real model elsewhere or wire one in if you want production replies.
- **Errors render onto the standard envelope.** Any thrown `CoveHttpError` (e.g. `UnauthorizedError`, `InvalidJsonError`) is rendered by `renderHttpError(err)` into `Response.json(body, { status })` — the same `{ error: { code, message, status } }` `CoveApiError` shape used everywhere else.
- **The channels route does not run the authorize hook.** `runAuthorize` gates the `/agents` and `/runs` routes; the Slack route authenticates via the signing-secret HMAC instead.

### Responses you will see

| Situation | Response |
| --- | --- |
| `url_verification` handshake | `200 { "challenge": "<echo>" }` |
| Valid user `message` / `app_mention` | `200 ok` (a prompt is submitted) |
| Bot/self/edit/empty (`kind: "ignore"`) | `200 ok` (no submit) |
| Replayed delivery (`isNew === false`) | `200 ok (duplicate)` (no submit) |
| `SLACK_SIGNING_SECRET` unset | `401 unauthorized` — `"[cove] Slack signing secret not configured."` |
| Bad/missing signature or timestamp headers | `401 unauthorized` — `"[cove] invalid Slack signature."` |
| Body that is not valid JSON | `400 invalid_json` |

---

## Wiring it up

### 1. Deploy the backend

The route is already in `convex/http.ts`, so a full deploy publishes it. From the repo root (`cove-harness/`):

```bash
node node_modules/convex/bin/main.js dev --once
```

`codegen` alone is not enough — it only pushes component bindings; `dev --once` is the full deploy that makes functions and HTTP routes callable. See [Deployment & Operations](08-deployment-and-operations.md).

### 2. Set the signing secret

Slack's "Signing Secret" lives under your Slack app's **Basic Information**. Set it on the Convex deployment (it is read inside the handler via `process.env.SLACK_SIGNING_SECRET`):

```bash
node node_modules/convex/bin/main.js env set SLACK_SIGNING_SECRET <your-signing-secret>
```

Without it, every non-challenge request returns `401`.

### 3. Point your Slack app at the URL

HTTP routes are served from your deployment's **`.convex.site`** origin (not `.convex.cloud`). The webhook URL is:

```
https://<your-deployment>.convex.site/channels/slack
```

In your Slack app's **Event Subscriptions**:

1. Paste that URL as the Request URL. Slack immediately `POST`s a `url_verification` challenge; the route echoes it back, so the URL verifies even before the signing secret is set.
2. Subscribe to the bot events you want — `message.channels` (and/or `app_mention`). The parser only acts on `message` / `app_mention` events; everything else is ignored.
3. Reinstall the app to the workspace if Slack prompts you.

### 4. Try it

Post a message in a channel the bot is in. The route dedups the event, maps it to `instanceId="slack:<team>"` / `sessionName="slack:<channel>"`, and submits a prompt. You can confirm the run by watching the request via the native query (`api.requests.get`) or `GET /runs/:runId` — see [Invoking Agents](03-invoking-agents.md). You will **not** see a reply in Slack yet (next section).

---

## The outbound-reply gap

The Slack route is **inbound only**. It maps an event onto `api.invoke.submit.submitPrompt` but never posts the run result back to Slack. Posting replies requires two pieces that are not in these files:

- A Slack **bot token** (`chat.postMessage`) to send the answer to the channel.
- A **run-completion hook** — something that watches the submitted request reach a terminal status (`completed` / `failed` / `cancelled`) and then formats and posts its `finalText`.

This is the documented P11 remainder. Until it lands, treat the Slack channel as a fire-and-forget ingress: it starts runs, and you observe results through the normal request-snapshot surfaces. If you need replies today, you can build the completion side yourself — subscribe to the request, and on terminal status call Slack's API with your bot token. The session mapping already gives you the channel: `sessionName` is `` `slack:${channel}` ``, so the channel id is recoverable.

---

## Adding another channel

A new channel mirrors Slack's two halves. There is no framework abstraction to subclass — you copy the shape.

### 1. Author a pure adapter — `src/runtime/channels/<name>.ts`

Keep it V8-safe: only Web Crypto, **no** `"use node"`, **no** Convex imports, **no** AI SDK imports. Provide the same four pieces Slack does:

```ts
// src/runtime/channels/<name>.ts  (sketch — mirror slack.ts)

// (a) A signature verifier for your provider's scheme.
export async function verifyXSignature(opts: { /* secret, timestamp, rawBody, signature, ... */ }): Promise<boolean> {
  // HMAC over the provider's canonical string, constant-time compare. Return false on replay/skew.
}

// (b) A parser returning a discriminated union with challenge / event / ignore kinds.
export type XInbound =
  | { kind: "challenge"; challenge: string }       // omit if your provider has no handshake
  | { kind: "event"; eventId: string; message: string; /* your addressing fields */ }
  | { kind: "ignore" };                            // drop bot/self/echo events to avoid loops
export function parseXPayload(payload: unknown): XInbound { /* ... */ }

// (c) A session-ref mapper — decide your (instanceId, sessionName) granularity.
export function xSessionRef(/* your scope keys */): { instanceId: string; sessionName: string } {
  return { instanceId: `x:${/*...*/}`, sessionName: `x:${/*...*/}` };
}

// (d) A provider-scoped dedup key — give it its own prefix.
export function xDedupKey(eventId: string): string {
  return `webhook:x:${eventId}`;
}
```

Design notes that carry over from Slack:

- **Always include an `ignore` arm** that drops bot/self/echo events, or you will create reply loops.
- **Choose your session granularity deliberately.** Slack uses one session per channel; you might key on a thread, a DM, or a user. Whatever tuple you pick, **never start a `sessionName` with `task:`** — that namespace is reserved for delegated subagent sessions and `submitPrompt`'s admission rejects it (see [Subagents & Workflows](06-subagents-and-workflows.md)).
- **Use a unique dedup prefix** (`webhook:<name>:`). The ledger is shared, so distinct prefixes keep channels from colliding.

### 2. Add the route — `convex/http.ts`

Register an exact-path route following the same five steps: parse → answer handshake → verify signature → `markWebhookSeen` dedup → `submitPrompt`. Reuse the shared dedup mutation with your own key.

```ts
// convex/http.ts — "Other channels follow this same shape."
http.route({
  path: "/channels/<name>",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const rawBody = await req.text();
      let payload: unknown;
      try { payload = JSON.parse(rawBody); } catch { throw new InvalidJsonError(); }

      const parsed = parseXPayload(payload);
      if (parsed.kind === "challenge") return Response.json({ challenge: parsed.challenge });

      const secret = process.env.X_SIGNING_SECRET;
      if (!secret) throw new UnauthorizedError("[cove] X signing secret not configured.");
      if (!(await verifyXSignature({ signingSecret: secret, rawBody, /* headers */ }))) {
        throw new UnauthorizedError("[cove] invalid X signature.");
      }

      if (parsed.kind === "ignore") return new Response("ok");

      const { isNew } = await ctx.runMutation(internal.channels.markWebhookSeen, {
        key: xDedupKey(parsed.eventId),
      });
      if (!isNew) return new Response("ok (duplicate)");

      const ref = xSessionRef(/* ... */);
      await ctx.runMutation(api.invoke.submit.submitPrompt, {
        prompt: parsed.message,
        instanceId: ref.instanceId,
        sessionName: ref.sessionName,
      });
      return new Response("ok");
    } catch (err) {
      const { status, body } = renderHttpError(err);
      return Response.json(body, { status });
    }
  }),
});
```

Use `path` (exact) for channel webhooks — the `/agents/`, `/runs/`, and `/workflows/` routes use `pathPrefix` because they carry path parameters; a channel webhook does not.

### 3. Test and deploy

Unit-test the pure adapter against `__tests__/` (e.g. `src/runtime/channels/__tests__/<name>.test.ts`) — the HMAC, parsing, and mapping are deterministic and need no deployment. Verify the Convex glue with `dev --once` + a real provider delivery, since Convex functions themselves cannot be unit-tested. See [Deployment & Operations](08-deployment-and-operations.md).

---

## Reference

| Export | File | Kind | Signature / shape |
| --- | --- | --- | --- |
| `verifySlackSignature` | `src/runtime/channels/slack.ts` | fn | `(opts: { signingSecret, timestamp, rawBody, signature, now?, toleranceSec? }) => Promise<boolean>` |
| `parseSlackPayload` | `src/runtime/channels/slack.ts` | fn | `(payload: unknown) => SlackInbound` |
| `SlackInbound` | `src/runtime/channels/slack.ts` | type | `{ kind: "challenge", challenge }` \| `{ kind: "event", eventId, message, channel, team, user }` \| `{ kind: "ignore" }` |
| `slackSessionRef` | `src/runtime/channels/slack.ts` | fn | `(team, channel) => { instanceId: "slack:"+team, sessionName: "slack:"+channel }` |
| `slackDedupKey` | `src/runtime/channels/slack.ts` | fn | `(eventId) => "webhook:slack:"+eventId` |
| `markWebhookSeen` | `convex/channels.ts` | internalMutation | `{ key }` → `{ isNew }` (call as `internal.channels.markWebhookSeen`) |
| `POST /channels/slack` | `convex/http.ts` | http route | inbound Slack webhook (exact `path`, method POST) |
| `submitPrompt` | `convex/invoke/submit.ts` | mutation | `api.invoke.submit.submitPrompt` — the run the channel drives |

**Env:** `SLACK_SIGNING_SECRET` (required for any non-challenge Slack request).

---

**Next:** [Deployment & Operations](08-deployment-and-operations.md) covers deploy/codegen, env vars, and the reserved test model. To revisit how the submitted run is watched, see [Invoking Agents](03-invoking-agents.md).
