# Phase G4.7 — Channels, workflows & scheduler

> Group-4 (Convex → AWS) migration plan. Sibling phases:
> [G4.1 foundation](phase-g4.1-foundation-cdk-dynamodb.md) ·
> [G4.2 compute](phase-g4.2-compute-lambda-actions.md) ·
> [G4.3 orchestrator](phase-g4.3-durable-orchestrator-stepfunctions.md) ·
> [G4.4 HITL](phase-g4.4-hitl-task-tokens.md) ·
> [G4.5 ingress](phase-g4.5-ingress-apigw-auth.md) ·
> [G4.6 reactive](phase-g4.6-reactive-websocket-streaming.md) ·
> [G4.8 tests/parity/cutover](phase-g4.8-tests-parity-cutover.md)

## Goal & scope

This phase ports the **edge surfaces** that bracket a run — everything that admits a run from
an external system and everything that talks back to one — plus the two remaining orchestration
entry points (workflow invoke, MCP discovery) and the single scheduler call. None of it is the
loop; all of it touches the loop's boundaries.

In scope:

1. **Inbound channel webhooks (8 adapters)** — the generic `POST /channels/{name}` route
   ([`convex/http.ts:165-179`](../../../convex/http.ts)) and the shared
   `authorize → verify → mapPayload → dedup → submit → ack` pipeline
   ([`convex/channels/inbound.ts`](../../../convex/channels/inbound.ts)) become **one
   `inboundChannel` Lambda** behind API Gateway with **raw-byte fidelity**. The verify cores
   (Web Crypto HMAC / Ed25519, jose JWT) and the `channelRegistry` move **verbatim**.
2. **Webhook dedup** — `markWebhookSeen` ([`convex/channels/dedup.ts`](../../../convex/channels/dedup.ts))
   over the `meta` `by_key` index becomes a **conditional Put + TTL** on the **Meta** table,
   run BEFORE `StartExecution`.
3. **Outbound reply** — the post-finalize journaled `reply.dispatch`
   ([`convex/channels/reply.ts`](../../../convex/channels/reply.ts)) becomes the **terminal Reply
   SFN Task → reply Lambda**, with the `repliedAt` exactly-once guard hardened to a conditional
   UpdateItem.
4. **`workflow.invoke` (`kind:"workflow"`)** — `admitWorkflow`
   ([`convex/invoke/admit.ts:225-252`](../../../convex/invoke/admit.ts)) → a **named
   `StartExecution`** on the SAME `AgentLoop` machine carrying `{kind:'workflow', target:name}`.
   No parallel state machine, no parallel table (D18 preserved).
5. **MCP discovery hop** — the pre-setup `"use node"` discovery action
   ([`convex/mcp/discover.ts`](../../../convex/mcp/discover.ts)) + the per-process pool
   ([`convex/mcp/pool.ts`](../../../convex/mcp/pool.ts)) become the **`mcpDiscover` Lambda**
   (a pre-Setup Task) + a **module-level pool in the warm `dispatchTools` container**.
6. **Scheduler** — the ONLY `ctx.scheduler` use
   ([`convex/invoke/admit.ts:204`](../../../convex/invoke/admit.ts), `runAfter(0, compact)`)
   becomes an **async Lambda Invoke** (`InvocationType=Event`). No crons exist in the tree, so
   **no EventBridge Scheduler rule is required at cutover**; future delays/recurring jobs are the
   forward-looking EventBridge story.

Explicitly NOT in this phase (owned elsewhere): the REST API resource declarations + the
closed-by-default authorizer ([G4.5](phase-g4.5-ingress-apigw-auth.md)); the `AgentLoop` state
machine itself, `StartExecution`/`StopExecution` plumbing and the Reply *state wiring*
([G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)); the `mcpDiscover`/`dispatchTools`/`compact`
Lambda *bodies* ([G4.2](phase-g4.2-compute-lambda-actions.md)); the store/ adapter + Meta table DDL
([G4.1](phase-g4.1-foundation-cdk-dynamodb.md)). This phase owns the **channels-stack** CDK
construct, the `inboundChannel`/`reply` handlers, the dedup/repliedAt store helpers, and the
behavioral re-shapes that wire those pieces to the loop.

## Dependencies

