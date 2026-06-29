# G4.2 — Compute boundary: task-worker Lambdas, sandbox, providers, streaming

> Group-4 (Convex → AWS) migration · Phase G4.2
> Owns the `backend/handlers/tasks/*` Lambda entry points + `compute-stack.ts`.
> Conforms to the shared design spine (`computeDesign`, `journalDesign`, decisions D-AWS-3/7/8/10/11) and the cove THESIS.

---

## Goal & scope

Build the **thin, single-purpose Node 20 Lambdas the orchestrator drives** — the compute boundary of the AWS backend. Today these are the `"use node"` engine actions (`convex/engine/llmStep.ts`, `dispatchTools.ts`, `compact.ts`) plus the V8 `setup`/`finalize` mutations and the `mcp/discover.ts` hop, each invoked from the Convex workflow handler (`convex/engine/runHandler.ts`) as a journaled `step.run*`. In AWS these become **five (+one) discrete Lambdas invoked as SFN Task states**: `setup`, `llmStep`, `dispatchTools`, `compact`, `finalize`, and `mcpDiscover`.

**The single hardest invariant of this phase:** no Lambda owns the loop. The while-loop in `convex/engine/loop.ts` is transcribed to ASL in **G4.3** (see `phase-g4.3-durable-orchestrator-stepfunctions.md`); each Lambda here is a *pure side-effect surface* keyed by `(requestId, stepNumber, op)`, re-invoked at-least-once by SFN, and idempotent through the **existing replay guards** (`decode.ts` `loadStep → reconstructDecision`, `dispatch.ts` `appendToolResult`-by-`toolCallId`, `compact.ts` CompactionEntry guard).

In scope:
- The 6 task-worker Lambda handlers (`backend/handlers/tasks/*`), each a thin adapter binding a portable core (`DecodeDeps`/`DispatchDeps`/`RunLoopDeps` ports) to a `store/` impl.
- `compute-stack.ts`: the CDK `NodejsFunction` constructs, esbuild bundling config, IAM, env/secrets, reserved concurrency.
- The provider registry retarget (`gateway()` keyless on the Lambda execution role).
- `@upstash/box` sandbox lifetime mapped to a Lambda invocation; MCP per-beat pool in the warm container.
- Image/large-payload spill to **S3** (generalizing the `imageChunks` `s3Key` pointer) so DynamoDB-400 KB / SFN-state-256 KB limits are never breached.
- How streamed deltas **leave** the Lambda (the `postToConnection` sink handoff to G4.6).
- Cold-start / 15-min-cap / payload posture.

Out of scope (cross-linked, do not duplicate):
- The ASL state machine + Choice/Map control flow + continue-as-new → **G4.3** (`phase-g4.3-durable-orchestrator-stepfunctions.md`).
- HITL `.waitForTaskToken` / `park` / `submitApproval` → **G4.4** (`phase-g4.4-hitl-task-tokens.md`).
- DynamoDB tables/GSIs/Streams + the `store/` adapter layer + S3 bucket construct → **G4.1** (`phase-g4.1-foundation-cdk-dynamodb.md`).
- The WebSocket API + `postToConnection` fan-out + delta-frame consumer → **G4.6** (`phase-g4.6-reactive-websocket-streaming.md`). This phase only *emits into* that sink.
- `mcpDiscover`'s channel/inbound siblings and the terminal `reply` Lambda → **G4.7** (`phase-g4.7-channels-workflows-scheduler.md`). (`mcpDiscover` is built here because it is a pre-Setup *Task* Lambda; its registration as a Task state is G4.3.)

---

## Dependencies

- **G4.1 (hard prerequisite).** Needs `store/ddb.ts` (DocumentClient singleton, conditional-put + atomic-counter helpers), `store/sessionStore.ts`, `store/journalStore.ts`, `store/requestStore.ts`, `store/eventStore.ts`, `store/blobStore.ts` (S3), `store/skillStore.ts`; the 9 DynamoDB tables (Sessions/Requests/Steps/Events/Approvals/Skills/Blobs/Meta/Runs); the S3 bucket; the SSM/Secrets entries for provider creds + `@upstash/box` token. The `store/` layer **is** the replaced Convex adapter seam — every `ctx.runQuery/runMutation` call in the source files below resolves to a `store/` method.
- **Portable cores (moved verbatim, no logic change):** `engine/loop.ts` (consumed by G4.3 as the ASL spec, imported here only for parity tests), `engine/decode.ts`, `engine/dispatch.ts`, `engine/deltaBatcher.ts`, `engine/buildTools.ts`, `engine/resultTools.ts`, `engine/usage.ts`, `engine/retry.ts`, `engine/types.ts`, `engine/task.ts` (`formatTaskResult`/`TASK_PARAMS`), `engine/frameworkTools.ts`, `mcp/descriptors.ts` + `mcp/connect.ts` + `mcp/pool.ts`, `sessions/images.ts`, `src/runtime/*` (`session-history.ts`, `compaction.ts`, `tool.ts`, `tool-registry.ts`, `extensions/*`), `providers/*` (the whole registry/plugin/capabilities/gateway/messages chain), `observability/otel.ts`.
- **Downstream:** G4.3 wires these Lambdas as Task states; G4.4 adds the HITL Map; G4.6 consumes the finalized-step Stream + the delta WS frames; G4.7 reuses the box container's MCP pool + the `mcpDiscover` Lambda.

