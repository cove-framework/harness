# 05 — Public API & SDK

The contract with agent authors and client developers. The authoring surface is
preserved; the *streaming* half of the consumer SDK necessarily changes because
SSE is gone. Naming follows the rebrand in
[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md):
brand-prefixed types are `Cove*`, generic verbs/domain types are kept, and the
package is `@cove/runtime` / `@cove/sdk` / `@cove/react` (the folder stays
`cove-harness/`).

## Preserved signature-compatible

These compile and behave the same. Live ports in
[`cove-harness/src/runtime/`](../../src/runtime/).

**Authoring**
- `createAgent(initialize)` → `CreatedAgent` — [`agent-definition.ts`](../../src/runtime/agent-definition.ts)
- `defineAgentProfile(profile)` — same file
- `defineTool(tool)` → `ToolDefinition` — [`tool.ts`](../../src/runtime/tool.ts)
  (`normalizeToolDefinition` is an **internal** helper consumed by `buildTools`, not part
  of the public barrel — at parity with flue, which also does not export it)
- `AgentProfile`, `AgentRuntimeConfig`, `AgentCreateContext`, `AgentHarnessOptions`

**Context / harness / session (types)** — [`types.ts`](../../src/runtime/types.ts)
- `CoveContext` (`id`, `payload`, `env`, `req`, `log`, `init()`)
- `CoveHarness` (`name`, `session()`, `sessions`, `shell()`, `fs`)
- `CoveSessions` (`get`/`create`/`delete`)
- `CoveSession` (`prompt`/`shell`/`skill`/`task`/`compact`/`delete`, `fs`)
- `CallHandle<T>` (a `Promise<T>` that also carries `.signal` + `.abort()`)
- `PromptResponse`, `PromptResultResponse<T>`, `PromptUsage`, `PromptModel`
- `PromptOptions`/`SkillOptions`/`TaskOptions`/`ShellOptions`, `ShellResult`

**Data model (wire)** — `SessionData` (v6), `SessionEntry`, `MessageEntry`,
`CompactionEntry`, `TaskSessionRef`, `SessionStore`.

**Sandbox** — `SandboxFactory`, `SessionEnv`, `CoveFs`, `FileStat`,
`SessionToolFactory`, `BashFactory`/`BashLike` (the contract behind the built-in
**local / real-machine `bash()` adapter** — a consumed contract, not orphaned types;
see [D7](07-risks-and-decisions.md)).

**Tools/skills** — `ToolDefinition`, `ToolArgs`, `ToolParameters`, `Skill`,
`SkillReference`, `PackagedSkillDirectory`.

**Events (types)** — `CoveEvent`, `AttachedAgentEvent`, the `Llm*` message types.

**Errors** — the whole `CoveError` hierarchy
([`errors.ts`](../../src/runtime/errors.ts)), plus the new
`ResultUnavailableError extends CoveError` (carries the give-up `reason` + the
assistant text — see [08 §4.10](08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination)).
Only the base `FlueError`
→ `CoveError` (and the `[flue]` message prefix → `[cove]`); the non-branded
subclasses (`SessionNotFoundError`, `ToolInputValidationError`, …) keep their
names — see [08 §1](08-conventions-and-execution-boundary.md).

> **Result-schema rejection contract.** A `prompt`-with-result-schema run that
> gives up (`give_up`) or exhausts `maxFollowUps` (default 32, parallel to
> `maxSteps`; terminal reason `result_followups_exhausted`) **rejects the
> `CallHandle` with `ResultUnavailableError`** — it never resolves
> `PromptResultResponse<T>` with unvalidated `data`. See
> [08 §4.10](08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination).

**Model/compaction/durability** — `ModelConfig`, `ThinkingLevel`,
`CompactionConfig`, `DurabilityConfig`.

## Changed — and why

