# Group 4 — Convex → AWS migration (hard cut)

A **hard migration off Convex onto an AWS-native stack**: the durable agent loop moves from
`@convex-dev/workflow` to **Step Functions STANDARD**; the journal + all aggregates move to
**DynamoDB**; the reactive substrate moves to **API Gateway WebSocket + DynamoDB Streams**;
ingress moves to **API Gateway REST + a Lambda authorizer**; large blobs spill to **S3**; and
everything is provisioned in-repo with **AWS CDK (TypeScript)**. There is **no strangler-fig and
no dual backend** — `convex/` is deleted at cutover and the portable, backend-agnostic core is
reused verbatim; only the Convex **adapter** seam is replaced.

> **Authoritative design** for the Convex implementation lives in [`../../design/`](../../design/)
> (README + 01–08, decisions D1–D19, hardened contracts 08 §3–§4). This group *re-platforms* that
> design onto AWS. Where a hardened contract and an AWS mechanism disagree, the **contract wins** and
> the AWS mechanism is chosen to honor it. Per-phase plans live in this folder (G4.1–G4.8).

---

## Locked decisions (do not revisit)

1. **Durable loop → Step Functions STANDARD.** The pure orchestrator in
   [`convex/engine/loop.ts`](../../../convex/engine/loop.ts) (a `while (stepNumber < maxSteps)`
   loop over a `RunLoopDeps` port) becomes an ASL state machine (Choice/Map states) driving thin
   single-purpose **Lambdas** (`setup`, `llmStep`, `dispatchTools`, `compact`, `finalize`).
   **DynamoDB** holds the per-step journal. HITL uses **task tokens** (`.waitForTaskToken`),
   replacing `@convex-dev/workflow`'s `step.awaitEvent`.
2. **Reactive / live UI → API Gateway WebSocket + DynamoDB Streams.** A Connections table +
   Streams → fan-out Lambda → `postToConnection`. LLM streaming deltas are broadcast over WS;
   **only finalized steps** are persisted to DynamoDB (no write-per-token).
3. **IaC → AWS CDK (TypeScript), in-repo.**
4. **Cutover → HARD replacement.** No strangler-fig, no dual backend, no parallel `convex/`. The new
   backend lives in ONE consolidated `backend/` folder; `convex/`, `@convex-dev/workflow`,
   `@convex-dev/workpool`, and the `convex` dependency are DELETED at cutover. The portable core is
   REUSED — only the Convex adapter layer (`runHandler.ts`, `workflow.ts`, `ctx.db`/`ctx.scheduler`/
   `ctx.storage`, `httpAction`, reactive queries) is replaced.

---

## Convex → AWS surface mapping

Grouped by subsystem; the right column is the owning phase. Every row is a faithful transcription of
a real Convex surface, not a new feature.

### Durable loop & journal (G4.3)
| Convex surface | AWS replacement |
| --- | --- |
| `WorkflowManager` + `workflow.define` + `components.workflow` | Step Functions STANDARD machine (ASL Choice/Map) driving thin Lambdas |
| `step.runAction/runMutation/runQuery` journaled checkpoints | SFN Task states → `setup`/`llmStep`/`dispatchTools`/`compact`/`finalize`; idempotent by `(requestId, stepNumber, op)` |
| [`loop.ts`](../../../convex/engine/loop.ts) pure while-loop + branches | ASL Choice states (Overflow/ZeroTool/Hitl/Result/StepCap/CompactThreshold) + loop counters in SFN state |
| `workflow.start → convexWorkflowId` | `StartExecution(name=submissionId)` → `executionArn` on the Requests item |
| `workflow.cancel` (supersede/stop) | `StopExecution` + conditional `UpdateItem status=cancelled` (DynamoDB authoritative) |

