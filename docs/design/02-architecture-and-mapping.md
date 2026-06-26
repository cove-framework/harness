# 02 — Architecture & Concept Map

This doc maps **flue** (the original in-process harness) onto **Cove** (the
Convex-native rewrite). Naming, the reference-header convention, and the
orchestration ↔ execution boundary are defined once in
[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md);
this doc links to it rather than restating it.

## Layering

```
            ┌─────────────────────────────────────────────────────┐
 Authoring  │  createAgent / defineTool / defineAgentProfile      │  ← unchanged
  surface   │  defineToolRegistry · defineExtensionRegistry       │     (src/runtime)
            │  CoveContext · CoveHarness · CoveSession (types)    │
            └───────────────────────┬─────────────────────────────┘
                                    │  resolved + frozen at admission
            ┌───────────────────────▼─────────────────────────────┐
 Engine     │  agentRun = workflow.define(                         │
 (durable)  │     setup → (llmStep → dispatchTools | awaitApproval)│  ← @convex-dev/workflow
            │            → compaction? → finalize )                │     (convex/engine)
            └───────┬───────────────┬───────────────┬─────────────┘
                    │ rich state    │ LLM           │ tools
            ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────────┐
 Substrate  │ Convex tables│ │ AI SDK       │ │ @upstash/box       │
            │ (SOR + react)│ │ (providers)  │ │ (SessionEnv)       │
            └───────┬──────┘ └──────────────┘ └────────────────────┘
                    │ reactive query subscriptions (no SSE)
            ┌───────▼─────────────────────────────────────────────┐
 Clients    │ ConvexReactClient subscription  |  HTTP submit/poll  │
            └─────────────────────────────────────────────────────┘
```

The **golden rule**: rich state (messages, tool calls, results) lives in Convex
tables; only **scalar handles** (ids, step numbers, status) flow through the
workflow journal. This keeps the durable journal small and replay cheap, and it
makes every piece of state a reactive read.

### Division of labor

The three substrate boxes above are not peers — they have strictly separated
responsibilities. This is the [execution boundary](08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)
formalized for the layering diagram:

- **Convex orchestrates.** It is the entry point and the loop owner: it invokes
  the LLM (from a `"use node"` action), **watches** both the model stream and the
  sandbox output, **persists** all rich state into tables, and **owns durability
  and recovery** (workflow journal + replay). Convex never executes tools itself.
- **The Sandbox executes.** `@upstash/box` behind the `SessionEnv` interface runs
  every tool's `execute`, every command, and every file op — and **only** inside
  its own per-session workspace folder. It does not orchestrate, persist, or
  control flow.
- **The LLM decides text and tool calls — nothing else.** The AI SDK boundary
  generates assistant text and tool-call requests. It does not initiate the loop,
  control flow, or own any state; the workflow decides the next step from the
  persisted decision row.

### The sandbox boundary

