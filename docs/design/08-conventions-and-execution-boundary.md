# 08 — Conventions & Execution Boundary

The canonical reference every other doc and every source file defers to: the
**name**, the **reference-header convention**, the **orchestration ↔ execution
boundary** (the core philosophy, formalized), and the **hardened engine
contracts** a cold-start build must honor.

---

## 1. Naming & namespace

The rewrite is its **own product, `Cove`** — it does **not** carry the `Flue` or
`Pi` namespace in code identifiers. (Con**ve**x + *cove*: the sheltered harbor
where the sandbox does its work.)

- **Brand-prefixed types are renamed** `Flue*` → `Cove*`.
- **Generic verbs and domain types are kept** — they were never brand: `createAgent`,
  `defineTool`, `defineAgentProfile`, `defineAgentRegistry`, `prompt`, `session`,
  `task`, `shell`, `compact`, `observe`, `dispatch`, `SessionEnv`, `SandboxFactory`,
  `SessionData`, `SessionEntry`, `MessageEntry`, `CompactionEntry`, `ToolDefinition`,
  `Prompt*`. (This is a **naming** statement only. Two of these — `defineAgentRegistry`
  and `connectMcpServer` — are **Convex-app-bound** and exported from the app/CLI
  surface, *not* the pure `@cove/runtime` barrel; see [05](05-public-api-and-sdk.md#agent-registry-defineagentregistry).)
- **Package name** is `cove` (`@cove/runtime`, `@cove/sdk`, `@cove/react`). The
  **folder stays `cove-harness/`** (it is the established path; only identifiers and
  the package name rebrand).
- **`pi` never appears as an identifier** — it only survives as a *copied data
  shape* (the message model) and as origin citations in headers.

| flue identifier | Cove |
| --- | --- |
| `FlueContext` / `FlueContextInternal` | `CoveContext` / `CoveContextInternal` |
| `FlueHarness` / `FlueSession` / `FlueSessions` | `CoveHarness` / `CoveSession` / `CoveSessions` |
| `FlueFs` / `FlueLogger` | `CoveFs` / `CoveLogger` |
| `FlueError` / `FlueHttpError` (hierarchy) | `CoveError` / `CoveHttpError` |
| `FlueEvent` / `FlueEventSubscriber` | `CoveEvent` / `CoveEventSubscriber` |
| `FlueClient` / `createFlueClient` / `FlueApiError` | `CoveClient` / `createCoveClient` / `CoveApiError` |
| `FlueEventStream` / `FlueStreamOptions` / `FluePublicError` | `CoveEventStream` / `CoveStreamOptions` / `CovePublicError` |
| `createFlueContext` / `configureFlueRuntime` / `createDefaultFlueApp` / `createFlueFs` | `createCoveContext` / `configureCoveRuntime` / `createDefaultCoveApp` / `createCoveFs` |
| `FLUE_SCHEMA_VERSION` / `assertSupportedFlueSchemaVersion` | `COVE_SCHEMA_VERSION` / `assertSupportedCoveSchemaVersion` |
| `__flueCreatedAgent` / `__flueSkillReference` (brand markers) | `__coveCreatedAgent` / `__coveSkillReference` |
| `[flue]` (error-message prefix) / `flue_error` (code) | `[cove]` / `cove_error` |

The non-branded error subclasses (`SessionNotFoundError`, `ToolInputValidationError`,
…) keep their names; only the base `FlueError` → `CoveError`.

## 2. Reference-header convention

**Every** source file in `cove-harness/` opens with a header citing its origin —
which flue/pi file it derives from, **and the npm package** that file belongs to —
plus the package it now exports as and any key transformation:

```ts
// Ported from flue · @flue/runtime · packages/runtime/src/session-history.ts → @cove/runtime
// SessionHistory tree logic unchanged; entries load from Convex rows, not an in-memory blob.
```

```ts
// Mirrors pi · @earendil-works/pi-ai · packages/ai/src/types.ts → @cove/runtime
// Canonical message model copied (not imported); replaces flue's pi imports.
```

New files with no flue equivalent say so and cite the pattern source:

```ts
// New (Convex backend) · @cove/runtime
// Durable agent loop. No flue equivalent — flue ran the loop in-process.
```

This is referenced from [`cove-harness/PLAN.md`](../../PLAN.md) and is a
review checklist item for every new file.

---

## 3. The execution boundary (core philosophy)

> **Convex is the entry point and the loop owner. The sandbox executes. The LLM
> decides — but does not control flow.**

Every agent execution starts with a Convex mutation. The durable workflow
([04 — The Durable Engine](04-durable-engine.md)) invokes the LLM from a Convex
action, **dispatches the model's tool calls into the sandbox**, **watches** the
results (the LLM stream *and* the sandbox output), persists everything, and
**decides the next step**. Three actors, one authority:

| Actor | Does | Does **not** |
| --- | --- | --- |
| **Convex** (workflow + actions + tables) | orchestrate the loop, invoke the LLM, watch results, persist all state, own durability/recovery | execute tools/commands itself |
| **Sandbox** (`SessionEnv`, `@upstash/box`) | execute tools, commands, file ops — inside its workspace folder | orchestrate, persist, or control flow |
| **LLM** (AI SDK) | generate text + tool calls | initiate, control the loop, or own state |

Consequences: Convex owns durability/recovery; sandboxes are **stateless and
replaceable**; the LLM is a **pure decision engine**.

### The sandbox is one designated folder

Each `SessionEnv` is scoped to **one specific working folder — the session's
workspace**, keyed by session. **All** `exec`/fs operations happen inside it;
`createSandboxSessionEnv` enforces it (relative paths resolve against `cwd`, path
resolution rejects `../` escapes, parent-dir creation/`rm`/`readdir` stay inside
the workspace). This gives session isolation, reproducibility, and the clean
executor/orchestrator split above.

- **`sandboxName` (resolution key):** `` `${ctx.id}:${instanceId}:${harnessName}` `` —
  collision-proof and cacheable per action. The box is resolved by name
  (`Box.list/get`) on each cold action (boxes outlive stateless actions; the
  in-process handle cache does not).
- **`cwd` is per-session.** Concurrent same-session operations serialize via the
  `agentRequests`/`sessions.state` gate. `ShellOptions.cwd` resolves *within* the
  workspace.
- **Session delete does not auto-wipe the box folder** (an optional cleanup step
  can be added). Box provisioning is lazy on first `exec`.

### Which Convex functions may touch the sandbox

Only `"use node"` **actions** in the engine touch the box — never queries or
mutations (the orchestrator/persistence layer stays box-free):

| Convex function | Touches box? | Why |
| --- | --- | --- |
| `engine/setup` (action) | resolve only | create/resolve the `SessionEnv`, freeze plan |
| `engine/llmStep` (action) | no | invokes the LLM; reads context from rows |
| `engine/dispatchTools` (action) | **box-bound tools only** | runs each box-bound tool's `execute` against the box; two sanctioned exceptions run here but never touch the box (below) |
| `engine/finalize` (mutation) | no | terminalizes the request from rows |
| `sessions/*` (mutations/queries) | no | pure SOR persistence |
| `invoke/*` (mutations) | no | admission + scheduling + cancel |

**Two sanctioned non-box executions** run *inside* `dispatchTools` but do **not**
touch the box — the only exceptions to "the sandbox executes":

- **`activate_skill`** resolves a skill by name from the `skills` **catalog table via
  a Convex query** — never an `env.readFile`/FS walk (see *Skills resolve at the call
  site* below, and [D13](07-risks-and-decisions.md)).
- **MCP tools** reach an **external MCP server over the network** (not the box); their
  re-resolution-from-descriptor rule is [§4.5](#45-tool-rebuild-from-frozen-descriptors).

### Skills resolve at the call site, not in the sandbox

A skill is **host state, not workspace state.** Autonomous `activate_skill` and
`session.skill(name)` both resolve a skill's identity, frontmatter, instructions, and
reference bodies **only from the `skills` catalog** (a Convex query), seeded by the
import action. **Non-goal: no `SKILL.md` is ever read from the sandbox FS to *resolve*
a skill at runtime.** On-demand `SessionEnv` reads stay available, but only for
**non-skill workspace context** (files the run is actually operating on) — never to
discover or load a skill. This keeps skill resolution box-free and replay-stable.

### Execution targets beyond the box (real-machine & network)

The `SandboxFactory`/`SessionEnv` seam is **the** extension point for any non-`@upstash/box`
execution target — including a **real-machine / in-process** executor (Cove ships one
as a built-in local adapter; see [D7](07-risks-and-decisions.md)). Every
`SandboxFactory` — sandbox or real machine — must obey the boundary:

- It is reached **only from `"use node"` engine actions** (`setup` resolve-only,
  `dispatchTools` execute), never from queries/mutations.
- It is **resolved by name** on each cold action (no reliance on a surviving in-process
  handle) and is **workspace-confined**: relative paths resolve against the session
  `cwd` and `../`-escapes are rejected. A real-machine adapter that cannot honor
  confinement must raise `SandboxOperationUnsupportedError` rather than silently widen
  access.
- Tools whose `execute` reaches the **network instead of the box** (MCP) are the
  sanctioned carve-out above: exempt from box-confinement, but still rebuilt per
  `llmStep` from a frozen descriptor.

---

## 4. Hardened engine contracts

Non-negotiable correctness rules for the durable loop (audit fixes). Full prose in
[04 — The Durable Engine](04-durable-engine.md); the contract values are here.

### 4.1 `llmStep` replay determinism *(critical)*
On workflow replay an action re-runs; it must **not** re-call the model. At entry,
`llmStep` queries `agentRequestSteps` by `(requestId, stepNumber)`; if a finalized
row exists, it **reconstructs and returns the finalized decision without calling the
AI SDK**. **The model is called at most once per step number**; the finalized step
row is the source of truth on replay.

### 4.2 Action budgets & timeouts
- **`llmStep` stream deadline ≈ 240 s** — on deadline, force-finalize the partial
  result rather than letting the action be killed.
- **per-tool timeout ≈ 30 s** (`dispatchTools`) — a hung tool yields an *error
  tool-result*, not a starved action.
- **default box `exec` `timeoutMs` = 30 s.**
- Both deadlines surfaced through `DurabilityConfig`.

### 4.3 Cancel short-circuit
After `workflow.cancel`, `dispatchTools` checks `agentRequests.status` **before each
tool**; if `cancelled`, it skips remaining tools and discards late results. The
abort sequence is atomic: `session.abort()` → `invoke.stopActive` →
**one mutation** doing `workflow.cancel` + `agentRequests.status = cancelled`.

### 4.4 HITL state machine
- Event key is **globally unique**: `` `approval:${requestId}:${toolCallId}` ``.
- `submitApproval` **rejects if `approvals.status !== "pending"`** (idempotent,
  fail-loud — no double-submit).
- The workflow event is **durable/queued** so a `submitApproval` arriving *before*
  `waitForEvent` is not lost.
- **Approver-edited args** are re-validated; a `ToolInputValidationError` returns as
  an error tool-result (not a crash).
- **Timeout while parked:** a request exceeding `durability.timeoutMs` terminalizes
  as `cancelled`.

### 4.5 Tool rebuild from frozen descriptors
The frozen tool descriptor on the request is **authoritative for the whole run**
(registry edits affect only *new* runs). `buildTools` (in `convex/engine`, importing
`normalizeToolDefinition` from [`src/runtime/tool.ts`](../../src/runtime/tool.ts))
re-wraps `execute`; `dispatchTools` invokes it. A `buildTools` failure becomes an
*error tool-result*, never a step crash. Replay must never double-execute a
side-effecting tool (idempotent `appendToolResult` keyed on `toolCallId`).

**MCP tools (network) — a named exception.** An MCP tool's `execute` closes over a
live, non-serializable network client, so it cannot be frozen as a closure. Instead its
frozen descriptor carries the tool's **server identity + transport config** (url /
transport / headers) and tool name — **not** a closure. On each `llmStep`/`dispatchTools`,
`buildTools` **re-resolves an MCP client from that descriptor** (reusing a live cached
connection, else re-opening it) and binds `execute` against that client rather than the
box `SessionEnv` — the one sanctioned departure from "execute is bound against the box"
([§3](#3-the-execution-boundary-core-philosophy)). Because `callTool` is a side-effecting
network call, replay must **not** re-issue it: the `appendToolResult` idempotency key
(`toolCallId`) is the de-dup, so a replayed `dispatchTools` returns the persisted result
instead of calling the server again. Connection lifecycle (per-run vs cached, keying,
`close()` owner) is pinned in [06 P10](06-phase-roadmap.md).

### 4.6 Streaming commit & subscription semantics
The delta-batcher flush mutation must be **durably committed before the workflow
advances** (no lost deltas on redeploy). Deltas are **coalesced into the step row**
(not an append log), so a late subscriber reading `agentRequestSteps` sees the
current patched text in-position. Cadence: **`deltaBatchMs = 400`,
`deltaBatchChars = 480`** (configurable); pick the production value from the P4
throughput stress test.

### 4.7 Usage & cost
Per-step usage is captured from the AI SDK result (`fromProviderUsage`), aggregated
(`addUsage`/`emptyUsage`) into `agentRequests` rollups (`totalTokens`/`totalSteps`/
`durationMs`); `PromptUsage` is surfaced to callers; cost is computed from the token
rollup (optional, model-rate driven).

**Persisted-usage fidelity (pinned).** The rollup widens beyond the three token fields to
carry `cacheRead`/`cacheWrite`/`cacheWrite1h` and the per-model `cost{}` breakdown —
**not** a token-only subset — so cache-token accounting and computed cost survive
persistence and replay (dropping them would silently understate spend on cache-heavy
runs). Two field-name conventions co-exist and are intentional: the **provider/rollup**
side uses `inputTokens`/`outputTokens` (AI SDK shape), while the **caller-facing**
`PromptUsage` uses `input`/`output`; the `fromProviderUsage` boundary is the single place
that bridges the divergence.

### 4.8 Image pipeline
`extractImageBlocks` hoists base64 out of entries → `assertImagesWithinLimit`
(`MAX_IMAGE_DATA_LENGTH`) → chunk (`IMAGE_DATA_CHUNK_LENGTH`) into `imageChunks`
(content-addressed by `hash`, `refCount`, cascade-decrement) → `hydratePersisted­
SessionEntry` on read → `redactEventImages`/`IMAGE_DATA_OMITTED` in events.
**Inline threshold: ~100 KB** in `imageChunks.data`; larger → Convex `_storage`.

### 4.9 Step cap & loop termination
The loop runs `while (stepNumber < plan.maxSteps)`. **`maxSteps` is a defense-in-depth
ceiling, not flue's behavior** — flue has *no* framework turn cap (the model
terminalizes via `finish`/`give_up`; `MAX_FOLLOWUPS` only bounds the result-tool
re-nudge). Cove keeps that intent: a run normally ends when `llmStep` returns
`finishReason === "stop"` or the model calls a terminal tool; `maxSteps` only catches a
runaway loop. It is **resolved at `setup` and frozen onto the plan** (origin
`DurabilityConfig.maxSteps`, **default 100**) and carried on `frozenPlanValidator`.
**At the cap** the loop stops and `finalize` terminalizes the request as `failed` with a
`step_limit_exceeded` reason — distinct from a model-driven `completed`, so hitting the
ceiling is observable, never silent. The result-tool re-nudge has its **own** independent
bound — `maxFollowUps` ([§4.10](#410-result-tool-re-nudge--termination)) — not `maxSteps`.

### 4.10 Result-tool re-nudge & termination
When the frozen plan declares an **output schema** (a result-shaped run), `finishReason
=== "stop"` does **not** break the loop on its own — a model that stops without ever
producing a valid result must be re-nudged, not silently completed. After each step the
loop consults the **result bundle outcome** (`pending | finished | gave_up`):

- **`finished`** → terminalize `completed`, resolving `PromptResultResponse<T>` with the
  **validated** `data`.
- **`gave_up`** → reject the `CallHandle` with **`ResultUnavailableError extends CoveError`**
  (carrying the give-up `reason` + the assistant text). A result run that gives up **never
  resolves `PromptResultResponse<T>` with unvalidated `data`** — there is no "best-effort"
  result.
- **`pending`** → append `buildResultFollowUpPrompt()` and continue, bounded by
  **`maxFollowUps`**.

`maxFollowUps` is resolved at `setup` and frozen onto the plan exactly parallel to
`maxSteps` (origin `DurabilityConfig.maxFollowUps`, **default 32** = `MAX_FOLLOWUPS`),
carried on `frozenPlanValidator`. The **follow-up counter is per-step durable state**
threaded across the journaled `llmStep → dispatchTools → finalize` split — replay-
deterministic and **distinct from `stepNumber`** (a step can produce multiple result
follow-ups without advancing the turn cap, and vice versa). **On exhaustion** the loop
stops and `finalize` terminalizes the request as `failed` with a
**`result_followups_exhausted`** reason (parallel to `step_limit_exceeded`), and the
`CallHandle` rejects with `ResultUnavailableError` — never a silent unvalidated resolve.

### 4.11 Shell tool-event envelope & env redaction
`session.shell()` and `harness.shell()` share **one** tool-event envelope
(`execShellWithEvents`, ported to `src/runtime/shell.ts`,
scheduled in [P6](06-phase-roadmap.md)) so a host-issued shell call is observable like any
model-issued tool call. The envelope emits a `tool_start` + terminal `tool` **pair** with a
**shared `toolCallId`**, `toolName: 'bash'`, and `durationMs`.

- **Env redaction is mandatory.** `ShellOptions.env` values are surfaced **keys-only** —
  every value replaced with `<redacted>` (`redactEnvValues`) — in **every** tool event
  **and** in the persisted `sessionEntries` triple. Only `env.exec` (the actual box/real-
  machine execution) receives the **real** values. A secret passed via `env` never lands in
  an event or a row.
- **Failure branch** is recorded structurally: `details.{ command, exitCode: -1 }` (the `-1`
  sentinel marks a shell that never produced an exit code), with the message normalized via
  `getErrorMessage`.

---

## 5. Dropped & obsolete (explicit)

- **Cloudflare Workers target — dropped.** Cove is Convex-only; flue's
  `cloudflare/*` (13 files) + `cloudflare-model.ts` remain reference-only.
- **Node durable coordinator + in-memory/sqlite stores — obsolete**, replaced by the
  Convex workflow + Convex tables.
- **Shared SQL store implementations** (`sql-agent-execution-store.ts`,
  `sql-storage.ts`, `sql-run-store.ts`, `sql-persisted-chunk-store.ts`) — obsolete;
  each store method becomes a Convex mutation/query. No public API surface.
- **flue's durable-submission reconciliation** (`submission-state.ts`,
  `stream-chunks.ts`) — subsumed by workflow replay; **except** `isRetryableModelError`,
  which is ported into `llmStep` error handling.
- **Obsolete HTTP-error subclasses (the *only* two that drop).** The `CoveHttpError`
  hierarchy ([M4](07-risks-and-decisions.md), lands P8) keeps nearly all of flue's 4xx
  subclasses, but two are legitimately obsolete: **`StreamNotFoundError`** (SSE dropped per
  [D2](07-risks-and-decisions.md) — there is no stream to 404) and
  **`PersistedSchemaVersionError`** (`migrate()` is a no-op, so there is no version mismatch
  to raise). **`WorkflowNotFoundError` / the `/workflows/:name` routes are *not* obsolete** —
  workflows are restored as first-class ([D18](07-risks-and-decisions.md), below).
- **The user-authored Workflow concept is *restored as first-class* — not dropped.**
  `defineWorkflow((ctx) => result)` returning a `WorkflowHandler` honors locked
  [D1](07-risks-and-decisions.md) full parity. It is **Convex-app-bound** like
  `defineAgentRegistry` (exported from the app/CLI surface under `convex/` — e.g.
  `convex/workflows/` + `convex/workflowRegistry.ts` — **not** the `@cove/runtime` barrel).
  Surface: HTTP `POST /workflows/:name`; SDK `client.workflows.invoke(name, input)`. A
  workflow run is a **distinct run kind** from an agent run — the `runs` table carries a
  `kind: 'agent' | 'workflow'` discriminator, resolving the prior agentName-rekey
  conflation. See [D18](07-risks-and-decisions.md); lands [P8](06-phase-roadmap.md) (HTTP)
  with the registry/codegen in [P8.5](06-phase-roadmap.md).

### Retained / deferred (not dropped — to avoid silent scope cuts)

- **flue's in-process / local `bash()` executor is *retained as a built-in*.** It ports
  behind `SandboxFactory` as the **local / real-machine** adapter alongside
  `@upstash/box`; `BashFactory`/`BashLike` are its consumed contract (not orphaned
  types). See [D7](07-risks-and-decisions.md). flue's Daytona / E2B / Cloudflare sandbox
  adapters are **not** ported — the seam stays open for third parties.
- **pi-agent-core loop capabilities outside the parity scope — deferred, not silently
  dropped:** in-turn **steering / follow-up queues** (`Agent.steer`/`followUp`/
  `steeringMode`/`followUpMode`) and **`beforeToolCall`/`afterToolCall` hooks**. The
  HITL gate ([§4.4](#44-hitl-state-machine)) covers the approval use case; general
  steering re-expresses later as a **pending-input table drained at the top of each
  `llmStep`**, tool hooks as a `dispatchTools` seam. Until then they are out of scope
  and recorded here so callers relying on them are not surprised.
- **`ToolExecutionMode` (sequential vs parallel) — not ported initially.**
  `dispatchTools` runs a step's tool calls with `Promise.all` (parallel); sequential
  execution is a deferred option, not a current guarantee.
- **Test language model — AI SDK `MockLanguageModelV2` supersedes flue's `faux.ts`.**
  The deterministic test model is the AI SDK mock (`MockLanguageModelV2` from
  `@ai-sdk/provider-utils`/test), injected via `resolveModel` (a reserved test model id, or
  `llmStep` accepts an injected `ModelHandle`). flue's `providers/faux.ts` is **not** ported
  — it is superseded, not lost ([M5](07-risks-and-decisions.md)).
- **Build-time skill packaging — retained but *deferred to [P8.5](06-phase-roadmap.md)*.**
  flue's import-attribute machinery (`skill-md.d.ts`, `importAttributePlugin`,
  `import skill from './SKILL.md' with { type: 'skill' }`) is not in the initial cut, but
  the producer contract — `SkillReference` / `PackagedSkillDirectory` — remains the seam it
  feeds. The catalog-table resolution of [D13](07-risks-and-decisions.md) is the *runtime*
  side; this is the *authoring/packaging* side, reintroduced in P8.5.
- **Per-subpath package entrypoints — collapsed into the single `@cove/runtime` barrel.**
  flue's `./tool` / `./adapter` / `./routing` / `./internal` / `./node` / `./test-utils`
  subpath exports are folded into one barrel; `./cloudflare/*` is dropped outright per
  [D12](07-risks-and-decisions.md).
- **flue-app OpenAPI / validator layer — dropped.** `describeRoute`,
  `openAPIRouteHandler`, and `GET /openapi.json` do not port; per-route request validation
  is subsumed by Convex `v.*` argument validators (the function-arg validator is the
  single source of request-shape truth).
- **`flue add` blueprints — deferred.** The scaffolding generator
  (`cli/lib/blueprint-index.ts`) is reintroduced as **`cove add`** in
  [P8.5](06-phase-roadmap.md), not the initial cut.
- **pi-ai image-*generation* stack — dropped/obsolete.** `images.ts`,
  `image-models*.ts`, and `images-api-registry.ts` never reached flue and do not port.
  This is **distinct from the *retained* image *input* pipeline** ([§4.8](#48-image-pipeline)
  / `imageChunks`), which ingests model-bound image inputs and is fully kept.
- **pi-ai provider-side OAuth — dropped.** `oauth.ts` (Claude Pro/Max, ChatGPT/Codex,
  Copilot device/auth flows) was the standalone pi-ai CLI's credential path; Cove resolves
  provider credentials as **API keys via the Convex environment** only. No flue capability
  is lost (flue never exposed provider OAuth).
- **Vertex ADC filesystem probe — real-machine adapter only.** The gcloud-config
  (Application Default Credentials) filesystem probe is available **only** under the local /
  real-machine bash adapter ([D7](07-risks-and-decisions.md)); the isolated `@upstash/box`
  path has no filesystem ADC discovery (credentials arrive via the Convex env).