| Needs | From | Why |
| --- | --- | --- |
| **Meta** table (`PK=<key>, SK=META`, TTL attribute) + `metaStore.markWebhookSeen` | [G4.1](phase-g4.1-foundation-cdk-dynamodb.md) | dedup ledger (conditional Put + TTL) |
| **Requests** table + `requestStore` (`replyContext`, `repliedAt`, terminal projection) | [G4.1](phase-g4.1-foundation-cdk-dynamodb.md) | reply reads the frozen `replyContext`; `repliedAt` guard |
| **S3 bucket** + presigned-URL hydrate | [G4.1](phase-g4.1-foundation-cdk-dynamodb.md) | mcpDiscover roster spill (descriptor set can exceed 256 KB) |
| `AgentLoop` state machine ARN + the **Reply** terminal state + `mcpDiscover`/`McpDiscoverChoice` states | [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md) | the Reply Task target; `StartExecution` for inbound/workflow; the discovery Task slot |
| `reply` / `mcpDiscover` Lambda bodies (portable `postReply` / `discoverMcpDescriptors`) | [G4.2](phase-g4.2-compute-lambda-actions.md) | this phase wires them as Tasks; G4.2 owns esbuild bundling |
| `dispatchTools` warm-container MCP pool | [G4.2](phase-g4.2-compute-lambda-actions.md) | the per-beat resolver (`closeAll()` in `finally`) |
| REST API + Lambda proxy integration (no body transform) + authorizer | [G4.5](phase-g4.5-ingress-apigw-auth.md) | `POST /channels/{name}` resource; authorizer gates the framework only |

This phase is on the critical path's tail: **G4.1 → G4.2 → G4.3 → G4.7**. It runs in parallel with
[G4.4](phase-g4.4-hitl-task-tokens.md) (both branch off the orchestrator).

## Deliverables

- `backend/cdk/stacks/channels-stack.ts` — the CDK construct: `POST /channels/{name}` route +
  Lambda proxy integration (no body transform, binary media types passthrough), the
  `inboundChannel` Lambda, Secrets Manager / SSM wiring for the 17 channel env vars, and the
  IAM grants (DDB Meta conditional-Put, `states:StartExecution` on `AgentLoop`).
- `backend/handlers/channels/inboundChannel.ts` — the one Lambda body: raw-bytes read →
  `runAuthorize` (framework gate is the authorizer; this is the residual hook) → `adapter.verify`
  → `mapPayload` handshake/ignore short-circuit → `metaStore.markWebhookSeen` →
  `StartExecution(name=submissionId)` → ack.
- `backend/handlers/tasks/reply.ts` — the terminal Reply Task body: conditional-UpdateItem
  `repliedAt` BEFORE the external post → `adapter.postReply`.
