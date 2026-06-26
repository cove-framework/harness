# cove-harness — Rewrite Plan

Rewrite of [flue](../flue) ("The Agent Harness Framework") on a **Convex-native** stack.
The public **interfaces and methods** of flue are preserved where reasonable; the entire
engine underneath is replaced. `flue/` is left untouched — all new code lives here in
`cove-harness/`.

**Product name: `Cove`** (`@cove/runtime`) — the rewrite is its own product and drops
the `Flue`/`Pi` namespace; only brand-prefixed types rebrand (`FlueContext` →
`CoveContext`), generic verbs/domain types stay. **Core philosophy:** Convex is the
entry point and owns the durable loop; it invokes the LLM, dispatches tool calls into
a sandbox scoped to one designated per-session workspace folder, watches the results,
and decides the next step. Convex orchestrates and watches; the sandbox executes; the
LLM decides but does not control flow.

**Full design-of-record:** [`docs/design/`](docs/design/README.md)
— start with [08 — Conventions & Execution Boundary](docs/design/08-conventions-and-execution-boundary.md)
(naming, the reference-header convention, the execution boundary, and the hardened
engine contracts). Every source file carries a header citing its flue/pi origin + package.

> **Update (2026-06-24):** a follow-on **pragmatic refactor** has since landed on top of this
> plan — `frozenPlan`→`runPlan` (kept as the determinism backbone, re-scoped to freeze the
> ordered extension manifest), a pi-modeled **extensions subsystem** (hooks partitioned by
> determinism class), a **provider-plugin** layer collapsing the four hardcoded provider
> switches, a live name-keyed **tool registry** (+ `ToolResult`-widened `execute`), and
> **incremental compaction** with compact-and-retry overflow recovery. The authoritative record
> is **[docs/REFACTOR-PRAGMATIC.md](docs/REFACTOR-PRAGMATIC.md)**; the design-of-record docs
> under [`docs/design/`](docs/design/README.md) have been updated to match.

## The stack (technology direction)

| Concern | flue (today) | cove-harness (target) |
| --- | --- | --- |
| Execution loop | in-process `pi-agent-core` `Agent` turn loop | **`@convex-dev/workflow`** durable loop |
| System-of-record | SQL `SessionStore` / `AgentExecutionStore` | **Convex tables** + reactive queries |
| Streaming transport | Durable Streams / SSE long-poll | **Convex reactivity** (no SSE) — clients subscribe to queries |
| Sandbox | `SandboxApi` / `bash()` (local/Daytona/E2B/CF) | **`@upstash/box`** (default sandbox) **+ a local in-process `bash()` adapter** (real-machine target), both behind the same `SandboxFactory` seam; Daytona/E2B/CF left to third parties |
| LLM | `pi-ai` multi-provider | **AI SDK** gateway (`@ai-sdk/*`) provider registry |
| HTTP runtime | Hono `flue()` app + DS endpoints | Convex `httpRouter` / `httpAction` (submit + poll only) |
| Consumer SDK | `@flue/sdk` over HTTP+DS | thin shim over **ConvexReactClient** subscriptions |

## Locked decisions (from the user)

1. **Scope:** full parity, phased — runtime core first, then SDK, then the ~25 channels.
   The SQL storage adapters (`postgres`/`libsql`/`mysql`/`mongodb`/`redis`) are **obsolete**
   (Convex *is* the DB) and collapse into one Convex adapter.
2. **Transport:** Convex-native reactive subscriptions are the primary path (**no SSE**).
   A minimal `httpAction` exists to *submit a prompt / poll a result* for non-Convex callers
   (webhooks, channels). There is no streaming HTTP endpoint.
