# Phase G5.5 — Channel breadth — SPI generalization & new channels

> Generalize the channel SPI at the **admission boundary** — a GET-challenge handshake, form/TwiML body
> kinds with a provider-owned `Response`, inbound media refs, rich outbound formatting, per-inbound run
> options, and multi-tenant secret resolution — then ship the highest-leverage **new channels** onto it:
> WhatsApp, Twilio, one support channel + email. Every item lives in the inbound V8 `httpAction` (verify →
> mapPayload → dedup → submitPrompt → ack) and the journaled `reply.dispatch` step — **no box, no LLM, no AI
> SDK**; durable state stays on `agentRequests` in Convex. Design-of-record:
> [04 — Durable Engine](../../design/04-durable-engine.md),
> [08 — Conventions & execution boundary](../../design/08-conventions-and-execution-boundary.md) (§3 channels
> admit+reply only, §4.4 HITL, §4.8 images), [07 — Risks & decisions](../../design/07-risks-and-decisions.md)
> (D14 reuse `agentRequests`, R5 ephemeral handles).
>
> **Hard gate:** the two new chat channels (WhatsApp/Twilio) cannot be served by today's POST-only,
> JSON-only SPI, so they are **sequenced after** item A lands. flue's STORAGE adapters
> (postgres/libsql/mysql/mongodb/redis) are **explicitly NOT ported** — Convex is the store (D1, obsolete in
> [channels/index.ts:30-31](../../../convex/channels/index.ts)).

## Goal & scope

Widen the `ChannelAdapter` contract and the inbound route so non-JSON, GET-verified, media-bearing, and
multi-tenant webhooks can admit a run, then port the new adapters that need those widenings. **In scope:**
the SPI extensions (A, plus the additive contract fields in E/F/G) and the new adapters (B, C). **Out of
scope (the thesis boundary):** relocating any durable state out of Convex; touching `@convex-dev/workflow`
journal-replay determinism; importing the AI SDK or entering the `@upstash/box` sandbox at the channel layer
(channels do "no box, no LLM", [types.ts:51](../../../convex/channels/types.ts),
[inbound.ts:4](../../../convex/channels/inbound.ts)); porting flue's STORAGE adapters; and the speculative
per-channel tool **policy** (deferred — no existing foundation). Inbound media is resolved in a **durable
post-admission step**, never inline in the ack path.

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| A | the inbound route + `ChannelAdapter` contract (exist) | adds a GET branch + `bodyKind`/`Response` to the existing pipeline; no new durable state |
| B | **A landed** (GET-challenge + form/TwiML) | hard-gated: WhatsApp needs the GET branch; Twilio needs form-body + TwiML `Response` |
| B (WhatsApp media) | **D landed** (inbound media SPI) | WhatsApp media is a second authenticated GET → image block |
| C | the existing JSON+HMAC SPI (no new shape) | Intercom/Resend fit `verify`/`mapPayload`/`postReply` as-is |
| D | widening the admission path to carry image blocks | `submitPrompt prompt: v.string()` + `admitPrompt` userMessage content must accept `(Text\|Image)[]` |
| E | per-adapter formatters + the journaled `reply.dispatch` step (exists) | Phase-2 interim status is its own journaled step with an idempotency marker |
| F | `submitPrompt` already accepts `approvalTools`/`mcpServers` | add the two fields to `SubmitSpec`; MCP half is fully usable, HITL half is gated |
| G | a new Convex `channelTenants` table + a ctx-aware resolution seam | `verify(req,rawBody)` has **no ctx** — the contract or `inbound.ts` must widen |

---

## A — Generalize the SPI for GET-challenge + form/non-JSON bodies

**What.** The `/channels/:name` route is **POST-only** and `inbound.ts` does `JSON.parse(rawBody)`
unconditionally, so major channels are unservable. Two SPI extensions unblock them: (1) an optional
`adapter.challenge(req)` GET hook + a GET branch on the route for Meta-style `hub.challenge` subscription
verification; (2) let an adapter declare `bodyKind: 'json' | 'form'` so `inbound.ts` parses form-urlencoded
instead of unconditional `JSON.parse`, and allow `mapPayload`/`postReply` to return a **provider-owned
`Response`** for non-JSON replies (Twilio TwiML) and alternate signatures (Twilio HMAC-SHA1 over sorted form
fields; Slack slash-commands/interactivity). The `hmacSha256Hex`/`timingSafeEqual` dedup is a trivial
orthogonal cleanup that may ride along but is **not** load-bearing for accepting this item.

