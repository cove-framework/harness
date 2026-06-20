# 06 — Phase Roadmap

Dependency-ordered. Each phase lists its deliverables and a concrete acceptance
bar. Status reflects the live build; the in-repo
[`cove-harness/PLAN.md`](../../PLAN.md) tracks the short form.

This roadmap defers to [08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md)
for naming (Cove brand types, the `[cove]` error prefix), the reference-header
convention, the orchestration ↔ execution boundary, and the **hardened engine
contracts** (§4 there). Where a phase below names a contract, the authoritative
value lives in 08; this doc only schedules the work.

Legend: ✅ done · ◻ pending.

---

### ✅ Phase 0 — Scaffold + plan
**Deliverables:** `package.json`, `tsconfig.json`,
[`convex/convex.config.ts`](../../convex/convex.config.ts), this plan,
[`PLAN.md`](../../PLAN.md).
**Acceptance:** deps install and resolve; `convex.config` registers the workflow
component.

### ✅ Phase 1 — Pure core + SOR schema
**Deliverables:** [`convex/schema.ts`](../../convex/schema.ts) (all
tables) + ported [`src/runtime/`](../../src/runtime/) modules
(`messages`, `types`, `errors`, `tool-types`, `tool-schema`, `tool`,
`agent-definition`, `session-history`, `skill-frontmatter`, `index`).
**Acceptance:** `tsc --noEmit` exits 0; the canonical message model mirrors pi so
`SessionData`/`session-history` are wire-faithful. **(met)**

### ◻ Phase 2 — Upstash box sandbox
**Deliverables:** `convex/sandbox/upstashBox.ts` implementing `SessionEnv` (9
methods) against `@upstash/box`, wrapped by the ported `createSandboxSessionEnv`
(path resolution, parent-dir creation, abort checks); `upstashBox()`
`SandboxFactory` constructor. `exec` wraps base64 `bash -l`; `timeoutMs` rounds up
to box seconds.

**Local / real-machine adapter (second built-in).** Port flue's in-process
`bash()` / `createBashSessionEnv` ([`sandbox.ts`](../../../flue/packages/runtime/src/sandbox.ts))
as a `BashFactory`-backed `SandboxFactory` — the **real-machine** execution target
that satisfies the same `SessionEnv` contract and workspace confinement as the box.
This makes `BashFactory`/`BashLike` a *consumed* contract, not orphaned types
([D7](07-risks-and-decisions.md)). The seam stays open for third-party targets
(Daytona/E2B/etc. are not ported).

Box **lifecycle** (per the boundary in
[08 §3](08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)):

- **Lazy provisioning** — no box is created until the first `exec`/fs operation
  of a run; setup only resolves a handle.
- **By-name resolution** — `` sandboxName = `${ctx.id}:${instanceId}:${harnessName}` ``,
  resolved via `Box.list/get` on each cold action and cached for that action only
  (boxes outlive stateless actions; the in-process handle cache does not).
- **Warm vs cold** — a warm box (resolved from a prior action) is reused; a cold
  action re-resolves by name before touching it.
- **Box-gone failure handling** — if a previously-resolved box no longer exists,
  the resolver re-provisions (or surfaces a typed failure) rather than wedging the
  run on a stale handle.
- **`SandboxOperationUnsupportedError`** — a partial/limited box implementation
  that cannot service a given `SessionEnv` method raises this typed error (it never
  silently no-ops).

**Workspace enforcement:** each `SessionEnv` is scoped to **one designated
per-session workspace folder**; `createSandboxSessionEnv` resolves relative paths
against that `cwd` and **rejects `../` escapes** (parent-dir creation / `rm` /
`readdir` stay inside the workspace). Concurrent same-session operations serialize
via the `agentRequests`/`sessions.state` gate.

**Acceptance:** a unit/integration test runs `exec("echo hi")` and round-trips
`writeFile`/`readFile`/`stat`/`readdir`/`rm` through a box; first `exec`
provisions the box lazily; a `../`-escape path is rejected; an unsupported
operation on a partial impl raises `SandboxOperationUnsupportedError`. The same
round-trip also runs `exec("echo hi")` through the **in-process `bash()` adapter**
(the real-machine target), confirming both built-ins satisfy one `SessionEnv` contract.
**Depends on:** P1 (`SessionEnv` type, `BashFactory`/`BashLike`).