### HITL (G4.4)
| Convex surface | AWS replacement |
| --- | --- |
| `step.awaitEvent` + `workflow.sendEvent` | `.waitForTaskToken` Map state + `park` Lambda + `submitApproval` Lambda `SendTaskSuccess` (two-sided early-submit guard) |
| `approvals` park/applyApproval/listPending/submitApproval | Approvals DynamoDB table (`by_toolCall` carries `taskToken`) + conditional `UpdateItem status=pending` |

### Compute / model boundary (G4.2)
| Convex surface | AWS replacement |
| --- | --- |
| `llmStep` `"use node"` (streamText, `tool()` no execute) | `llmStep` Node Lambda (AI SDK v7, gateway, esbuild); deltas→WS, finalized→DynamoDB |
| `dispatchTools` `"use node"` (`@upstash/box`, `runDispatch`) | `dispatchTools` Lambda; **EC2/Docker container** reattach by stable id (via SSM Run Command); child `task()` → nested `StartExecution.sync` |
| `compact` `"use node"` (generateText) | `compact` Lambda (idempotent on existing CompactionEntry) |
| observability `exportSpans` query + `SpanTreeRecorder` fold (`otel.ts`, `read.ts`) | moved verbatim; `exportSpans` becomes a **pull** Lambda over the `Events` table (parity). A live OTLP **push** exporter is group-5/G5.7 enhancement scope — out of this migration |

### Data plane (G4.1)
| Convex surface | AWS replacement |
| --- | --- |
| `ctx.storage` / `imageChunks` large-blob spill | S3 bucket (`images/<hash>`, presigned-URL hydrate) + `Blobs.s3Key` pointer |
| `defineSchema` 10 tables + ~20 indexes | CDK DynamoDB multi-table (Sessions/Requests/Steps/Events/Approvals/Skills/Blobs/Meta/Runs) + GSIs |
| `ctx.db.get/insert/patch/query.withIndex` | DynamoDB `GetItem`/`PutItem`/`UpdateItem`/`Query` via `store/` DocumentClient adapter |
| `sessions/{store,persist,diff}.ts` | `store/sessionStore.ts` (pure algos kept, `ctx`→DocClient port) |

### Reactive substrate (G4.6)
| Convex surface | AWS replacement |
| --- | --- |
| events `seq` read-max+1 (single-writer) | DynamoDB atomic counter `UpdateItem ADD :1` (per-streamKey `SEQCOUNTER`); `eventIndex` from primary stream once |
| reactive queries (`steps.listForRequest`/`requests.get`/`events.listForStream`/`approvals.listPending`) | DynamoDB Streams → fan-out Lambda → API GW WebSocket `postToConnection` + Connections/Subscriptions table |
| `deltaBatcher.flush` → `patchStreaming` | `deltaBatcher.flush` → `postToConnection` (deltas WS-only, never persisted) |
| `convex/browser` + `convex/react` (SDK transport) | `createReactiveClientFromWebSocket`; event-stream/reducer/hooks portable |

### Ingress & auth (G4.5)
| Convex surface | AWS replacement |
| --- | --- |
| `httpRouter` + `httpAction` (submit/poll/workflows) | API Gateway REST + Lambda proxy (`admit`/`poll`/`submitWorkflow`); `CoveHttpError` mapping portable |
| `runAuthorize` open-by-default hook | API Gateway REQUEST Lambda authorizer **closed-by-default** (no policy ⇒ DENY) |
| `?wait=result` 60 s synchronous poll | bounded <29 s poll Lambda (API GW timeout) OR WS terminal-frame push |

### Channels, workflows & scheduler (G4.7)
| Convex surface | AWS replacement |
| --- | --- |
| `mcp.discover` `"use node"` + per-beat pool | `mcpDiscover` Lambda (pre-Setup Task) + module-level MCP pool in `dispatchTools` container |
| channels/inbound verify→dedup→submit→ack | `inboundChannel` Lambda (portable verify; conditional-Put dedup + TTL) |
| `channels/reply.dispatch` + `repliedAt` guard | terminal Reply SFN Task → `reply` Lambda; conditional `UpdateItem repliedAt` |
| `workflow.invoke` (`kind:'workflow'`) | named `StartExecution` on AgentLoop `{kind:'workflow', target}` |
| `ctx.scheduler.runAfter(0, compact)` ([admit.ts:204](../../../convex/invoke/admit.ts)) | async Lambda `Invoke (InvocationType=Event)`; EventBridge only for future delays |

