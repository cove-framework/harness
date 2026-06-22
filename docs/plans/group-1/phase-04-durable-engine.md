# Phase 4 — Durable engine — the loop

> Build the durable `setup → (llmStep → dispatchTools)* → finalize` workflow loop with streamed deltas, honoring every §4 hardened contract. Design-of-record: [06 — Roadmap](../../design/06-phase-roadmap.md) + [04 — Durable Engine](../../design/04-durable-engine.md) + [08 — Conventions & Execution Boundary](../../design/08-conventions-and-execution-boundary.md). Decisions: [D1–D19](../../design/07-risks-and-decisions.md).

## Goal & scope

Stand up the **durable agent loop** as a `@convex-dev/workflow` workflow plus the `convex/engine/` actions/mutations it journals through. The loop must:

- `setup` → resolve + **freeze the plan** (resolve-only; provisions **no** box), compose the system prompt.
- `(llmStep → dispatchTools)*` → one streamed decode per step (replay-guarded), then parallel/idempotent/cancel-aware tool dispatch.
- `finalize` → terminalize the request (`completed` / `failed` / `cancelled`) and roll up usage.

**In scope (this phase):** the loop skeleton, the streaming delta-batcher, `buildTools` rebuild-from-frozen-descriptor (incl. the MCP re-resolution carve-out *seam*), the replay guard, action budgets, cancel short-circuit, step cap, result-tool re-nudge/termination, usage capture, `isRetryableModelError` retry, and the `MockLanguageModelV2`-driven replay/throughput/parity tests.

**Out of scope (deferred to named phases):** the HITL `waitForEvent` gate body + `applyApproval`/`submitApproval` (P7 — leave the `step.waitForEvent` call site as a documented stub that no-ops when no tool is `isHitl`); compaction `compact.run` summarization step (P12 — leave the `shouldCompact` branch stubbed/false); the `connectMcpServer` network client (P10 — `buildTools` honors the MCP descriptor *branch* but the live client resolver is a typed stub); the `CoveContext.init → session.prompt` facade and `invoke/*` admission (P6); the `sessions.load`/`save` store internals (P5 — **co-developed**, see Dependencies).

## Dependencies

| Phase | Why it must land (or co-develop) first |
| --- | --- |
| **P1** (pure core + schema) ✅ | `SessionHistory.buildContext()`/`fromData` ([`src/runtime/session-history.ts`](../../../src/runtime/session-history.ts)), `normalizeToolDefinition` ([`src/runtime/tool.ts`](../../../src/runtime/tool.ts)), `ResultUnavailableError`/`CoveError` ([`src/runtime/errors.ts`](../../../src/runtime/errors.ts)), `PromptUsage`/`ModelHandle`/`DurabilityConfig` ([`src/runtime/types.ts`](../../../src/runtime/types.ts)), and the `agentRequests`/`agentRequestSteps`/`sessions` tables ([`convex/schema.ts`](../../../convex/schema.ts)). |
| **P2** (box sandbox) | `dispatchTools` resolves a `SessionEnv` for box-bound tool `execute`. Until P2 lands, `dispatchTools` can drive the **in-process bash adapter** built-in (the real-machine target) so the loop is testable without a box. |
| **P3** (provider registry) | `resolveModel` returns a `ModelHandle`; `llmStep` also accepts an **injected** `ModelHandle` and honors the **reserved test model id → `MockLanguageModelV2`** seam — the single deterministic driver for every P4 test. `fromProviderUsage`/`adjustMaxTokensForThinking`/`toModelMessages` live here. |
| **P5** (session store) — **co-developed** | The loop needs `internal.sessions.load` (rebuild context) and `internal.sessions.save`/append (write user/assistant/tool entries). P4 and P5 are built together; P4 may stub `sessions.load` against a minimal in-table reader and tighten it as P5 lands. |