### ◻ Phase 3 — Provider registry
**Deliverables:** `convex/providers/` — AI SDK gateway registry,
`registerProvider`/`registerApiProvider` facade, `ModelConfig` string → gateway
model id, `ThinkingLevel` → per-provider reasoning options, V8-safe default
constants, `resolveModel` → `ModelHandle`.

This phase carries the **provider-options fidelity** ported from pi:

- **Concrete thinking budgets + token fitting** — reproduce pi's per-provider
  `ThinkingLevel` mapping with its concrete numeric budgets and the
  `adjustMaxTokensForThinking` fitting math: **anthropic/bedrock** map to explicit
  reasoning **token budgets** (the budget is carved out of and fit within
  `maxTokens`), **google** maps to `thinkingConfig` (thinking-token budget), and
  **openai** maps to `reasoningEffort`. The fitting math guarantees the thinking
  budget never exceeds the model's `maxTokens` envelope.
- **`storeResponses` flag** — the request-level `storeResponses` flag threads
  through to `providerOptions.openai.store`.
- **`toModelMessages` non-vision downgrade** — when a model lacks vision,
  `toModelMessages` downgrades an image part to a text **placeholder** rather than
  passing raw image bytes to a non-vision model.
- **Test model injection** — `resolveModel` honors a **reserved test model id**
  that returns an AI SDK `MockLanguageModelV2` (from
  `@ai-sdk/provider-utils`/test) `ModelHandle`; `llmStep` also accepts a directly
  injected `ModelHandle`. This is the single deterministic seam P3/P4 tests drive
  (flue's `providers/faux.ts` is **not** ported — superseded by the AI SDK mock,
  [08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)).

**Acceptance:** `resolveModel("anthropic/claude-sonnet-4-6")` returns a handle
with the right capabilities; a non-streaming `generateText` smoke call works
**against an injected `MockLanguageModelV2`** (reserved test model id) so the smoke
test needs no live provider. A thinking-budget request fits within `maxTokens` per
`adjustMaxTokensForThinking`; an `openai` request with `storeResponses` sets
`providerOptions.openai.store`; a non-vision model downgrades an image part to a
placeholder. Provider detection also resolves **keyless ambient credentials**
(Google ADC / AWS Bedrock) — not only literal API keys.
**Depends on:** P1 (`ModelHandle`, `ModelConfig`, `ThinkingLevel`).

### ◻ Phase 4 — Durable engine
**Deliverables:** `convex/workflow.ts` + `convex/engine/` (`setup`,
`runHandler.agentRun`, `llmStep`, `dispatchTools`, `finalize`, `deltaBatcher`).
The full `setup → (llmStep → dispatchTools)* → finalize` loop with streamed
deltas. (HITL + compaction land in P7/P12.)

