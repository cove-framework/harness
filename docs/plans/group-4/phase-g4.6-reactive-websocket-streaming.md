# Phase G4.6 — Reactive substrate — API Gateway WebSockets + DynamoDB Streams + client retarget

> Group 4 (Convex → AWS migration). This phase replaces the **reactive read path** — the flue-SSE
> substitute that today is plain Convex reactive queries — with an **API Gateway WebSocket API** fed by
> **DynamoDB Streams** through a single **fan-out Lambda** that `postToConnection`s deltas. It also rewires
> the LLM token-delta path (deltas broadcast over WS, **only finalized steps persisted**), ships the
> race-free `seq`/`eventIndex` write substrate, and retargets the SDK + React client from
> `convex.onUpdate` to the WebSocket transport. **The portable consumer core stays unchanged** — only the
> Convex transport adapter is replaced.
>
> Design-of-record: shared design spine (`reactiveDesign`, `dynamoDesign` Streams section, decisions
> **D-AWS-1**, **D-AWS-3**, **D-AWS-4**) + locked decision #2 (deltas over WS, finalized-only persist) +
> Convex SoR docs [05 — Public API & SDK](../../design/05-public-api-and-sdk.md) and
> [08 — Conventions & Execution Boundary](../../design/08-conventions-and-execution-boundary.md) §4.6.

## Goal & scope

Reproduce, on AWS, the exact wire behavior of cove's reactive read path. Today that path is four reactive
Convex queries re-broadcast on every matching write:
[`convex/events/read.ts`](../../../convex/events/read.ts) (`listForStream`/`listForSubmission` — the SSE
replacement), [`convex/steps.ts`](../../../convex/steps.ts) (`listForRequest`),
[`convex/requests.ts`](../../../convex/requests.ts) (`get` — watched to terminal), and the approvals
listing consumed by the approval-card UI. The substrate underneath them is
[`convex/events/emit.ts`](../../../convex/events/emit.ts) (`computeStreamKeys` + `appendEvents`),
[`convex/events/seq.ts`](../../../convex/events/seq.ts) (`nextSeq`), and the delta-commit path
[`convex/engine/steps.ts`](../../../convex/engine/steps.ts) (`patchStreaming`) coalesced by
[`convex/engine/deltaBatcher.ts`](../../../convex/engine/deltaBatcher.ts).

This phase owns:

- **The WebSocket API + connection lifecycle.** `backend/cdk/stacks/reactive-stack.ts` — an
  `apigatewayv2.WebSocketApi` with `$connect`/`$disconnect`/`subscribe` routes, a `$connect` authorizer,
  and a new **Connections + Subscriptions** table (no Convex equivalent — Convex tracked subscriptions
  internally).
- **The Streams fan-out Lambda.** One Lambda consuming the **Streams (NEW_IMAGE)** that G4.1 enabled on
  `Steps`, `Events`, `Requests`, `Approvals` → resolves subscribers by `streamKey` → `postToConnection`.
- **The `seq`/`eventIndex` write substrate.** The `appendEvents` fan-out rewritten onto DynamoDB **atomic
  counters** (`UpdateItem ADD :1 RETURN_VALUES UPDATED_NEW`) — replacing `nextSeq`'s read-max+1 which is
  unsafe off Convex's single-writer serialization (**D-AWS-4**). This is the load-bearing ordering
  invariant for the whole reactive path.