### Tooling & tests (G4.8)
| Convex surface | AWS replacement |
| --- | --- |
| cove CLI (`npx convex deploy/dev`, `generate-http-entry`) | `cdk deploy/watch`; `init` scaffolds `backend/`; routes declared in CDK not patched |
| `convex-test` suite (412 tests) | Step Functions Local + ASL tests + `aws-sdk-client-mock` + LocalStack; crash-recovery E2E |

---

## DynamoDB data model

**Decision: MULTI-TABLE** (one table per aggregate), NOT single-table (see **D-AWS-1**). The 10
logical Convex tables fold onto **9 physical DynamoDB tables**; the two entry-tree tables
(`sessions` + `sessionEntries`) collapse into **Sessions**, and `runs`/`events`/`meta` get their own
tables. App-generated **ULID** replaces Convex `_id`, but the deterministic prefixed ids
(`u-`/`a-`/`t-`/`f-`/`x-`) are **preserved for idempotency** and never switched to random ids on the
write path. Monotonic counters (`events.seq`, `sessionEntries.position`) use an **atomic counter item**
(`UpdateItem ADD :1 RETURN_VALUES UPDATED_NEW`), NOT read-max+1, because DynamoDB lacks Convex's
single-writer serialization.

| Table | PK / SK shape | Realizes (Convex) |
| --- | --- | --- |
| **Sessions** | `PK=SESS#<id>`, SK ∈ {`HEADER` · `ENT#<pos>` · `EID#<entryId>` · `ENTCOUNTER`} | `sessions` + `sessionEntries` (folded). runPlan frozen on HEADER (spill to S3 if >300 KB). GSI1 by_instance_harness_session, GSI2 by_instance, GSI3 by_session_and_entry |
| **Requests** | `PK=REQ#<id>`, `SK=META` | `agentRequests`. Holds `executionArn` (was `convexWorkflowId`), status, replyContext, usage rollups. GSI1 by_session, GSI2 by_session_and_status, GSI3 by_submission, GSI4 by_instance |
| **Steps** | `PK=REQ#<id>`, `SK=STEP#<paddedN>` (+ `STEP#<n>#TR#<toolCallId>` children) | `agentRequestSteps` (the journal). **Only finalized steps persisted**; tool results as idempotent replace-in-place children |
| **Events** | `PK=STREAM#<key>`, `SK=<seq:N>` (+ `SEQCOUNTER`) | `events` + `meta`(seq). GSI1 by_submission. seq/eventIndex via atomic counter |
| **Approvals** | `PK=REQ#<id>`, `SK=<status>#<toolCallId>` | `approvals`. GSI1 by_session_and_status, GSI2 by_toolCall (**carries `taskToken`**). park = conditional Put; resolve = conditional UpdateItem |
| **Skills** | `PK=SKILL#<slug>`, `SK=META` | `skills`. GSI1 by_isActive |
| **Blobs** | `PK=HASH#<hash>`, `SK=META` | `imageChunks`. refCount via `ADD`; bytes >100 KB → S3 `s3Key`, inline base64 below |
| **Meta** | `PK=<key>`, `SK=META` | `meta` + webhook dedup ledger. `markWebhookSeen` = conditional Put `attribute_not_exists` + **TTL** |
| **Runs** | `PK=RUN#<id>`, `SK=META` | `runs` (inspect surface). GSI1 by_agent, GSI2 by_instance. **Writer is new** (G2.4/D18 pending) — written by the SFN execution lifecycle |