Hardened-contract work this phase carries (values in
[08 §4](08-conventions-and-execution-boundary.md#4-hardened-engine-contracts)):

- **Built-in framework tools** — the ported `createTools` set plus the loop
  control tools (`result`, `finish`, `give_up`) registered ahead of user tools so
  the model can terminalize a run from inside a step.
- **`llmStep` REPLAY GUARD** *(critical)* — at entry, query `agentRequestSteps` by
  `(requestId, stepNumber)`; a finalized row reconstructs and returns the decision
  **without calling the AI SDK** (the model is called at most once per step
  number). See [08 §4.1](08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical).
- **Action budgets** — `llmStep` stream deadline ≈ **240 s** (force-finalize the
  partial on deadline); per-tool timeout ≈ **30 s** in `dispatchTools`; default box
  `exec` `timeoutMs` = 30 s. Surfaced through `DurabilityConfig`.
- **`buildTools` rebuild-from-frozen-descriptor** — the frozen tool descriptor on
  the request is authoritative for the whole run; `buildTools` re-wraps `execute`
  via `normalizeToolDefinition` from
  [`src/runtime/tool.ts`](../../src/runtime/tool.ts). A `buildTools`
  failure becomes an *error tool-result*, never a step crash; `appendToolResult` is
  idempotent on `toolCallId`.
- **Usage capture** — per-step usage via `fromProviderUsage`, aggregated with
  `addUsage`/`emptyUsage` into the `agentRequests` rollups (`totalTokens`/
  `totalSteps`/`durationMs`); ported from
  [`runtime/src/usage.ts`](../../../flue/packages/runtime/src/usage.ts).
- **`isRetryableModelError`** — ported from flue's
  [`submission-state.ts`](../../../flue/packages/runtime/src/submission-state.ts) into
  `llmStep` error handling (the rest of `submission-state`/`stream-chunks` is
  subsumed by workflow replay — see [08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)).

**Acceptance:** a hard-coded request runs end-to-end — a step row streams `text`,
a tool call dispatches and writes an idempotent result, the request terminalizes
`completed`. Killing the action mid-loop and re-running resumes from the journal.
A **crash-after-finalize replay test** confirms the replay guard makes **no second
provider call**. A **streaming-throughput stress test** drives the delta-batcher
and sets the production `deltaBatchMs`/`deltaBatchChars` cadence
([08 §4.6](08-conventions-and-execution-boundary.md#46-streaming-commit--subscription-semantics)).

**P4 acceptance checklist** — each invariant gets a test, not just prose:

- **Replay guard** — a finalized `agentRequestSteps` row makes `llmStep` reconstruct
  the decision with **no second AI-SDK call** (model called at most once per
  `stepNumber`). [08 §4.1](08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical)
- **Three-beat cadence** — each `llmStep` / `dispatchTools` / decide beat is its own
  `step.run*` journaled checkpoint.
- **Frozen-descriptor rebuild in *both* actions** — `llmStep` (model view, `execute`
  stripped) and `dispatchTools` (executable) rebuild tools from the same frozen
  descriptor; MCP descriptors re-resolve a network client.
  [08 §4.5](08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors)
- **Idempotent `appendToolResult`** — a replayed `dispatchTools` re-writes results in
  place by `toolCallId` and never double-executes a side-effecting tool.
- **`responseMessages` round-trip** — a parity test shows the context rebuilt across the
  `llmStep`→`dispatchTools`→next-`llmStep` split is byte-faithful (provider signatures
  preserved), not merely asserted.
- **Step cap** — reaching `maxSteps` terminalizes `failed` with `step_limit_exceeded`.
  [08 §4.9](08-conventions-and-execution-boundary.md#49-step-cap--loop-termination)
- **Result-tool re-nudge & termination** — for a result-schema run: a step that
  stops **without** calling `finish`/`result` re-nudges (bounded by
  `maxFollowUps`, default 32, parallel to `maxSteps`); a `give_up` **rejects the
  CallHandle with `ResultUnavailableError`** (carrying the give-up `reason` +
  assistant text) and never resolves `PromptResultResponse<T>` with unvalidated
  `data`; exhausting `maxFollowUps` terminalizes `failed` with
  `result_followups_exhausted`; a **completed** result run always carries
  validated `data`.
  [08 §4.10](08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination)

The replay-guard, `responseMessages` round-trip, and throughput tests drive
`llmStep` through the injected AI SDK `MockLanguageModelV2` (P3, reserved test
model id) — no live provider — so step decisions are deterministic and replay
equality is exact.

**Depends on:** P2, P3, and the session store (P5 — see note).
**Note:** P4 and P5 are co-developed; the loop needs `sessions.load`/`save`.

### ◻ Phase 5 — Session store
**Deliverables:** `convex/sessions/` — `getOrCreate`/`get`/`create`/`delete`
mutations + `SessionStore.save`/`load` (header upsert + entry diff-sync +
image-chunk replace), cascade delete over `taskSessions`, `state` guard for
per-session serialization.

**Image pipeline** (ported, content-addressed; values in
[08 §4.8](08-conventions-and-execution-boundary.md#48-image-pipeline)):
`extractImageBlocks` hoists base64 out of entries → `assertImagesWithinLimit`
(`MAX_IMAGE_DATA_LENGTH`) → chunk (`IMAGE_DATA_CHUNK_LENGTH`) into `imageChunks`
(content-addressed by `hash`, with `refCount` and cascade-decrement) →
`hydratePersistedSessionEntry` on read. **Inline threshold: ~100 KB** in
`imageChunks.data`; larger payloads spill to Convex `_storage`.

**Obsoleted by Convex** (no public API surface — see
[08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)):
flue's Node durable **coordinator** and its **in-memory / sqlite** stores, plus
the shared **SQL store** implementations (`sql-agent-execution-store.ts`,
`sql-storage.ts`, `sql-run-store.ts`, `sql-persisted-chunk-store.ts`). Each store
method becomes a Convex mutation/query.

**Acceptance:** `save` then `load` round-trips a `SessionData` v6 byte-faithfully;
appending entries is O(new); an image entry round-trips through chunking +
hydration with correct `refCount` on add and on delete; deleting a parent cascades
to task children and rejects while a descendant is active.
**Depends on:** P1 (`SessionHistory`, `SessionData`).

### ◻ Phase 6 — Harness facade + invoke
**Deliverables:** `convex/invoke/` (`submitPrompt`/`submitTask`/`stopActive`) +
the `CoveContext.init → CoveHarness → CoveSession` facade whose
`prompt/skill/task/shell/fs` map onto the mutations + workflow. Supersede/serialize
via the `by_session_and_status` gate.

**Subagents / task delegation** (ported from flue's
[`agent.ts`](../../../flue/packages/runtime/src/agent.ts)/[`session.ts`](../../../flue/packages/runtime/src/session.ts)):
`createTaskTool` spawns a **nested workflow** under `task:*` sessions; depth and
declaration are guarded by `TaskDepthExceededError` and
`SubagentNotDeclaredError`. Cascade delete (P5) covers `taskSessions`.

**`abort.ts` mapping** (ported from
[`runtime/src/abort.ts`](../../../flue/packages/runtime/src/abort.ts)):
`createCallHandle`/`composeTimeoutSignal` map onto the Convex model — native
clients get **id + reactive-await**, HTTP clients get **poll-to-terminal**. The
abort sequence is atomic: `session.abort()` → `invoke.stopActive` → **one
mutation** doing `workflow.cancel` + `agentRequests.status = cancelled`
([08 §4.3](08-conventions-and-execution-boundary.md#43-cancel-short-circuit)).

**Shell tool-event envelope** (ported file `src/runtime/shell.ts` —
`execShellWithEvents` + `redactEnvValues` + `getErrorMessage`; values in
[08 §4.11](08-conventions-and-execution-boundary.md#411-shell-tool-event-envelope--env-redaction)):
`session.shell()` and `harness.shell()` share one envelope emitting a `tool_start`
+ terminal `tool` pair (`toolName:'bash'`, shared `toolCallId`, `durationMs`).
`ShellOptions.env` values are **redacted keys-only** (`<redacted>`) in every tool
event (and in any persisted transcript), while the real values reach `env.exec`.
A failure branch records `details.{command, exitCode:-1}` via `getErrorMessage`.
**`session.shell()`** appends the **redacted** transcript triple via
`appendShellTriple`; **`harness.shell()`** omits the transcript (no session to
append to).

**Admission invariants asserted here** — the surviving
[ADMISSION](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)
contract (flue's `AgentSubmissionStore` lease/attempt/turn-journal/stream-chunk
machinery is **not** ported, [D5](07-risks-and-decisions.md)) lands its assertions
on the Convex admission path as a named **admission-contract test**:
`admitDispatch` is **replay-idempotent**; reusing a dispatch id with a **different
payload** raises a conflict; a 2nd concurrent same-session prompt selects head via
**serialize/supersede**; a settled session's **receipt is retained** after the
session is deleted; `deleteSession` **blocks new admission**.

**Acceptance:** `const h = await ctx.init(agent); const s = await h.session();
await s.prompt("hi")` resolves a `PromptResponse`; a second concurrent prompt on
the same session serializes (or supersedes) per flue semantics; a `task` delegates
to a nested `task:*` run; a depth-exceeding delegation raises
`TaskDepthExceededError`; `s.abort()` cancels the active workflow and discards late
tool results. A `session.shell()` call emits the `tool_start`+`tool` pair with
**redacted** `env` keys and appends the redacted transcript triple, while
`harness.shell()` emits the same event pair but appends **no** transcript. The
named admission-contract test passes all five admission assertions above.
**Depends on:** P4, P5.

### ◻ Phase 7 — HITL
**Deliverables:** `approvals` flows — `applyApproval`, `submitApproval`, the
`step.waitForEvent` gate in `runHandler`, the `isHitl` tool flag + policy.

Full **state machine** (contract values in
[08 §4.4](08-conventions-and-execution-boundary.md#44-hitl-state-machine)):

- **Unique key** — `` `approval:${requestId}:${toolCallId}` `` (globally unique).
- **Idempotent submit** — `submitApproval` rejects if `approvals.status !==
  "pending"` (fail-loud, no double-submit).
- **Durable event** — the workflow event is durable/queued so a `submitApproval`
  arriving *before* `waitForEvent` is not lost.
- **Edited-args validation** — approver-edited args are re-validated; a
  `ToolInputValidationError` returns as an error tool-result, not a crash.
- **Timeout while parked** — a parked request exceeding `durability.timeoutMs`
  terminalizes as `cancelled`.

**Acceptance:** a gated tool parks the run (`approvals` pending, no compute
burning); `submitApproval` approve/reject resumes correctly; a duplicate submit is
rejected; edited args are re-validated; the parked run survives a redeploy and
terminalizes `cancelled` on timeout.
**Depends on:** P4.

### ◻ Phase 8 — HTTP + auth
**Deliverables:** `convex/http.ts` — `httpRouter` `POST /agents/:name/:id`
(+`?wait=result`), `GET /runs/:runId`; the pluggable **`authorize(ctx, req)`**
hook with **per-transport gating** (the same hook signature gates HTTP submit,
the native SDK path, and channel inbound). The generated `app.ts` →
`convex/http.ts` entry wires the router into the deployed app.

**Workflow surface** (user-authored, code-orchestrated — honors locked
[D1](07-risks-and-decisions.md) full parity, [D18](07-risks-and-decisions.md)):
`POST /workflows/:name` routes onto a registered `WorkflowHandler`; SDK exposes
`client.workflows.invoke(name, input)`. A workflow run is a **distinct run kind**
from an agent run — the `runs` table carries a `kind: 'agent' | 'workflow'`
discriminator (resolving the agentName-rekey conflation), so a workflow invoke is
observable as a `kind:'workflow'` run. (The `defineWorkflow` registry + codegen
land in P8.5.)

**Error-render + request-validation sub-layer** (values in
[08 §4](08-conventions-and-execution-boundary.md#4-hardened-engine-contracts)):
`validateAgentRequest`/`validateWorkflowRequest` guard each route, and
`renderHttpError(err)` / `toHttpResponse` map a `CoveHttpError` (4xx subclasses:
`MethodNotAllowedError` 405, `UnsupportedMediaTypeError` 415, `InvalidJsonError`
400, `AgentNotFoundError` 404, `WorkflowNotFoundError` 404, `InvalidRequestError`,
`RunNotFoundError`) onto the **`CoveApiError`** wire envelope;
`configureErrorRendering({devMode})` controls detail leakage. The
legitimately-obsolete subset (`StreamNotFoundError` — SSE dropped,
[D2](07-risks-and-decisions.md); `PersistedSchemaVersionError` — `migrate()` is a
no-op) is **not** ported; `WorkflowNotFoundError`/workflow routes are live (D18).

**Acceptance:** an external `curl` submits a prompt and polls a result; an
unauthorized call is rejected by the hook; the gate applies uniformly across
transports. A `client.workflows.invoke` (and `POST /workflows/:name`) runs a
code-orchestrated input→result and surfaces as a `kind:'workflow'` run, distinct
from agent runs. A **malformed call** (bad method/media-type/JSON, or unknown
agent/workflow) returns the canonical **`CoveApiError` 4xx envelope** — not a raw
500.
**Depends on:** P6.

### ◻ Phase 8.5 — CLI + codegen
**Deliverables:** a **Convex-native build/dev entry** that replaces `@flue/cli`;
`defineAgentRegistry` **codegen** that emits the Convex app wiring (router entry,
agent/tool registration) from the declared registry; **config validation** of the
registry + provider + durability config at build time; and the **`cove` binary**
exposing `cove dev` / `cove build` / `cove deploy` over the Convex toolchain.

**Workflow registry/codegen** (alongside `defineAgentRegistry`, [D18](07-risks-and-decisions.md)):
`defineWorkflow((ctx) => result)` returns a `WorkflowHandler`, registered via a
**Convex-app-bound** `convex/workflowRegistry.ts` (workflows live under `convex/`,
e.g. `convex/workflows/`) — exported from the app/CLI surface, **not** the
`@cove/runtime` barrel, exactly like `defineAgentRegistry`. Codegen wires the
`POST /workflows/:name` routes (P8) from the declared workflow registry.

**Cross-refs / non-goals:**
- **Build-time skill packaging** is deferred (not wired by this codegen) — see
  [08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit).
- **`cove add` / blueprint scaffolding** is a **non-goal** for this phase
  (deferred): the CLI ships `dev`/`build`/`deploy` only.

**Acceptance:** `cove dev` boots a Convex deployment with a declared
`defineAgentRegistry`; codegen produces a wired `convex/http.ts` entry **and wires
declared `defineWorkflow` handlers to their `POST /workflows/:name` routes**; an
invalid registry (e.g. missing provider, undeclared subagent) fails validation with
a `[cove]` diagnostic before deploy.
**Depends on:** P8.

### ◻ Phase 9 — Reactive events + native SDK
**Deliverables:** `convex/events/` (append batched + reactive read queries);
`src/sdk/` — `createCoveClient` over `ConvexReactClient` yielding the same
`CoveEvent`/`RunRecord` types, where `runs.events()` async-iterates a reactive
query; **`src/react/`** — the UI **reducer** that folds the reactive event stream
into render state (optimistic local messages reconcile to the server
`submissionId` without duplication; a redacted image part **reuses the prior file
part** rather than re-uploading); and **`@cove/react`** hooks wrapping the reactive
queries + reducer for UI subscriptions.
**Acceptance:** a client subscribes and observes the full event sequence of a run
(`run_start … text_delta … tool … run_end`) live, no SSE; a `@cove/react` hook
renders the same stream reactively; the `src/react/` reducer reconciles an
optimistic message onto the server `submissionId` with **no duplicate**, and a
redacted image **reuses the prior file part**.
**Depends on:** P4, P6.

### ◻ Phase 10 — Skills + MCP
**Deliverables:** skill catalog import/read (`skills` table), `session.skill()`
routing, and MCP integration via `connectMcpServer`.

**MCP** (ported from [`runtime/src/mcp.ts`](../../../flue/packages/runtime/src/mcp.ts)),
owned by a new **`convex/mcp/`** `"use node"` module (it cannot live on the pure
`src/runtime` barrel — its `execute` opens a network transport):

- **`connectMcpServer`** adapts MCP tools to `ToolDefinition[]` across its
  **transports**; connection + tool execution run under `"use node"` actions.
- **Registration:** the call site declares servers via a declarative
  `mcpServers` field on the agent profile (resolved at `setup`); the discovered tool
  **schemas freeze as descriptors** carrying **server identity + transport** (not a
  closure) on the request.
- **Re-resolution (not box-binding):** `buildTools` re-resolves a network MCP client
  from the descriptor each `llmStep`/`dispatchTools` — the sanctioned exception in
  [08 §4.5](08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors).
- **Replay determinism:** `callTool` is side-effecting, so a replayed `dispatchTools`
  returns the persisted result (idempotent by `toolCallId`), never re-issuing the call.
- **Connection lifecycle:** cached connections are keyed by server identity with an
  explicit eviction + `close()` owner; a cold action that finds no live connection
  re-opens one. If a cached connection's tool list **drifts** from the frozen
  descriptors mid-run, the frozen descriptors win and a now-missing tool returns an
  error tool-result.

**`context.ts` discovery — DECIDED:** flue's filesystem `AGENTS.md` / `.agents` /
on-disk skills discovery (`context.ts`) is **replaced by the skills CATALOG
table**, seeded by an **import action that parses host-supplied `SKILL.md` via
`parseSkillMarkdown` and writes idempotent catalog rows — it provisions no box and
reads no sandbox FS** (the import source is the host/repo, not a sandbox). A skill is
**resolved only from the catalog** at runtime; **on-demand `SessionEnv` reads** are for
*non-skill* workspace context only, never to resolve a skill. No directory-walk
discovery at runtime ([08 §3](08-conventions-and-execution-boundary.md#skills-resolve-at-the-call-site-not-in-the-sandbox)).

**Acceptance:** `session.skill("review-pr")` loads and runs a catalog skill seeded
by the import action (no box provisioned to resolve it); the import action parses a
host `SKILL.md` and is idempotent on re-run; an MCP server's tools appear as
model-callable tools with frozen schemas and survive a `dispatchTools` replay without a
second `callTool`; on-demand `SessionEnv` reads surface non-skill workspace context
without a discovery walk.
**Depends on:** P6.

### ◻ Phase 11 — Channels + adapters
**Deliverables:** port the channel integrations onto the HTTP submit surface;
collapse the SQL storage adapters into the single Convex adapter (the rest are
dropped as obsolete — see [08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)).

**Scope (sequenced):**

- **Ship first:** Slack, Discord, GitHub, Teams, Telegram, Google Chat, Linear,
  Notion.
- **Defer:** Intercom, Resend, Salesforce, Zendesk.
- **TBD:** Messenger, WhatsApp, Twilio, Shopify, Stripe.

**Inbound model** (one shared path, no separate inbound table initially):

1. **Per-channel signature verification** of the webhook.
2. **Idempotent webhook dedup** (dedup key per provider event id).
3. **`payload → submitPrompt`** — map the verified payload onto the existing HTTP
   submit (reusing `agentRequests`; no separate inbound table).
4. **Outbound reply** — post the run result back on the originating channel.

The `authorize` hook (P8) gates inbound just like any other transport.

**Acceptance:** at least one channel (e.g. Slack) verifies an inbound event,
dedups a replayed webhook, drives an agent run end-to-end via `submitPrompt`, and
posts the reply back.
**Depends on:** P8.

### ◻ Phase 12 — Compaction parity + sample agent + tests
**Deliverables:** the compaction summarization step (threshold + overflow→retry),
a worked sample agent, and the test suite.

**Test suite:**

- **Store contract-test harnesses (three)** — a shared contract run against the
  Convex adapter for each store: **Session store**, **Run store**, and
  **EventStream**. The same contract that flue's in-memory/SQL stores satisfied now
  validates the Convex implementations.
  flue's **`AgentSubmissionStore`** contract is **not** ported as a 4th harness —
  its lease/attempt/turn-journal/stream-chunk assertions die with the dropped
  machinery ([D5](07-risks-and-decisions.md),
  [08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit));
  the surviving ADMISSION invariants are asserted in **P6**.
- **Pure-logic unit tests** — `session-history`, `compaction`, `tool-schema`,
  `agent-definition`. These have no Convex dependency and **run per-phase** as soon
  as their module lands (P1/P5/P12).
- **E2E multi-turn + crash-recovery test** — a multi-turn run that is killed
  mid-loop and resumes from the journal to a coherent terminal state.
- **Throughput stress test** — drives the delta-batcher; the P4 run sets the
  production cadence, and it is re-run at P12 as a regression gate.

**Per-phase vs at-P12:** the pure-logic unit tests and the P4 replay/throughput
tests run within their owning phase; the **store contract harnesses** and the
**E2E multi-turn + crash-recovery** test are consolidated and gated at **P12**.

**Acceptance:** a long conversation auto-compacts and continues coherently; the
three store contract harnesses pass against the Convex adapter; the E2E
multi-turn + crash-recovery test resumes correctly; the sample agent demonstrates
G1–G5 from [01](01-overview-and-goals.md#success-criteria).

---

## Observability (deferred)

flue's **`@flue/opentelemetry`** is **kept** but **deferred to post-P12**. In Cove
it is fed from the **`events` table** plus per-step telemetry (the usage/step
rollups from P4), so tracing is a read-side consumer of durable state rather than
an in-loop dependency. No phase above blocks on it.

---

## Critical path

```
P1 ─┬─▶ P2 ─┐
    ├─▶ P3 ─┼─▶ P4 ◀─▶ P5 ─▶ P6 ─┬─▶ P7
    └─────────┘                   ├─▶ P8 ─▶ P8.5 ─▶ P11
                                  └─▶ P9 ─▶ P10
                                          └─▶ P12
```

P4↔P5 are co-developed. P7/P8/P9 fan out from P6. P8.5 (CLI + codegen) sits on the
HTTP/auth surface ahead of channels. P12 closes the loop.