- **The delta path re-shape (locked decision #2 / D-AWS-3).** `deltaBatcher`'s sink moves from
  `ctx.runMutation(patchStreaming)` to `postToConnection`; LLM token deltas are broadcast over WS and
  **never persisted per-token**; only `finalizeStep` writes to `Steps`, whose Stream re-pushes the
  canonical finalized row.
- **The client retarget.** `createReactiveClientFromConvex` →
  `createReactiveClientFromWebSocket(url, {getAuthToken})`. The portable consumer core
  ([`src/sdk/event-stream.ts`](../../../src/sdk/event-stream.ts),
  [`src/react/agent-reducer.ts`](../../../src/react/agent-reducer.ts),
  [`src/react/agent-store.ts`](../../../src/react/agent-store.ts), all hooks) is **unchanged** — it depends
  only on the structural `onUpdate(ref,args,cb)` / `subscribeEvents(streamKey,listener)` shape.

**Out of scope** (owned elsewhere — cross-linked, never duplicated):

- The `Connections`/`Subscriptions` table is *created here*, but the streamed tables (`Steps`/`Events`/
  `Requests`/`Approvals`) + their `NEW_IMAGE` Streams + the `Events`/`SEQCOUNTER` item convention + the
  `bumpCounter` helper are **enabled** in → [G4.1](./phase-g4.1-foundation-cdk-dynamodb.md). This phase
  ships the *write logic* that drives the counter and the *consumer* of the streams.
- The `postWsDelta` sink that `llmStep` injects into `deltaBatcher` — the *Lambda-side* call is wired in →
  [G4.2](./phase-g4.2-compute-lambda-actions.md); this phase exports the helper (endpoint + subscriber
  resolution) it calls and owns the contract.
- The terminal-frame push for the `?wait=result` HTTP path + the closed-by-default `$connect` authorizer
  *shape* (it reuses the same `authorize()` hook as the REST authorizer) → primary owner is
  [G4.5](./phase-g4.5-ingress-apigw-auth.md); this phase only attaches a WebSocket authorizer that defers
  to it.
- Who *writes* the finalized `Steps`/`Requests`/`Approvals` rows whose Stream this phase fans out
  (`llmStep`/`finalize` → [G4.2](./phase-g4.2-compute-lambda-actions.md); the SFN lifecycle →
  [G4.3](./phase-g4.3-durable-orchestrator-stepfunctions.md); approvals →
  [G4.4](./phase-g4.4-hitl-task-tokens.md)).

## Dependencies

- **[G4.1](./phase-g4.1-foundation-cdk-dynamodb.md) (hard prerequisite).** Needs the `Events` table shape
  (`PK=STREAM#<streamKey>`, `SK ∈ {<seq:N>, SEQCOUNTER}`, GSI1 `by_submission`), the `NEW_IMAGE` Streams
  enabled on `Steps`/`Events`/`Requests`/`Approvals`, `store/eventStore.ts` with the `bumpCounter`
  (`ADD :1 RETURN_VALUES UPDATED_NEW`) helper, and `store/ddb.ts`. G4.1 ships the table + the atomic-counter
  helper; **this phase ships the `appendEvents` write that uses it** and the fan-out consumer.
- **[G4.2](./phase-g4.2-compute-lambda-actions.md).** `llmStep` injects this phase's `postWsDelta` sink
  into `deltaBatcher`; `finalize` emits the terminal `idle`/`submission_settled` events through
  `store/eventStore.appendEvents` (this phase's write path).
- **Portable cores (moved verbatim, no logic change):**
  [`src/sdk/event-stream.ts`](../../../src/sdk/event-stream.ts) (the serialized async-iterator + seq
  cursor), [`src/react/agent-reducer.ts`](../../../src/react/agent-reducer.ts) (the `recentEventIds` /
  `eventIndex` dedup), [`src/react/agent-store.ts`](../../../src/react/agent-store.ts),
  [`src/react/use-cove-run.ts`](../../../src/react/use-cove-run.ts),
  [`src/react/use-run-events.ts`](../../../src/react/use-run-events.ts),
  [`src/react/use-agent-prompt.ts`](../../../src/react/use-agent-prompt.ts),
  `convex/engine/deltaBatcher.ts` (moves to `backend/engine/deltaBatcher.ts`),
  `convex/events/emit.ts`'s `computeStreamKeys` (pure — moves to `store/eventStore.ts`).
- **Downstream:** none within group-4 strictly *blocks* on G4.6 (it branches off G4.1/G4.3 in parallel
  with G4.5), but the cutover gate [G4.8](./phase-g4.8-tests-parity-cutover.md) requires the WS substrate
  for the live-UI parity checks.

## Deliverables

| # | Deliverable | Path |
|---|---|---|
| 1 | **Reactive stack** — `WebSocketApi` + routes + stages + `$connect` authorizer + Connections/Subscriptions table | `backend/cdk/stacks/reactive-stack.ts` |
| 2 | `$connect` handler — auth + `PutItem` connection | `backend/handlers/ws/connect.ts` |
| 3 | `$disconnect` handler — delete connection + its subscriptions | `backend/handlers/ws/disconnect.ts` |
| 4 | `subscribe` handler — register a `Subscriptions` row + backfill from `sinceSeq` | `backend/handlers/ws/subscribe.ts` |
| 5 | **Fan-out Lambda** — Streams (Steps/Events/Requests/Approvals) → resolve subscribers → `postToConnection` | `backend/handlers/ws/fanout.ts` |
| 6 | The `appendEvents` write path on atomic counters (`seq`/`eventIndex`) + `computeStreamKeys` | `backend/store/eventStore.ts` |
| 7 | `postWsDelta` helper (endpoint + subscriber resolution; injected by `llmStep`/`deltaBatcher`) | `backend/store/wsBroadcast.ts` |
| 8 | `connectionStore` — Connections/Subscriptions CRUD + 410-Gone reaping | `backend/store/connectionStore.ts` |
| 9 | **Client retarget** — `createReactiveClientFromWebSocket(url,{getAuthToken})` + the WS `onUpdate` adapter | `src/sdk/ws-transport.ts`, `src/react/client-types.ts` (new builder) |
| 10 | Backfill query path — `readSince(streamKey, sinceSeq)` over `Events` for reconnect catch-up | `backend/store/eventStore.ts` + a `GET`/`subscribe`-frame path |

## Source map

| Convex source (replaced) | New AWS file(s) | Notes |
|---|---|---|
| [`convex/events/read.ts`](../../../convex/events/read.ts) (`listForStream`/`listForSubmission` reactive queries — **the SSE replacement**) | `backend/handlers/ws/fanout.ts` (push) + `backend/store/eventStore.ts` `readSince` (reconnect backfill) | The reactive *re-broadcast on every matching write* becomes a Stream→fan-out **delta push**; the `Query SK>since` backfill (`read.ts:24-29`) survives as `readSince` for reconnect/catch-up. The whole-result re-delivery is **gone** — the server emits the delta. |
| [`convex/events/emit.ts`](../../../convex/events/emit.ts) (`computeStreamKeys`, `appendEvents`, `eventIndex`-once) | `backend/store/eventStore.ts` `appendEvents` | `computeStreamKeys` (`emit.ts:20-28`) moves **verbatim** (pure). `appendEvents` (`emit.ts:35-62`) keeps the decorate→redact→seq→fan-out shape; only `nextSeq` → atomic counter. |
| [`convex/events/seq.ts`](../../../convex/events/seq.ts) (`nextSeq` read-max+1) | `backend/store/eventStore.ts` (atomic counter via G4.1's `bumpCounter`) | **D-AWS-4** — read-max+1 (`seq.ts:11-18`) is NOT safe off single-writer serialization; replaced by `UpdateItem ADD seq :1 RETURN_VALUES UPDATED_NEW` on `PK=STREAM#<key>, SK=SEQCOUNTER`. |
| [`convex/events/append.ts`](../../../convex/events/append.ts) (`internal.events.append.append`) | (folded into `store/eventStore.appendEvents`) | The mutation-vs-action split (`emitFromMutation`/`emitFromAction`, `emit.ts:64-78`) collapses — every Lambda calls `store/eventStore.appendEvents` directly; no `runMutation` hop. |
| [`convex/engine/steps.ts`](../../../convex/engine/steps.ts) `patchStreaming` (`steps.ts:72-91`) | **deleted — no per-token persist.** Deltas → `backend/store/wsBroadcast.ts` `postWsDelta` | **Locked decision #2 / D-AWS-3.** `insertStreaming`/`finalizeStep`/`appendToolResult` stay (the journal, owned by [G4.2](./phase-g4.2-compute-lambda-actions.md)); `patchStreaming` (the ~10-20×/turn delta write) is **removed** — deltas are WS-only. |
| [`convex/engine/deltaBatcher.ts`](../../../convex/engine/deltaBatcher.ts) (pure) | `backend/engine/deltaBatcher.ts` (moved verbatim) | Sink rewired from `patchStreaming` mutation → `postWsDelta`; cadence `DELTA_BATCH_CHARS=480`/`DELTA_BATCH_MS=400` (`deltaBatcher.ts:20-21`) kept. |
| [`convex/steps.ts`](../../../convex/steps.ts) (`listForRequest` reactive query) | `backend/handlers/ws/fanout.ts` (Steps Stream → finalized-step frame) | Today re-broadcasts as `patchStreaming` patches text in place (`steps.ts:1-3`); now the **finalized** Steps write is the only persisted row and its Stream pushes it once. |
| [`convex/requests.ts`](../../../convex/requests.ts) (`get` reactive query — watched to terminal) | `backend/handlers/ws/fanout.ts` (Requests Stream → terminal frame) + `src/sdk/ws-transport.ts` | `watchRequestToTerminal` (`client.ts:138-178`) re-targets onto a `request` logical channel; the terminal status flip arrives over the Requests Stream. |
| [`src/sdk/event-stream.ts`](../../../src/sdk/event-stream.ts) (`createCoveEventStream` over `convex.onUpdate`) | `backend/`-agnostic; **moved/kept verbatim** | The serialized async-iterator + `currentSeq` at-least-once cursor (`event-stream.ts:74-167`) depend only on `CoveConvexClient.onUpdate(ref,args,cb)`; the WS adapter exposes the same shape. |
| [`src/sdk/client.ts`](../../../src/sdk/client.ts) (`createCoveReactiveClient` over `CoveConvexClient`) | `src/sdk/ws-transport.ts` provides the WS `CoveConvexClient`; `client.ts` body unchanged | The client is built from a structural `onUpdate`; only the transport passed to it changes. |
| [`src/react/client-types.ts`](../../../src/react/client-types.ts) `createReactiveClientFromConvex` (`client-types.ts:78-135`) | `createReactiveClientFromWebSocket(url,{getAuthToken})` (same file or `src/react/ws-client.ts`) | The `subscribeEvents` cursor logic (`client-types.ts:99-133`) maps 1:1 onto the WS adapter; it already advances `cursor` and forwards only `seq > cursor`. |
| [`src/react/agent-reducer.ts`](../../../src/react/agent-reducer.ts) (`recentEventIds`/`eventIndex` dedup) | unchanged (portable) | The `eventIndex`-keyed dedup (`agent-reducer.ts:60-67`) is the **second** dedup line; it survives verbatim and is exactly what makes WS at-least-once + lossy-reconnect safe. |
| `convex/browser` / `convex/react` (SDK transport) | `src/sdk/ws-transport.ts` (raw `WebSocket`) | per `surfaceMapping` G4.6: `createReactiveClientFromWebSocket`; event-stream/reducer/hooks portable. |

## Hardened-contract obligations

Every contract below is from the THESIS, locked decision #2, or design doc
[08 §4.6](../../design/08-conventions-and-execution-boundary.md). This phase is the implementation surface
for the reactive/streaming half of the boundary.

1. **THESIS — replay-reconstructable from journaled state; render-only deltas are NOT the source of truth.**
   WS delta frames are **ephemeral** (no `seq`, never persisted). The durable journal (`Steps` finalized
   rows + seq'd `Events`) is the sole replay-reconstructable record. The client reducer keeps finalized
   seq'd events as the source of truth and reconciles render-only deltas against the finalized step when it
   lands ([`agent-reducer.ts`](../../../src/react/agent-reducer.ts) already treats `message_end` as
   authoritative, `agent-reducer.ts:129/188`). A lost delta degrades only rendering, never correctness.

2. **Locked decision #2 / D-AWS-3 — no per-token DynamoDB writes.** `patchStreaming`
   ([`steps.ts:72-91`](../../../convex/engine/steps.ts)) is **deleted**. The ~10-20 writes/turn against
   `PK=REQ#<id>` (a hot-partition storm + one Stream record per batch = fan-out amplification) is replaced
   by `postToConnection`. ONLY `finalizeStep` writes to `Steps`; the `Steps` Stream therefore carries
   ~1 record/step. `deltaBatcher` stays portable — only its injected sink changes.

3. **D-AWS-4 — per-streamKey `seq` via atomic counter, never read-max+1 (sharpest ordering risk).**
   `nextSeq` ([`seq.ts:11-18`](../../../convex/events/seq.ts)) was only safe under Convex single-writer
   serialization. On DynamoDB, `seq` MUST be allocated by `UpdateItem ADD seq :1 RETURN_VALUES UPDATED_NEW`
   on `PK=STREAM#<streamKey>, SK=SEQCOUNTER`, then the event written at the returned `seq`. Concurrent
   emits (parallel Map states / SFN retries) would otherwise collide on the SK and break **both** the SDK
   `currentSeq` cursor ([`event-stream.ts:74,164`](../../../src/sdk/event-stream.ts)) and replay ordering.

4. **`eventIndex` allocated ONCE from the primary stream, reused across the fan-out** (`emit.ts:44-48`).
   `eventIndex` = the **first (primary)** streamKey's counter value; the SAME `eventIndex` is stamped on
   every fan-out row while each row's own `seq` is its own counter. This is the stable per-context ordinal
   the consumer dedups by — `listForSubmission` dedups on it (`read.ts:46-51`) and the reducer's
   `recentEventIds` keys on it (`agent-reducer.ts:60`). Mis-implementing this re-orders consumer dedup.

5. **§4.6 streaming commit semantics — coalesced deltas, finalized text in-position.** The `deltaBatcher`
   coalesces token deltas on the *looser* of char/time threshold (`deltaBatcher.ts:71-76`) and emits the
   delta *since the last flush* (`deltaBatcher.ts:83-96`). Over WS, a late subscriber does NOT see prior
   deltas (they are ephemeral) — it reconciles by reading the finalized step (re-pushed by the `Steps`
   Stream) and, on subscribe, by a `readSince` backfill of seq'd events. The render-text accumulation that
   was server-side (in `patchStreaming`) now lives in the client reducer.

6. **§4.6 / `computeStreamKeys` — the fan-out keying is preserved verbatim.** A workflow run keys by
   `runId`; direct/dispatched activity keys by `instanceId` **and** `${instanceId}:${session}`
   (`emit.ts:20-28`). The fan-out Lambda derives the SAME keys when mapping a `Steps`/`Requests`/`Approvals`
   NEW_IMAGE to its subscribers (events already carry `streamKey`; the other tables map via
   `requestId → instanceId/session/runId` read off the row's `submissionId`/`instanceId` attributes).

7. **At-least-once + lossy-reconnect safety (the two-line dedup must survive).** DynamoDB Streams are
   at-least-once and per-shard-ordered; WS is lossy on reconnect (unlike Convex whole-result re-delivery).
   The client therefore keeps **both** dedup lines: the SDK `currentSeq` cursor advances only after a batch
   is fully yielded (`event-stream.ts:160-167`), and the reducer dedups by `eventIndex`
   (`agent-reducer.ts:60-67`). On reconnect the client re-issues from its last `sinceSeq` to backfill
   missed events ([G4.1](./phase-g4.1-foundation-cdk-dynamodb.md)'s `readSince`).

8. **THESIS — the AI SDK stays thin; the reactive layer carries no control flow.** The WS substrate is a
   pure read/broadcast plane: it never decides, never dispatches, never journals. It moves bytes the
   orchestrator ([G4.3](./phase-g4.3-durable-orchestrator-stepfunctions.md)) and compute
   ([G4.2](./phase-g4.2-compute-lambda-actions.md)) already committed.

9. **The portable consumer core is REUSED, only the adapter is replaced** (locked decision #4). No edits to
   `event-stream.ts` / `agent-reducer.ts` / `agent-store.ts` / hooks — they depend only on the structural
   `onUpdate`/`subscribeEvents` shape. The WS adapter (`ws-transport.ts`) implements that shape; everything
   above it is unchanged.

## Implementation tasks

Ordered so a builder can execute top-to-bottom without re-deriving the design.

1. **`backend/store/eventStore.ts` — the `seq`/`eventIndex` write path (the substrate).**
   - Move `computeStreamKeys` (`emit.ts:20-28`) verbatim (pure; no Convex import).
   - Implement `appendEvents(input)`: `redactEventImages(input)` (port `convex/events/redact.ts` verbatim);
     compute `streamKeys`; allocate `eventIndex = bumpCounter(Events, streamPk(streamKeys[0]), 'SEQCOUNTER')`
     **once**; for each `streamKey`, allocate `seq = bumpCounter(Events, streamPk(streamKey), 'SEQCOUNTER')`
     and `PutItem` the event row at `SK=<seq:N>` carrying `{streamKey, seq, eventIndex, type, runId,
     instanceId, submissionId, session, data, createdAt}` (mirror `emit.ts:46-61`). **The `eventIndex` is
     allocated once; each `seq` is its own counter** (D-AWS-4 / obligation 4).
   - Implement `readSince(streamKey, sinceSeq, limit=256)`: `Query PK=STREAM#<key>, SK > <sinceSeq:N>`
     (mirror `read.ts:24-29`), returning `{events: [...{...data, seq}], nextSeq}`. This is the reconnect
     backfill + the `listForSubmission` GSI1 dedup-by-`eventIndex` path (`read.ts:38-58`).
   - **Never** port `nextSeq`'s read-max+1 (`seq.ts:11-18`).

2. **`backend/store/connectionStore.ts` — Connections/Subscriptions CRUD.**
   - Connections table: `PK=CONN#<connectionId>, SK=META` → `{connectionId, userId?, connectedAt, ttl}`
     (short TTL as a stale-connection backstop).
   - Subscriptions: `PK=SUB#<streamKey>, SK=<connectionId>` → `{streamKey, connectionId, sinceSeq}` so the
     fan-out resolves subscribers by `streamKey` in **one Query**.
   - `putConnection`, `deleteConnection` (+ cascade delete its `Subscriptions` rows — a GSI
     `by_connection` `PK=CONN#<connectionId>` over Subscriptions, or store the reverse key), `putSubscription`,
     `querySubscribers(streamKey)`, `reapStale(connectionId)` (on 410 GoneException).

3. **`backend/handlers/ws/connect.ts` — `$connect`.** Run the closed-by-default authorizer
   ([G4.5](./phase-g4.5-ingress-apigw-auth.md) owns the `authorize()` shape; attach it as a WebSocket
   `$connect` Lambda authorizer or validate the token-in-query-string here). On allow → `putConnection`.
   Return `200`. No subscription yet (that is the `subscribe` frame).

4. **`backend/handlers/ws/subscribe.ts` — the `subscribe` route.** Body `{ref: 'events'|'request',
   streamKey?|requestId?, sinceSeq?}`. `putSubscription` keyed by the resolved `streamKey` (for a
   `request` ref, the logical channel maps to the request's `streamKey(s)`). **Backfill on subscribe:**
   immediately `readSince(streamKey, sinceSeq ?? -1)` and `postToConnection` the catch-up page so a new
   subscriber sees history past its cursor (mirrors `read.ts`'s `sinceSeq` window; replaces Convex's
   first-tick whole-result delivery).

5. **`backend/handlers/ws/disconnect.ts` — `$disconnect`.** `deleteConnection` + cascade-delete its
   `Subscriptions` rows.

6. **`backend/handlers/ws/fanout.ts` — the Streams fan-out Lambda (the core).**
   - Event source: the DynamoDB Streams of `Events`, `Steps`, `Requests`, `Approvals` (4 event-source
     mappings, `StartingPosition.LATEST`, `batchSize` tuned, `bisectBatchOnError` + a DLQ).
   - For each NEW_IMAGE record:
     - **`Events`**: the row already carries `streamKey`, `seq`, `eventIndex`, `data` — derive nothing,
       push the `data` (with `seq`) directly.
     - **`Steps`** (finalized step): skip non-finalized images defensively (only finalized are written, but
       be robust); map `requestId → {instanceId, submissionId, session, runId}` (read off the Steps row or
       a point `GetItem` on `Requests`), derive `computeStreamKeys`, push a finalized-step frame.
     - **`Requests`**: only on a **terminal** status flip (`completed`/`failed`/`cancelled`) push a request
       frame (mirrors `watchRequestToTerminal`, `client.ts:163-176`).
     - **`Approvals`**: on a `pending#`/resolved transition push an approval-card frame
       ([G4.4](./phase-g4.4-hitl-task-tokens.md) drives the writes).
   - `querySubscribers(streamKey)` → for each, `PostToConnectionCommand` via the API Gateway Management API
     client (endpoint = the WS stage callback URL). On **410 GoneException** → `reapStale(connectionId)`.
   - **Idempotent** (Streams are at-least-once): re-pushing the same frame is harmless because the client
     dedups by `seq`/`eventIndex` (obligation 7). Never mutate DynamoDB from the fan-out except the stale-
     connection reap.

7. **`backend/store/wsBroadcast.ts` — `postWsDelta`.** The helper `llmStep`/`deltaBatcher` inject as the
   delta sink (the Lambda-side wiring is [G4.2](./phase-g4.2-compute-lambda-actions.md)). Given
   `{streamKeys, frame}` (a `text_delta`/`thinking_delta` etc. — **no `seq`**), `querySubscribers` and
   `postToConnection`. This is the *only* path delta frames take; they never touch DynamoDB.

8. **`backend/cdk/stacks/reactive-stack.ts` — the WebSocket API + wiring.**
   - `new apigatewayv2.WebSocketApi` with `routeSelectionExpression: '$request.body.action'`; routes
     `$connect` (→ connect Lambda + `WebSocketLambdaAuthorizer`), `$disconnect`, `subscribe`,
     and a `$default` (optional, for malformed frames).
   - `new apigatewayv2.WebSocketStage` (`autoDeploy: true`); export the callback URL
     (`https://{apiId}.execute-api.{region}.amazonaws.com/{stage}`) for `postToConnection` clients.
   - The `Connections` + `Subscriptions` tables (or reuse a single table with the two key shapes).
   - The fan-out Lambda + four `DynamoEventSource` mappings (Steps/Events/Requests/Approvals streams from
     G4.1; import the table stream ARNs).
   - IAM: fan-out + `postWsDelta` callers get `execute-api:ManageConnections` on the WS API ARN, `dynamodb:Query`
     on Subscriptions, `dynamodb:GetItem` on Requests/Steps; connect/subscribe get `dynamodb:PutItem`/`Query`
     on Connections/Subscriptions; the four stream consumers get
     `dynamodb:GetRecords/GetShardIterator/DescribeStream/ListStreams` on the source streams.

9. **Client retarget — `src/sdk/ws-transport.ts` (the WS `CoveConvexClient`).** Implement the structural
   `CoveConvexClient` ([`types.ts:33-42`](../../../src/sdk/types.ts)) over a raw `WebSocket`:
   - `onUpdate(ref, args, callback, onError)`: open/reuse the socket, send a `subscribe` frame
     `{action:'subscribe', ref, ...args}` (where `ref` is the logical channel `events`|`request` and
     `args` carries `{streamKey|requestId, sinceSeq}`), demux incoming frames by `ref`+key to the right
     callback, return an unsubscribe that sends an `unsubscribe` frame. **Reconnect:** on socket close,
     re-open and re-issue `subscribe` from the last delivered `sinceSeq` to backfill (WS is lossy;
     obligation 7). The callback receives the **same `{events, nextSeq}` page shape** the SDK
     `event-stream.ts` expects (`event-stream.ts:22-26`) — so `createCoveEventStream` is unchanged.
   - `mutation`/`query`: route to the REST API ([G4.5](./phase-g4.5-ingress-apigw-auth.md)) — the WS
     transport handles only the reactive read; submit/poll stay HTTP.

10. **`src/react/client-types.ts` — `createReactiveClientFromWebSocket(url, {getAuthToken})`.** Mirror
    `createReactiveClientFromConvex` (`client-types.ts:78-135`) but build the client off the WS transport:
    `agents.send` → HTTP `admit`; `subscribeEvents(streamKey, listener, {sinceSeq})` → the WS `onUpdate`
    adapter, keeping the **identical cursor logic** (`client-types.ts:104-128`: track `cursor`, forward
    only `seq > cursor`, the reducer's `recentEventIds` is the second line). Keep the old
    `createReactiveClientFromConvex` export until [G4.8](./phase-g4.8-tests-parity-cutover.md) deletes the
    Convex deps.

11. **Delete `patchStreaming` and rewire the batcher sink.** Remove
    `convex/engine/steps.ts`'s `patchStreaming` (`steps.ts:72-91`) at the move into `backend/`; the
    `deltaBatcher` sink is `postWsDelta`, injected by `llmStep`
    ([G4.2](./phase-g4.2-compute-lambda-actions.md)). `insertStreaming`/`finalizeStep`/`appendToolResult`
    stay (journal writes; G4.2).

12. **Wire the terminal-frame push for the reactive `?wait=result` path.** The Requests Stream → fan-out
    request-terminal frame is what lets a reactive caller resolve a prompt without the bounded HTTP poll
    (the HTTP poll parity is [G4.5](./phase-g4.5-ingress-apigw-auth.md)). `watchRequestToTerminal`
    (`client.ts:138-178`) consumes it over the `request` channel.

13. **Tests** (full gate in [G4.8](./phase-g4.8-tests-parity-cutover.md)): atomic-counter race test (N
    parallel `appendEvents` → gap-free `{0..N-1}` per stream, same `eventIndex` across fan-out rows);
    fan-out idempotency (re-deliver a Stream record → client sees the event once); the existing
    `src/sdk/__tests__/event-stream.test.ts` + `src/react/__tests__/agent-reducer.test.ts` +
    `agent-store.test.ts` run **unchanged** against the WS adapter (proves portability).

## Acceptance

Objective bars — what proves the phase done, each mirroring the Convex behavior replaced:

1. **Live push parity.** Subscribing to a `streamKey` over WS and running an agent turn delivers the same
   ordered `CoveEvent` sequence (by `seq`) the Convex `listForStream` reactive query
   ([`read.ts`](../../../convex/events/read.ts)) delivered — verified by feeding the WS frames through the
   **unchanged** `createCoveEventStream` and asserting the event order/content matches the convex-test
   fixture.
2. **Seq is gap-free and race-safe (D-AWS-4).** N concurrent `appendEvents` against one `streamKey` produce
   `seq` values `{0..N-1}` with no collision or gap; a multi-streamKey emit writes the **same** `eventIndex`
   to every fan-out row while each row's `seq` is independent (matches `emit.ts:44-61`).
3. **No per-token DynamoDB writes (locked decision #2 / D-AWS-3).** A streamed turn produces N
   `postToConnection` delta frames (no `seq`) and exactly **one** `Steps` write (the finalized step); the
   `Steps` Stream emits **one** record for that step — zero per-delta DynamoDB writes and zero per-delta
   Stream records. (`patchStreaming` no longer exists.)
4. **Finalized step is the source of truth.** Killing the WS mid-stream (dropping delta frames) and then
   delivering only the finalized-step frame reconstructs the same final assistant message in the reducer —
   proving deltas are render-only and the finalized step reconciles (`agent-reducer.ts:129/188`).
5. **Reconnect backfill (WS lossy → no gaps).** Disconnecting after `seq=k`, missing events `k+1..k+m`
   while down, then reconnecting re-issues `subscribe` from `sinceSeq=k` and the `readSince` backfill
   delivers `k+1..k+m` exactly once (the `currentSeq` cursor + `recentEventIds` dedup any overlap).
6. **Stale-connection reaping.** A `postToConnection` returning **410 GoneException** deletes the
   `Connections` row + its `Subscriptions` (no orphaned fan-out targets accumulate).
7. **Submission fan-out dedup preserved.** Subscribing to a `submissionId` (events fanned across
   `instanceId` + `${instanceId}:${session}`) yields each event **once**, deduped by `eventIndex`
   (parity with `listForSubmission`, `read.ts:46-51`).
8. **Portable core untouched.** `src/sdk/__tests__/event-stream.test.ts`,
   `src/react/__tests__/agent-reducer.test.ts`, and `agent-store.test.ts` pass **with no source edits** to
   `event-stream.ts`/`agent-reducer.ts`/`agent-store.ts` — only the transport differs (locked decision #4).
9. **Terminal frame resolves a prompt.** `agents.prompt` over the WS client resolves on the Requests Stream
   terminal flip without any HTTP poll (parity with `watchRequestToTerminal`, `client.ts:138-178`).
10. **Approval-card liveness.** An `Approvals` write (park / resolve, [G4.4](./phase-g4.4-hitl-task-tokens.md))
    pushes an approval frame to the request's subscribers — the live approval-card UI updates without a
    reactive query.

## Risks & gotchas

- **Seq determinism is the sharpest ordering risk (D-AWS-4, top-3 spine risk).** If any writer assigns
  `seq` non-atomically (a regression to read-max+1, or two parallel Map states racing), the SK collides or
  gaps and breaks **both** the SDK `currentSeq` cursor and replay ordering. `bumpCounter`
  ([G4.1](./phase-g4.1-foundation-cdk-dynamodb.md)) is the **only** sanctioned path; the parity test guards
  it. `eventIndex` must be allocated **once** from the primary stream and reused across the fan-out — a
  per-row `eventIndex` silently re-orders consumer dedup.
- **DynamoDB Streams latency + at-least-once + per-shard ordering.** Streams have ~1s latency, deliver
  at-least-once, and are ordered only per shard. The fan-out Lambda **must** be idempotent (it is — it only
  pushes; the client dedups). Cross-shard ordering is NOT guaranteed, which is exactly why the durable
  `seq`/`eventIndex` (not Stream arrival order) is the ordering authority. Do not derive order from Stream
  delivery.
- **WS is lossy on reconnect (unlike Convex whole-result re-delivery).** Convex re-sent the entire current
  result every tick, so a reconnect self-healed. WS drops frames while disconnected — the client **must**
  re-issue `subscribe` from `sinceSeq` and the server **must** backfill via `readSince`. Forgetting the
  backfill silently loses events on every reconnect.
- **Delta frames carry NO `seq` — never let a client treat them as durable.** They are render-only; if a
  client mistakenly advances its cursor on a delta, it will skip the finalized event. The frame schema must
  make delta frames structurally distinct (no `seq` field) from seq'd events so the
  `event-stream.ts` `seqOf` (`event-stream.ts:103`) returns `-1` and they are never cursor-advancing.
- **`postToConnection` 29s / payload limits.** A single `postToConnection` payload is capped (128 KB); a
  large backfill page must be chunked. Frame the `readSince` backfill in bounded pages (the `limit=256` /
  `DEFAULT_LIMIT` in `read.ts:12`).
- **Connection table growth / TTL.** Without a TTL backstop and 410-reaping, the `Connections`/
  `Subscriptions` tables accumulate dead rows (a client that vanished without `$disconnect`). Set a TTL on
  Connections and reap on 410 — both, because either alone leaks.
- **Subscriber resolution for non-`Events` streams.** `Steps`/`Requests`/`Approvals` NEW_IMAGEs don't carry
  `streamKey` — the fan-out must map `requestId → instanceId/session/runId` to call `computeStreamKeys`. A
  cheap point `GetItem` on `Requests` (or denormalizing those fields onto the Steps/Approvals rows at write
  time in [G4.2](./phase-g4.2-compute-lambda-actions.md)/[G4.4](./phase-g4.4-hitl-task-tokens.md)) avoids a
  per-record join — prefer denormalization to keep the fan-out hot path a single Query.
- **Fan-out concurrency vs. `postToConnection` throughput.** A burst of finalized steps across many active
  runs can fan out widely; cap fan-out Lambda concurrency and batch `postToConnection` per subscriber set,
  or a thundering herd throttles the Management API.
- **The `$connect` authorizer must be closed-by-default too.** The WS authorizer reuses the same inverted
  open→closed `authorize()` hook as the REST authorizer (D-AWS-6, [G4.5](./phase-g4.5-ingress-apigw-auth.md));
  a missing policy must **deny** the WS handshake, not silently allow an unauthenticated subscriber to read
  another tenant's stream. This is a cutover behavior change — flag it on the
  [G4.8](./phase-g4.8-tests-parity-cutover.md) checklist.
- **Don't re-introduce a write-per-token by accident.** The temptation to also persist the streaming row
  (so a late HTTP poller sees in-flight text) re-creates the exact storm D-AWS-3 removed. In-flight text is
  WS-only by design; HTTP callers see the finalized step (or the bounded `?wait=result` poll, G4.5).