**Where.** POST-only route: [http.ts:160-178](../../../convex/http.ts) (`method: "POST"` at
[http.ts:167](../../../convex/http.ts), no GET). Unconditional parse + the only three branches:
[inbound.ts:35-39](../../../convex/channels/inbound.ts) (`JSON.parse(rawBody)` → `InvalidJsonError`),
[inbound.ts:40-42](../../../convex/channels/inbound.ts) (`handshake`/`ignore` short-circuits). The contract
to widen: [types.ts:24-28](../../../convex/channels/types.ts) (`MapResult = submit | handshake | ignore`,
no challenge/Response shape) and [types.ts:53-65](../../../convex/channels/types.ts) (`ChannelAdapter`, no
`challenge`/`bodyKind`). Form breakage today: [slack/index.ts:32-51](../../../convex/channels/slack/index.ts)
(`mapPayload` takes a pre-parsed object — breaks on form-urlencoded slash commands). Durable boundary stays
fixed: [reply.ts:1-5](../../../convex/channels/reply.ts) (journaled dispatch, `repliedAt` guard). Duplicated
helpers to optionally dedup: [github/index.ts:10-29](../../../convex/channels/github/index.ts),
[notion/index.ts:14-21](../../../convex/channels/notion/index.ts),
[linear/index.ts:12-19](../../../convex/channels/linear/index.ts),
[telegram/index.ts:11-16](../../../convex/channels/telegram/index.ts),
[src/runtime/channels/slack.ts:35-38](../../../src/runtime/channels/slack.ts). flue prior art:
[whatsapp/src/webhook.ts:15-25](../../../../flue/packages/whatsapp/src/webhook.ts) (GET `hub.challenge`),
[twilio/src/webhook.ts:210-215](../../../../flue/packages/twilio/src/webhook.ts) (`isFormRequest` 415 gate),
[twilio/src/webhook.ts:244,258-261](../../../../flue/packages/twilio/src/webhook.ts) (HMAC-SHA1 over sorted
field names+values), [twilio/src/webhook.ts:11,334-337](../../../../flue/packages/twilio/src/webhook.ts)
(`EMPTY_TWIML` + the `Response`-returning `serializeHandlerResult`).

**Why native / why it fits.** The change lives **entirely** at the inbound V8 `httpAction` admission boundary
and in the `ChannelAdapter` contract. Runs still admit via `api.invoke.submit.submitPrompt` into
`agentRequests`; replies still fire from the journaled `step.runAction` in
[reply.ts:1-5](../../../convex/channels/reply.ts) with the `repliedAt` replay guard. It touches no
journal-replay determinism, adds no competing loop/durability engine, and never involves the AI SDK or the box
(the inbound route has no `"use node"`, no LLM). A GET `challenge` hook and a `bodyKind`/custom-`Response`
option only widen **how a webhook is parsed/answered before admission** — fully inside the existing
Convex-native pipeline.