| flue today | Cove (cove-harness) | reason |
| --- | --- | --- |
| Agent addressing by module filename (`agents/<name>.ts` default export) | `defineAgentRegistry({ <name>: createAgent(...) })` | Convex has no filesystem-module addressing |
| SDK `stream()` / `events()` async iteration | subscribe to a Convex reactive query | no SSE; reactivity is the transport |
| `AgentSendResult.streamUrl` + `offset` | `{ sessionId, requestId, submissionId }` | client subscribes by id, not URL |
| `observe(cb)` as the client delivery path | reactive query over `events` (server-side `observe` survives only to *write* deltas) | reactivity replaces in-process fan-out |
| `CallHandle.abort()` = synchronous in-flight abort | async `workflow.cancel` | can't cross the action boundary |
| HTTP `flue()` Hono app w/ DS endpoints | Convex `httpRouter` submit/poll (no streaming GET) | httpActions return immediately |

## Agent registry (`defineAgentRegistry`)

flue addressed agents by filesystem-module name (`agents/<name>.ts` default export);
Convex has no filesystem-module addressing, so cove adds **one** new authoring
construct — `createAgent`'s signature is unchanged.

- **Signature:** `defineAgentRegistry(map: Record<string, CreatedAgent>) → AgentRegistry`
  — a `name → CreatedAgent` map. `setup` resolves the requested agent **by name**;
  `listAgents()` / `AgentManifestEntry` derive from the same map.
- **Validation (now load-bearing — OS file-existence no longer guards names):** each key
  matches `^[A-Za-z][A-Za-z0-9_-]*$` (`assertAgentName`); keys are unique
  (`assertUniqueNames`, duplicate → throw); each value carries the **`__coveCreatedAgent`**
  brand (a non-`CreatedAgent` value throws). An invalid registry fails **build-time**
  validation (P8.5) with a `[cove]` diagnostic, not at runtime.