---

## Deliverables

1. `backend/handlers/tasks/setup.ts` — freezes `runPlan` to the Sessions `HEADER` item, flips status → `running`, returns the small scalars `{maxSteps, maxFollowUps, hasResultSchema, overflowRetryBudget, compactEnabled}`. (No box, no model call — a plain DynamoDB write Lambda.)
2. `backend/handlers/tasks/llmStep.ts` — the **ONLY model boundary**. Wires `DecodeDeps` (from `decode.ts`) to `store/journalStore.ts` + the WS delta sink; resolves the model via `providers/gateway.ts`; replay-guarded.
3. `backend/handlers/tasks/dispatchTools.ts` — resolves the `@upstash/box` `SessionEnv`, rebuilds executable tools from frozen descriptors, runs `runDispatch` (`dispatch.ts`); child `task()` → **nested `StartExecution.sync`** (replacing the in-Lambda poll loop); MCP pool in the warm container.
4. `backend/handlers/tasks/compact.ts` — one-shot `generateText` summarization, idempotent on an existing CompactionEntry.
5. `backend/handlers/tasks/finalize.ts` — usage rollup `Query` over Steps + terminal `UpdateItem`; emits the `idle` event.
6. `backend/handlers/tasks/mcpDiscover.ts` — network-only discovery hop (no box); writes the frozen `McpToolDescriptor[]` to DynamoDB (not the SFN state payload — roster can exceed 256 KB).
7. `backend/cdk/stacks/compute-stack.ts` — six `NodejsFunction` (esbuild) constructs, Node 20, **no VPC**, AI SDK v7 pinned, reserved concurrency, IAM least-privilege, env/secrets injection.
8. `backend/store/blobStore.ts` extension: a generic `spillToS3(payload) → {s3Key}` / `hydrateFromS3(s3Key)` used for oversized `runPlan` / `responseMessages` / large tool results, generalizing the `imageChunks` `s3Key` pattern (D-AWS-10).
9. Parity test scaffolding: the portable cores' existing unit tests run unchanged against `aws-sdk-client-mock` + the in-memory `MockLanguageModelV3` (full suite gated in G4.8).

---

## Source map