Per [06 critical path](../../design/06-phase-roadmap.md#critical-path): `P2,P3 ─▶ P4 ◀─▶ P5`.

## Deliverables

Exact files/dirs to create (each opens with the [§2 reference header](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)):

| File | Purpose |
| --- | --- |
| `convex/workflow.ts` | The `WorkflowManager` singleton: `export const workflow = new WorkflowManager(components.workflow)`. |
| `convex/engine/runHandler.ts` | `export const agentRun = workflow.define(...)` — the journaled `setup → (llmStep → dispatchTools)* → finalize` loop; owns step cap, result re-nudge, cancel branch, the `waitForEvent` stub. |
| `convex/engine/setup.ts` | `internalAction` `run`: resolve the frozen plan from the agent registry, compose the system prompt (HEADLESS_PREAMBLE + Available Skills + Date/Working-dir; **no** dir listing), freeze onto `agentRequests.plan`/`sessions.plan`. **Resolve-only — provisions no box.** Registers built-in + loop-control tools as **frozen descriptors**. |
| `convex/engine/buildTools.ts` | Pure rebuild: frozen descriptor[] → AI SDK tool map. Two views: **model view** (`execute` stripped, JSON-Schema only) for `llmStep`; **executable view** (`execute` re-wrapped via `normalizeToolDefinition`) for `dispatchTools`. Handles the MCP descriptor branch (re-resolve client — P10 stub) and `buildTools`-failure → error tool-result. |
| `convex/engine/llmStep.ts` (`"use node"`) | `internalAction` `run`: **replay guard** → rebuild context → model-view tools → insert streaming row → `streamText` + delta-batch → finalize row (toolCalls/usage/responseMessages). Carries the 240 s stream deadline, `isRetryableModelError` retry, `toModelMessages` outbound transform. Returns the decision. |
| `convex/engine/dispatchTools.ts` (`"use node"`) | `internalAction` `run`: resolve `SessionEnv`, executable-view tools, `Promise.all` over toolCalls with **per-tool 30 s timeout**, **cancel short-circuit before each tool**, idempotent `appendToolResult` keyed on `toolCallId`. |
| `convex/engine/finalize.ts` | `internalMutation` `run`: terminalize `agentRequests` (`completed` / `failed`+`reason` / `cancelled`), set `finalText`/`result`, roll up `totalTokens`/`totalSteps`/`totalToolCalls`/`durationMs` from finalized step rows. |
| `convex/engine/deltaBatcher.ts` | `class DeltaBatcher` — coalesce text/reasoning deltas, flush on the looser of `deltaBatchMs`/`deltaBatchChars`; flush mutation **durably committed before the workflow advances**. |
| `convex/engine/steps.ts` | The step-row mutations/queries `llmStep`/`dispatchTools` call: `byRequestStep` (query), `insertStreaming`, `patchStreaming`, `finalize`, `appendToolResult`, `getOutcome`, `appendFollowUp`. (May be split per-call; keep one module to avoid circular `internal.*` refs.) |
| `convex/engine/reconstructDecision.ts` | Pure helper: a finalized `agentRequestSteps` row → the in-memory `decision` object the loop consumes (`{ finishReason, toolCalls, shouldCompact }`). The replay-guard return path. |
| `convex/engine/usage.ts` | Ported `emptyUsage`/`addUsage`/`fromProviderUsage` (from flue `runtime/src/usage.ts`) — per-step capture + rollup aggregation. |
| `convex/engine/modelErrors.ts` | Ported `isRetryableModelError` (+ `isContextOverflow` re-export seam) from flue `submission-state.ts`/`compaction.ts` — `llmStep` retry classification. |
| `convex/engine/resultTools.ts` | The per-call `result`/`finish`/`give_up` tool descriptors + `buildResultFollowUpPrompt` + `getOutcome` outcome mapping (`pending | finished | gave_up`), ported from flue `result.ts`. |
| `convex/engine/builtinTools.ts` | The frozen **descriptor** set for read/write/edit/bash/grep/glob (+ task/activate_skill descriptor placeholders) ported from flue `agent.ts` `createTools`; `execute` is re-bound in `buildTools`, not frozen. |
| `convex/engine/__tests__/loop.test.ts` (or `test/engine/…`) | The P4 acceptance test suite driven by `MockLanguageModelV2`: replay guard, three-beat cadence, frozen-descriptor rebuild parity, idempotent dispatch, `responseMessages` round-trip, step cap, result re-nudge/give-up/exhaustion, throughput-stress cadence calibration. |

## Source map (flue/pi → cove)

All flue paths verified present under `/Users/toannguyen/Repo-Explorer/harness-engine/flue/packages/runtime/src/`.

| flue/pi source | → cove target | Port / transform notes |
| --- | --- | --- |
| `runtime/src/agent.ts` ([`createTools`](../../../../flue/packages/runtime/src/agent.ts) L39, `createTaskTool` L299, `initializeCreatedAgent`, `composeSystemPrompt`) | `convex/engine/setup.ts` + `convex/engine/builtinTools.ts` | `createTools(env, opts)` returns live closures; **invert** to frozen *descriptors* at setup, re-bind `execute` in `buildTools`. `composeSystemPrompt` → keep HEADLESS_PREAMBLE + Available Skills (catalog query) + Date/Working-dir; **omit dir listing** ([04 setup](../../design/04-durable-engine.md#setup--freeze-the-plan)). `task`/`activate_skill` descriptors land as placeholders (full wiring P6/P10). |
| `runtime/src/result.ts` (`FINISH_TOOL_NAME` L13, `GIVE_UP_TOOL_NAME` L14, `buildResultFollowUpPrompt` L27, `createResultTools` L159, `ResultToolBundle`/`ResultToolOutcome`, `ResultUnavailableError` L303) | `convex/engine/resultTools.ts` (+ reuse `ResultUnavailableError` already in [`src/runtime/errors.ts`](../../../src/runtime/errors.ts) L138) | Port the `finish`/`give_up` (+ `result`) descriptors + the first-call-wins outcome bundle. `getOutcome` maps the bundle to `pending|finished|gave_up`. Use cove's `ResultUnavailableError` (CoveError subclass) — do **not** re-port flue's `extends Error` version. |
| `runtime/src/usage.ts` (`emptyUsage` L15, `addUsage` L30, `fromProviderUsage` L54) | `convex/engine/usage.ts` | Verbatim port. **Field-name divergence is intentional** ([08 §4.7](../../design/08-conventions-and-execution-boundary.md#47-usage--cost)): provider/rollup side uses `inputTokens`/`outputTokens` (AI SDK shape, matches `usageValidator` in schema), caller-facing `PromptUsage` uses `input`/`output`; `fromProviderUsage` is the single bridge. Persist `cacheRead`/`cacheWrite`/`cost{}` — not a token-only subset. |
| `runtime/src/submission-state.ts` (`isRetryableModelError` L284) + `runtime/src/compaction.ts` (`isContextOverflow` re-export L735) | `convex/engine/modelErrors.ts` | Port **only** `isRetryableModelError` (+ `isContextOverflow` seam for P12). The rest of `submission-state.ts`/`stream-chunks.ts` is **subsumed by workflow replay** ([08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)) — do not port `classifySubmissionState`/`findTrailingPartialToolBatch`/lease machinery. |
| `runtime/src/submission-state.ts` `runModelTurnWithRecovery` (in-process recovery loop) | `convex/engine/llmStep.ts` | Replaced by the **workflow journal + replay-guarded idempotent step row**. `llmStep` mirrors the *decode* of `runModelTurnWithRecovery`; "recovery" is the journal, not the in-process retry wrapper. |
| flue Node durable coordinator / in-memory / sqlite stores | (none — dropped) | Obsolete; replaced by the Convex workflow + tables ([08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)). |
| `runtime/src/session-identity.ts` (`createTaskSessionName`) | referenced by `task` descriptor placeholder | Full task-spawn wiring is **P6**; setup only freezes the `task` descriptor + declared subagents here. |
| pi `packages/ai` `MockLanguageModelV2` seam (via `@ai-sdk/provider-utils`) | test driver only | `llmStep` accepts an injected `ModelHandle`; `resolveModel` honors the reserved test-model id (P3). flue `providers/faux.ts` is **not** ported — superseded ([08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)). (`flue/.../providers/` does not exist in flue runtime — confirms the mock is the only seam.) |

## Hardened-contract obligations

This phase must honor every applicable rule in [08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy) and [08 §4](../../design/08-conventions-and-execution-boundary.md#4-hardened-engine-contracts):

- **§3 execution boundary** — only `"use node"` engine actions touch the sandbox: `setup` **resolve-only** (no box), `dispatchTools` **box-bound tools only**; `llmStep`/`finalize`/`steps.*` are **box-free**. The LLM never initiates a step.
- **[§4.1 replay guard](../../design/08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical)** *(critical)* — `llmStep` queries `agentRequestSteps by (requestId, stepNumber)` at entry; an `isFinalized` row → `reconstructDecision` returns **without any AI-SDK call**. Model called **at most once per stepNumber**.
- **[§4.2 budgets](../../design/08-conventions-and-execution-boundary.md#42-action-budgets--timeouts)** — `llmStep` stream deadline **≈ 240 s** (force-finalize the partial, never let the action be killed mid-stream); per-tool timeout **≈ 30 s** in `dispatchTools` (hung tool → error tool-result); default box `exec` `timeoutMs` = 30 s. Both surfaced through `DurabilityConfig` ([`src/runtime/types.ts`](../../../src/runtime/types.ts) L217).
- **[§4.3 cancel short-circuit](../../design/08-conventions-and-execution-boundary.md#43-cancel-short-circuit)** — `dispatchTools` re-reads `agentRequests.status` **before each tool**; on `cancelled` it skips remaining tools and **discards late results**.
- **[§4.5 frozen-descriptor rebuild](../../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors)** — the frozen descriptor is authoritative for the whole run; `buildTools` (importing `normalizeToolDefinition` from [`src/runtime/tool.ts`](../../../src/runtime/tool.ts)) rebuilds in **both** actions. A `buildTools` failure → error tool-result, never a step crash. **MCP carve-out:** the descriptor carries server identity + transport (not a closure); `buildTools` re-resolves a network client (live resolver stubbed → P10) instead of binding the box; replay returns the persisted result (no re-`callTool`).
- **[§4.6 streaming commit](../../design/08-conventions-and-execution-boundary.md#46-streaming-commit--subscription-semantics)** — the delta flush mutation is **durably committed before the workflow advances**; deltas are **coalesced into the step row** (patch-in-position, not an append log). Cadence `deltaBatchMs = 400`, `deltaBatchChars = 480` (configurable; calibrate the production value from the throughput test).
- **[§4.7 usage](../../design/08-conventions-and-execution-boundary.md#47-usage--cost)** — per-step `fromProviderUsage` → aggregate with `addUsage`/`emptyUsage` → `agentRequests` rollups. Persist `cacheRead`/`cacheWrite`/`cost{}`, not a token-only subset. Honor the `inputTokens`/`outputTokens` ↔ `input`/`output` bridge.
- **[§4.9 step cap](../../design/08-conventions-and-execution-boundary.md#49-step-cap--loop-termination)** — `while (stepNumber < plan.maxSteps)` (default **100**, frozen at setup onto `frozenPlanValidator.maxSteps`); a model-driven `finishReason === "stop"`/terminal tool ends normally; hitting the cap → `finalize` `failed` + reason **`step_limit_exceeded`** (observable, never silent).
- **[§4.10 result re-nudge](../../design/08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination)** — for an output-schema run, `stop` is terminal **only** when `getOutcome` is `finished`. `gave_up` → reject `CallHandle` with `ResultUnavailableError` (reason + assistant text), **never** an unvalidated `data` resolve. `pending` → `appendFollowUp(buildResultFollowUpPrompt())`, bounded by **`maxFollowUps`** (default **32**, frozen on `frozenPlanValidator.maxFollowUps`). The `followUps` counter is **durable per-run state threaded through the journal**, distinct from `stepNumber`. Exhaustion → `finalize` `failed` + **`result_followups_exhausted`** + reject.
- **`responseMessages` round-trip parity** ([04 context-rebuild](../../design/04-durable-engine.md#llmstep--one-decode-streamed)) — verbatim provider `responseMessages` (signatures/reasoning metadata) persist on the step row and round-trip **byte-faithfully** across the `llmStep → dispatchTools → next-llmStep` split (preserves reasoning-signature continuity + prompt-cache affinity `sessions.affinityKey`).
- **`toModelMessages` outbound transform** ([04](../../design/04-durable-engine.md#tomodelmessages--outbound-message-normalization)) — apply `sanitizeSurrogates` to every outbound text field; on `ModelHandle.supportsVision === false`, **replace** (not drop) image parts with a text placeholder and de-dup consecutive placeholders.

## Implementation tasks

Ordered, buildable checklist. Keep `tsc --noEmit` green after **every** task.

- [ ] **1. `convex/workflow.ts`** — `export const workflow = new WorkflowManager(components.workflow)` (component already registered in [`convex/convex.config.ts`](../../../convex/convex.config.ts)). Reference header: `// New (Convex backend) · @cove/runtime`.
- [ ] **2. `convex/engine/usage.ts`** — verbatim-port `emptyUsage`/`addUsage`/`fromProviderUsage`; align `PromptUsage` import from [`src/runtime/types.ts`](../../../src/runtime/types.ts). No Convex deps — unit-testable immediately.
- [ ] **3. `convex/engine/modelErrors.ts`** — port `isRetryableModelError` + `isContextOverflow` seam. Strip the pi-ai-specific `AssistantMessage` coupling down to what the AI-SDK error shape exposes.
- [ ] **4. `convex/engine/resultTools.ts`** — port `result`/`finish`/`give_up` descriptors + `buildResultFollowUpPrompt` + the first-call-wins outcome bundle; export `mapOutcome(bundleState) → 'pending'|'finished'|'gave_up'`. Reuse `ResultUnavailableError` from [`src/runtime/errors.ts`](../../../src/runtime/errors.ts).
- [ ] **5. `convex/engine/builtinTools.ts`** — frozen **descriptors** for read/write/edit/bash/grep/glob (+ `task`/`activate_skill` placeholder descriptors). No live `env`/closures captured here.
- [ ] **6. `convex/engine/buildTools.ts`** — `buildModelTools(frozenDescriptors)` (strip `execute`) and `buildExecutableTools(frozenDescriptors, env, signal)` (re-wrap via `normalizeToolDefinition` from [`src/runtime/tool.ts`](../../../src/runtime/tool.ts)). Wrap each `execute` in a try/catch that converts a build/bind failure into an **error tool-result** marker (never throw). Add the **MCP branch**: if `descriptor.kind === 'mcp'`, resolve via the (P10-stubbed) client resolver instead of binding `env`; the stub throws `SandboxOperationUnsupportedError`-style typed "not yet wired" so it's visibly unimplemented, not silently broken.
- [ ] **7. `convex/engine/steps.ts`** — the step-row functions:
  - `byRequestStep` (query, `by_request_and_step`) — replay-guard read.
  - `insertStreaming` (mutation) — insert `{isFinalized:false, text:"", reasoning:"", toolResults:[]}`.
  - `patchStreaming` (mutation) — append-coalesce text/reasoning **in position** (read current, concat, patch); the batcher's flush target.
  - `finalize` (mutation) — set `finishReason`/`toolCalls`/`usage`/`responseMessages`/`model`/`durationMs`, `isFinalized:true`. **Idempotent**: if already finalized, no-op.
  - `appendToolResult` (mutation) — **idempotent by `toolCallId`**: replace-in-place in `toolResults[]`, never append a duplicate; set `hadToolError`.
  - `appendFollowUp` (action or mutation) — write the re-nudge prompt entry into the session (via `sessions.save`).
  - `getOutcome` (query) — read the result bundle state for the request → `{kind:'pending'|'finished'|'gave_up', reason?, assistantText?, data?}`.
- [ ] **8. `convex/engine/reconstructDecision.ts`** — pure: finalized row → `{finishReason, toolCalls, shouldCompact}`. Used by the §4.1 guard return path. Must produce a decision **identical** to the live finalize path (parity-test target).
- [ ] **9. `convex/engine/deltaBatcher.ts`** — `class DeltaBatcher` with `text(s)`/`reasoning(s)`/`flush()`. Flush when buffered chars ≥ `deltaBatchChars` (480) **or** elapsed ≥ `deltaBatchMs` (400); `flush()` awaits the `patchStreaming` mutation so it is **durably committed before the workflow advances**. Expose the two constants from `DurabilityConfig`-driven config with the §4.6 defaults.
- [ ] **10. `convex/engine/setup.ts`** (`"use node"` only if it must touch network/registry; otherwise plain action) — `internalAction run({requestId})`:
  - Load the `agentRequests` row + agent profile from the registry (P6 wires the registry; here resolve from a passed/declared profile or a P6-stub registry getter).
  - Resolve model/instructions/tools/skills/subagents; resolve `maxSteps` (default 100) and `maxFollowUps` (default 32) from `DurabilityConfig`.
  - `composeSystemPrompt`: HEADLESS_PREAMBLE + Available-Skills (catalog query — P10 stub returns empty) + Date/Working-dir block; **omit the directory listing**.
  - Freeze descriptors (built-ins + loop-control `result`/`finish`/`give_up` when `expectsResult`, registered **ahead of** user tools) onto `agentRequests.plan` / `sessions.plan` (`frozenPlanValidator`). **Provision no box.** Return the frozen `plan`.
- [ ] **11. `convex/engine/llmStep.ts`** (`"use node"`) — `internalAction run({requestId, stepNumber, plan, followUps})`:
  1. **REPLAY GUARD** — `byRequestStep`; if `isFinalized`, `return reconstructDecision(row)` (no model call).
  2. Rebuild context: `sessions.load` → `SessionHistory.fromData(data).buildContext()`.
  3. `buildModelTools(plan.tools)` (execute stripped).
  4. `insertStreaming`.
  5. Resolve model: injected `ModelHandle` ?? `resolveModel(plan.model)`.
  6. `streamText({ model, system: plan.systemPrompt, messages: toModelMessages(messages), tools })`; iterate `fullStream`, route `text-delta`/`reasoning-delta` into the `DeltaBatcher`. Enforce the **240 s deadline** (race the stream against a timer; on deadline **force-finalize the partial**).
  7. `batcher.flush()` (durable commit).
  8. `finalizeFromResult` → capture `finishReason`, `toolCalls`, `usage` (`fromProviderUsage`), verbatim `responseMessages`; `steps.finalize`.
  9. Wrap the decode in `isRetryableModelError` retry (bounded retry of the **same** step; do **not** finalize a retryable failure as a request failure). Context-overflow (`isContextOverflow`) → signal `shouldCompact`/retry seam (P12 stub: log + rethrow as non-retryable for now).
  10. `return {finishReason, toolCalls, shouldCompact}`.
- [ ] **12. `convex/engine/dispatchTools.ts`** (`"use node"`) — `internalAction run({requestId, stepNumber, toolCalls, plan})`:
  - Resolve `SessionEnv` (P2 box / in-process bash adapter); `buildExecutableTools(plan.tools, env, signal)`.
  - `Promise.all(toolCalls.map(...))`: **before each tool** re-read `agentRequests.status`; if `cancelled`, `return` (skip + discard). Run the tool under a **30 s per-tool timeout**; catch → error tool-result. `appendToolResult` idempotently by `toolCallId`.
  - (`ToolExecutionMode` sequential is **not** ported — `Promise.all` parallel only, [08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit).)
- [ ] **13. `convex/engine/finalize.ts`** — `internalMutation run({requestId, reason?})`: read finalized step rows, roll up `totalTokens`/`totalSteps`/`totalToolCalls`/`durationMs`; set terminal `status` + `finalText`/`result`/`error`/`cancelReason`; on `reason` set `failed` + the reason string (`step_limit_exceeded` / `result_followups_exhausted`). Idempotent on an already-terminal request.
- [ ] **14. `convex/engine/runHandler.ts`** — `export const agentRun = workflow.define(...)` per [04 the loop](../../design/04-durable-engine.md#the-loop):
  - `step.runAction(setup)` → `plan`.
  - `let stepNumber = 0; let followUps = 0;` (durable, journal-replayed).
  - `while (stepNumber < plan.maxSteps)`: `llmStep` → branch on `finishReason`/`getOutcome` (result re-nudge logic from §4.10) → HITL gate **stub** (`step.waitForEvent` only when a `toolCall.isHitl`; no-op in P4 since no tool sets it) → `dispatchTools` → compaction **stub** (`if (decision.shouldCompact)` left false) → `stepNumber++`.
  - Cap reached → `finalize({reason:'step_limit_exceeded'})`.
  - Normal exit → `finalize()`.
  - Each `llmStep`/`dispatchTools`/decide beat is **its own `step.run*` checkpoint** (three-beat cadence, §06 P4 checklist).
- [ ] **15. Wire `_generated/api`** — run `npx convex codegen` (or `convex dev --once`) so `internal.engine.*` resolves; fix any `internal.*` reference ordering (keep step mutations in one module to avoid cycles).
- [ ] **16. Tests** (`convex/engine/__tests__/loop.test.ts`) — see Acceptance; all driven by `MockLanguageModelV2` via the injected `ModelHandle` / reserved test-model id. Use `convex-test` (vitest) to drive `workflow`/actions in-process.
- [ ] **17. Calibrate cadence** — run the throughput-stress test; record the chosen production `deltaBatchMs`/`deltaBatchChars` (start at 400/480) in `convex/engine/deltaBatcher.ts` and note it for the P12 regression gate.
- [ ] **18. `tsc --noEmit`** green; no `any`-leaks across the journal boundary (only serializable scalars cross `step.run*`).

## Acceptance

Each invariant gets a **test**, not prose ([06 P4 checklist](../../design/06-phase-roadmap.md#-phase-4--durable-engine)). All model decisions come from an injected `MockLanguageModelV2`.

1. **End-to-end happy path** — a hard-coded request runs `setup → llmStep → dispatchTools → finalize`: a step row streams `text`, a tool call dispatches and writes an **idempotent** result, the request terminalizes **`completed`** with `finalText` + usage rollups set.
2. **Replay guard / at-most-once model call** ([§4.1](../../design/08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical)) — finalize a step row, re-invoke `llmStep` for the same `(requestId, stepNumber)`; assert the `MockLanguageModelV2` `doStream`/`doGenerate` call count **does not increase** and the reconstructed decision equals the original. **Crash-after-finalize replay**: kill the action post-finalize, re-run the workflow, assert **no second provider call**.
3. **Three-beat cadence** — assert each `llmStep` / `dispatchTools` / decide beat is its own journaled `step.run*` checkpoint (a kill between beats resumes at the next beat, not the prior one).
4. **Crash mid-loop resumes from journal** — kill the action mid-loop; re-running resumes from the last committed `step.run*` to a coherent terminal state (no duplicated tool side-effects).
5. **Frozen-descriptor rebuild in both actions** ([§4.5](../../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors)) — `llmStep` builds the model view (`execute` stripped) and `dispatchTools` the executable view from the **same** frozen descriptor; a registry edit mid-run is **not** observed (frozen wins). `buildTools` failure → **error tool-result**, request not crashed.
6. **Idempotent `appendToolResult`** — a replayed `dispatchTools` rewrites results in place by `toolCallId` and **never double-executes** a side-effecting tool (assert a counter on the tool's `execute`).
7. **`responseMessages` round-trip parity** — capture `responseMessages` at `llmStep` N, split through `dispatchTools`, rebuild context at `llmStep` N+1; assert the rebuilt provider messages are **byte-faithful** (provider signatures preserved), demonstrated not asserted.
8. **Step cap** ([§4.9](../../design/08-conventions-and-execution-boundary.md#49-step-cap--loop-termination)) — a mock that never stops reaches `maxSteps` → terminalizes **`failed`** with reason **`step_limit_exceeded`**.
9. **Result re-nudge & termination** ([§4.10](../../design/08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination)) — for an output-schema run:
   - a `stop` without `finish`/`result` **re-nudges** (bounded by `maxFollowUps`, default 32) and the `followUps` counter is replay-deterministic + distinct from `stepNumber`;
   - `give_up` **rejects the CallHandle with `ResultUnavailableError`** (carrying reason + assistant text), never resolving `PromptResultResponse<T>` with unvalidated `data`;
   - exhausting `maxFollowUps` → terminalizes **`failed`** + **`result_followups_exhausted`** + reject;
   - a **completed** result run always carries **validated** `data`.
10. **Usage rollup fidelity** ([§4.7](../../design/08-conventions-and-execution-boundary.md#47-usage--cost)) — per-step `fromProviderUsage` aggregates into `agentRequests` rollups; `cacheRead`/`cacheWrite`/`cost{}` survive persistence (not a token-only subset); the `inputTokens` ↔ `input` bridge holds.
11. **Cancel short-circuit** ([§4.3](../../design/08-conventions-and-execution-boundary.md#43-cancel-short-circuit)) — flip `agentRequests.status = cancelled` mid-dispatch; the remaining tools are skipped and late results discarded.
12. **`toModelMessages` defenses** — a lone surrogate in prior tool output is stripped before `streamText`; a `supportsVision:false` model gets image parts **replaced** by a de-duped placeholder (not dropped, not raw bytes).
13. **Streaming-throughput stress** ([§4.6](../../design/08-conventions-and-execution-boundary.md#46-streaming-commit--subscription-semantics)) — drive a high-volume delta stream through the `DeltaBatcher`; assert flush count stays within the `deltaBatchMs`/`deltaBatchChars` envelope, deltas land **coalesced in-position** in the step row, and no delta is lost across a simulated redeploy (flush committed before advance). **Record the production cadence** for the P12 regression gate.

## Risks & gotchas

- **`"use node"` only where the box/AI-SDK lives.** `llmStep` and `dispatchTools` are `"use node"` actions; `setup` is **resolve-only** (provisions no box) and `finalize`/`steps.*` are plain mutations/queries — keep them box-free. A `"use node"` file cannot share a module with non-node Convex functions, so don't co-locate `steps.ts` mutations inside `llmStep.ts`.
- **Journal serialization.** Only **serializable scalars** cross `step.run*`. The frozen `plan`, `decision`, `followUps`, `stepNumber` must be plain JSON — **no closures, no class instances, no `ModelHandle`/`SessionEnv`** across the boundary. `buildTools` rebuilds closures **inside** each action, never passes them through the journal.
- **Replay determinism is the whole ballgame.** The §4.1 guard must run **before** any AI-SDK touch. Any non-determinism the model call would introduce (timestamps, ids, partial streams) must be sourced from the **finalized row** on replay via `reconstructDecision`, not recomputed. The `followUps` counter must be threaded through the journal (incremented only **after** the `appendFollowUp` checkpoint commits) so replay re-takes the identical branch.
- **Stateless box handles.** A warm `SessionEnv` does not survive a cold action; `dispatchTools` re-resolves the box **by name** each invocation ([08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)) — never assume a cached handle from a prior step.
- **Stream deadline vs. action kill.** If the 240 s deadline is not enforced, Convex kills the action mid-stream and leaves the step row ambiguous. **Race the stream against a timer** and force-finalize the partial so the journal entry is always well-formed.
- **Delta flush ordering.** `patchStreaming` must **append-coalesce in position** (read-concat-patch), not overwrite; and the final `flush()` must be awaited **before** the action returns so a redeploy can't lose the tail (§4.6). Patching per-token (not batching) will overwhelm Convex mutation throughput — the batcher is mandatory.
- **`appendToolResult` idempotency is load-bearing for replay AND cancel.** Keyed on `toolCallId`, replace-in-place; a replayed `dispatchTools` must not double-execute a side-effecting tool nor append a duplicate result row entry.
- **MCP carve-out is a seam, not a feature here.** `buildTools` must *route* MCP descriptors to a (P10-stubbed) client resolver rather than binding the box — but the live client is **not** built in P4. Make the stub throw a typed "not yet wired" error so it's visibly unimplemented, never a silent box-bind.
- **Result-schema `stop` is not terminal.** For an output-schema run, a bare `finishReason === "stop"` must consult `getOutcome` — a model that stops without a validated result re-nudges; resolving `PromptResultResponse<T>` with unvalidated `data` is a **correctness bug**, not a fallback.
- **Co-development with P5.** `sessions.load`/`save`/`appendFollowUp` are P5 surfaces; stub them minimally if P5 lags, but the `responseMessages` round-trip test needs a real save/load to be meaningful — gate that test on the P5 entry-diff-sync landing.
- **`isRetryableModelError` retry ≠ request failure.** A retryable model error retries the **same step** (bounded), not a request `failed` — distinct from the overflow-driven compact-then-retry path (P12). Don't terminalize on a transient error.