- **Where it lives (resolved):** `defineAgentRegistry` is a **Convex-app-bound** construct
  — it wires agents into the deployed app via codegen — so it is exported from the
  app/CLI surface (`convex/agentRegistry.ts`), **not** from the pure `@cove/runtime`
  barrel (which stays V8-safe and Convex-free). [08 §1](08-conventions-and-execution-boundary.md#1-naming--namespace)
  lists it among kept *generic verb names* (it is not brand-renamed) — a naming
  statement, **not** a claim that it sits on the runtime barrel.

## Workflows (user-authored, restored)

Per [D18](07-risks-and-decisions.md) — restored as a first-class construct at full
parity with flue (honoring locked D1) — cove keeps `defineWorkflow` for
user-authored orchestration over agents:

- **Signature:** `defineWorkflow((ctx) => result) → WorkflowHandler` — the handler
  receives a workflow `ctx` and returns its `result`.
- **Where it lives (resolved):** like `defineAgentRegistry` (above), a
  `WorkflowHandler` is **Convex-app-bound** — it wires into the deployed app via
  codegen — so it is exported from the **app/CLI surface** (under `convex/`, e.g.
  `convex/workflows/` + `convex/workflowRegistry.ts`), **not** from the pure
  `@cove/runtime` barrel (which stays V8-safe and Convex-free). The
  Convex-app-bound rationale is the same as the
  [agent registry's](#agent-registry-defineagentregistry).
- **HTTP:** `POST /workflows/:name` (alongside the `/agents/:name/:id` routes).
- **Native SDK:** `client.workflows.invoke(name, input)`.
- **Distinct run kind.** Workflow runs are a **separate run kind** from agent runs;
  the `runs` table carries a `kind: 'agent' | 'workflow'` discriminator, which also
  resolves the prior agentName-rekey conflation. The HTTP route lands in **P8** with
  the registry/codegen in **P8.5** — see [06 — Phase Roadmap](06-phase-roadmap.md).

## MCP servers (network tools the call site declares)

Beyond in-code `tools`, a call site attaches **MCP servers** declaratively. flue's
`connectMcpServer` ([`mcp.ts`](../../../flue/packages/runtime/src/mcp.ts)) is preserved as
the underlying primitive; cove adds a declarative registration field so the durable loop
freezes a deterministic descriptor set:

- **`mcpServers?: McpServerOptions[]`** on `AgentProfile` — each carries `url` /
  `transport` / `headers`. In the `setup` action the `convex/mcp/` `"use node"` module
  calls `connectMcpServer` for each, discovers the server's tools, and **freezes their
  descriptors** (server identity + transport — *not* the live client) onto the plan.
- At each step `buildTools` **re-resolves a network MCP client** from the descriptor
  instead of binding against the box — the one sanctioned exception to box-binding
  ([08 §4.5](08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors));
  `callTool` is replay-de-duped by `toolCallId`.

So the model sees three tool sources uniformly — built-in framework tools, the call
site's in-code `tools`, and MCP tools — all as frozen JSON-Schema descriptors.

## Transport: native first, HTTP for outsiders

**Native (primary).** A client holds a `ConvexReactClient`, calls the submit
mutation, gets `{ sessionId, requestId, submissionId }`, and subscribes:

```ts
// submit
const { requestId } = await convex.mutation(api.invoke.submitPrompt, {
  agent: "triage", instanceId, sessionName: "default", message,
});
// watch tokens + tool activity stream in, live, no SSE
const steps = useQuery(api.steps.listForRequest, { requestId });
const request = useQuery(api.requests.get, { requestId }); // status → completed/failed
```

**HTTP (non-Convex callers: webhooks, channels).** A minimal `httpAction`
surface — *submit* and *poll a result*, no streaming endpoint:

```
POST /agents/:name/:id            → { sessionId, requestId, submissionId }
POST /agents/:name/:id?wait=result→ poll to terminal, return PromptResponse
GET  /runs/:runId                 → RunRecord (point-in-time, not a stream)
```

The `?wait=result` poll-to-terminal shim preserves the
`CallHandle<PromptResponse>` *await* semantics for callers that can't subscribe.

## The Convex-native SDK

`createCoveClient` (in `@cove/sdk`) keeps a recognizable shape but is backed by
Convex subscriptions instead of DS:

```ts
const cove = createCoveClient({ convex });          // wraps a ConvexReactClient/HTTP
const handle = await cove.agents.send("triage", id, { message });   // → ids
for await (const ev of cove.runs.events(handle.requestId)) { ... }  // yields CoveEvent, sourced from a reactive query
const run = await cove.runs.get(runId);             // RunRecord
```

`runs.events()` async-iterates a `CoveEventStream` (`CoveStreamOptions`) fed by a
reactive query rather than an SSE `CoveEventStream` reader. The returned
`CoveEvent`/`RunRecord` **types are identical** to flue's, so event-consuming code
ports unchanged; only the *source* (a reactive query, not an SSE stream) differs.
On the wire `CoveApiError` replaces `FlueApiError`. The existing HTTP+DS SDK in
[`flue/packages/sdk`](../../../flue/packages/sdk/src) is **not** preserved — it is
replaced by this native client (plus the HTTP submit/poll shim above).

### `@cove/react`

A thin hook layer over the native SDK, bound to `useQuery` subscriptions — no
fetch loops of its own:

- `useCoveClient()` — returns the `CoveClient` bound to the ambient
  `ConvexReactClient` (from `ConvexProvider`).
- `useAgentPrompt()` — a submit helper returning
  `{ submit, requestId, submissionId, status }`; `submit` calls the
  `api.invoke.submitPrompt` mutation and hands back the ids to subscribe with.
- `useRunEvents(requestId)` — subscribes to the request's reactive `events`/`steps`
  query and yields a `UIMessage[]` view-model (not raw `CoveEvent[]`) assembled by
  a **ported reducer** that reconciles against patched snapshots: it folds text
  deltas, tool activity, and terminal status into renderable messages and
  correlates **optimistic sends** (`pendingSends` / `activeSubmissionIds` /
  `settledSubmissionIds` / `recentEventIds`) so a locally-echoed user turn settles
  cleanly against the server's authoritative entry, and reuses the prior file
  part on `IMAGE_DATA_OMITTED` so omitted image payloads do not flicker. Re-renders
  on each batched delta flush.
- `useCoveRun(runId)` *(optional)* — a run-scoped convenience hook returning
  `{ events, logs, status, result, error }` for callers that want the full run
  record reactively rather than the message view-model.

These wrap (not reimplement) `@cove/sdk` so the async-iterator path and the React
path share one source of truth.

## Auth (pluggable, none by default)

flue gates routes with bearer-token middleware (`AgentRouteHandler`). Cove ships
the **hook** but no default provider: a user-supplied `authorize(ctx, req)` runs at
admission, **returns an identity or throws**. It is invoked in two places, and the
gate that applies depends on the caller's transport:

| Transport | Gate |
| --- | --- |
| **HTTP outsiders** (webhooks, channels via the `httpAction` submit surface) | `authorize(ctx, req)` reads the bearer/header off `req` and resolves the identity, or throws → 401. The same hook also runs from the public `invoke.submit*` mutations so the engine is never reached unauthenticated. |
| **Native `ConvexReactClient` callers** | the Convex auth identity path — `ctx.auth.getUserIdentity()` (Convex Auth / Clerk / Auth0 configured on the deployment). The mutation reads the already-verified identity from `ctx.auth`; `authorize` may still run to map that identity onto the agent/instance authorization, but there is no bearer header to parse. |

In short: HTTP callers are gated by the bearer hook on `req`; native callers are
gated by the deployment's Convex auth identity, with `authorize` as the shared
authorization (not authentication) seam in front of the engine. Drop in Clerk /
Convex Auth / bearer parity later without touching the durable loop
([04 — The Durable Engine](04-durable-engine.md)).

## Environment & configuration

`CoveContext.env` (typed `TEnv`, defaulting to `Record<string, any>`) is the
agent's view of platform bindings — `process.env` on Node, the Worker `env` on
Cloudflare in flue. Under Convex it is populated from the deployment's
**environment variables** (set via `npx convex env set …` / the dashboard /
deployment config); the runtime reads them and exposes them as `ctx.env` to
`createAgent` initializers. Because only `"use node"` actions touch the LLM and the
box (see [08 §3](08-conventions-and-execution-boundary.md)), **provider API keys**
(e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) live as Convex environment variables
read inside those actions — never shipped to the client and never read in queries
or mutations.

**Provider credential detection under Convex.** The non-key providers detect
ambient credentials from env vars rather than the filesystem: **Vertex** ADC via
`GOOGLE_APPLICATION_CREDENTIALS`, **Bedrock** via the AWS chain
(`AWS_PROFILE` / IAM instance role / ECS / IRSA). flue's `ProviderEnv` overrides
collapse to **plain Convex env reads** here (no Worker/Node `env`-object plumbing).
The filesystem `gcloud`-config probe is **local-bash-adapter-only** — it runs only
in the real-machine `bash()` adapter, never inside Convex actions
([D7](07-risks-and-decisions.md)).

Tuning surfaces flow through the agent profile and the durable loop, not loose
globals:

- **`DurabilityConfig`** (`maxAttempts`, `timeoutMs`) — resolved from the agent
  profile onto each submission; the action stream deadline (~240 s) and per-tool
  timeout (~30 s) are surfaced through it. See
  [08 §4.2](08-conventions-and-execution-boundary.md).
- **`CompactionConfig`** (or `false` to disable threshold compaction) — set on the
  profile / created-agent config; overflow recovery and explicit `session.compact()`
  still run when disabled.
- **Delta-batch cadence** — `deltaBatchMs = 400`, `deltaBatchChars = 480`
  (configurable), governing the streaming-commit flush; deltas coalesce into the
  step row. See [08 §4.6](08-conventions-and-execution-boundary.md).
- **`AgentHarnessOptions`** (`name`, `tools`, `skills`, `subagents`) — passed to
  `ctx.init(agent, options)` to select the harness and extend its tool/skill/subagent
  surface at runtime.

## Generated server entry

flue lets an authored `app.ts` own the request pipeline: without it, flue generates
an app mounting the `flue()` router at `/`; with it, the default `Fetchable` export
composes the routes (`routing.ts`'s flue-router / `Fetchable`, the `flue()` Hono
app, and `createDefaultFlueApp` plumbing). Cove keeps the *authoring* ergonomic but
changes the *target*: the authored `app.ts` compiles to a Convex
**`convex/http.ts`** (an `httpRouter` with the submit/poll routes above), produced
by the **Cove CLI / codegen** — the `createDefaultCoveApp` equivalent of flue's
`createDefaultFlueApp` + `flue-router` / `Fetchable` plumbing. Authors write the
registry and (optional) app composition; codegen emits the Convex HTTP entry. This
compilation step lands in the roadmap at **P8 / P8.5** (HTTP + auth) — see
[06 — Phase Roadmap](06-phase-roadmap.md).