| Convex source being replaced | New AWS file(s) | Notes |
| --- | --- | --- |
| [`../../../convex/engine/setup.ts`](../../../convex/engine/setup.ts) (V8 `internalMutation`) | `backend/handlers/tasks/setup.ts` + `store/sessionStore.ts` | freeze `runPlan` → Sessions `HEADER` `PutItem`; `ctx.db.get/insert/patch` → DocClient. Registry side-effect imports (`_cove/*Resolver.ts`) bundle into the zip. Returns small scalars only. |
| [`../../../convex/engine/llmStep.ts`](../../../convex/engine/llmStep.ts) (`"use node"` action) | `backend/handlers/tasks/llmStep.ts` | wires `DecodeDeps` to `store/journalStore.ts`; `patch` sink → `postToConnection` (deltas WS-only); `finalizeStep` → Steps `UpdateItem`. |
| [`../../../convex/engine/decode.ts`](../../../convex/engine/decode.ts) (pure core, `"use node"` for AI SDK) | `backend/engine/decode.ts` (moved verbatim) | `streamText` + `tool()` **without `execute`** ([`decode.ts:339-349`](../../../convex/engine/decode.ts)); replay guard `loadStep → reconstructDecision` ([`decode.ts:117-119`](../../../convex/engine/decode.ts)); `STREAM_DEADLINE_MS=240_000` kept. |
| [`../../../convex/engine/dispatchTools.ts`](../../../convex/engine/dispatchTools.ts) (`"use node"` action) | `backend/handlers/tasks/dispatchTools.ts` | `resolveSandbox` → `@upstash/box` by stable id; `runTaskDelegation` poll loop ([`dispatchTools.ts:37-104`](../../../convex/engine/dispatchTools.ts)) **deleted** → nested `StartExecution.sync`. |
| [`../../../convex/engine/dispatch.ts`](../../../convex/engine/dispatch.ts) (pure core) | `backend/engine/dispatch.ts` (moved verbatim) | `runDispatch` `Promise.all`, `PER_TOOL_TIMEOUT_MS=30_000`, cancel-aware. `DispatchDeps.isCancelled` → strongly-consistent `GetItem` on Requests base item. |
| [`../../../convex/engine/compact.ts`](../../../convex/engine/compact.ts) (`"use node"` action) | `backend/handlers/tasks/compact.ts` | `generateText` one-shot; CompactionEntry idempotency via conditional `Put` / pre-read on `(sessionId, firstKeptEntryId)`. |
| [`../../../convex/engine/finalize.ts`](../../../convex/engine/finalize.ts) (V8 `internalMutation`) | `backend/handlers/tasks/finalize.ts` + `store/requestStore.ts` | `by_request_and_step` `.collect()` → Steps `Query begins_with STEP#`; `ctx.db.patch` terminal → conditional `UpdateItem` (non-terminal guard); `emit idle`. |
| [`../../../convex/mcp/discover.ts`](../../../convex/mcp/discover.ts) (`"use node"` action) | `backend/handlers/tasks/mcpDiscover.ts` | `discoverMcpDescriptors` moved verbatim; result written to DynamoDB pointer, not the state payload. |
| [`../../../convex/engine/runHandler.ts`](../../../convex/engine/runHandler.ts) (workflow handler) | (no Lambda — becomes the ASL machine, **G4.3**) | the `step.run*` wiring here is the contract each Lambda's Task state must honor. |
| [`../../../convex/providers/gateway.ts`](../../../convex/providers/gateway.ts) + `providers/*` | `backend/engine/providers/*` (moved verbatim) | `gateway()` resolves keyless off the Lambda execution role (AWS chain recognized at [`gateway.ts:156-166`](../../../convex/providers/gateway.ts)). |
| [`../../../convex/engine/deltaBatcher.ts`](../../../convex/engine/deltaBatcher.ts) (pure) | `backend/engine/deltaBatcher.ts` (moved verbatim) | sink rewired from `patchStreaming` mutation → `postToConnection`; cadence `DELTA_BATCH_CHARS=480`/`DELTA_BATCH_MS=400` kept. |
| [`../../../convex/engine/usage.ts`](../../../convex/engine/usage.ts) (pure, AI SDK v7 shape) | `backend/engine/usage.ts` (moved verbatim) | `AiSdkUsage` v7 token-detail shape ([`usage.ts:86-99`](../../../convex/engine/usage.ts)) is why esbuild **pins AI SDK v7** (D-AWS-11). |
| [`../../../convex/mcp/pool.ts`](../../../convex/mcp/pool.ts) (`"use node"`) | `backend/engine/mcp/pool.ts` (moved verbatim) | module-level `Map` in the warm dispatchTools container; `closeAll()` in handler `finally`. |
| [`../../../convex/sessions/images.ts`](../../../convex/sessions/images.ts) (pure) | `backend/engine/images.ts` (moved verbatim) + `store/blobStore.ts` | `INLINE_IMAGE_THRESHOLD=100*1024` ([`images.ts:19`](../../../convex/sessions/images.ts)); `_storage` → S3; the `s3Key` pattern is generalized to all oversized payloads (D-AWS-10). |
| [`../../../convex/engine/task.ts`](../../../convex/engine/task.ts) (`formatTaskResult`, child-request lifecycle) | `backend/engine/task.ts` (`formatTaskResult`/`TASK_PARAMS` portable) | `createChildRequest`'s `workflow.start` ([`task.ts:101`](../../../convex/engine/task.ts)) → child `StartExecution`; deterministic `submissionId = task:<parent>:<toolCallId>` ([`task.ts:47`](../../../convex/engine/task.ts)) preserved as the SFN execution name for idempotency. |
| [`../../../convex/observability/otel.ts`](../../../convex/observability/otel.ts) (pure read-fold) + [`../../../convex/observability/read.ts`](../../../convex/observability/read.ts) | `backend/engine/observability/{otel,read}.ts` (moved verbatim) + an `exportSpans` **pull** Lambda over the `Events` table | **G4.2 owns the observability migration**: the pure fold + `exportSpans` pull query migrate as-is (parity with today's Convex behavior — a query, not a live exporter). A live OTLP **push** exporter is **group-5/G5.7** enhancement scope — explicitly out of this migration (do not build it here). |

---

## Hardened-contract obligations

Every contract below is from design doc [`08`](../../design/08-conventions-and-execution-boundary.md) and/or the THESIS. This phase is the *implementation surface* for most of them — they must survive verbatim.

- **THESIS — the AI SDK stays THIN; tools have no `execute`.** `decode.ts`'s `toAiTools` builds each `tool({description, inputSchema})` with **no `execute`** ([`decode.ts:339-349`](../../../convex/engine/decode.ts)). cove dispatches OOB. Nothing above the model-interaction boundary (no SDK agent loop, no SDK durability/HITL/telemetry/sandbox) may be introduced in `llmStep.ts`. ([08 §3](../../design/08-conventions-and-execution-boundary.md).)
- **THESIS — tools dispatch OUT-OF-BAND in an `@upstash/box` sandbox.** `dispatchTools.ts` is the only Lambda that touches the box. `setup` resolves-only; `llmStep`/`compact`/`finalize`/`mcpDiscover` never touch the box. The two sanctioned non-box executions inside dispatch — `activate_skill` (a `store/skillStore.ts` `GetItem`, never an FS walk) and MCP tools (network) — are preserved ([08 §3](../../design/08-conventions-and-execution-boundary.md), D13).
- **THESIS — replay-reconstructable, never re-derived from live state.** Every Lambda reads the **frozen `runPlan`** (Sessions `HEADER`) + journaled Steps; nothing reads live mutable registry/session state mid-run.
- **§4.1 `llmStep` replay determinism (critical).** `runDecode` consults `loadStep()` first; a finalized row → `reconstructDecision` with **no model call** ([`decode.ts:117-119, 313-327`](../../../convex/engine/decode.ts)). On at-least-once SFN re-invoke this is now *load-bearing* (not belt-and-suspenders). The model is called ≤ once per **finalized** step. A crash after `insertStreaming` but before `finalizeStep` leaves a non-finalized row and the re-run re-streams + overwrites it (the conditional-`Put` on the streaming insert + the deterministic `UpdateItem` finalize keep this consistent).
- **§4.2 Action budgets.** `STREAM_DEADLINE_MS≈240_000` force-finalize KEPT in `decode.ts` ([`decode.ts:34, 208-212`](../../../convex/engine/decode.ts)); set the llmStep Lambda timeout to ~5 min (well under the 15-min hard cap). `PER_TOOL_TIMEOUT_MS≈30_000` ([`dispatch.ts:18`](../../../convex/engine/dispatch.ts)); box default `exec timeoutMs=30_000` ([`upstashBox.ts:88`](../../../convex/sandbox/upstashBox.ts)).
- **§4.3 Cancel short-circuit.** `DispatchDeps.isCancelled` re-reads `agentRequests.status === "cancelled"` **before each tool AND after execute** ([`dispatch.ts:48-69`](../../../convex/engine/dispatch.ts)); in AWS this is a **strongly-consistent `GetItem` on the Requests base item** (never a GSI — GSIs are eventually consistent).
- **§4.5 Tool rebuild from frozen descriptors + idempotency.** `buildExecutableTools` rebuilds per dispatch from the frozen descriptor; a build failure → error tool-result, never a crash. `appendToolResult` is idempotent by `toolCallId` (replace-in-place: Steps child item `SK=STEP#<n>#TR#<toolCallId>`) — a Task retry re-runs only tools whose result item is absent ([`dispatchTools.ts:133-141`](../../../convex/engine/dispatchTools.ts)). MCP `callTool` is a side-effecting network call → the `toolCallId` de-dup means a replayed dispatch returns the persisted result, never re-issuing it.
- **§4.6 Streaming commit semantics (re-shaped by D-AWS-3).** `deltaBatcher.flush`'s sink moves from `ctx.runMutation(patchStreaming)` to `postToConnection`. Deltas are **broadcast over WS, never persisted per-token**; ONLY `finalizeStep` writes to Steps ([locked decision #2](README.md)). Delta frames carry NO `seq` (render-only/ephemeral); the client reconciles against the finalized seq'd event (the finalized step is the sole source of truth). This eliminates the ~10-20 writes/turn hot-partition storm.
- **§4.7 Usage & cost fidelity.** `usageFromAiSdk` bridges the v7 token-detail shape ([`usage.ts:109-129`](../../../convex/engine/usage.ts)); `addUsage`/`emptyUsage` roll up in `finalize` over the Steps `Query` ([`finalize.ts:27-39`](../../../convex/engine/finalize.ts)). The rollup keeps `cacheRead`/`cacheWrite`/`cacheWrite1h` + the `cost{}` breakdown (not a token-only subset).
- **§4.8 Image pipeline.** `extractEntryImages`/`hydrateEntryImages` portable; inline ≤ ~100 KB, larger → S3 (`store/blobStore.ts`), same content-addressed-by-hash + refCount semantics ([`images.ts:19-21, 80-116`](../../../convex/sessions/images.ts)).
- **§4.12/4.13 Extensions determinism.** The frozen extension manifest re-binds in manifest order; content-mutation hooks run **behind** the `loadStep` replay guard as pure fns of `(frozen plan + persisted inputs + payload)` ([`llmStep.ts:54-58, 146-160`](../../../convex/engine/llmStep.ts)). `_cove/extensionResolver.ts` + `_cove/toolResolver.ts` side-effect imports must bundle into each zip so `getRegisteredExtension`/`getRegisteredTool` resolve in the Lambda isolate.
- **§4.9/4.10 Step cap & result re-nudge.** `setup` freezes `maxSteps` (default 100) + `maxFollowUps` (default 32) and returns them as scalars; the *enforcement* (the `while`/Choice branches, `step_limit_exceeded`/`result_followups_exhausted`) is the ASL machine's (G4.3). This Lambda layer just supplies the frozen scalars and the per-step durable rows the machine branches on.

---

## Implementation tasks

A builder can execute this list top-to-bottom without re-deriving the design.

1. **Move the portable cores into `backend/engine/`** (verbatim, drop the `"use node"` pragma where present): `decode.ts`, `dispatch.ts`, `deltaBatcher.ts`, `buildTools.ts`, `resultTools.ts`, `usage.ts`, `retry.ts`, `types.ts`, `task.ts`, `frameworkTools.ts`, `mcp/*`, `images.ts`, `providers/*`, `observability/otel.ts`. Keep the reference-header convention ([08 §2](../../design/08-conventions-and-execution-boundary.md)); update the package path only. **Do not edit the algorithms** — only the DI ports change, and they change at the *handler*, not the core.

2. **`setup` Lambda** (`backend/handlers/tasks/setup.ts`):
   - Input: `{requestId, discoveredMcp?: {s3Key} | McpToolDescriptor[]}` (the MCP roster is read from DynamoDB/S3, not the SFN payload).
   - Port `convex/engine/setup.ts` body: resolve the registered agent profile (`getRegisteredAgent`), freeze tool descriptors, compute the system prompt + compaction config.
   - `ctx.db.get(request)` / `ctx.db.get(session)` → `store/requestStore.getRequest` + `store/sessionStore.getHeader`.
   - Freeze `runPlan` onto the Sessions `HEADER` item via `store/sessionStore.putHeader` (conditional `Put` `attribute_not_exists` for at-least-once idempotency). **If the frozen `runPlan` (tool descriptors + system prompt + extension manifest) exceeds ~300 KB, spill to S3 via `store/blobStore.spillToS3` and store an `s3Key` pointer on `HEADER`** (D-AWS-10).
   - Flip Requests status → `running` (conditional `UpdateItem`).
   - Return ONLY scalars: `{maxSteps, maxFollowUps, hasResultSchema, overflowRetryBudget, compactEnabled}`. No bodies.

3. **`llmStep` Lambda** (`backend/handlers/tasks/llmStep.ts`):
   - Read the frozen `runPlan` from `store/sessionStore.getHeader` (hydrate the S3 pointer if present); rebuild context via `SessionHistory.fromData(store.load(...))` → `buildContext` → `toModelMessages` ([`llmStep.ts:42-60`](../../../convex/engine/llmStep.ts)).
   - `resolveModel(plan.model)` via the ported `providers/gateway.ts`.
   - Build `tools = buildModelView(plan.tools)` (no execute).
   - Wire `DecodeDeps`: `loadStep → store/journalStore.byRequestStep`; `insertStreaming → store/journalStore.insertStreaming` (conditional `Put attribute_not_exists(SK)`); `patch → postWsDelta` (see task 9); `finalizeStep → store/journalStore.finalizeStep` (`UpdateItem` on `SK=STEP#<paddedStepNumber>`); `finalizeOverflow → store/journalStore.finalizeOverflowStep`.
   - Apply the extension `before_agent_start`/`context` hooks behind the replay guard exactly as `llmStep.ts:54-58`; fire `turn_end` notify hooks after the decode ([`llmStep.ts:146-160`](../../../convex/engine/llmStep.ts)) writing custom entries with deterministic ids `x-${requestId}-${stepNumber}-te-${i}` (conditional `Put`, idempotent on replay).
   - Run `runDecode(...)`; return the **small** decision summary the ASL machine branches on: `{overflow, toolCallCount, gatedCount, shouldCompact}` (the full `StepDecision`/`responseMessages` stay in the Steps row; if `responseMessages` would breach 400 KB, spill to S3 with a pointer on the step row — `reconstructDecision` follows the pointer).
   - Lambda timeout ~300 s (under the 15-min cap, above `STREAM_DEADLINE_MS`).

4. **`dispatchTools` Lambda** (`backend/handlers/tasks/dispatchTools.ts`):
   - Read frozen `runPlan` + the journaled step (`store/journalStore.byRequestStep`); filter out already-resulted `toolCallId`s ([`dispatchTools.ts:133-141`](../../../convex/engine/dispatchTools.ts)).
   - Resolve the box: `upstashBox().createSessionEnv({ id: sandboxName })` where `sandboxName = ${ctx.id}:${instanceId}:${harnessName}` ([08 §3](../../design/08-conventions-and-execution-boundary.md)) — the stable id reattaches the same box across invocations; R5 ephemeral-handle semantics map 1:1 onto the Lambda invocation lifetime (the per-action handle cache in `upstashBox.ts:122-158` becomes the per-invocation cache; the box outlives it).
   - Recover user-tool `execute` closures by name (`getRegisteredTool`), bind extension tools (`bindManifest`), build executables (`buildExecutableTools` with `mcpResolve: resolveMcpTool`), wrap with hooks, run `runDispatch` ([`dispatchTools.ts:176-209`](../../../convex/engine/dispatchTools.ts)).
   - **Delete `runTaskDelegation` (the `CHILD_POLL_INTERVAL_MS`/`CHILD_POLL_DEADLINE_MS` `setTimeout` poll, [`dispatchTools.ts:37-104`](../../../convex/engine/dispatchTools.ts)).** A `task()` call becomes a **nested `StartExecution.sync`** of AgentLoop named by the deterministic child `submissionId` (`task:<parentRequestId>:<toolCallId>`, [`task.ts:47`](../../../convex/engine/task.ts)); SFN — not a Lambda — owns subagent fan-out and blocks on the child terminal state natively (D-AWS-8). Keep `formatTaskResult` ([`task.ts:127-145`](../../../convex/engine/task.ts)) to map the child's terminal Requests item into the parent's task tool-result; the child-request create stays a `store/` write. (How the nested `StartExecution.sync` Task is expressed in ASL is G4.3.)
   - `isCancelled` → strongly-consistent `GetItem` on the Requests base item; `appendToolResult` → idempotent `store/journalStore.appendToolResult` (Steps child item).
   - MCP pool: module-level `Map` in the warm container; call `closeAll()` in the handler `finally` ([`pool.ts:56-60`](../../../convex/mcp/pool.ts)).
   - **Box keepAlive cleanup:** on the finalize path (or via an SFN cleanup state), call `env.delete()` so a box does not stay warm forever per `sandboxName` (Risks).

5. **`compact` Lambda** (`backend/handlers/tasks/compact.ts`):
   - Port `convex/engine/compact.ts` verbatim into a handler; `resolveModel(args.model ?? "anthropic/claude-haiku-4-5")` ([`compact.ts:57`](../../../convex/engine/compact.ts)); `generateText` summarization (history + optional split-turn prefix, both calls' usage summed, [`compact.ts:169-184`](../../../convex/engine/compact.ts)).
   - **Idempotency guard (load-bearing, D-AWS-7):** before the model call, check whether a CompactionEntry for `(sessionId, firstKeptEntryId)` already exists (conditional `Put` / pre-read on `store/sessionStore`); if so, return the existing summary with **no second `generateText`**. This is what `loop.ts:134`'s "replay re-yields the journaled summary with no second summarization call" relied on — now mandatory under at-least-once Tasks.
   - Preserve `session_before_compact` cancel-as-NOOP + `replacementSummary` skip-the-model behavior ([`compact.ts:122-144`](../../../convex/engine/compact.ts)).

6. **`finalize` Lambda** (`backend/handlers/tasks/finalize.ts`):
   - Roll up usage: Steps `Query begins_with STEP#` (the `by_request_and_step` `.collect()` equivalent, [`finalize.ts:27-39`](../../../convex/engine/finalize.ts)); `addUsage` over each step.
   - Terminalize the Requests item via conditional `UpdateItem` with a **non-terminal condition** (`status IN (pending,running)`) so a re-invoke is a no-op (D-AWS-7).
   - Emit the `idle` event (`store/eventStore.append`, atomic-seq) carrying `submissionId` ([`finalize.ts:56-66`](../../../convex/engine/finalize.ts)); fire `agent_end` notify hooks writing custom entries with deterministic ids `x-${submissionId}-ae-${i}`.
   - Trigger box cleanup (`env.delete()` for `sandboxName`) here, tied to the SFN execution lifecycle (Box keepAlive cost risk).

7. **`mcpDiscover` Lambda** (`backend/handlers/tasks/mcpDiscover.ts`):
   - Port `discoverMcpDescriptors` ([`discover.ts:30-61`](../../../convex/mcp/discover.ts)) verbatim — connect per declared server, freeze closure-free `McpToolDescriptor`s, per-server failure → diagnostic descriptor, no box.
   - Write the roster to DynamoDB (or S3 with a pointer if it exceeds 256 KB / 400 KB) keyed by `requestId`; return only the pointer/scalar to the SFN state. `setup` reads it back.
   - Keep `mcp/connect.ts`'s dynamic `import(SSEClientTransport)` lazy via esbuild code-splitting (D-AWS-11).

8. **`store/blobStore.ts` spill API** (extend G4.1's blob store): `spillToS3(payload): Promise<{s3Key}>` (key `spill/<requestId>/<sha>`), `hydrateFromS3(s3Key): Promise<payload>`. Used by `setup` (large `runPlan`), `llmStep` (large `responseMessages`), `dispatchTools` (large tool results), `mcpDiscover` (large roster) (D-AWS-10). Generalizes the `images.ts` `s3Key` pattern.

9. **WS delta sink** (`postWsDelta`): a thin function the `llmStep` handler injects as `DecodeDeps.patch` and as the `deltaBatcher` sink. It calls API Gateway Management API `postToConnection` for the request's subscribers (the `Subscriptions` lookup + endpoint construction is **G4.6**; this phase just calls the helper G4.6 exports, or a stub until G4.6 lands). Delta frames carry NO `seq`. The terminal `message_end`/`turn`/finalized-step write goes to DynamoDB (the Steps Stream re-pushes it — G4.6).

10. **`compute-stack.ts`** (`backend/cdk/stacks/compute-stack.ts`):
    - Six `aws_lambda_nodejs.NodejsFunction` constructs (`runtime: NODE_20_X`, `architecture: ARM_64` or `X86_64`, `bundling: { format: esbuild, target: 'node20', externalModules: [] }`), **NOT in a VPC** (D-AWS-11 — external HTTP services, not VPC resources; avoid the cold-start ENI penalty).
    - **Pin AI SDK v7** in the bundle (`usage.ts` depends on the v7 token-detail shape, [`usage.ts:86-99`](../../../convex/engine/usage.ts)); keep `mcp/connect.ts`'s SSE transport dynamic-import lazy (code-splitting).
    - Per-Lambda timeouts: `llmStep` ~300 s, `dispatchTools` ~600 s (deep tool work; nested child execution is now `StartExecution.sync` so the 15-min wall-clock is no longer spent polling — D-AWS-8), `compact` ~120 s, `setup`/`finalize`/`mcpDiscover` ~30-60 s.
    - **Reserved concurrency caps** on `dispatchTools` (throttle protection for `@upstash/box` + remote MCP under parallel dispatch) and `llmStep` (provider rate limits) (D-AWS-11, Risks).
    - Memory: `llmStep`/`dispatchTools` higher (streaming + box client); `setup`/`finalize` minimal.
    - IAM least-privilege per Lambda (task 11).
    - Env/secrets: provider creds (`AI_GATEWAY_API_KEY` or none — AWS chain keyless), `@upstash/box` token, table names, the S3 bucket name, the WS Management API endpoint — from SSM/Secrets Manager (G4.1).

11. **IAM** (per Lambda, least-privilege):
    - `setup`: `dynamodb:PutItem/UpdateItem/GetItem/Query` on Sessions/Requests; `s3:PutObject/GetObject` on the bucket (runPlan spill).
    - `llmStep`: `dynamodb:GetItem/PutItem/UpdateItem/Query` on Steps/Sessions/Events; `s3:GetObject/PutObject`; `execute-api:ManageConnections` on the WS API (postToConnection); Bedrock `bedrock:InvokeModel*` if Bedrock is the provider (else gateway egress only); the execution role IS the keyless provider credential ([`gateway.ts:156-166`](../../../convex/providers/gateway.ts)).
    - `dispatchTools`: `dynamodb:*` on Steps/Sessions/Requests/Skills; `s3:*` on the bucket; `states:StartExecution` + `states:DescribeExecution` for nested child AgentLoop runs; outbound HTTPS (box + MCP).
    - `compact`: Sessions/Events DynamoDB + S3; provider creds.
    - `finalize`: Requests/Steps/Events DynamoDB; `execute-api:ManageConnections` (idle frame) optional.
    - `mcpDiscover`: outbound HTTPS only + DynamoDB/S3 write of the roster.

12. **Provider creds smoke check.** Confirm `hasCredentialsFor("bedrock")` recognizes the Lambda execution-role chain (`AWS_ROLE_ARN`/`AWS_WEB_IDENTITY_TOKEN_FILE`/`AWS_CONTAINER_CREDENTIALS_*`, [`gateway.ts:156-166`](../../../convex/providers/gateway.ts)) so a Bedrock model resolves keyless; the gateway path still works with `AI_GATEWAY_API_KEY`.

13. **Parity tests (scaffold; full gate in G4.8).** Run the moved cores' existing unit tests unchanged (`decode`, `dispatch`, `deltaBatcher`, `usage`, `images`, `compaction`) against `MockLanguageModelV3` + `aws-sdk-client-mock`. Add a handler-level idempotency test per Lambda: invoke twice with the same `(requestId, stepNumber)`, assert ≤ one model call and one tool-result child item.

---

## Acceptance

Objective bars that prove the phase done, each mirroring the Convex behavior it replaces:

1. **No-model replay.** Invoking the `llmStep` Lambda a second time with a finalized Steps row for `(requestId, stepNumber)` returns the same decision and makes **zero** AI SDK calls (`reconstructDecision` path, [`decode.ts:117-119`](../../../convex/engine/decode.ts)). Verified with a counting `MockLanguageModelV3`.
2. **Thin AI SDK.** A static check (or test) asserts `toAiTools` produces tools with no `execute` and that `llmStep` imports `streamText`/`tool`/`generateText` only — no AI-SDK agent/loop/tool-execution API ([`decode.ts:339-349`](../../../convex/engine/decode.ts)).
3. **OOB dispatch, box-only.** `dispatchTools` runs tools against the resolved `@upstash/box` `SessionEnv`; `activate_skill` resolves from `store/skillStore` (no FS), MCP tools reach the network — and `setup`/`llmStep`/`compact`/`finalize` never import the box.
4. **Idempotent tool dispatch.** Re-invoking `dispatchTools` with one tool-result child item already present re-runs only the missing tools; the present `toolCallId` is untouched (replace-in-place, [`dispatchTools.ts:133-141`](../../../convex/engine/dispatchTools.ts)).
5. **No double-summarize.** Re-invoking `compact` with an existing CompactionEntry for `(sessionId, firstKeptEntryId)` makes **zero** `generateText` calls and returns the existing summary (`loop.ts:134` guarantee, now Lambda-enforced).
6. **Deltas WS-only, finalized-only persisted.** A streamed turn produces N `postToConnection` delta frames (no `seq`) and exactly **one** Steps write (the finalized step) — zero per-delta DynamoDB writes (D-AWS-3 / [§4.6](../../design/08-conventions-and-execution-boundary.md)).
7. **Counters not in DynamoDB.** No Lambda reads or writes `stepNumber`/`followUps`/`overflowRetries` from DynamoDB; they arrive in the SFN state and the Lambdas key only on `(requestId, stepNumber)` (D-AWS-7).
8. **Payload posture.** A large-roster run (frozen `runPlan` > 300 KB or `responseMessages` > 400 KB) spills to S3 and the SFN state + DynamoDB items stay under their limits; a downstream Lambda hydrates the pointer transparently (D-AWS-10).
9. **Usage parity.** `finalize`'s rollup over the Steps `Query` matches the Convex `addUsage` rollup field-for-field (`totalTokens`/`cacheRead`/`cacheWrite`/`cost`), [§4.7](../../design/08-conventions-and-execution-boundary.md).
10. **Keyless provider resolution.** With only the Lambda execution role (no `*_API_KEY`), a Bedrock model resolves and a decode succeeds; with `AI_GATEWAY_API_KEY` the gateway path resolves ([`gateway.ts:125-179`](../../../convex/providers/gateway.ts)).
11. **Cold-start bound.** Each Lambda cold-starts off-VPC within budget; the `llmStep` timeout sits above `STREAM_DEADLINE_MS` and under 15 min; no Lambda risks the 15-min cap (child task work is `StartExecution.sync`, not in-Lambda poll).

---

## Risks & gotchas

- **At-least-once Tasks make replay guards mandatory (D-AWS-7).** SFN re-invokes the SAME Lambda with the SAME input on retry. If `decode`'s `reconstructDecision`, `compact`'s CompactionEntry guard, or `appendToolResult`-by-`toolCallId` are not honored, the model/summarizer is **double-charged** or tool results double-appended. These guards were "belt-and-suspenders" in Convex (single-writer + workflow journal); here they are the only thing standing between a retry and a duplicate side effect.
- **The streaming-row crash window (§4.1).** A crash after `insertStreaming` but before `finalizeStep` leaves a non-finalized row; the re-run re-streams a full turn (preferred over force-finalizing a partial). The conditional `Put` on insert + the deterministic `UpdateItem` finalize keep persisted state consistent — but the streaming row's WS deltas were already broadcast (render-only, no `seq`), so the client must reconcile against the re-emitted finalized step (this is the G4.6 reducer's job; flag the contract).
- **Box keepAlive cost (unbounded without eviction).** `upstashBox.ts:131` creates with `keepAlive: true`. Every distinct `sandboxName` keeps a box warm; across many concurrent runs this is unbounded cost. **Tie `env.delete()` to the SFN execution lifecycle** (finalize / a cleanup state) — do not leak boxes.
- **`STREAM_DEADLINE_MS` vs Lambda timeout.** The 240 s force-finalize must fire *before* the Lambda is killed; set the llmStep timeout strictly above 240 s (~300 s) and below the 15-min cap. A misconfigured short timeout turns a force-finalizable partial into a hard kill → a non-finalized row → an avoidable re-stream.
- **AI SDK v7 pin (D-AWS-11).** `usage.ts:86-99` reads the v7 `inputTokenDetails`/`outputTokenDetails` nested shape (v5 was flat). A drift to v5/v8 silently zeroes cache-token accounting and understates spend. Pin v7 in the esbuild bundle and assert the shape in a test.
- **Cancel must be strongly consistent.** `dispatch.ts:48,69`'s `isCancelled` must `GetItem` the Requests **base** item with `ConsistentRead: true` — a GSI read (eventually consistent) could miss a just-written `cancelled` flag and run a tool that should have been skipped/discarded.
- **No-VPC + outbound HTTPS.** `dispatchTools` (box) and `mcpDiscover`/MCP reach external HTTPS; off-VPC Lambdas have direct egress. If a future requirement forces a VPC, a NAT gateway is needed (and the cold-start ENI penalty returns) — keep these off-VPC unless a VPC resource is genuinely required.
- **Bundle size / dynamic imports.** `@upstash/box` + `ai` + `@ai-sdk/gateway` + `@modelcontextprotocol/sdk` are large; keep `mcp/connect.ts`'s SSE transport a lazy dynamic import (code-split) so non-MCP runs don't pay for it, and keep zips under the unzipped 250 MB Lambda limit.
- **Registry side-effect imports must bundle.** `_cove/toolResolver.ts` / `_cove/extensionResolver.ts` / `_cove/agentResolver.ts` are side-effect imports that install the name→closure registries in the isolate ([`llmStep.ts:13`](../../../convex/engine/llmStep.ts), [`dispatchTools.ts:19-21`](../../../convex/engine/dispatchTools.ts), [`setup.ts:12-18`](../../../convex/engine/setup.ts)). esbuild tree-shaking must NOT drop them — user tools/extensions silently degrade to `errorTool` stubs if the registry is empty in the Lambda.
- **Nested `StartExecution.sync` depth.** Deep `task()` trees become nested synchronous executions; SFN nesting is bounded and each level is a real execution (cost + the 25k-history cap per level — continue-as-new is G4.3). Surface the depth guard (`assertTaskDepth`, [`task.ts:59-60`](../../../convex/engine/task.ts)) as an error tool-result, never a crash, exactly as today.
- **The `runs` table has no writer yet.** Parity gap (G2.4/D18 pending): the SFN execution lifecycle is the natural place to write the Runs row, but that is new work, not a port — track it in the G4.8 parity checklist, do not assume `finalize` already does it.