Each `SessionEnv` is scoped to **one designated per-session workspace folder** —
all `exec`/fs operations resolve inside it, and the ported `createSandboxSessionEnv`
**enforces no `../` escape**. The box is resolved per cold action by the
`sandboxName` key. The full contract (key shape, `cwd` semantics, which Convex
functions may touch the box) lives in
[08 — The sandbox is one designated folder](08-conventions-and-execution-boundary.md#the-sandbox-is-one-designated-folder).

## The concept map (flue → Convex/Upstash)

Difficulty is the porting effort, not the runtime cost. Brand types are renamed
`Flue*` → `Cove*` per [08 §1](08-conventions-and-execution-boundary.md#1-naming--namespace);
generic verbs/domain types (`createAgent`, `defineTool`, `SessionEnv`, …) keep
their flue names.

| flue concept | Convex/Upstash realization | Difficulty |
| --- | --- | --- |
| `createAgent(initialize)` → frozen `{__coveCreatedAgent, initialize}` | Signature kept byte-identical. Filesystem-name addressing → explicit `defineAgentRegistry`. Initializer runs in the `setup` step; the resolved `AgentRuntimeConfig` is frozen onto the request/session row. | Medium |
| `defineAgentProfile` + profile/runtime merge | Ported verbatim ([`agent-definition.ts`](../../src/runtime/agent-definition.ts)) — pure, V8-safe, no I/O. Runs inside the setup action; resolved profile is persisted in the frozen plan. | Low |
| `defineAgentRegistry` (name → `CreatedAgent` map) | New construct (flue addressed agents by filesystem name; see [`flue-app.ts`](../../../flue/packages/runtime/src/runtime/flue-app.ts)). A `name → CreatedAgent` map wired into Convex via codegen + a runtime map. `setup` resolves the requested agent **by name** from the registry; `listAgents()`/`AgentManifestEntry` are derived from the same map. | Medium |
| User-authored Workflow → `defineWorkflow((ctx) => result)` ⇒ `WorkflowHandler` | **Restored as a first-class construct** (honors locked D1 full parity — [D18](07-risks-and-decisions.md)). Convex-app-bound exactly like `defineAgentRegistry`: exported from the app/CLI surface under `convex/` (e.g. `convex/workflows/` + `convex/workflowRegistry.ts`), **not** on the `@cove/runtime` barrel. Workflow runs are a **distinct run kind** from agent runs — the `runs` table carries a `kind: 'agent' \| 'workflow'` discriminator (resolving the agentName-rekey conflation). HTTP `POST /workflows/:name`; SDK `client.workflows.invoke(name, input)`. | High |
| `CoveContext.init(agent, opts)` → `CoveHarness` | `ctx` becomes the argument bundle threaded through the workflow handler. `init()` resolves the agent + sandbox and returns a facade whose `session()/shell()/fs` are Convex mutations/actions keyed by `(instanceId, harnessName)`. `ctx.req` = the httpAction Request when entered via HTTP. | High |
| `CoveHarness` / `CoveSessions` (`get/create/delete`, `task:*` reserved) | `sessions` table keyed by `(instanceId, harnessName, sessionName)`. Per-session-name serialization → workflow ordering + a `by_session_and_status` pending-gate (supersede/serialize). `delete()` cascades over `taskSessions` and rejects while active. | Medium |
| `CoveSession.prompt/skill/task/shell/compact` → `CallHandle<T>` | Two surfaces: **(a) native** — `prompt()` is a mutation that schedules the workflow and returns a `submissionId`; caller awaits terminal state via a reactive query. **(b) HTTP** — `?wait=result` httpAction polls to terminal so `await` semantics survive. `CallHandle.abort()` → `workflow.cancel`. | High |
| Built-in framework tools — `createTools` (read/write/edit/bash/grep/glob/task/activate_skill, [`agent.ts`](../../../flue/packages/runtime/src/agent.ts)) + result/finish/give_up (`createResultTools`, [`result.ts`](../../../flue/packages/runtime/src/result.ts)) | These are **rebuilt from frozen descriptors per `llmStep`**, exactly like user tools — closures can't cross the journal. Their `execute` is rebuilt **in `dispatchTools`** (read/write/edit/bash/grep/glob bind against the request's `SessionEnv` and touch the box; `task` spawns a child run; **`activate_skill` resolves a skill from the `skills` catalog via a Convex query — no box** ([08 §3](08-conventions-and-execution-boundary.md#skills-resolve-at-the-call-site-not-in-the-sandbox)); finish/give_up/result terminalize). Names stay framework-reserved. | Medium |
| In-process pi `Agent` loop with per-turn checkpoint | `agentRun` workflow: `setup → for(maxSteps){ llmStep → dispatchTools }`. Messages/toolCalls/results live in `sessionEntries`; the journal carries scalars. The pi "message cursor" becomes `leafId`, rebuilt by `SessionHistory.buildContext()` at each step. | High |
| Result-schema loop (`session.ts#runWithResultTools` — result/finish/give_up re-nudge) | The durable result-schema branch: when a `result` schema is set, the loop re-nudges the model toward a valid `result` call, bounded by `maxFollowUps` (frozen on the plan, default 32, parallel to `maxSteps`). Exhaustion terminalizes with reason `result_followups_exhausted`; a `give_up` raises the new `ResultUnavailableError extends CoveError` (carries `reason` + assistant text). Either way the run **rejects the `CallHandle` with `ResultUnavailableError`** — it never resolves `PromptResultResponse<T>` with unvalidated `data` ([08 §4.10](08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination)). | Medium |
| `SessionData` v6 tree + `SessionHistory` (getActivePath/buildContext/append…) | `sessions` (header) + `sessionEntries` (one row per node). `SessionHistory` ported **verbatim** as pure logic; mutations do append-only diff-sync of entry rows. `buildContext()` walks parent links in app logic after an indexed load. | High |
| `defineTool` / `ToolDefinition` (valibot or JSON-Schema params) | `defineTool` signature identical; `normalizeToolDefinition` ported pure. Tools are **rebuilt per `llmStep`** from frozen descriptors (closures can't cross the journal). `execute` is stripped for the model call; `dispatchTools` runs it and writes results idempotently by `toolCallId`. `execute` returns **`string \| ToolResult`** (`{content[], details?, isError?}`; `details` is a model-invisible side-channel). | Medium |
| User-tool recovery — name-keyed **tool registry** ([`tool-registry.ts`](../../src/runtime/tool-registry.ts)) | `defineToolRegistry`/`registerToolRegistry`/`getRegisteredTool`/`listRegisteredTools`, mirroring `agentRegistry`. The `kind:"user"` path is **live**: `dispatchTools` recovers a user tool's `execute` **by name** via `getRegisteredTool(name)` (was a dead path degrading to `errorTool`). Since closures can't cross the journal, user tools must be **module-scope, registered by name** — inline-in-`initialize` user tools are **rejected at validation**. `cove build` emits `convex/_cove/toolResolver.ts`; `cove init` scaffolds `convex/toolRegistry.ts`. | Medium |
| Extensions — in-process plugin surface ([`extensions/`](../../src/runtime/extensions/)) | `defineExtensionRegistry({ name: factory })` (Convex-app-bound, mirrors `agentRegistry`/`toolRegistry`) or an inline factory in a profile's `extensions` array. An `ExtensionFactory` registers tools / system-prompt fragments / event handlers; the registration API has **no action methods** (purely data, so re-running per isolate is safe). Hooks fall into **three determinism classes** (registration / content-mutation / notify); the manifest freezes into `runPlan.extensions` and re-binds in order on replay ([08 §4.12](08-conventions-and-execution-boundary.md#412-extensions--the-determinism-class-contract)). | Medium |
| MCP: `connectMcpServer` ([`mcp.ts`](../../../flue/packages/runtime/src/mcp.ts)) → `ToolDefinition[]` | `connectMcpServer` adapts an MCP server's tools to flue's `ToolDefinition[]` shape; owned by a `"use node"` `convex/mcp/` module (it opens a network transport). The frozen descriptor carries the tool's **server identity + transport config** (not a closure); `buildTools` **re-resolves a network MCP client** from it rather than binding against the box — the one sanctioned exception to box-binding, with replay de-duped by `toolCallId` ([08 §4.5](08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors)). | Medium |
| Skills (`Skill`/`SkillReference`, `parseSkillMarkdown`, workspace discovery) | `parseSkillMarkdown` ported pure. Workspace FS discovery → a `skills` **catalog table** (seeded by an import action that parses host-supplied `SKILL.md`, not a box). A skill is **resolved only from the catalog** — identity, frontmatter, instructions, and reference bodies — **never by reading `SKILL.md` from the sandbox FS** ([08 §3](08-conventions-and-execution-boundary.md#skills-resolve-at-the-call-site-not-in-the-sandbox)); on-demand `SessionEnv` reads stay available only for *non-skill* workspace context. `session.skill()` resolves a prompt and routes to the prompt path. | Medium |
| `SandboxFactory.createSessionEnv` → `SessionEnv` (exec/fs) | New `@upstash/box` adapter implementing the 9-method `SessionEnv`, wrapped by the ported `createSandboxSessionEnv` (path resolution, parent-dir creation, abort checks, `../`-escape rejection). Box resolved by name + cached per action; `exec` wraps base64 `bash -l`. `timeoutMs` rounds **up** to box seconds. | Medium |
| Durable submissions (turn journals, leases, attempt markers, stream-chunk recovery) | **Subsumed** by `@convex-dev/workflow` (durable checkpoint, crash recovery, replay). A `submissions`/`agentRequests` row tracks lifecycle; the lease/attempt CAS machinery is dropped. | High |
| Compaction (`runCompaction`, threshold + overflow→compact→retry) | Pure helpers (token estimation, cut-point) ported; the **summarization LLM call** becomes a workflow step. Auto-compaction fires between `llmStep`s when estimated tokens exceed the window reserve. | Medium |
| HTTP runtime: `flue()` Hono app, `dispatch()`, DS protocol, `observe()` | Convex `httpRouter` + `httpAction` wrap the submit routes; `dispatch()` → an admission mutation. **GET stream reads are gone** (httpActions return immediately); native clients use reactive queries. `?wait=result` polls to terminal. | High |
| Event model: `CoveEvent` (text_delta/tool/turn/run_*) + `EventStreamStore` | `events` table (`streamKey`, `seq`, `data`). `appendEvent` = mutation; **Convex reactivity replaces `subscribe()`**. `text_delta`s are delta-batched to avoid per-token mutations. | High |
| SDK: `createCoveClient` → `{agents.prompt/send, runs.get, …}` + `CoveEventStream` | The send/prompt **shape** is kept; the **streaming** half becomes "subscribe to a Convex query." A `ConvexCoveClient` yields the same `CoveEvent`/`RunRecord` types from reactive subscriptions. | Medium |
| `@flue/react` `agent-reducer.ts` + `UIMessage` assembly | Ported to cove `src/react` as the client-side reducer. It **reconciles against PATCHED snapshots** — the in-position delta-coalescing model of [08 §4.6](08-conventions-and-execution-boundary.md#46-streaming-commit--subscription-semantics) — **not** an append-only event log; `UIMessage` assembly is rebuilt from the coalesced snapshot a Convex query yields. | Medium |
| Identity/grouping ids (`requestId`, `turnId`, `operationId`, `stepNumber`) | `turnId`/`operationId` are ported as ULID ids (`turn_${ulid()}` / `op_${ulid()}`) — **opaque grouping ids, not persistence keys**: rows are addressed by their own table keys, and these only tag-and-group events/entries. `turnId ≠ (requestId, stepNumber)` (a turn spans steps and is not reconstructable from the step coordinate). | Low |
| Provider registration (`registerProvider`, `ModelConfig`, thinking levels) | AI SDK gateway registry behind flue's `registerProvider` facade. `ModelConfig` string → gateway model id. `storeResponses` registration flag → AI SDK `providerOptions.openai.store=true` on the `llmStep` `streamText` call. `ThinkingLevel` → per-provider reasoning options (anthropic budget / google `thinkingConfig` / openai `reasoningEffort`), with the per-level token budgets `{minimal:1024,low:2048,medium:8192,high:16384}` + `minOutputTokens` floor + `adjustMaxTokensForThinking` fitting math reproduced from pi — see [06 P3](06-phase-roadmap.md#-phase-3--provider-registry). | Medium |
| Provider **plugins** (`convex/providers/` — `ProviderPlugin`, `registerProviderPlugin`/`getProviderPlugin`/`hasProviderPlugin`) | A pluggable provider layer (`plugin.ts`) with **4 self-registering built-ins** (`builtins.ts`). `capabilities.ts`/`registry.ts`/`thinking.ts`/`gateway.ts` consult the plugin map **first**, with the legacy hardcoded switch as **fallback** (zero behavior change). `thinking.ts` is now V8-safe (`"use node"` removed); `ModelHandle.model: unknown` keeps the V8 layer AI-SDK-free. | Medium |
| pi-ai `providers/faux.ts` (scripted test model) | **Not ported** — superseded by the AI SDK `MockLanguageModelV2` (from `@ai-sdk/provider-utils`/test). Scripted `doStream`/`doGenerate` exercises `llmStep` without network; injected via `resolveModel` (a reserved test model id, or `llmStep` accepts an injected `ModelHandle`). The single deterministic seam P3/P4 tests drive. | Low |
| pi-ai `utils/sanitize-unicode.ts` (`sanitizeSurrogates`) | Ported pure and **applied inside `toModelMessages`** — lone/invalid UTF-16 surrogates are stripped from message content before the AI SDK call, matching pi's pre-send sanitization. | Low |
| `PersistenceAdapter`/`SessionStore`/`RunStore`/`EventStreamStore` | One Convex adapter: each store method becomes a mutation/query. `save` = header upsert + entry diff-sync + image-chunk replace. `migrate()` is a no-op (declarative schema). The shared **SQL store implementations** (`sql-*.ts`) are **obsolete** under Convex — see below. | Medium |

## Where pi disappears and where it survives

- **Disappears:** pi's `Agent` loop, pi-ai's provider calls, pi-agent-core's
  harness/session layer (flue already bypassed most of this — see
  [`documents/start/06`](../../../documents/start/06-flue-on-pi-integration.md)).
- **Obsolete (the SQL backends):** the shared SQL store implementations
  (`sql-agent-execution-store.ts`, `sql-storage.ts`, `sql-run-store.ts`,
  `sql-persisted-chunk-store.ts`) have **no place under Convex** — each store method
  collapses into a Convex mutation/query and there is **no public surface**. (Full
  dropped/obsolete list in
  [08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit).)
- **Survives (as a shape, not a dependency):** pi's **message model** — copied
  into [`cove-harness/src/runtime/messages.ts`](../../src/runtime/messages.ts)
  so `SessionData`/`SessionEntry` stay wire-compatible and
  [`session-history.ts`](../../src/runtime/session-history.ts) ports
  verbatim. The AI SDK boundary lives only in `convex/engine/llmStep.ts` and
  `convex/providers/`.

## Module layout

See [`cove-harness/PLAN.md`](../../PLAN.md#module-layout) for the live
tree. Summary:

- `src/runtime/` — portable, V8-safe pure logic (the preserved public surface),
  including the **tool registry** (`tool-registry.ts`) and the **extension subsystem**
  (`extensions/` — factories, the registration API, and the determinism-class model).
- `convex/engine/` — the durable loop.
- `convex/sessions/` · `convex/invoke/` — SOR mutations/queries + the public
  submission mutations behind `CoveSession`.
- `convex/providers/` — the pluggable **provider-plugin** layer (`ProviderPlugin`,
  `registerProviderPlugin`, 4 self-registering built-ins) the registry/capabilities/
  thinking/gateway modules consult first (legacy switch as fallback).
- `convex/sandbox/` · `convex/events/` · `convex/http.ts`
  — the remaining substrate adapters and the HTTP submit/poll surface.
