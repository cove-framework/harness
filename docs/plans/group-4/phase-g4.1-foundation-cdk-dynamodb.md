# Phase G4.1 — Foundation — CDK scaffold + DynamoDB data model + S3 + IAM

> Stand up the single consolidated `backend/` folder, the AWS CDK (TypeScript) app skeleton, the **multi-table DynamoDB** data model that realizes all 10 Convex tables + their ~20 indexes, the S3 bucket that replaces Convex `_storage` for large image/payload spill, the IAM baseline, the SSM/Secrets config seam, and the **`store/` adapter layer** that replaces `convex/sessions/{store,persist}.ts` and the `ctx.db` seam. This is the dependency-injection foundation every other group-4 phase binds to.
>
> Design-of-record: shared design spine (`dynamoDesign`, `dynamoTables`, `journalDesign`, decisions **D-AWS-1**, **D-AWS-4**, **D-AWS-7**, **D-AWS-10**, **D-AWS-11**) + the Convex SoR docs [03 — Data Model](../../design/03-data-model-sor.md) and [08 — Conventions & Execution Boundary](../../design/08-conventions-and-execution-boundary.md). Locked decisions #3 (CDK) and #4 (hard cut into `backend/`).

## Goal & scope

This phase delivers the **seam**, not the behavior. Concretely:

- **The `backend/` folder + CDK app skeleton** — one consolidated, hard-cut folder at repo root replacing `convex/` (locked decision #4). `backend/cdk/bin/cove.ts` (CDK app entry) and the empty stack files every later phase fills. G4.1 owns **`data-stack.ts`** in full; it stubs the other six stacks so the app synths from day one.
- **The DynamoDB data model** — the **9 physical tables** (`Sessions`, `Requests`, `Steps`, `Events`, `Approvals`, `Skills`, `Blobs`, `Meta`, `Runs`) with PK/SK + GSIs realizing every access pattern of the 10 logical Convex tables in [`convex/schema.ts`](../../../convex/schema.ts). On-demand billing, point-in-time recovery, **Streams (NEW_IMAGE) enabled on `Steps`/`Events`/`Requests`/`Approvals` only**.
- **The S3 bucket** — replaces `_storage`; holds image bytes `>100 KB` (the `imageChunks.storageId` follow-up that [`convex/sessions/images.ts`](../../../convex/sessions/images.ts) declares but never implemented) **and** the oversized-payload spill (runPlan / responseMessages / large tool results) per **D-AWS-10**.
- **The `store/` adapter layer** — `store/ddb.ts` (DocumentClient singleton + conditional-put / atomic-counter helpers), `store/sessionStore.ts` (replaces `convex/sessions/{store,persist}.ts`), `store/journalStore.ts`, `store/requestStore.ts`, `store/eventStore.ts`, `store/approvalStore.ts`, `store/skillStore.ts`, `store/blobStore.ts`, `store/metaStore.ts`. The pure algorithms move verbatim; only the `ctx.db`/`ctx.storage` calls become DocumentClient calls. **This is the single DI seam** — every portable core (`SessionStore`/`EventStore` ports, `RunLoopDeps`, `DecodeDeps`, `DispatchDeps`) wires to a `store/` impl in a Lambda handler; nothing above the port imports the AWS SDK, nothing below it imports the AI SDK.
- **IAM baseline + config seam** — per-table least-privilege managed policies the compute stack (G4.2) attaches to Lambda roles; SSM Parameter Store / Secrets Manager parameters for provider keys, the `@upstash/box` token, and channel signing secrets.

**Out of scope** (owned elsewhere — cross-linked, never duplicated here):
- The task-worker Lambdas that *consume* `store/` → [G4.2](./phase-g4.2-compute-lambda-actions.md).
- The Step Functions state machine that drives them + the journal-replay control flow → [G4.3](./phase-g4.3-durable-orchestrator-stepfunctions.md).
- HITL task-token park/resolve over the `Approvals` table → [G4.4](./phase-g4.4-hitl-task-tokens.md).
- The REST API + closed authorizer + `admit`/`poll` → [G4.5](./phase-g4.5-ingress-apigw-auth.md).
- The WebSocket API + `Connections`/`Subscriptions` table + Streams fan-out Lambda (G4.1 only **enables** the Streams; the consumer is G4.6) → [G4.6](./phase-g4.6-reactive-websocket-streaming.md).
- The atomic-counter `seq`/`eventIndex` *write logic* in `eventStore` is exercised by → [G4.6](./phase-g4.6-reactive-websocket-streaming.md); G4.1 only ships the `Events` table shape + the `SEQCOUNTER` item convention + the `ADD :1` helper.
- Channel webhook routes + `Meta` dedup write path → [G4.7](./phase-g4.7-channels-workflows-scheduler.md).
- The cutover that **deletes** `convex/` + `@convex-dev/workflow` + `@convex-dev/workpool` + the `convex` dependency → [G4.8](./phase-g4.8-tests-parity-cutover.md).

## Dependencies

- **None within group-4** — G4.1 is the root of the build order (`G4.1 → G4.2 → G4.3 → {G4.4, G4.7}`, with G4.5/G4.6 branching off G4.1/G4.3).
- **Inbound contracts from the Convex tree** (the behavior this phase must preserve): the schema in [`convex/schema.ts`](../../../convex/schema.ts); the session-store algorithms in [`convex/sessions/store.ts`](../../../convex/sessions/store.ts) + [`convex/sessions/persist.ts`](../../../convex/sessions/persist.ts); the pure image pipeline in [`convex/sessions/images.ts`](../../../convex/sessions/images.ts) (already declared `Pure / V8-safe`, moves verbatim); the `seq` allocator in [`convex/events/seq.ts`](../../../convex/events/seq.ts) and fan-out in [`convex/events/emit.ts`](../../../convex/events/emit.ts) (the read-max+1 logic G4.1 **must not port as-is** — see D-AWS-4).
- **Tooling**: AWS CDK v2 (TypeScript), `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (DocumentClient), `@aws-sdk/client-s3`, `@aws-sdk/client-ssm` / `client-secrets-manager`. ULID generator (`ulid` or `ulidx`) for surrogate ids.

## Deliverables

| # | Deliverable | Path |
|---|---|---|
| 1 | CDK app entry + synth-clean skeleton | `backend/cdk/bin/cove.ts`, `backend/cdk/cdk.json` |
| 2 | **Data stack** (9 tables + GSIs + Streams + S3 + SSM/Secrets) | `backend/cdk/stacks/data-stack.ts` |
| 3 | Empty stub stacks (synth, no resources yet) | `backend/cdk/stacks/{compute,orchestrator,ingress,reactive,channels}-stack.ts` |
| 4 | DocumentClient singleton + helpers (conditional put, atomic counter) | `backend/store/ddb.ts` |
| 5 | `sessionStore` (replaces `convex/sessions/{store,persist}.ts`) | `backend/store/sessionStore.ts` |
| 6 | `journalStore` / `requestStore` / `eventStore` / `approvalStore` / `skillStore` / `blobStore` / `metaStore` | `backend/store/*.ts` |
| 7 | Portable image pipeline moved verbatim | `backend/engine/images.ts` (from `convex/sessions/images.ts`) |
| 8 | S3 bucket construct + presign helper | in data-stack + `backend/store/blobStore.ts` |
| 9 | IAM per-table managed policies (exported for G4.2 to attach) | `data-stack.ts` exports |
| 10 | SSM/Secrets config seam + a `config.ts` reader | `backend/store/metaStore.ts` env wiring + `data-stack.ts` params |
| 11 | Key-encoding helpers (ULID, zero-pad, prefix conventions) | `backend/store/keys.ts` |

## Source map

| Convex source (replaced) | New AWS file(s) | Notes |
|---|---|---|
| [`convex/schema.ts`](../../../convex/schema.ts) (`defineSchema`, 10 tables, ~20 indexes) | `backend/cdk/stacks/data-stack.ts` | `defineTable`+`.index(...)` → `dynamodb.Table` + `addGlobalSecondaryIndex`. |
| [`convex/sessions/store.ts`](../../../convex/sessions/store.ts) (`getOrCreate`/`load`/`appendUserPrompt`/`appendToolResults`/`appendCompactionEntry`/`deleteSession`/`exists`/`remove`) | `backend/store/sessionStore.ts` | Pure algos kept; `ctx.db.query.withIndex` → `Query`, `ctx.db.insert`/`.patch` → conditional `PutItem`/`UpdateItem`. |
| [`convex/sessions/persist.ts`](../../../convex/sessions/persist.ts) (`loadSessionData`/`appendCanonicalEntry`/`persistCustomEntries`/`cascadeDeleteSession`/`releaseImageRefs`/`generateAffinityKey`) | `backend/store/sessionStore.ts` (+ `keys.ts`) | The O(new) diff-sync + cascade-delete + refCount accounting; `position` read-max+1 (`persist.ts:138-143`) → **atomic counter item** `SK=ENTCOUNTER`. |
| [`convex/sessions/images.ts`](../../../convex/sessions/images.ts) (`extractEntryImages`/`hydrateEntryImages`/`defaultImageHash`/`redactImageBlocks`/`INLINE_IMAGE_THRESHOLD`) | `backend/engine/images.ts` (verbatim) + `backend/store/blobStore.ts` (S3 spill) | Module is already `Pure / V8-safe`; only the persistence wrapper changes. The `storageId` follow-up (`images.ts:18`, `persist.ts:157`) finally lands as `Blobs.s3Key` → S3. |
| [`convex/events/seq.ts`](../../../convex/events/seq.ts) `nextSeq` (read-max+1) | `backend/store/eventStore.ts` (`SEQCOUNTER` atomic counter) | **D-AWS-4** — the single-writer read-max+1 is NOT safe on DynamoDB; replaced by `UpdateItem ADD seq :1 RETURN_VALUES UPDATED_NEW`. Write path is G4.6; table shape + helper land here. |
| [`convex/events/emit.ts`](../../../convex/events/emit.ts) `appendEvents` (`eventIndex` from primary stream, `emit.ts:45-48`) | `backend/store/eventStore.ts` | `events` table → `Events` table shape; `eventIndex`-once-then-reused contract preserved. |
| `ctx.storage` / `imageChunks.storageId` (`_storage`) | S3 bucket (`images/<hash>`) + `Blobs.s3Key` pointer | per `surfaceMapping`, phase G4.1. |
| `ctx.db.get/insert/patch/query.withIndex` (everywhere) | `backend/store/ddb.ts` DocumentClient `GetItem`/`PutItem`/`UpdateItem`/`Query` | the replaced Convex **adapter seam**. |
| `convex/convex.config.ts` (`app.use(workflow)`) | *(deleted at cutover, no port)* | The `@convex-dev/workflow` + `@convex-dev/workpool` components are deleted in [G4.8](./phase-g4.8-tests-parity-cutover.md); their durable-loop role moves to Step Functions ([G4.3](./phase-g4.3-durable-orchestrator-stepfunctions.md)). |

## DynamoDB data model (the core deliverable)

**Decision D-AWS-1: MULTI-TABLE** (one table per aggregate), not single-table. Rationale (spine): access patterns are overwhelmingly per-aggregate; the one cross-aggregate read (`agentRequests.sessionId` → session) is a point `GetItem` by stored FK, never a collection scan; Streams must be per-table and only 4 tables feed the WS fan-out; per-aggregate TTL (only `Meta`) and least-privilege IAM are cleaner; on-demand billing makes extra tables ~free.

### Key conventions (`backend/store/keys.ts`)
- **ULID** for surrogate ids (replaces Convex `_id`), monotonic + lexically sortable.
- **Deterministic prefixed ids are PRESERVED** for idempotency — `u-${requestId}` (user prompt, `store.ts:63` / `admit.ts:136`), `t-${requestId}-${stepNumber}-${toolCallId}` (tool result, `store.ts:88`), `a-`/`f-`/`x-` entries. These are **never** switched to random ids on the write path; they are the idempotency keys that make at-least-once SFN Task retries safe.
- `stepNumber`/`position`/`seq` are stored **zero-padded** as the numeric portion of the SK where range ordering matters (e.g. `STEP#0000000007`).
- **Every create-once write** uses `ConditionExpression attribute_not_exists(pk)` (or `(SK)`) — the DynamoDB analogue of Convex's `.unique()`-then-insert idempotency (`store.ts:30-39`, `persist.ts:89-93`/`123-127`).
- **Monotonic counters** (`Events.seq`, `Sessions` entry `position`) use an **atomic counter item** (`UpdateItem ADD :1 RETURN_VALUES UPDATED_NEW`), **NOT** read-max+1 — because DynamoDB lacks the single-writer serialization Convex relied on (`seq.ts:11-18`, `persist.ts:138-143`). **D-AWS-4 / D-AWS-7.**

### The 9 physical tables (10 logical Convex tables folded in)

| Table | PK / SK | GSIs | Realizes (Convex) | Stream |
|---|---|---|---|---|
| **Sessions** | `PK=SESS#<sessionId>` · `SK ∈ {HEADER, ENT#<paddedPosition>, EID#<entryId>, ENTCOUNTER}` | GSI1 `by_instance_harness_session` (`PK=INST#<instanceId>#<harnessName>, SK=<sessionName>`); GSI2 `by_instance` (`PK=INST#<instanceId>, SK=createdAt`); GSI3 `by_session_and_entry` (`PK=SESS#<sessionId>, SK=EID#<entryId>`) | `sessions` + `sessionEntries` (folded). `runPlan` frozen on `HEADER` (spill to S3 if >300 KB) | — |
| **Requests** | `PK=REQ#<requestId>` · `SK=META` | GSI1 `by_session` (`PK=SESS#<sessionId>, SK=createdAt`); GSI2 `by_session_and_status` (`PK=SESS#<sessionId>#<status>, SK=createdAt`); GSI3 `by_submission` (`PK=SUB#<submissionId>`); GSI4 `by_instance` (`PK=INST#<instanceId>, SK=createdAt`) | `agentRequests`. Holds `executionArn` (was `convexWorkflowId`), `status`, `replyContext`, `repliedAt`, usage rollups | **yes** |
| **Steps** | `PK=REQ#<requestId>` · `SK ∈ {STEP#<paddedStepNumber>, STEP#<n>#TR#<toolCallId>}` | (none) | `agentRequestSteps` (the journal). Base `GetItem` = `.unique()`; `Query begins_with STEP#` = usage/outcome rollup. **Only finalized steps persisted** (deltas → WS) | **yes** |
| **Events** | `PK=STREAM#<streamKey>` · `SK ∈ {<seq:N>, SEQCOUNTER}` | GSI1 `by_submission` (`PK=SUB#<submissionId>, SK=<eventIndex:N>`) | `events` + `meta(seq)`. `Query SK>since`; `seq`/`eventIndex` via atomic counter | **yes** |
| **Approvals** | `PK=REQ#<requestId>` · `SK=<status>#<toolCallId>` | GSI1 `by_session_and_status` (`PK=SESS#<sessionId>#<status>`); GSI2 `by_toolCall` (`PK=TC#<toolCallId>` — carries `taskToken`) | `approvals`. `Query begins_with pending#`; resolve = conditional `UpdateItem` | **yes** |
| **Skills** | `PK=SKILL#<slug>` · `SK=META` | GSI1 `by_isActive` (`PK=ACTIVE#<0|1>, SK=slug`) | `skills`. `by_slug`=`GetItem`, `by_isActive`=`Query` | — |
| **Blobs** | `PK=HASH#<hash>` · `SK=META` | (none) | `imageChunks`. `refCount` via `ADD`; GC via conditional `DeleteItem` (`refCount<=1`); bytes >100 KB in S3 via `s3Key`, inline base64 below | — |
| **Meta** | `PK=<key>` · `SK=META` | (none) | `meta` + webhook dedup ledger. `markWebhookSeen` = conditional Put `attribute_not_exists` + **TTL** | — |
| **Runs** | `PK=RUN#<runId>` · `SK=META` | GSI1 `by_agent` (`PK=AGENT#<agentName>, SK=startedAt`); GSI2 `by_instance` (`PK=INST#<instanceId>, SK=startedAt`) | `runs` (inspect surface). NB: the run-row **writer is new** (G2.4/D18 pending) — wired from the SFN execution lifecycle in [G4.3](./phase-g4.3-durable-orchestrator-stepfunctions.md), not ported | — |

> **Why `Runs` is separate from `Events`/`Requests`**: the spine folds `runs` + `events` + `meta(seq)` such that `Events` is dedicated to the seq'd event log and `Runs` is its own small inspect-surface table (the `by_run`/`by_agent`/`by_instance` access of [`convex/runs.ts`](../../../convex/runs.ts)). That is why "10 logical → 9 physical": the two entry-tree tables (`sessions`+`sessionEntries`) fold into **Sessions**, and `runs`/`events`/`meta` each get their own table.

### Streams
`StreamViewType.NEW_IMAGE` on **Steps, Events, Requests, Approvals** only → consumed by the single fan-out Lambda in [G4.6](./phase-g4.6-reactive-websocket-streaming.md). `Sessions`/`Skills`/`Blobs`/`Meta`/`Runs` have **NO** stream (no live-UI need). Because only **finalized** step items are written to `Steps` (locked decision #2 — deltas broadcast over WS), the `Steps` stream carries ~1 record/step, not per-token — this is what eliminates the `patchStreaming` write-storm (`agentRequestSteps` `text`/`reasoning` are patched ~10-20×/turn today, schema.ts:266-267).

### S3 + the spill pattern (D-AWS-10)
One S3 bucket (`backend/cdk` `s3.Bucket`, SSE, versioned-off, lifecycle to expire orphaned spill). Two uses:
1. **Image bytes >100 KB** — `INLINE_IMAGE_THRESHOLD = 100 * 1024` (`images.ts:19`); below it, inline base64 in `Blobs.data`; above it, `PutObject images/<hash>` and store `Blobs.s3Key`. This is the documented-but-unbuilt `_storage` follow-up (`images.ts:18`, `persist.ts:157`).
2. **Oversized payloads** — frozen `runPlan` (tool descriptors + system prompt + extension manifest, `schema.ts:45-77`) and verbatim `responseMessages` (`schema.ts:299-307`) and large tool results can breach the **400 KB DynamoDB item** / **256 KB SFN-state** limits → spill the body to `s3://.../spill/<requestId>/<...>` and store a pointer. The `store/` read path transparently follows the pointer.

## Hardened-contract obligations

This phase is the foundation, so it must lay down the invariants every later phase relies on. Each maps to a design-of-record contract and to the THESIS.

1. **Replay-reconstructable, never re-derived from live mutable state** (THESIS). The data model must let every step read the **frozen `runPlan`** (on the Sessions `HEADER` item) + the **journaled `Steps`** and nothing else. `Setup` (G4.2) freezes `runPlan`; G4.1 guarantees the `HEADER` item shape (and S3 spill) can hold it. Mirrors how Convex froze the plan at admission so "replay never drifts" (schema.ts:40-44, loop.ts header).
2. **Idempotency by `(requestId, stepNumber, op)`** (D-AWS-7, `journalDesign`). The key encodings (`STEP#<n>`, `STEP#<n>#TR#<toolCallId>`, `EID#<entryId>`, `u-`/`t-`/`a-`/`f-` prefixes) and the conditional-write helpers in `ddb.ts` are the load-bearing substrate for the replay guards in G4.2/G4.3. G4.1 must ship `putIfAbsent(pk, sk, item)` and `updateItem` helpers that surface the `ConditionalCheckFailedException` so callers can treat it as "already done" (the Convex `.unique()`-then-insert idempotency of `store.ts:30-39`, `persist.ts:93`/`127`).
3. **Atomic monotonic counters** (D-AWS-4, the sharpest correctness risk after HITL). `ddb.ts` must expose `bumpCounter(table, pk, sk) → number` implemented as `UpdateItem ADD <attr> :1 RETURN_VALUES UPDATED_NEW`. The `Events.SEQCOUNTER` and `Sessions.ENTCOUNTER` items use it. **No code path may port `nextSeq`'s read-max+1** (`seq.ts:11-18`) or `persist.ts`'s `(last?.position ?? -1) + 1` (`persist.ts:143`, `store.ts:163`) — concurrent emits would collide on the SK and break replay ordering + the SDK seq-cursor.
4. **`eventIndex` allocated once, reused across fan-out** (`emit.ts:45-48`). The `Events` table + `eventStore` must preserve: `eventIndex` = the **primary** streamKey's counter value, then the SAME `eventIndex` is written to every fan-out row, while each row's own `seq` is its own counter. G4.1 ships the shape + helper; the write loop is G4.6.
5. **Content-addressed image dedup with refCount** (THESIS: deterministic, replay-safe). `Blobs.refCount` via `UpdateItem ADD refCount :1`; reclaim via conditional `DeleteItem (refCount<=1)`. Preserves the exact dedup semantics of `persist.ts:158-174` + `releaseImageRefs` (`persist.ts:234-248`), but race-safe under at-least-once retries (the Convex read-then-patch refCount was single-writer-safe; the conditional-ADD version is not).
6. **Cascade-delete guard survives** (`persist.ts:184-232`). `sessionStore.deleteSession` must still BFS over `taskSessions`, **refuse while any descendant has a `pending`/`running` request** (the `by_session_and_status` query, `persist.ts:209-219`), and decrement image refs — now via the `Requests` GSI2 `by_session_and_status` and `Blobs` `ADD -1`.
7. **The `store/` layer is the ONLY AWS-SDK importer below the port** (spine `backendFolder`). The portable cores (`engine/`, `runtime/`, `channels/`, `registries/`) must remain AWS-free; the DI ports (`SessionStore`/`EventStore`/`RunLoopDeps`/`DecodeDeps`/`DispatchDeps`) bind to `store/` impls **in the Lambda handler** (G4.2), not inside the core. G4.1 defines the port interfaces so G4.2 can wire them.
8. **No durable-loop / HITL / sandbox logic in this phase** (THESIS: AI SDK stays thin; orchestrator owns the loop). G4.1 introduces no control flow — it is pure data + adapter. The loop stays in Step Functions ([G4.3](./phase-g4.3-durable-orchestrator-stepfunctions.md)).

## Implementation tasks

Ordered so a builder can execute without re-deriving the design.

1. **Scaffold `backend/`** at repo root. Create `backend/cdk/`, `backend/store/`, `backend/engine/`, `backend/runtime/`, `backend/channels/`, `backend/registries/`, `backend/handlers/` (empty), `backend/sfn/` (empty). Add `backend/cdk/cdk.json` and `backend/cdk/bin/cove.ts` (the CDK `App`) instantiating all seven stacks (six as stubs).
2. **`backend/store/keys.ts`** — ULID factory; `pad(n)` (zero-pad to fixed width, e.g. 12 digits); prefix builders `sessPk(id)`, `entSk(pos)`, `eidSk(entryId)`, `reqPk(id)`, `stepSk(n)`, `toolResultSk(n, toolCallId)`, `streamPk(key)`, `seqSk(n)`, `tcPk(toolCallId)`, etc. Re-export the preserved deterministic id builders (`u-`, `t-`, `a-`, `f-`, `x-`).
3. **`backend/store/ddb.ts`** — `DynamoDBDocumentClient` singleton (`marshallOptions: { removeUndefinedValues: true }`); helpers: `getItem`, `putIfAbsent` (Condition `attribute_not_exists`), `putOverwrite`, `updateItem`, `query`, `bumpCounter(table, pk, sk, attr='value') → number` (`ADD :1 RETURN_VALUES UPDATED_NEW`), `transactWrite`. Surface `ConditionalCheckFailedException` distinctly.
4. **`data-stack.ts`: the 9 tables.** For each: `new dynamodb.Table` with `billingMode: PAY_PER_REQUEST`, `pointInTimeRecovery: true`, `removalPolicy: RETAIN` (prod) / `DESTROY` (dev via context). PK/SK string attributes per the table above. Add each GSI via `addGlobalSecondaryIndex` (projection `ALL` unless a narrower set is obviously sufficient). Enable `stream: StreamViewType.NEW_IMAGE` on **Steps, Events, Requests, Approvals** only. **`Meta`**: add `timeToLiveAttribute: 'ttl'`.
5. **S3 bucket** in `data-stack.ts` — `new s3.Bucket` (`encryption: S3_MANAGED`, `blockPublicAccess: BLOCK_ALL`, lifecycle rule expiring `spill/` after N days). Export the bucket + table refs as stack outputs/props for the compute stack to consume.
6. **IAM baseline** — in `data-stack.ts`, expose per-table grant helpers (so G4.2's Lambda roles get `dynamodb:GetItem/PutItem/UpdateItem/DeleteItem/Query` scoped to exactly the tables + index ARNs each Lambda touches) and `bucket.grantReadWrite`. Do not create the Lambda roles here — just the grantable resources.
7. **SSM / Secrets config seam** — declare `ssm.StringParameter` / `secretsmanager.Secret` placeholders for: provider keys (Anthropic/OpenAI/Google/Gateway), the `@upstash/box` token, and channel signing secrets (`SLACK_SIGNING_SECRET`, etc. — consumed in [G4.7](./phase-g4.7-channels-workflows-scheduler.md)). Export ARNs; a tiny `config.ts` reads them from Lambda env at runtime.
8. **Move the portable image pipeline** — copy `convex/sessions/images.ts` → `backend/engine/images.ts` **verbatim** (it is already `Pure / V8-safe`); only drop the `convex` type import for the `src/runtime` one. No logic change.
9. **`backend/store/sessionStore.ts`** — port `sessions/store.ts` + `sessions/persist.ts`:
   - `getOrCreate` → GSI1 `GetItem` then conditional `PutItem` of the `HEADER` item (`store.ts:27-56`).
   - `loadSessionData` → `GetItem HEADER` + `Query begins_with ENT#` ordered by SK + hydrate images from `Blobs` (`persist.ts:26-61`).
   - `appendCanonicalEntry` → `bumpCounter(Sessions, sessPk, ENTCOUNTER)` for `position` (replaces `persist.ts:138-143`), conditional `PutItem EID#<entryId>` for idempotency (replaces `persist.ts:123-127`), `Blobs` refCount ADD, `UpdateItem HEADER` leaf advance (`persist.ts:176`).
   - `appendToolResults` (`store.ts:68-94`), `appendCompactionEntry` (`store.ts:126-187` — note: replace the random-`entryId` clash loop with a deterministic id derived from `(sessionId, firstKeptEntryId)` so compact is replay-idempotent, per `journalDesign`), `persistCustomEntries`, `cascadeDeleteSession` + `releaseImageRefs`.
10. **`backend/store/journalStore.ts`** — `agentRequestSteps` reads/writes: `loadStep(requestId, stepNumber)` (`GetItem`), `insertStreaming` (conditional Put), `finalizeStep`/`finalizeOverflowStep` (`UpdateItem`), `appendToolResult` (idempotent `UpdateItem` on `STEP#<n>#TR#<toolCallId>`), `Query begins_with STEP#` rollup. (Write callers are G4.2/G4.3; G4.1 ships the store.)
11. **`backend/store/requestStore.ts`** — `agentRequests` CRUD over the `Requests` table + GSIs; `cancelActiveRequests` query via GSI2 `by_session_and_status` (`admit.ts:60-84`).
12. **`backend/store/eventStore.ts`** — `appendEvents` shape with `bumpCounter` for `seq` and the **`eventIndex`-once** rule (`emit.ts:35-62`); `readSince(streamKey, sinceSeq)` `Query SK>since`. Counter logic lands here; the WS write path is G4.6.
13. **`backend/store/approvalStore.ts`** — park (conditional Put `pending#<toolCallId>`), resolve (conditional `UpdateItem status=pending`), `listPending` (`Query begins_with pending#`), `by_toolCall` GSI lookup carrying `taskToken`. (Park/resolve callers are G4.4.)
14. **`backend/store/{skillStore,blobStore,metaStore}.ts`** — skills CRUD + `by_isActive`; blob inline-vs-S3 spill + refCount; meta kv + `markWebhookSeen` conditional-Put-with-TTL (`Meta`).
15. **Define the port interfaces** (`backend/store/ports.ts` or co-located) — `SessionStorePort`, `EventStorePort`, etc., matching the existing `RunLoopDeps`/`DecodeDeps`/`DispatchDeps` shapes so G4.2 wires them in handlers.
16. **`cdk synth`** must succeed; **`cdk diff`** shows the 9 tables + GSIs + 4 streams + bucket + params with no errors. Add a CDK assertion test (`@aws-cdk/assertions`) snapshotting the table/stream/GSI set.

## Acceptance

Objective bars — what proves the phase done, mirroring the Convex behavior replaced:

- **Synth/diff clean.** `cdk synth` produces a template with exactly the 9 tables, their GSIs (Sessions×3, Requests×4, Events×1, Approvals×2, Skills×1, Runs×2), **Streams enabled on exactly Steps/Events/Requests/Approvals**, one S3 bucket, and the SSM/Secrets params. A CDK assertion test pins this set.
- **Access-pattern parity.** A `store/` unit suite (aws-sdk-client-mock or DynamoDB Local) proves every Convex index from [`convex/schema.ts`](../../../convex/schema.ts) has a working query: `by_instance_harness_session` (Sessions GSI1 `GetItem`), `by_instance`, `by_session_and_position` (ordered `Query`), `by_session_and_entry`, `by_session`, `by_session_and_status`, `by_submission`, `by_request_and_step`, `by_stream_and_seq`, `by_toolCall`, `by_slug`, `by_isActive`, `by_hash`, `by_key`, `by_run`, `by_agent`.
- **Session round-trip parity.** `getOrCreate` → `appendCanonicalEntry` (×N with images) → `loadSessionData` reconstructs the **same hydrated `SessionData` v6** (entries in `position` order, leaf advanced, images rehydrated) as the Convex `sessions/persist.ts` path — verified against the existing `convex/sessions/__tests__` fixtures ported.
- **Idempotency proven.** Re-running `appendCanonicalEntry` with the same `entryId`, `appendToolResult` with the same `toolCallId`, and a create-once `PutItem` are all **no-ops** (ConditionalCheckFailed swallowed) — the at-least-once-retry guarantee that replaces Convex `.unique()`-then-insert.
- **Atomic counters proven race-safe.** Concurrent `bumpCounter` calls return **distinct, gap-free** values (no two callers get the same `seq`/`position`) — the D-AWS-4 invariant. A test fires N parallel bumps and asserts `{0..N-1}` with no collision.
- **`eventIndex`-once preserved.** A multi-streamKey emit writes the **same** `eventIndex` to every fan-out row while each row's `seq` is independent (matches `emit.ts:45-48`).
- **Image dedup + GC.** Two entries referencing the same hash → one `Blobs` row with `refCount=2`; deleting both reclaims it; a >100 KB image lands in S3 with a `s3Key` pointer and rehydrates byte-identical.
- **Cascade-delete guard.** `deleteSession` over a `taskSessions` tree **throws** while a descendant has a `pending`/`running` request and otherwise deletes entries + decrements refs (parity with `persist.ts:184-232`).
- **No AWS SDK above the port.** A lint/grep gate confirms `backend/engine/`, `backend/runtime/`, `backend/channels/`, `backend/registries/` import no `@aws-sdk/*`; only `backend/store/` and `backend/handlers/` do.

## Risks & gotchas

- **Atomic-counter determinism is load-bearing (D-AWS-4).** If any future writer reverts to read-max+1, `seq`/`position` collide under parallel Map states / SFN retries and break both the SDK seq-cursor dedup and replay ordering. The `bumpCounter` helper is the only sanctioned path; the parity test must guard it. This is called out as a top correctness risk in the spine `risks`.
- **`eventIndex` allocation subtlety.** It is the *primary* stream's counter, reused across fan-out rows — not a per-row counter. Mis-implementing this re-orders consumer dedup (`emit.ts:45-48`). The store API should make "allocate eventIndex once, then write rows" the only ergonomic shape.
- **Payload-limit breaches (D-AWS-10).** A large-roster `runPlan` or verbatim `responseMessages` can exceed 400 KB. The S3 spill must be wired in `sessionStore`/`journalStore` reads/writes **before** a big run hits prod, or a `ValidationException: Item size has exceeded the maximum` surfaces only in production. Bake a size check + spill into the store helpers, not the callers.
- **`removeUndefinedValues` vs. Convex optionals.** The Convex schema is full of `v.optional(...)` fields that are simply absent. DynamoDB rejects `undefined` attributes — configure DocumentClient `marshallOptions.removeUndefinedValues: true` and never write `null` where Convex wrote "absent" unless the field is semantically nullable (e.g. `leafId` IS `v.union(v.string(), v.null())`, schema.ts:111 — keep it nullable).
- **Stream-enable is permanent-ish.** Toggling `StreamViewType` on an existing table forces a brief reconfiguration; enabling streams on `Sessions`/`Blobs` "just in case" would funnel non-UI writes into the fan-out (the D-AWS-1 anti-pattern). Enable on exactly the 4 tables.
- **`Runs` table has no writer yet** (G2.4/D18 pending). G4.1 ships the table + GSIs; the writer is new work wired from the SFN execution lifecycle in [G4.3](./phase-g4.3-durable-orchestrator-stepfunctions.md) — flag it in the [G4.8](./phase-g4.8-tests-parity-cutover.md) parity checklist so the inspect surface isn't silently empty after cutover.
- **`RemovalPolicy` on data tables.** Default `RETAIN` for prod data; a stray `DESTROY` (or `cdk destroy`) on the `Sessions`/`Steps`/`Events` tables is irreversible journal loss. Gate `DESTROY` behind a dev-only CDK context flag.
- **GSI projection cost.** `ALL` projection on hot GSIs (e.g. Requests GSI2 `by_session_and_status`) doubles write cost; if a query only needs keys + status, project `KEYS_ONLY`/`INCLUDE`. Tune per access pattern, but never under-project a GSI a query actually reads (DynamoDB silently returns partial items, a subtle correctness bug).
- **Cross-phase coupling on Streams.** G4.1 *enables* the streams but the consumer (fan-out Lambda) is [G4.6](./phase-g4.6-reactive-websocket-streaming.md). Until G4.6 lands, the stream is unconsumed (fine) — but the `NEW_IMAGE`-only choice (no `OLD_IMAGE`) must be set now, because the fan-out emits the **delta** (new item), not a before/after diff.