**Effort** M + **Risk** med — touches the shared route + contract (every adapter's blast radius), and the
`Response`-returning path must not break the existing JSON ack for the eight shipped adapters; the GET branch
itself is low-risk.

**Acceptance.** A GET `/channels/whatsapp?hub.mode=subscribe&hub.challenge=X&hub.verify_token=…` with a valid
token returns `X` as `text/plain` (no admission); an adapter with `bodyKind:'form'` receives a parsed
`URLSearchParams`/record (not a thrown `InvalidJsonError`) and an adapter returning a `Response` from
`mapPayload`/`postReply` posts that exact body (TwiML XML); the eight existing JSON adapters are byte-for-byte
unchanged; dedup/admission/ack ordering is preserved.

---

## B — Add WhatsApp + Twilio channels (highest-reach consumer surfaces)

**What.** Two unbuilt adapters on the generalized SPI: **WhatsApp** (Meta Cloud API — GET `hub.challenge`
verify + `x-hub-signature-256` HMAC-SHA256, identical in shape to the shipped GitHub adapter) and **Twilio**
(SMS/voice — form-encoded inbound, sorted-field HMAC-SHA1, TwiML XML reply, `MessageSid` dedup). Both are
listed TBD and **not registered**.

**Where.** TBD markers: [channels/index.ts:29](../../../convex/channels/index.ts)
(`TBD (not yet scoped): messenger, whatsapp, twilio, …`); the registry of 8 shipped adapters:
[channels/index.ts:16-25](../../../convex/channels/index.ts). The SPI gaps that block them today:
[http.ts:167](../../../convex/http.ts) (`method:"POST"` only — WhatsApp verify is a GET returning
`hub.challenge` as `text/plain`); [inbound.ts:35-39](../../../convex/channels/inbound.ts) (unconditional
`JSON.parse` — Twilio sends form-urlencoded); [types.ts:24-28](../../../convex/channels/types.ts) (`MapResult`
lacks any XML/TwiML or plain-text-challenge return shape). The shipped HMAC-SHA256 reference WhatsApp mirrors:
[github/index.ts:17-43](../../../convex/channels/github/index.ts). The test that only exercises POST/JSON:
[__tests__/inbound.test.ts:48-50](../../../convex/channels/__tests__/inbound.test.ts). flue ports:
[whatsapp/src/webhook.ts:13-29](../../../../flue/packages/whatsapp/src/webhook.ts) (GET `hub.challenge`),
[whatsapp/src/webhook.ts:43-52](../../../../flue/packages/whatsapp/src/webhook.ts) (`x-hub-signature-256`),
[twilio/src/webhook.ts:11](../../../../flue/packages/twilio/src/webhook.ts) (`EMPTY_TWIML`),
[twilio/src/webhook.ts:244](../../../../flue/packages/twilio/src/webhook.ts) (HMAC-SHA1),
[twilio/src/webhook.ts:258-261](../../../../flue/packages/twilio/src/webhook.ts) (sorted field names+values).
A `grep` for `media|attachment|download` over `convex/channels` returns **nothing** — the WhatsApp **media**
SPI is confirmed absent (depends on D).

**Why native / why it fits.** Both are pure `ChannelAdapter` implementations of the existing
verify/mapPayload/postReply contract. They run inline in the V8 inbound `httpAction` doing only signature
verification + payload mapping + admission via the existing `submitPrompt` mutation
([inbound.ts:51-57](../../../convex/channels/inbound.ts)) — no box, no LLM, no AI SDK. Durable state stays in
Convex (`agentRequests` row + `replyContext`), journal replay is untouched (channels admit/reply only, never
drive the loop), no competing durability engine. The signature verification is the same shape as the shipped
GitHub adapter and uses Web Crypto (V8-safe); the Teams adapter's per-process JWKS cache
([teams/auth.ts:15](../../../convex/channels/teams/auth.ts)) precedents modest per-process caching within
thesis bounds. **HARD PREREQUISITE:** sequence after A — the current SPI cannot serve either channel.
WhatsApp **media** (a second authenticated GET) further depends on D; ship WhatsApp **text** first, media when
D lands.

**Effort** M + **Risk** med — pure-adapter work once A is in, but Twilio's sorted-field HMAC-SHA1 and the
TwiML `Response` are easy to get subtly wrong; the dedup id (`MessageSid`) must be the form field, not a
re-parsed body.

**Acceptance.** A WhatsApp GET verification round-trips `hub.challenge`; an inbound WhatsApp message with a
valid `x-hub-signature-256` admits a run and replies via the Cloud API; a Twilio form-urlencoded `POST` with
a valid sorted-field HMAC-SHA1 admits and replies with valid TwiML XML; a replayed delivery (same
`MessageSid`/WhatsApp message id) is a dedup no-op; both adapters are registered in `channelRegistry` and pass
adapter tests; neither imports the AI SDK or enters the box.

---

## C — Add a support channel + email (Intercom, then Resend)

**What.** Support-automation and email channels that fit the existing JSON+HMAC SPI **with no new shape**.
Ship **one at a time**: **Intercom** first (conversation/ticket webhooks; HMAC-SHA1 over the raw body via
`x-hub-signature`; reply via the Intercom API), then **Resend** as a **separate** item (inbound email;
svix-style HMAC-SHA256 over `{id}.{timestamp}.{body}`; `postReply` sends an email). Do **not** bundle three
providers into one effort.

**Where.** Registry + deferred comment: [channels/index.ts:16-31](../../../convex/channels/index.ts)
(`Deferred …: intercom, resend, …, zendesk`). The fixed contract they map to:
[types.ts:1-65](../../../convex/channels/types.ts) (verify/mapPayload/postReply, no box/LLM; D14 reuses
`agentRequests`). The shared admit pipeline: [inbound.ts:14-58](../../../convex/channels/inbound.ts). The
journaled reply with the `repliedAt` guard: [reply.ts:38-60](../../../convex/channels/reply.ts). A
representative adapter shape (Web Crypto, no `"use node"`):
[slack/index.ts:1-71](../../../convex/channels/slack/index.ts). The generic route that resolves from the
registry: [http.ts:160-170](../../../convex/http.ts). flue prior art:
[intercom/src/webhook.ts:24-40](../../../../flue/packages/intercom/src/webhook.ts) (HMAC-SHA1,
`x-hub-signature`, Web Crypto), [zendesk/src/webhook.ts](../../../../flue/packages/zendesk/src/webhook.ts)
(HMAC over timestamp+body — a third item if wanted),
[resend/src/webhook.ts:22-44](../../../../flue/packages/resend/src/webhook.ts) (`svix-id`/`timestamp`/
`signature`, the **official `client.webhooks.verify`** svix-lib path — **reimplement** with Web Crypto, see
below), [examples/intercom-channel](../../../../flue/examples/intercom-channel) (a full worked example).

**Why native / why it fits.** Channels are admit+reply only — verify(raw bytes) → runAuthorize → dedup →
submitPrompt ([inbound.ts:20-58](../../../convex/channels/inbound.ts)); reply fires from the journaled
`step.runAction` after the run terminalizes, with the `repliedAt` replay double-post guard
([reply.ts:44](../../../convex/channels/reply.ts)). Durable state stays on `agentRequests` with a frozen
`replyContext`; no new inbound table (D14). The AI SDK is never imported here, and there is no competing loop.
**Re-scope note:** flue's Resend ports the official svix **library** path, which would force a `"use node"`
import the inbound route forbids ([inbound.ts:4](../../../convex/channels/inbound.ts)) — reimplement
svix verification with Web Crypto so it honors the "no use node" inbound constraint. Each item is one adapter
file + one `channelRegistry` entry + one dedup `eventId` mapping (Intercom delivery id / Zendesk
`X-Zendesk-Webhook-Invocation-Id` / Resend `svix-id`) + adapter tests. No route or schema changes.

**Effort** M (per provider) + **Risk** low — mechanical against a fixed contract; the only real care is
reimplementing svix verification with Web Crypto rather than the node svix lib.

**Acceptance.** An Intercom webhook with a valid `x-hub-signature` HMAC-SHA1 admits a run and replies via the
Intercom API; a duplicate delivery (same delivery id) is a no-op; a Resend inbound-email event verifies via a
**Web-Crypto** svix check (no `"use node"`) and `postReply` sends an email; both register in the registry and
pass adapter tests; no route/schema change is required.

---

## D — Inbound channel media / attachment handling (image content blocks)

**What.** All eight adapters extract a **text string only**; inbound images/files (Slack files, Telegram
photo/document) are dropped, so vision-capable agents never see shared images even though the engine already
carries an image content block. Add an **optional media-resolution step** to the SPI: `mapPayload` may emit
media refs (url + auth hint + mimeType), then a **durable post-admission action** (`"use node"`/`fetch`)
downloads them, uploads to Convex `_storage`, and rewrites the admitted user message content from `string` to
`(Text | Image)[]`.

**Where.** Text-only extraction + the sync contract: [types.ts:31-39](../../../convex/channels/types.ts)
(`SubmitSpec.message: string`), [types.ts:62](../../../convex/channels/types.ts) (`mapPayload` is sync, inline
in the V8 httpAction). The inbound route forbids network/use-node:
[inbound.ts:4](../../../convex/channels/inbound.ts). The text-only sites:
[slack/index.ts:33](../../../convex/channels/slack/index.ts),
[telegram/index.ts:40-41](../../../convex/channels/telegram/index.ts). The real channels: only Slack/Telegram
ship today; WhatsApp/Twilio are TBD ([channels/index.ts:29](../../../convex/channels/index.ts)) — **drop them
from this item's scope**. String-only admission to widen:
[submit.ts:17-18](../../../convex/invoke/submit.ts) (`prompt: v.string()`),
[admit.ts:135](../../../convex/invoke/admit.ts) (`userMessage.content = args.prompt`). The existing image
content block + spill infra to reuse: [engine/types.ts:39-44](../../../convex/engine/types.ts)
(`EngineToolContentImage`), [src/runtime/messages.ts:40-44](../../../src/runtime/messages.ts) (`ImageContent`),
[sessions/images.ts:1-30](../../../convex/sessions/images.ts) (content-addressed spill to `_storage`).
**Provenance:** flue channels were ALSO text-only (no flue adapter builds image blocks; Twilio only documents
`MediaUrl0` as a passthrough) — this is a **net-new build, not a port**.

**Why native / why it fits.** Downloading via an authenticated GET, uploading to Convex `_storage`, and
injecting an image block fits the model (durable workflow/action step, Convex owns state, AI SDK untouched).
**The replay trap the candidate flags:** do **not** do the second authenticated GET + upload inline in
`mapPayload`/the inbound `httpAction` — that route is explicitly "No box, no LLM, no 'use node'"
([inbound.ts:4](../../../convex/channels/inbound.ts)) and `mapPayload` runs inline
([types.ts:62](../../../convex/channels/types.ts)); an inline download adds latency/failure to the ~3s ack
path. Resolve media in a **durable step AFTER admission** that downloads, stores in `_storage`, and rewrites
the user message — no durable state leaves Convex and replay determinism is preserved. **Real prerequisite:**
widening the admission path ([submit.ts:17-18](../../../convex/invoke/submit.ts),
[admit.ts:135](../../../convex/invoke/admit.ts)) to carry image blocks — more than the image-spill infra,
which already exists.

**Effort** L + **Risk** med — widens the admission content type (`string` → `(Text | Image)[]`) across
`submitPrompt`/`admitPrompt`/the canonical entry, and adds a new durable download/upload step; the
authenticated second-GET (WhatsApp media id) must live in the post-admission action, never the ack path.

**Acceptance.** A Slack/Telegram message with an attached image admits a text run, then a durable
post-admission action downloads the image, stores it in `_storage` via the content-addressed spill, and
rewrites the user message content to `(Text | Image)[]`; the inbound ack path performs **no** network download
(returns within the ack window); the rewritten message survives a mid-loop replay (reconstructed from the
persisted row, identical to the live write); no image is downloaded inline in `mapPayload`.

---

## E — Rich channel outbound (Slack Block Kit, Discord embeds, Teams cards) + optional interim status

**What.** Every `postReply` renders only a plain-text reply via the shared `replyText`; no Slack Block Kit,
Teams Adaptive Cards, Discord embeds, no in-progress "thinking" indicator. Add per-adapter rich formatting
(additive), and — gated/deferred — an optional interim status post, **out-of-band** of the ~3s ack window.

**Where.** Single plain-text renderer: [format.ts:5-9](../../../convex/channels/format.ts) (`replyText`). The
contract with no rich/interim fields: [types.ts:11-22,42-47](../../../convex/channels/types.ts)
(`ReplyContext`/`TerminalResult`). Plain-text `postReply` bodies:
[slack/index.ts:53-70](../../../convex/channels/slack/index.ts),
[discord/index.ts:104-123](../../../convex/channels/discord/index.ts),
[teams/index.ts:49-59](../../../convex/channels/teams/index.ts). The terminal-only, exactly-once reply step:
[reply.ts:38-60](../../../convex/channels/reply.ts) (`repliedAt` guard at
[reply.ts:44](../../../convex/channels/reply.ts)); dispatched as a journaled `step.runAction` post-terminalize
at [runHandler.ts:106](../../../convex/engine/runHandler.ts). The route admits+acks; run+reply happen
elsewhere: [inbound.ts:1-5](../../../convex/channels/inbound.ts). The schema fields that exist:
[schema.ts:197-227](../../../convex/schema.ts) (`replyContext`/`repliedAt`/`finalText`).
**Provenance:** flue's adaptive-card code was inbound parsing — flue outbound was plain text, so this is no
regression.

**Why native / why it fits.** The reply is dispatched at [runHandler.ts:106](../../../convex/engine/runHandler.ts)
via `step.runAction(internal.channels.reply.dispatch)` — a **journaled** durable step that fires only after
the run terminalizes, guarded by `repliedAt` for exactly-once on replay. Adding per-adapter rich rendering
changes only the body JSON each adapter POSTs inside that same already-durable step; it relocates no state out
of Convex, adds no competing loop, and never touches the AI-SDK boundary (channels do "no box, no LLM").
**Phase 1 (clear win, low risk):** per-adapter formatters for the SINGLE terminal reply (Slack Block Kit /
Discord embeds / Teams Adaptive Card) alongside the `replyText()` fallback. Scope rich formatting to the three
chat surfaces where it adds value; keep Telegram/Google-Chat/comment-based channels (notion/linear/github) on
`replyText`. **Phase 2 (optional, gated, defer):** an interim "working…" post — it MUST be its own journaled
`step.runAction` with its own idempotency marker on `agentRequests` (mirroring `repliedAt`) so a workflow
replay cannot re-post it, and it must NOT block or extend the inbound ~3s ack.

**Effort** M + **Risk** low (Phase 1) — additive body rendering inside the existing durable step; Phase 2 is
the only part that needs a new replay-idempotent marker.

**Acceptance.** A completed Slack run posts a Block Kit body (Discord an embed, Teams an Adaptive Card) via the
existing `reply.dispatch` step; an adapter with no formatter falls back to `replyText` unchanged; the reply is
still posted exactly once across a workflow replay (the `repliedAt` guard holds); (Phase 2, if shipped) an
interim status post is a journaled step with its own marker and is NOT re-emitted on replay and does NOT
extend the ack.

---

## F — Thread `approvalTools` / `mcpServers` through channel inbound

**What.** The shared inbound pipeline calls `submitPrompt` with only `prompt`/`instanceId`/`sessionName`/
`model`/`replyContext`; it never threads `approvalTools` or `mcpServers` even though `submitPrompt` accepts
both — so a channel-originated run can never attach declared MCP servers nor HITL-gate a tool. Add the two
fields to `SubmitSpec` and thread them through.

**Where.** `submitPrompt` already accepts both: [submit.ts:26-27](../../../convex/invoke/submit.ts) (args),
[submit.ts:40-41](../../../convex/invoke/submit.ts) (forwarded to `admitPrompt`);
[admit.ts:90-93,128-129](../../../convex/invoke/admit.ts) (frozen on the row). The inbound call that **omits**
them: [inbound.ts:51-57](../../../convex/channels/inbound.ts). The `SubmitSpec` lacking the fields:
[types.ts:31-39](../../../convex/channels/types.ts). A representative `mapPayload` to populate them:
[slack/index.ts:32-51](../../../convex/channels/slack/index.ts). Downstream consumers (MCP is fully wired):
[setup.ts:339](../../../convex/engine/setup.ts) (`approvalTools` frozen), [mcp/discover.ts:20-26](../../../convex/mcp/discover.ts)
+ [requests.ts:70-74](../../../convex/engine/requests.ts) (MCP discovered + frozen),
[llmStep.ts:62](../../../convex/engine/llmStep.ts) (`hitlToolNames`),
[runHandler.ts:18-22](../../../convex/engine/runHandler.ts) (MCP gate). **The HITL gap:** there is no
channel-inbound path to RESOLVE an approval — `submitApproval`
([approvals.ts:113](../../../convex/engine/approvals.ts)) is a Convex mutation answered via the approval-card
UI/`listPending` ([approvals.ts:96](../../../convex/engine/approvals.ts)), not via a channel webhook, so a
channel-gated tool parks on an approval a Slack/Discord user cannot answer in-channel.

**Why native / why it fits.** Purely additive plumbing: two optional fields on the `SubmitSpec`/`mapPayload`
contract, forwarded into the existing `submitPrompt` mutation. Durable state stays on `agentRequests`, journal
replay is unaffected (`admitPrompt` already reads these fields deterministically), no competing loop, AI-SDK
boundary untouched. **Scope:** the **MCP** half is fully usable from channels with zero downstream gap (the
high-value part — ship it). **Scope down the HITL half:** either (a) ship MCP threading first and **defer**
`approvalTools` until a channel-side approve/reject affordance exists, or (b) explicitly accept that
channel-originated HITL is resolvable only out-of-band via the UI/API. **DROP** the speculative per-channel
**policy** — no existing foundation (flat `channelRegistry` at
[channels/index.ts:16](../../../convex/channels/index.ts), no policy concept anywhere); it is a separate,
larger design and a follow-up, not part of this S-effort plumbing.

**Effort** S + **Risk** low — two optional fields + forwarding; no flow or durability change.

**Acceptance.** A channel `mapPayload` that sets `mcpServers` produces a run whose plan freezes those servers'
tools (verified via `getMcpServers`/setup); the two fields default to absent for adapters that don't set them
(existing adapters unchanged); the threading is replay-stable (folds from the frozen `agentRequests` row); if
`approvalTools` is threaded, the docs state plainly that resolution is UI/API-only until a channel-side
affordance exists.

---

## G — Per-tenant channel secret resolution (Convex-table-backed)

**What.** Channel secrets/tokens are single-tenant `process.env` globals (one Slack app, one bot token), and
the Teams/Google-Chat JWKS caches are module-scoped per-process. For multi-workspace/multi-tenant
deployments, move secret resolution to a Convex-table lookup keyed by team/workspace id derived from the
payload — durable, per-tenant, replay-safe.

**Where.** `verify` has **no ctx**: [types.ts:57](../../../convex/channels/types.ts)
(`verify(req, rawBody)`). The adapter call site that holds ctx but passes only `req,rawBody`:
[inbound.ts:28](../../../convex/channels/inbound.ts) (`adapter.verify(req, rawBody)` inside `verifyThenAdmit`,
which holds `ctx`). Adapters are **static module-level singletons**:
[channels/index.ts:16](../../../convex/channels/index.ts) (`channelRegistry`). Per-adapter env reads:
[slack/index.ts:19,63](../../../convex/channels/slack/index.ts). Per-process JWKS caches keyed by a single
module global: [teams/auth.ts:15,29-37](../../../convex/channels/teams/auth.ts),
[googlechat/auth.ts:33-34,46](../../../convex/channels/googlechat/auth.ts). The route segment that yields the
channel name: [http.ts:165-177](../../../convex/http.ts). No secrets/tenant table exists in
[schema.ts](../../../convex/schema.ts).

**Why native / why it fits.** Moving secret resolution from `process.env` to a Convex-table lookup moves
durable state **INTO** Convex (the durability owner) — the opposite of relocating it out. It does not touch
`@convex-dev/workflow`, journal replay, or the AI-SDK boundary. `verify()` runs inline in the V8 `httpAction`
([inbound.ts:28](../../../convex/channels/inbound.ts)) **before** admission/workflow, so the non-deterministic
JWKS network fetch stays entirely outside the replayed journal path — no determinism risk.
**CRITICAL re-scope:** the candidate's claim that "the existing `verify(req,rawBody)` signature already
accommodates this" is **FALSE** — `verify(req,rawBody)` ([types.ts:57](../../../convex/channels/types.ts))
receives **no ctx**, and adapters are static singletons
([channels/index.ts:16](../../../convex/channels/index.ts)), so they cannot run a `ctx.db` lookup. The work
therefore requires either (a) widening the `ChannelAdapter` contract to pass `ctx` into `verify`, or (b)
hoisting per-tenant secret/key resolution into `verifyThenAdmit` (which holds `ctx`,
[inbound.ts:14-28](../../../convex/channels/inbound.ts)) and threading the resolved config into
`verify`/`mapPayload`/`postReply`. Per-tenant JWKS caching should key the existing in-isolate cache by tenant,
not a single module global. Forward-looking multi-tenant capability, **not** a bug fix.

**Effort** M + **Risk** med — widens the contract or the inbound seam (every adapter's blast radius); a wrong
tenant key derivation is a cross-tenant secret leak, so the payload→tenant mapping must be verified before any
secret is read.

**Acceptance.** A new `channelTenants` Convex table keyed by `provider + workspace/team id` resolves the
per-tenant signing secret / bot token / appId / project number from the payload; two Slack workspaces with
distinct secrets each verify against their own row (no `process.env` fallback when a row exists); the JWKS
cache is keyed by tenant (no cross-tenant key reuse); resolution runs inline before admission and adds nothing
to the replayed journal; existing single-tenant `process.env` deployments still work when no row exists.

---

## Risks & gotchas (cross-item)

- **A — the `Response`-returning path must not break the JSON ack.** The eight shipped adapters return
  handshake/ignore/submit and rely on `inbound.ts` posting the ack `Response`. A `bodyKind:'form'` parse and a
  provider-owned `Response` from `mapPayload`/`postReply` are the only new shapes; the existing JSON branch
  ([inbound.ts:40-58](../../../convex/channels/inbound.ts)) must stay byte-for-byte. The GET `challenge`
  branch must short-circuit **before** dedup/admission (it spawns no run).
- **B — Twilio sorted-field HMAC-SHA1 + the dedup id.** Verify over `url + Σ(sorted field name+value)`
  ([twilio/src/webhook.ts:258-261](../../../../flue/packages/twilio/src/webhook.ts)), not the raw body; the
  dedup `eventId` is the `MessageSid` form field. Sequence B strictly after A — neither channel is servable on
  the POST-only/JSON-only SPI.
- **D — never download inline in the ack path.** `mapPayload` runs inline in the V8 `httpAction`
  ([inbound.ts:4](../../../convex/channels/inbound.ts)); the second authenticated GET + `_storage` upload must
  live in a **durable post-admission action**, and the admission content type must widen
  (`string` → `(Text | Image)[]`) across [submit.ts:17-18](../../../convex/invoke/submit.ts) /
  [admit.ts:135](../../../convex/invoke/admit.ts) for the image block to survive replay.
- **E — the interim status post must be replay-idempotent.** A mid-run status post (Phase 2) must be its own
  journaled `step.runAction` with its own marker on `agentRequests` (mirroring `repliedAt`,
  [reply.ts:44](../../../convex/channels/reply.ts)); otherwise a workflow replay re-emits duplicate interim
  messages. Phase-1 rich formatting rides the existing exactly-once `reply.dispatch` and is safe.
- **F — channel HITL has no in-channel resolution.** `submitApproval`
  ([approvals.ts:113](../../../convex/engine/approvals.ts)) is answered via the UI/`listPending`, not a
  webhook; a channel-gated tool parks where the channel user cannot answer. Ship MCP threading first; gate or
  document the HITL half.
- **G — `verify` has no ctx; tenant key derivation is security-critical.** Do not assume the current
  `verify(req,rawBody)` signature ([types.ts:57](../../../convex/channels/types.ts)) can do a `ctx.db` lookup —
  widen the contract or resolve in `verifyThenAdmit`. A wrong payload→tenant mapping leaks another tenant's
  secret; verify the mapping before reading any secret.
- **Cross-cutting — the thesis boundary holds for every item.** No item imports the AI SDK or enters the box at
  the channel layer ([types.ts:51](../../../convex/channels/types.ts),
  [inbound.ts:4](../../../convex/channels/inbound.ts)); durable state stays on `agentRequests` (D14, no new
  inbound table); replies stay on the journaled `reply.dispatch` step
  ([runHandler.ts:106](../../../convex/engine/runHandler.ts)). flue STORAGE adapters are **not** ported — Convex
  is the store.