- `backend/handlers/tasks/mcpDiscover.ts` — the pre-Setup discovery Task body (network-only, no box).
- `backend/store/metaStore.ts` (`markWebhookSeen`) + `backend/store/requestStore.ts`
  (`getForReply`, `stampReplied`) helpers (this phase's slice).
- `backend/channels/` — the moved-verbatim `channelRegistry`, `types.ts`, `dedup.ts` (dedupKey
  helper only; the mutation is replaced), and all 8 adapters' `verify`/`mapPayload`/`postReply`.
- `backend/handlers/tasks/scheduleCompact.ts` / `compactKickoff` — the `runAfter(0)` replacement
  (async `lambda:InvokeFunction` of the compact Lambda, `InvocationType=Event`).
- CDK wiring of the **Reply** Task and the **mcpDiscover** Task into the G4.3 state machine
  (this phase contributes the Task definitions; G4.3 owns the ASL topology).

## Source map

The convex/* files this phase replaces → the new AWS files it creates.

| Convex surface (replaced) | New AWS artifact (this phase) |
| --- | --- |
| [`convex/http.ts:165-179`](../../../convex/http.ts) — generic `POST /channels/:name` `httpAction` (resolve adapter, 404 on unknown) | `channels-stack.ts` `POST /channels/{name}` Lambda-proxy resource → `backend/handlers/channels/inboundChannel.ts`; unknown channel → 404 inside the handler |
| [`convex/channels/inbound.ts`](../../../convex/channels/inbound.ts) — `verifyThenAdmit` pipeline (raw bytes → authorize → verify → mapPayload → dedup → submit → ack) | `inboundChannel.ts` handler body, same step order over `event.body` (base64-decoded if `isBase64Encoded`) |
| [`convex/channels/dedup.ts:15-26`](../../../convex/channels/dedup.ts) — `markWebhookSeen` (`meta.by_key` unique-then-insert) | `backend/store/metaStore.ts:markWebhookSeen` — conditional Put `attribute_not_exists(PK)` on **Meta** + TTL; `dedupKey` helper moves verbatim |
| [`convex/channels/reply.ts:38-60`](../../../convex/channels/reply.ts) — `dispatch` `internalAction` (post-finalize reply) | `backend/handlers/tasks/reply.ts` — the terminal **Reply** SFN Task body (`adapter.postReply`) |
| [`convex/channels/reply.ts:15-29`](../../../convex/channels/reply.ts) — `getForReply` `internalQuery` | `requestStore.getForReply(requestId)` — GetItem `PK=REQ#<requestId>, SK=META` projecting `status, replyContext, repliedAt, finalText, result, error` |
| [`convex/channels/reply.ts:31-36`](../../../convex/channels/reply.ts) — `markReplied` (`ctx.db.patch repliedAt`) | `requestStore.stampReplied` — conditional `UpdateItem SET repliedAt IF attribute_not_exists(repliedAt)` (the exactly-once guard, hardened) |
| [`convex/channels/types.ts`](../../../convex/channels/types.ts) — `ChannelAdapter`/`ReplyContext`/`MapResult`/`SubmitSpec`/`TerminalResult` | `backend/channels/types.ts` — moved **verbatim** (pure types, no Convex import) |
| [`convex/channels/index.ts`](../../../convex/channels/index.ts) — `channelRegistry` (8 adapters) | `backend/channels/index.ts` — moved verbatim; resolved in-process by `inboundChannel`/`reply` |
| `convex/channels/{slack,discord,github,telegram,teams,googlechat,linear,notion}/` — verify/mapPayload/postReply | `backend/channels/<name>/` — moved verbatim (Web Crypto HMAC/Ed25519 + jose JWT all run on Node 20) |
| [`convex/invoke/admit.ts:225-252`](../../../convex/invoke/admit.ts) — `admitWorkflow` (`kind:"workflow"` row + `workflow.start`) | `StartExecution(name=submissionId)` on `AgentLoop` with input `{kind:'workflow', target:name, requestId}`; (admit row write owned by [G4.5](phase-g4.5-ingress-apigw-auth.md) `submitWorkflow.ts`) |
| [`convex/workflowRegistry.ts`](../../../convex/workflowRegistry.ts) — `defineWorkflow`/`defineWorkflowRegistry`/`getRegisteredWorkflow` | moved verbatim; the 404-on-unknown resolution is in `submitWorkflow.ts` ([G4.5](phase-g4.5-ingress-apigw-auth.md)) — this phase only confirms the SFN-execution mapping |
| [`convex/mcp/discover.ts:19-27`](../../../convex/mcp/discover.ts) — `run` `internalAction` (discovery hop) | `backend/handlers/tasks/mcpDiscover.ts` — pre-Setup SFN Task; freezes `McpToolDescriptor[]` to DynamoDB (S3 spill if >256 KB) |
| [`convex/mcp/discover.ts:30-61`](../../../convex/mcp/discover.ts) — `discoverMcpDescriptors` (pure) | moved verbatim to `backend/engine/mcp/discover.ts` (the algo; the `connectMcpServer` SDK boundary moves with it) |
| [`convex/mcp/pool.ts`](../../../convex/mcp/pool.ts) — per-process pool + `resolveMcpTool` + `closeAll` | `backend/engine/mcp/pool.ts` — module-level `Map` in the warm `dispatchTools` container; `closeAll()` in the handler `finally` (body in [G4.2](phase-g4.2-compute-lambda-actions.md)) |
| [`convex/engine/runHandler.ts:17-24`](../../../convex/engine/runHandler.ts) — MCP discovery gate (`getMcpServers.length > 0`) | the **McpDiscoverChoice** Choice state ([G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)); this phase supplies the `mcpDiscover` Task |
| [`convex/engine/runHandler.ts:106`](../../../convex/engine/runHandler.ts) — `step.runAction(reply.dispatch)` | the **Reply** terminal SFN Task ([G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md) topology; this phase's Task body) |
| [`convex/invoke/admit.ts:204-209`](../../../convex/invoke/admit.ts) — `ctx.scheduler.runAfter(0, compact)` | async `lambda:InvokeFunction` (`InvocationType=Event`) of the compact Lambda from `admitCompact` |
| Channel secrets (`SLACK_SIGNING_SECRET`, `DISCORD_PUBLIC_KEY`, `GITHUB_WEBHOOK_SECRET`, `TELEGRAM_SECRET_TOKEN`, `LINEAR_WEBHOOK_SECRET`, `NOTION_WEBHOOK_SECRET`/`NOTION_VERIFICATION_TOKEN`, `TEAMS_APP_ID`, `GOOGLE_CHAT_*`, the `*_BOT_TOKEN`/`*_API_KEY` reply creds) from `process.env` | **Secrets Manager / SSM Parameter Store**, injected as `inboundChannel`/`reply` Lambda env at deploy (channels-stack) |

## Hardened-contract obligations

The design-of-record contracts ([../../design/08](../../design/08-conventions-and-execution-boundary.md) §3
"execution boundary", §4.3 "atomic abort", D3/D14/D18) and the THESIS this phase MUST keep:

- **THESIS — channels never run the loop.** Per [`convex/channels/types.ts:49-52`](../../../convex/channels/types.ts)
  ("No box, no LLM — channels admit + reply only") the `inboundChannel` Lambda does NO box, NO
  LLM, NO `StepDecision` work. It admits (`StartExecution`) and acks. The reply Lambda only posts
  a finalized result. The orchestrator owns the loop; channels are pure edges.
- **THESIS — the reply is replay-reconstructable.** `reply` reads the **frozen** `replyContext` off
  the terminal Requests item ([`reply.ts:47`](../../../convex/channels/reply.ts)) and the finalized
  `status/finalText/result/error` — never re-derives them from live state. An SFN at-least-once
  retry of the Reply Task re-reads the same journaled row and is a no-op.
- **D3 — the framework gate runs first, closed by default.** `inbound.ts:24-25` runs
  `runAuthorize` BEFORE verify. Under AWS this is split: the API Gateway authorizer is the
  framework gate (closed-by-default, [G4.5](phase-g4.5-ingress-apigw-auth.md)); but because an
  authorizer **cannot see the raw body**, `adapter.verify` MUST stay inside the `inboundChannel`
  Lambda. The authorizer either skips `/channels/*` (caching TTL=0) or runs only the framework
  shape — the signature check never moves out of the handler.
- **Raw-byte fidelity (non-negotiable).** Every adapter HMAC/Ed25519/JWT-verifies the EXACT raw
  bytes ([`inbound.ts:21-22`](../../../convex/channels/inbound.ts): "read raw bytes once … re-serialized
  JSON breaks it"). Slack HMACs `v0:{ts}:{body}`, Discord Ed25519s `timestamp+rawBody`, GitHub/Linear/Notion
  HMAC the raw body. The Lambda proxy integration MUST be configured with **no body transform** and
  `isBase64Encoded` correctly handled (base64-decode to the exact bytes before verify). Any
  re-serialization breaks all 8 adapters.
- **D14 — dedup before admission.** `inbound.ts:44-48` runs `markWebhookSeen` BEFORE `submitPrompt`;
  a replayed delivery never spawns a second run. The conditional Put on Meta MUST precede
  `StartExecution` so an at-least-once provider redelivery (or a retried Lambda) never starts a
  second execution. The conditional-Put **IS** the dedup (no read-then-write race).
- **Handshake/ignore short-circuit BEFORE any admission.** `inbound.ts:40-42` returns the
  handshake echo (Slack `url_verification`, Discord `PING` type 1, Notion subscription
  `verification_token`) and ignores bot-echo/non-message events **without** dedup or
  `StartExecution`. Preserved verbatim — these return synchronously inside the provider ack window.
- **Exactly-once reply (D14 / [`reply.ts:44`](../../../convex/channels/reply.ts)).** The Convex
  guard is a read-then-patch (`if repliedAt !== undefined return`) — a TOCTOU window. The AWS
  version is STRICTLY STRONGER: a conditional `UpdateItem SET repliedAt IF attribute_not_exists(repliedAt)`
  run BEFORE the external post. An SFN at-least-once retry that re-enters the Reply Task fails the
  condition and skips the post. Reply's other guards survive: no `replyContext` ⇒ native/HTTP run,
  skip ([`reply.ts:43`](../../../convex/channels/reply.ts)); non-terminal status ⇒ defensive skip
  ([`reply.ts:45`](../../../convex/channels/reply.ts)); unknown provider ⇒ never crash
  ([`reply.ts:49`](../../../convex/channels/reply.ts)).
- **Reply is the ONLY channels touch in the loop.** [`runHandler.ts:103-106`](../../../convex/engine/runHandler.ts)
  posts the reply AFTER `runAgentLoop` returns and even after a swallowed `ResultUnavailableError`
  (`reply.ts` runs on the gave-up/exhausted terminal-but-reply path). The **Reply** SFN Task MUST
  sit on the join after every `Finalize*` state (per [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)'s
  `Finalize* → Reply → Succeed`), including the `FinalizeGaveUp`/`FinalizeFollowupsExhausted` paths.
- **D18 — workflow is a distinct run kind on the SAME machine.** `admitWorkflow` creates a
  `kind:"workflow"` row and starts the SAME `agentRun` ([`admit.ts:232-249`](../../../convex/invoke/admit.ts)).
  Under AWS it is a named `StartExecution` on the SAME `AgentLoop` with `{kind:'workflow', target}`
  — NO parallel state machine, NO parallel table. The `kind:"workflow"` discriminator stays the
  only observable difference.
- **MCP discovery is network-only, pre-setup, journaled (08 §3 network carve-out).**
  [`discover.ts:1-10`](../../../convex/mcp/discover.ts): discovery runs BEFORE the setup freeze so
  setup stays a deterministic read of discovered descriptors. The `mcpDiscover` Task runs before
  Setup, does NO box, freezes closure-free `McpToolDescriptor[]` to DynamoDB. A per-server connect
  failure becomes a **diagnostic descriptor** (never crashes setup) — preserved verbatim
  ([`discover.ts:54-58`](../../../convex/mcp/discover.ts)).
- **MCP pool is per-process, never assumed durable (D15 / R5).**
  [`pool.ts:5-9`](../../../convex/mcp/pool.ts): a warm container reuses the `Map`; a cold start
  re-opens. This maps 1:1 onto the warm-Lambda-container lifetime; `closeAll()` runs in the
  handler `finally`. The frozen descriptor wins on drift ([`pool.ts:82`](../../../convex/mcp/pool.ts)).
- **Scheduler fidelity.** `runAfter(0, compact)` is a literal 0-delay maintenance kick. The
  faithful mapping is an async Lambda `Invoke` (`InvocationType=Event`), NOT EventBridge — there is
  no delay to schedule. `@convex-dev/workpool` is unused (no behavior to port; deleted at cutover).

## Implementation tasks

Ordered so a builder never re-derives the design.

1. **Move the portable channel core.** Copy `convex/channels/{types.ts,index.ts}` and all 8
   `convex/channels/<name>/` adapter folders into `backend/channels/` unchanged. Move
   `dedupKey()` from `convex/channels/dedup.ts:9-12` into `backend/channels/dedup.ts` (drop the
   `markWebhookSeen` `internalMutation` — replaced in step 3). Confirm `grep -rn "convex" backend/channels/`
   is empty except type-only imports that resolve to `src/runtime/*`.
2. **Verify Web Crypto / jose run on Node 20.** Slack/GitHub/Linear/Notion use `crypto.subtle`
   HMAC-SHA256; Discord uses `crypto.subtle` Ed25519; Teams uses `jose` JWT; Google Chat uses
   `jose` via dynamic import. All are present on Node 20 — no shims. Keep Google Chat's dynamic
   `import` lazy so the static bundle stays jose-free (code-split in esbuild). Per-isolate JWKS
   cache (Teams/Google Chat) becomes per-warm-container caching.
3. **`metaStore.markWebhookSeen`.** Implement against the **Meta** table
   ([G4.1](phase-g4.1-foundation-cdk-dynamodb.md)): `PutItem PK=webhook:<provider>:<eventId>,
   SK=META` with `ConditionExpression attribute_not_exists(PK)` and a TTL attribute
   (`expireAt = now + N days`). On `ConditionalCheckFailedException` return `{isNew:false}`; on
   success `{isNew:true}`. This replaces the `meta.by_key` unique-then-insert
   ([`dedup.ts:18-24`](../../../convex/channels/dedup.ts)) and IS the dedup — no separate read.
4. **`inboundChannel` Lambda handler.** Implement the pipeline exactly mirroring
   [`inbound.ts`](../../../convex/channels/inbound.ts):
   1. Read raw bytes: `const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body`
      — pass the exact byte string to verify. Build a `Request`-shaped shim (headers + a `text()`
      returning `rawBody`) so the moved adapters work unchanged.
   2. Resolve the adapter from `channelRegistry[event.pathParameters.name]`; unknown ⇒ 404
      (mirrors [`http.ts:170-176`](../../../convex/http.ts)).
   3. Residual `runAuthorize` hook (the framework gate is the authorizer; this is the in-handler
      remainder, kept for parity with `inbound.ts:25`).
   4. `adapter.verify(req, rawBody)` — on `!ok` return 401 (`UnauthorizedError` →
      `renderHttpError`, [G4.5](phase-g4.5-ingress-apigw-auth.md) `apiError` shim).
   5. `JSON.parse(rawBody)` → `InvalidJsonError` on failure; `adapter.mapPayload(parsed, req)`.
      `handshake` ⇒ return `Response.json(body)` synchronously; `ignore` ⇒ `200 "ok"`. **Return
      BEFORE dedup/StartExecution.**
   6. `metaStore.markWebhookSeen(dedupKey(adapter.name, mapped.spec.eventId))`; `!isNew` ⇒
      `200 "ok (duplicate)"`.
   7. Admit: call the shared **`ingress/admitWrite.ts` `admitPrompt()`** helper (**owned/exported by
      [G4.5](phase-g4.5-ingress-apigw-auth.md)** task 4; consumed here) with the frozen `replyContext` and
      `supersede:true` semantics ([`submit.ts:18-46`](../../../convex/invoke/submit.ts)) — it writes the
      `agentRequests` row (`kind:"prompt"`) + the `u-<requestId>` user entry as one `TransactWriteItems`,
      then `StartExecution(name=submissionId, input={requestId})` on `AgentLoop`. Return `200 "ok"`.
   8. Wrap everything in `renderHttpError` → `{statusCode, headers, body}` (the
      `CoveApiError` envelope, [`inbound.ts:59-62`](../../../convex/channels/inbound.ts)).
   Keep the handler synchronous-fast: verify→dedup→StartExecution→ack within the ~3 s Slack/Discord/Telegram
   ack window. `StartExecution` returns immediately; the loop + reply run out of band.
5. **channels-stack CDK construct.** `POST /channels/{name}` resource on the REST API
   (declared in [G4.5](phase-g4.5-ingress-apigw-auth.md), wired here): Lambda proxy integration
   with **`contentHandling` left as passthrough**, the API's `binaryMediaTypes` set to `*/*` (so
   binary/text bodies arrive byte-faithful as base64), and **no request templates**. Authorizer on
   this route either omitted or with `resultsCacheTtl=0`. Grant `inboundChannel`:
   `dynamodb:PutItem`/`GetItem` on Meta + Requests + Sessions, `states:StartExecution` on the
   `AgentLoop` ARN. Inject the inbound secrets (SLACK_SIGNING_SECRET, DISCORD_PUBLIC_KEY,
   GITHUB_WEBHOOK_SECRET, TELEGRAM_SECRET_TOKEN, LINEAR_WEBHOOK_SECRET, NOTION_WEBHOOK_SECRET /
   NOTION_VERIFICATION_TOKEN, TEAMS_APP_ID, GOOGLE_CHAT_*) from Secrets Manager / SSM as Lambda env.
6. **`requestStore.getForReply` + `stampReplied`.** `getForReply`: GetItem `PK=REQ#<requestId>,
   SK=META` projecting `status, replyContext, repliedAt, finalText, result, error` (mirrors
   [`reply.ts:15-29`](../../../convex/channels/reply.ts)). `stampReplied`: `UpdateItem SET
   repliedAt = :now ConditionExpression attribute_not_exists(repliedAt)`; on
   `ConditionalCheckFailedException` treat as already-replied (no error).
7. **`reply` Task Lambda handler.** Input `{requestId}` from the **Reply** SFN Task. Body mirrors
   [`reply.ts:38-60`](../../../convex/channels/reply.ts) with the guard order **inverted to put
   the conditional stamp first**:
   1. `getForReply(requestId)`; `null` ⇒ return (no-op).
   2. No `replyContext` ⇒ return (native/HTTP run).
   3. `status` not in `{completed, failed, cancelled}` ⇒ return (defensive).
   4. `stampReplied(requestId)`; condition-failed ⇒ return (already posted; the strengthened guard).
   5. Resolve `channelRegistry[replyContext.provider]`; unknown ⇒ return (never crash).
   6. `adapter.postReply(replyContext, terminal)` where `terminal = {status, finalText, result, error}`.
   Note: the stamp is BEFORE `postReply` (stronger than Convex's after-post `markReplied`), so a
   retry can't double-post even if `postReply` succeeded but the Lambda crashed before returning.
   *(Trade-off vs. lost-reply: see Risks — chosen because an SFN Task retry would otherwise
   double-post, and a failed post can be surfaced/retried via the Requests row.)*
8. **Wire the Reply Task into the state machine.** Contribute the `Reply` `tasks.LambdaInvoke`
   (payload `{requestId.$: '$.requestId'}`) to [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)'s
   topology so every `Finalize*` state transitions `→ Reply → Succeed`. Add a `Catch`/`Retry` on
   the Reply Task that, on terminal failure, still reaches `Succeed` (a failed reply must not fail
   the run — matches `reply.ts` swallowing unknown-provider/post errors).
9. **`mcpDiscover` Task Lambda handler.** Input `{requestId}`. Read `mcpServers` from the Requests
   row (`requestStore.getMcpServers`), call the moved `discoverMcpDescriptors(mcpServers)`
   ([`discover.ts:30-61`](../../../convex/mcp/discover.ts)) — network-only, NO box. Write the
   resulting `McpToolDescriptor[]` to DynamoDB for Setup to read (NOT the SFN state payload — the
   roster can exceed 256 KB; spill to S3 with a pointer if the descriptor set >256 KB, extending
   the `imageChunks`/Blobs `s3Key` pattern). Per-server failure stays a diagnostic descriptor.
10. **MCP pool in `dispatchTools`.** Confirm [G4.2](phase-g4.2-compute-lambda-actions.md)'s
    `dispatchTools` keeps `convex/mcp/pool.ts` as a **module-level** `Map` (warm-container reuse,
    D15/R5) and calls `closeAll()` in the handler `finally`. This phase only verifies the discovery
    Task freezes the descriptors the pool's `resolveMcpTool` later rebinds.
11. **Workflow invoke = named StartExecution.** Confirm [G4.5](phase-g4.5-ingress-apigw-auth.md)'s
    `submitWorkflow.ts` resolves the name in the bundled `workflowRegistry` (404 on unknown,
    [`workflowRegistry.ts:63`](../../../convex/workflowRegistry.ts)) and calls
    `StartExecution(name=submissionId, input={kind:'workflow', target:name, requestId})` on the
    SAME `AgentLoop`. No parallel machine/table. This phase owns the assertion that the
    `kind:"workflow"` discriminator is the only divergence from a `kind:"prompt"` run (D18).
12. **Scheduler → async Invoke.** In `admitCompact` ([`admit.ts:185-211`](../../../convex/invoke/admit.ts))
    replace `ctx.scheduler.runAfter(0, internal.engine.compact.compact, {...})` with
    `lambda.invoke({FunctionName: COMPACT_FN, InvocationType: 'Event', Payload: {sessionId,
    requestId, model, finalizeOnComplete:true}})`. Grant the admit Lambda
    `lambda:InvokeFunction` on the compact Lambda. **No EventBridge rule.** Leave a documented
    forward hook: future timeouts/recurring jobs → EventBridge Scheduler.
13. **Secrets migration.** Move all 17 channel `process.env.*` values (verify secrets + reply
    bot tokens / API keys) into Secrets Manager / SSM; the channels-stack injects them as Lambda
    env at deploy. No secret stays in source or in a committed `.env`.

## Acceptance

Objective bars — each mirrors the Convex behavior it replaces.

- **Inbound parity (all 8 adapters).** For each of slack/discord/github/teams/telegram/linear/notion/google-chat:
  a correctly-signed webhook with a fresh `eventId` → `200 "ok"` + exactly one `StartExecution`
  on `AgentLoop` + one `agentRequests` row with the frozen `replyContext`. A bad signature →
  `401` and **no** `StartExecution`. Mirrors [`inbound.ts:28-58`](../../../convex/channels/inbound.ts).
- **Raw-byte fidelity.** A LocalStack/integration test posts a real Slack body and asserts
  `verifySlackSignature` passes through API Gateway → Lambda with the bytes intact (no
  re-serialization). Equivalent assertions for Discord Ed25519 (`timestamp+rawBody`) and a
  GitHub/Linear/Notion raw-body HMAC. A test that flips one byte fails verify (proves no transform
  masks corruption).
- **Handshake short-circuit.** Slack `url_verification`, Discord `PING` (type 1), and Notion
  subscription `verification_token` each return the echo synchronously with **no** dedup write and
  **no** `StartExecution`. Bot-echo/non-message events return `200` with no admission.
- **Dedup before admission.** Two identical deliveries (same `provider:eventId`) → the first
  admits, the second returns `200 "ok (duplicate)"` and writes **no** second execution. The Meta
  conditional Put fires before `StartExecution`. Mirrors [`inbound.ts:44-48`](../../../convex/channels/inbound.ts).
- **Exactly-once reply under retry.** A run finalizes; the **Reply** Task posts once and stamps
  `repliedAt`. A forced SFN at-least-once retry of the Reply Task fails the conditional
  `attribute_not_exists(repliedAt)` and does **not** re-post. A native/HTTP run (no `replyContext`)
  posts nothing. Mirrors [`reply.ts:43-58`](../../../convex/channels/reply.ts).
- **Reply on the gave-up path.** A result-schema run that exhausts follow-ups (`FinalizeFollowupsExhausted`)
  or gives up (`FinalizeGaveUp`) STILL reaches the Reply Task and posts the failed terminal result
  — matching [`runHandler.ts:97-106`](../../../convex/engine/runHandler.ts) swallowing
  `ResultUnavailableError` and falling through to `reply.dispatch`.
- **Workflow invoke.** `POST /workflows/{name}` for a registered name → a named `StartExecution`
  on `AgentLoop` with `{kind:'workflow', target:name}`, observable as a `kind:"workflow"` Requests
  row; unknown name → 404 (`WorkflowNotFoundError`). No second state machine or table exists.
- **MCP discovery.** A request declaring `mcpServers` runs the `mcpDiscover` Task before Setup,
  freezes `McpToolDescriptor[]` to DynamoDB (S3 pointer if >256 KB), and a server that fails to
  connect yields a diagnostic descriptor (the run continues; the tool surfaces an error result).
  A request with no `mcpServers` skips the Task entirely (McpDiscoverChoice → Setup). Mirrors
  [`runHandler.ts:20-24`](../../../convex/engine/runHandler.ts) + [`discover.ts:54-58`](../../../convex/mcp/discover.ts).
- **MCP pool warm-reuse.** Two tool calls to the same MCP server within one warm `dispatchTools`
  container reuse one connection; a cold container re-opens; `closeAll()` runs on teardown. Drift
  (a tool the server no longer offers) degrades to an error result (frozen descriptor wins).
  Mirrors [`pool.ts:37-95`](../../../convex/mcp/pool.ts).
- **Scheduler.** `submitCompact` triggers an async `Invoke` (`InvocationType=Event`) of the compact
  Lambda (no EventBridge rule deployed). The compaction run completes and finalizes its
  `kind:"compact"` request. Mirrors [`admit.ts:204-209`](../../../convex/invoke/admit.ts).
- **No EventBridge Scheduler / cron at cutover.** `grep -rn "Schedule\|Cron\|Rule" backend/cdk/`
  finds no time-based rule (parity with the empty cron scan in the tree). Forward hooks documented.

## Risks & gotchas

- **Raw-byte fidelity is the sharpest risk.** Any API Gateway body transformation (re-serialization,
  a mishandled `binaryMediaTypes`, double base64) breaks HMAC/Ed25519/JWT for all 8 adapters at
  once. Mandatory: Lambda proxy integration, `binaryMediaTypes: ['*/*']`, no request templates,
  and base64-decode `isBase64Encoded` to the exact bytes. This is the first thing the integration
  test must prove (one flipped byte must fail verify).
- **Ack-window pressure.** Slack/Discord/Telegram expect a response within ~3 s. The handler must
  finish verify→dedup→`StartExecution`→ack fast; a cold `inboundChannel` start that bundles the
  full adapter set + jose risks the window. Keep the bundle lean (code-split jose / SSE transport),
  keep the Lambda out of a VPC, and consider provisioned concurrency for the channels Lambda if
  cold starts breach the window in load tests.
- **Reply ordering trade-off (stamp-before-post).** Stamping `repliedAt` BEFORE `postReply`
  prevents double-posting on an SFN Task retry but introduces a lost-reply window: if `postReply`
  throws after the stamp, the guard now blocks a re-post. Mitigation: surface a `postReply` failure
  on the Requests row (e.g. a `replyError` attribute) and allow an explicit re-drive; do NOT revert
  to Convex's post-then-stamp (that re-opens the double-post window an at-least-once Task makes
  real). Document this as a deliberate inversion vs. [`reply.ts:57-58`](../../../convex/channels/reply.ts).
- **Authorizer can't see the body — keep verify in the Lambda.** The closed-by-default authorizer
  ([G4.5](phase-g4.5-ingress-apigw-auth.md)) handles only the framework gate; the signature check
  MUST remain inside `inboundChannel`. Misconfiguring the authorizer to enforce `/channels/*`
  identically to `/agents/*` would 403 legitimate signed webhooks (the provider sends no auth
  token). Set `resultsCacheTtl=0` or omit the authorizer on the channels route.
- **Dedup must precede StartExecution.** If a refactor moves `markWebhookSeen` after
  `StartExecution`, a provider redelivery (or a retried Lambda) starts a second run before the
  ledger blocks it. The conditional Put MUST be the gate immediately before `StartExecution`
  (D14 / [`inbound.ts:44-48`](../../../convex/channels/inbound.ts)).
- **Dedup TTL vs. provider redelivery horizon.** The Meta TTL must outlive the provider's maximum
  redelivery window (some retry for hours/days) or a late redelivery slips past an expired ledger
  row and double-admits. Size the TTL to the longest provider redelivery horizon.
- **MCP roster size.** A many-tool MCP server's frozen descriptor set can exceed the 256 KB SFN
  state and 400 KB DynamoDB item limits. `mcpDiscover` must write to DynamoDB (not SFN state) and
  spill to S3 with a pointer (D-AWS-10); Setup follows the pointer. A large-roster run without the
  spill wired will fail at the Task boundary.
- **MCP pool lifetime.** MCP connections kept in the warm Lambda container are unbounded if the
  container stays warm across many runs without `closeAll()`. The handler `finally` must close the
  pool; a partial-failure path that skips `finally` leaks connections. (The sandbox container leak /
  host saturation is the [G4.2](phase-g4.2-compute-lambda-actions.md) concern, D-AWS-15; MCP-pool teardown is here.)
- **Workflow input fidelity.** `admitWorkflow` serializes non-string input with `JSON.stringify`
  ([`admit.ts:231`](../../../convex/invoke/admit.ts)). The SFN `input` carries `{kind, target,
  requestId}` only — the serialized input lives on the Requests row, NOT in the SFN state, to avoid
  the 256 KB limit. Don't pass the raw workflow input through the state machine.
- **Scheduler is a 0-delay kick, not a cron.** Resist modeling `runAfter(0)` as an EventBridge
  Scheduler rule — that adds a rule with no delay to schedule and a min-1-minute granularity that
  changes timing semantics. Async `Invoke` (`InvocationType=Event`) is the faithful, lowest-latency
  mapping. EventBridge Scheduler is reserved for *future* real delays/recurrence.
- **Secrets at cutover.** All 17 channel env vars must be in Secrets Manager / SSM and injected
  before the first webhook lands, or every adapter's verify fails (`secret not configured` → 401).
  This belongs on the [G4.8](phase-g4.8-tests-parity-cutover.md) cutover checklist alongside the
  open→closed authorizer inversion.