**Streams (NEW_IMAGE)** are enabled on **Steps, Events, Requests, Approvals** only → single fan-out
Lambda → `postToConnection`. Sessions/Skills/Blobs/Meta/Runs have **no stream** (no live-UI need).
Because only finalized step items are written to Steps (locked decision #2), the Steps stream carries
~1 record/step, not per-token.

---

## Step Functions loop-translation

The pure `runAgentLoop(plan, deps)` while-loop ([`loop.ts`](../../../convex/engine/loop.ts)) is
**transcribed** into the ASL STANDARD machine `AgentLoop`. The crucial invariant: states pass only
`{requestId, stepNumber, followUps, overflowRetries}` — the loop-local counters that `loop.ts`
reconstructs deterministically (`let stepNumber/followUps/overflowRetries`, loop.ts:74–77) — and
**every Lambda re-reads the frozen runPlan (Sessions HEADER) + the journaled Steps from DynamoDB**.
Nothing is re-derived from live mutable state. `loop.ts` stays in-repo as the executable **spec** the
ASL is derived from and the parity tests run against (**D-AWS-9**).

| `loop.ts` construct | ASL state(s) |
| --- | --- |
| MCP gate (runHandler.ts:20–24) | **McpDiscoverChoice** → **McpDiscover** Task (roster → DynamoDB, not state payload) |
| `setup` once | **Setup** Task — freezes runPlan, status→running, returns `{maxSteps, maxFollowUps, hasResultSchema, overflowRetryBudget}` |
| `while (stepNumber < maxSteps)` (loop.ts:79) | **StepCapChoice** → **DecideStep** else **FinalizeStepCap** (`failed/step_limit_exceeded`, loop.ts:140–141) |
| `deps.decode(stepNumber)` (loop.ts:80) | **DecideStep** Task (`llmStep`) → returns small `{overflow, toolCallCount, gatedCount, shouldCompact}` |
| `if (decision.overflow)` (loop.ts:86–95) | **OverflowChoice** → **OverflowBudgetChoice** → **CompactRetry** (`overflowRetries++`) else **FinalizeOverflow** |
| zero-tool branch (loop.ts:97–113) | **ZeroToolChoice**: `!hasResultSchema`→**FinalizeFreeform**; else **SettleResultZero**→**ResultChoice** |
| HITL gate (loop.ts:119–122) | **HitlChoice** → **AwaitApproval** Map (`maxConcurrency:1`) else **Dispatch** |
| `deps.dispatch` (loop.ts:123) | **Dispatch** Task — OOB sandbox (EC2/Docker via SSM); child `task()` → nested `StartExecution.sync` |
| result settle (loop.ts:104–105,125–129) | **ResultGateChoice** → **SettleResult** → **ResultChoice** (finished/gave_up/pending) |
| follow-up re-nudge (loop.ts:106–113) | **FollowUpBudgetChoice** → **AppendFollowUp** (`followUps++`) else **FinalizeFollowupsExhausted** |
| threshold compact (loop.ts:131–137) | **CompactThresholdChoice** → **Compact** then `stepNumber++` → **StepCapChoice** |
| post-finalize reply (runHandler.ts:106) | all **Finalize\*** → **Reply** Task → **Succeed** (the ONLY channels touch) |

**Long-run history bound.** SFN STANDARD caps at 25,000 history events; `maxSteps=100` × several
states/step + the HITL Map + retries can approach it. A **continue-as-new** `RestartChoice` does a
fresh `StartExecution` carrying the four counters when `stepNumber` crosses a threshold (~40); the
DynamoDB journal makes that boundary stateless — the SFN analogue of the Convex workflow journal that
has no history cap (**D-AWS-12**).

### Journal-replay crash-recovery (preserved)

`@convex-dev/workflow` gave two guarantees we must reproduce: **(a)** journaled checkpoints — each
`step.run*` result is cached so a replay re-yields it and the same branch is taken; **(b)**
at-most-once side effects. SFN provides **(a)** natively (execution history caches each state's
output), but delivers Tasks **at-least-once** and re-invokes the SAME Lambda with the SAME input on
retry — so **(b)** becomes a **per-Lambda idempotency obligation** keyed on `(requestId, stepNumber, op)`.
The existing replay guards become load-bearing:

- **llmStep** — `loadStep` first; a finalized row → `reconstructDecision` returns the cached
  `StepDecision` **without a model call** (decode.ts:118–119). `insertStreaming` is a conditional Put;
  `finalizeStep` is a deterministic UpdateItem. Model called ≤ once per finalized step.
- **dispatchTools** — `appendToolResult` writes child `SK=STEP#<n>#TR#<toolCallId>` with idempotent
  UpdateItem (replace-in-place); a retry re-runs only tools whose result item is absent. `isCancelled`
  re-reads request status with a strongly-consistent `GetItem` on the base Requests item.
- **compact** — guards on the existing `CompactionEntry` for `(sessionId, firstKeptEntryId)` before
  `generateText` (loop.ts:135 relies on this) — no double-summarize/double-charge.
- **finalize / appendFollowUp** — terminal UpdateItem on a non-terminal condition; appends use
  conditional Put `attribute_not_exists(entryId)` on the deterministic prefixed ids.

Counters live in **SFN state, not DynamoDB** — mirroring `loop.ts` locals; a crash mid-loop resumes
from the last committed state with the counters intact. A redeploy does not abort in-flight STANDARD
executions; on resume each idempotent Task is a no-op for committed steps — equivalent to Convex
journal replay.

---

## Phases

| Phase | Title | Replaces | Depends on |
| --- | --- | --- | --- |
| **[G4.1](phase-g4.1-foundation-cdk-dynamodb.md)** | Foundation — CDK + DynamoDB + S3 + `store/` | `defineSchema` (10 tables), `ctx.db`/`ctx.storage`, `sessions/*` | — |
| **[G4.2](phase-g4.2-compute-lambda-actions.md)** | Compute — task-worker Lambdas | `llmStep`/`dispatchTools`/`compact`/`finalize`/`setup`/`mcpDiscover` `"use node"` actions | G4.1 |
| **[G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)** | Orchestrator — Step Functions STANDARD | `WorkflowManager` + `workflow.define` + `loop.ts` driver (`runHandler.ts`) | G4.2 |
| **[G4.4](phase-g4.4-hitl-task-tokens.md)** | HITL — task tokens | `step.awaitEvent` + `workflow.sendEvent` + `approvals` | G4.3 |
| **[G4.5](phase-g4.5-ingress-apigw-auth.md)** | Ingress — API GW REST + closed authorizer | `httpRouter`/`httpAction` + `runAuthorize` + `?wait=result` poll | G4.1, G4.3 |
| **[G4.6](phase-g4.6-reactive-websocket-streaming.md)** | Reactive — WebSocket + Streams fan-out | reactive queries + `deltaBatcher`→`patchStreaming` + `convex/react` transport | G4.1, G4.2/G4.3 |
| **[G4.7](phase-g4.7-channels-workflows-scheduler.md)** | Channels / workflows / scheduler | channels inbound+reply, `workflow.invoke`, `ctx.scheduler.runAfter(0)` | G4.3 |
| **[G4.8](phase-g4.8-tests-parity-cutover.md)** | Tests / parity / cutover | `convex-test` (412 tests); the HARD delete of `convex/` + `@convex-dev/*` | ALL |

---

## Decision log (D-AWS-\*)

| # | Decision | Rationale (short) |
| --- | --- | --- |
| **D-AWS-1** | Multi-table DynamoDB (9 physical tables per aggregate), NOT single-table | Per-aggregate access patterns; only 4 tables feed the WS fan-out — single-table funnels every write through one stream; per-aggregate TTL/IAM cleaner; on-demand makes extra tables ~free |
| **D-AWS-2** | Step Functions STANDARD, not Express | Loop runs long (`maxSteps=100`) + HITL parks for hours; needs durable history-as-journal + task tokens. Express caps at 5 min, has neither |
| **D-AWS-3** | Do NOT persist token deltas; broadcast over WS, persist only finalized steps | `patchStreaming` fires ~10–20×/turn → hot-partition storm + a stream record per batch. Keeps the journal a clean finalized-only record; `deltaBatcher` stays portable, only its sink changes |
| **D-AWS-4** | Per-streamKey seq via atomic counter (`ADD :1`, RETURN UPDATED_NEW), not read-max+1 | Read-max+1 is only safe under single-writer serialization DynamoDB lacks; concurrent emits would collide on seq and break the SDK cursor + replay ordering. `eventIndex` allocated once from the primary stream (emit.ts:45–48) |
| **D-AWS-5** | HITL = `.waitForTaskToken` + two-sided early-submit guard | Raw task tokens don't exist until the wait state is entered, so they lack Convex's "wake never lost before park". Persisting the decision + park self-completing restores it (approvals.ts:141) |
| **D-AWS-6** | API Gateway REQUEST Lambda authorizer, CLOSED by default | Inverts `convex/auth.ts`'s open-by-default (returns `undefined`, auth.ts:20–21) — a deliberate security improvement. Channel HMAC verify stays inside the channels Lambda (authorizer can't see the raw body) |
| **D-AWS-7** | Idempotency keyed on `(requestId, stepNumber, op)`; counters in SFN state | SFN is at-least-once and re-invokes the same Lambda; `reconstructDecision`/CompactionEntry guard/`appendToolResult`-by-toolCallId become load-bearing. Counters reconstruct in SFN state, mirroring loop.ts |
| **D-AWS-8** | Child `task()` → nested `StartExecution.sync`, not in-Lambda poll | The current CHILD_POLL `setTimeout` loop burns wall-clock and risks the 15-min cap for deep trees; `.sync` blocks natively and keeps the orchestrator (not a Lambda) owning subagent fan-out |
| **D-AWS-9** | Keep `loop.ts` as the executable SPEC; derive ASL from it | `loop.ts` is already pure/V8-safe and is the source of truth for branch order; transcribing preserves every hardened contract. Runtime control flow is SFN; `loop.ts` is reused for parity tests |
| **D-AWS-10** | Spill oversized payloads (runPlan, responseMessages, large tool results, images>100 KB) to S3 + DynamoDB pointer | 400 KB item + 256 KB SFN-state limits; frozen runPlan + verbatim responseMessages can exceed them. Generalizes the `imageChunks` `s3Key` pattern; SFN states pass only ids |
| **D-AWS-11** | esbuild-bundled zip Lambdas, Node 20, NOT in a VPC; AI SDK pinned v7 | Bundles fit zip; no-VPC avoids cold-start ENI penalty (external HTTP, not VPC resources). v7 pin because `usage.ts` depends on the v7 token-detail shape; MCP SSE transport stays dynamic-import lazy |
| **D-AWS-12** | Continue-as-new at a step threshold to bound SFN 25k-event history | `maxSteps=100` × states/step + HITL Map + retries can approach the cap; the journal makes the restart boundary stateless. Analogous to the cap-free Convex journal |
| **D-AWS-13** | Bounded <29 s poll for `?wait=result` parity; WS terminal-frame for the reactive SDK | API GW REST has a hard 29 s integration timeout; the Convex 60 s synchronous poll can't be ported as-is. Keep a shortened poll for wire-contract parity, push the terminal frame over WS for reactive callers |
| **D-AWS-14** | DynamoDB UpdateItem authoritative for cross-service ops; SFN call best-effort | `StopExecution`/`SendTask` + status write span two services and can't be transactional. Conditional DynamoDB write is the source of truth + states self-check status at entry; the SFN call is idempotent/best-effort |
| **D-AWS-15** | Sandbox = **self-hosted EC2 + Docker**, replacing `@upstash/box` | Removes the third-party dependency — the sandbox runs entirely in-account. One long-running EC2 host runs Docker; a **container named by the stable id** (`${ctx.id}:${instanceId}:${harnessName}`) is reattached across steps, so the per-run filesystem persists exactly as the box did. `dispatchTools` drives it via **SSM Run Command** (`docker exec`), so the Lambda needs **no inbound networking and stays off-VPC — D-AWS-11 is preserved (no NAT)**. Teardown = `docker rm -f` on finalize/cleanup + a host-side age-reaper (replaces box `keepAlive`/`env.delete()`). **Tradeoff:** containers share the host kernel (weaker than box's Firecracker microVM) and one host is a scale/availability bound — accepted as the simple-for-now posture. The `SessionEnv` seam is **unchanged**, so a later swap to **Fargate** (Firecracker, per-run task) needs no dispatch change. Known perf caveat: per-op SSM Run Command latency; the documented upgrade is a private exec-agent with `dispatchTools` in-VPC. |

---

## Considered & cut

- **Step Functions EXPRESS** — 5-min hard cap, no execution history / task-token suspension. The loop
  runs long and HITL parks for hours; STANDARD is mandatory.
- **DynamoDB write-per-token** (porting `patchStreaming` to `UpdateItem`) — ~10–20 writes/turn
  hot-partition storm + stream amplification; no server-side string concat. Broadcast deltas over WS,
  persist only finalized steps.
- **AppSync (GraphQL subscriptions)** — adds a schema/resolver layer the consumer doesn't need; the
  SDK's seq-cursor maps cleanly onto raw WS+Streams, and AppSync doesn't give the finalized-only-persist
  control the locked design wants.
- **EventBridge as the loop driver** — a bus, not a durable orchestrator: no journaled state, no
  task-token suspension, no Choice/Map control flow.
- **Single-table DynamoDB design** — access patterns are per-aggregate; only 4 tables feed the fan-out
  so one stream/filter would be undifferentiated (D-AWS-1).
- **Keeping `convex/` as a fallback / strangler-fig / dual backend** — locked decision #4 is a HARD
  replacement; a parallel backend doubles the journal/seq/HITL surface and reintroduces the coupling the
  migration removes.
- **In-Lambda child-task poll loop** (direct port of the `dispatchTools` `setTimeout`) — burns
  wall-clock, risks the 15-min cap, keeps loop-ownership in a Lambda. Nested `StartExecution.sync`
  removes it (D-AWS-8).
- **Container-image Lambdas** — slower cold start + heavier CI than esbuild zips, which fit with
  code-splitting.
- **Cognito user pools for the authorizer** — heavier and opinionated; the locked decision is a
  pluggable closed-by-default `authorize()` hook, best expressed as a REQUEST Lambda authorizer.
- **`@convex-dev/workpool` concurrency bounding** — unused in the tree (mentioned only as a future
  addition). No behavior to port; deleted at cutover. Future bounding → SFN Map `maxConcurrency` /
  Lambda reserved-concurrency.
- **EventBridge Scheduler for the compact kickoff** — the only scheduler use is `runAfter(0)`
  (admit.ts:204), a literal 0 delay. An async Lambda `Invoke (InvocationType=Event)` is the faithful
  mapping; no scheduler rule needed at cutover.
- **Keeping `@upstash/box` as the sandbox** — the original locked choice. Cut for a self-hosted
  **EC2 + Docker** sandbox (**D-AWS-15**) to drop the third-party dependency and keep everything
  in-account. The `SessionEnv` seam is unchanged, so this is an adapter swap, not a core change.
- **Fargate (per-run Firecracker task) for the sandbox now** — the stronger-isolation, auto-scaling
  option, and the documented **upgrade path** from D-AWS-15. Deferred for now: a per-step `RunTask`
  pays ~10–40 s cold-start each dispatch, and a warm-task-per-run model bills idle compute across
  multi-hour HITL parks (worse than one shared EC2). Revisit when shared-kernel isolation or
  single-host scale becomes the binding constraint.

---

## Build order

```
G4.1  Foundation: CDK scaffold + DynamoDB (9 tables/GSIs) + S3 + IAM + SSM/Secrets + store/ adapter
  │      (the seam everything binds to; SessionStore/journal/event/approval/blob stores)
  │
  ├────────────► G4.2  Compute: setup/llmStep/dispatchTools/compact/finalize/mcpDiscover Lambdas
  │                │      (needs store/ for DynamoDB I/O + S3 spill; provider registry; EC2/Docker sandbox host; esbuild)
  │                │
  │                ├────► G4.3  Orchestrator: ASL STANDARD state machine driving G4.2 Lambdas
  │                │        │      (needs the task Lambdas to wire as Task states; journal idempotency)
  │                │        │
  │                │        ├────► G4.4  HITL: .waitForTaskToken AwaitApproval Map + park/submitApproval
  │                │        │              (needs the state machine + Approvals table; SendTaskSuccess)
  │                │        │
  │                │        └────► G4.7  Channels/workflows/scheduler: inbound webhooks + Reply terminal
  │                │                       Task + workflow.invoke StartExecution + compact async-invoke
  │                │                       (needs the state machine + reply Lambda + Meta dedup)
  │                │
  ├────────────► G4.5  Ingress: API GW REST + closed authorizer + admit→StartExecution + poll
  │                       (needs G4.3 state-machine ARN to StartExecution; store/ for admit writes)
  │
  └────────────► G4.6  Reactive: API GW WebSocket + Connections/Subscriptions + Streams fan-out Lambda
                          + client retarget (needs G4.1 Streams on Steps/Events/Requests/Approvals;
                           consumes finalized-step writes from G4.2/G4.3)

                 G4.8  Tests/parity/cutover (depends on ALL: SFN Local + LocalStack + crash-recovery E2E
                        + parity vs 412-test suite; HARD delete convex/ + @convex-dev/* into backend/)
```

**Critical path:** G4.1 → G4.2 → G4.3 → {G4.4, G4.7}. G4.5 and G4.6 branch off G4.1/G4.3 in parallel.
G4.8 gates cutover.

---

## How this preserves the thesis

Every mechanism is chosen so the harness thesis **survives** the migration. The **orchestrator owns the
durable loop** — it moves from a Convex workflow to a Step Functions STANDARD machine, but it is still
the orchestrator, not a Lambda, that drives `setup → (llmStep → dispatchTools)* → finalize` and owns
subagent fan-out (via nested `StartExecution.sync`); the execution history + DynamoDB journal are the
crash-recovery substrate, exactly as the Convex journal was. **The LLM decides but does not control
flow** — `llmStep` returns only a small `{overflow, toolCallCount, gatedCount, shouldCompact}` decision
summary and the ASL Choice states branch on it. **Tools dispatch out-of-band** in a self-hosted
**EC2/Docker** sandbox (D-AWS-15, reattached by stable id via SSM Run Command) with **no AI-SDK
`execute`** — `dispatchTools` rebuilds executable tools from frozen
descriptors and runs them itself (decode.ts:339 keeps `tool()` execute-free). **The AI SDK stays thin**
— only `llmStep`/`compact` touch `streamText`/`generateText`/`tool()`; nothing above it (loop,
durability, HITL, telemetry, sandbox) lives in the SDK. And the invariant that **anything a step
consumes is replay-reconstructable from the frozen runPlan + journaled DynamoDB state** is upheld by
freezing the runPlan to the Sessions HEADER, persisting only finalized steps, and re-reading both on
every Lambda invocation — never re-deriving from live mutable state.