3. **Auth:** pluggable. Core ships an auth **hook** (the analog of flue's route middleware);
   no provider wired in by default. Clerk / Convex Auth / bearer drop in later.
4. **HITL:** added as a new **additive** capability — `CoveSession` gains an approval gate
   backed by the workflow `awaitEvent` pattern. Existing flue code is unaffected.

### Defaulted decisions (sensible defaults, revisit anytime)

- **Recovery** is owned by `@convex-dev/workflow` (durable journal + replay). flue's
  turn-journal / lease / attempt-marker machinery is **dropped**, not re-implemented.
- **Agent addressing** is an explicit `defineAgentRegistry({ name: createAgent(...) })`
  (Convex has no filesystem-module addressing). `createAgent()`'s signature is unchanged.
- **Sandbox:** `SandboxFactory` stays an open extension point; **two built-ins ship** —
  `@upstash/box` (default isolated sandbox) and a local in-process `bash()` adapter (the
  **real-machine** target, ported from flue's `createBashSessionEnv`; backed by
  `BashFactory`/`BashLike`). A third-party real-machine factory must obey the boundary
  rules in [08 §3](docs/design/08-conventions-and-execution-boundary.md#execution-targets-beyond-the-box-real-machine--network).
- **Layout:** standalone Convex app in `cove-harness/`; `pi-agent-core` / `pi-ai` are dropped
  (AI SDK replaces the loop and the provider layer).
- **Delta-batch cadence:** ~400 ms / ~480 chars, made configurable.

## Module layout

```
cove-harness/
  PLAN.md                      ← this file
  package.json, tsconfig.json
  convex/
    convex.config.ts           ← app.use(workflow) (+ workpool later)
    schema.ts                  ← the SOR (sessions, sessionEntries, agentRequests, steps, runs, events, approvals, skills, imageChunks, meta)
    engine/                    ← durable agent loop
      setup.ts                 ← step 0: run initializer, resolve+freeze plan snapshot
      runHandler.ts            ← agentRun = workflow.define: setup → loop(llmStep → dispatchTools / awaitApproval) → compaction → finalize
      llmStep.ts               ← build context from sessionEntries, AI SDK stream, delta-batch into steps
      dispatchTools.ts         ← run non-HITL tools in Promise.all, idempotent by toolCallId
      finalize.ts              ← terminalize request, roll up usage
      deltaBatcher.ts          ← coalesce token deltas before patching step rows
    sessions/                  ← SessionStore over Convex: getOrCreate/get/create/delete + header upsert + entry diff-sync + cascade
    invoke/                    ← submitPrompt / submitTask / stopActive / submitApproval (public mutations behind CoveSession)
    sandbox/upstashBox.ts      ← @upstash/box SandboxApi impl wrapped by ported createSandboxSessionEnv
    providers/                 ← AI SDK gateway registry + ModelConfig/ThinkingLevel resolution
    mcp/                       ← "use node" connectMcpServer: open transport, freeze tool descriptors (server identity+transport), re-resolve client per step (the one network exception to box-binding)
    events/                    ← eventStream append (batched) + reactive read queries (observe() substitute)
    http.ts                    ← httpRouter: POST submit (agents + POST /workflows/:name), GET poll result (no SSE); pluggable auth hook; error-render + request-validation sub-layer (CoveHttpError 4xx subclasses, renderHttpError→CoveApiError wire envelope, validateAgentRequest/validateWorkflowRequest)
    agentRegistry.ts           ← defineAgentRegistry — explicit name→CreatedAgent map (build-time name/uniqueness/__coveCreatedAgent-brand validation); Convex-app-bound, NOT on the @cove/runtime barrel
    workflows/                 ← defineWorkflow user-authored handlers: code-orchestrated runs (a WorkflowHandler per name); distinct run kind (runs.kind='workflow')
    workflowRegistry.ts        ← defineWorkflow — name→WorkflowHandler map (D18); Convex-app-bound like agentRegistry, NOT on the @cove/runtime barrel
  src/
    runtime/                   ← portable, V8-safe pure logic (the public @cove/runtime surface)
      messages.ts              ← AgentMessage/ImageContent/AgentTool/ThinkingLevel decoupled from pi
      types.ts                 ← preserved public contract (CoveContext/Harness/Session, Llm*, SessionData, …)
      errors.ts                ← CoveError + subclasses (flue parity)
      tool-types.ts, tool-schema.ts, tool.ts   ← defineTool, normalizeToolDefinition (ported)
      agent-definition.ts      ← createAgent, defineAgentProfile (ported verbatim)
      session-history.ts       ← SessionHistory tree logic (ported; pure)
      compaction.ts            ← prepareCompaction / token estimation (ported; pure)
      skill-frontmatter.ts     ← parseSkillMarkdown (ported; pure)
      index.ts                 ← barrel mirroring @flue/runtime's PORTABLE exports as @cove/runtime (Convex-app-bound constructs — defineAgentRegistry, defineWorkflow, connectMcpServer — live under convex/, not here)
    sdk/                       ← createCoveClient over ConvexReactClient (Phase 9)
```

## What is preserved vs. changed (caller-facing)

**Preserved signature-compatible:** `createAgent`, `defineAgentProfile`, `defineTool`,
`AgentProfile`, `AgentRuntimeConfig`, `CoveContext`, `CoveHarness`, `CoveSession(s)`,
`PromptResponse`/`PromptResultResponse`, `SessionData`/`SessionEntry`, the `Llm*` message
types, `CompactionConfig`, `DurabilityConfig`, `SandboxFactory`/`SessionEnv`, the `CoveError`
hierarchy.

**Changed (necessarily):**
- The **streaming** half of the SDK: `stream()`/`events()` iteration + `streamUrl`/`offset`
  become "subscribe to a Convex query." `sendAgent`/`promptAgent` still return identifiers.
- `observe()` is no longer the client delivery path (reactive queries are); it survives only
  as an internal emit used to write deltas to rows.
- `CallHandle.abort()` degrades from synchronous in-process abort to an async `workflow.cancel`.
- Agent addressing moves from "drop a file in `agents/`" to an explicit registry.

## Phase roadmap

- **P0 — Scaffold + plan** (this commit): package, tsconfig, convex.config, schema, plan.
- **P1 — Pure core:** SOR schema + ported pure-logic modules (compile-clean spine).
- **P2 — Sandbox:** `@upstash/box` adapter + local `bash()` real-machine adapter behind `SandboxFactory`/`SessionEnv`.
- **P3 — Providers:** AI SDK gateway registry; model + thinking-level resolution.
- **P4 — Engine:** durable workflow loop (setup → llmStep → dispatchTools → finalize) + batcher.
- **P5 — Sessions:** Convex `SessionStore` (header + entry tree diff-sync, cascade delete).
- **P6 — Harness/invoke:** `CoveContext.init` → `CoveHarness`/`CoveSession` over Convex.
- **P7 — HITL:** approval gate via `awaitEvent` + `approvals` table + `submitApproval`.
- **P8 — HTTP + auth:** submit/poll `httpAction`s; `POST /workflows/:name` workflows surface
  (D18); pluggable auth hook; `CoveHttpError` 4xx subclasses + `renderHttpError` (`CoveApiError`
  wire envelope) + `validateAgentRequest`/`validateWorkflowRequest`.
- **P8.5 — CLI + codegen:** Convex-native build/dev; `defineAgentRegistry` +
  `defineWorkflow` codegen into the app wiring; config validation; the `cove` binary
  (replaces `@flue/cli`). `cove add`/blueprint scaffolding is a deferred non-goal.
- **P9 — Events + SDK:** reactive event substrate; `createCoveClient` over ConvexReactClient + `@cove/react` hooks.
- **P10 — Skills + MCP:** skill catalog, `parseSkillMarkdown`, `connectMcpServer`.
- **P11 — Channels:** port slack/github/discord/… and remaining integrations.
- **P12 — Parity:** compaction, a sample end-to-end agent, tests.

## Top risks (tracked)

1. **Streaming model mismatch** — per-token deltas must be batched or they overwhelm Convex
   mutation throughput; CallHandle await semantics need a poll-to-terminal shim.
2. **Abort across the action boundary** — mid-tool cancellation weakens to `workflow.cancel`.
3. **Tool/closure serialization** — Zod/valibot schemas + `execute` can't cross the workflow
   journal; tools are rebuilt per `llmStep` from frozen descriptors.
4. **Sandbox lifecycle** — Upstash box handles don't persist across stateless actions; resolve
   by name each cold action.
5. **Convex action limits** — long turns / large reads / image chunking can hit per-function caps.

> Status is tracked in the session todo list. This doc is the durable source of intent.
