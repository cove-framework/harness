# Overview & Mental Model

Cove is a **Convex-native, durable agent harness you self-host**. You run the agent loop — model calls, tool execution, multi-turn sessions, compaction, human-in-the-loop approvals, subagent delegation — *inside your own Convex deployment*, against your own schema, with no separate agent service to operate. There is no Cove SaaS: the framework is the `cove-harness/` Convex app, and you build on it by authoring agents, wiring your Convex client into the SDK, and driving runs over Convex functions or HTTP.

This page is the mental model. It is the first stop before [Getting Started](01-getting-started.md). For the *why* behind these choices, cross-link to the design docs under [`../design`](../design/README.md) as you go.

> **Status note.** Cove is an early scaffold (`package.json` version `0.0.0`, private). Only `prompt()` is wired end-to-end in the SDK facade; `session.skill()`, `session.task()`, `session.shell()`, `session.fs`, `session.compact()`, and `harness.shell()`/`harness.fs` currently reject with a `CoveError` whose code is `'not_implemented'`. The HTTP `POST /workflows/:name` route is a live stub that always returns `404 workflow_not_found`. Outbound Slack replies are not implemented. Those gaps are called out honestly throughout this doc set — don't build on a surface this page says is deferred.

## What Cove is

- **A library, not a service.** You deploy the `cove-harness/` Convex app and build your product on top of it. Agents, tools, and skills are *your* code.
- **Durable by construction.** Every agent run is a Convex [`@convex-dev/workflow`](../design/04-durable-engine.md) workflow registered in `convex/convex.config.ts` (`app.use(workflow)`). The loop survives restarts, deploys, and crashes because all of its state lives in Convex tables — see the [system-of-record](#the-convex-system-of-record) below.
- **Convex-reactive, not SSE.** There is **no streaming / SSE anywhere** in Cove. You observe a run by subscribing to a reactive Convex query (`useQuery(api.requests.get, { requestId })`), which re-renders as the durable loop patches the row. HTTP callers can long-poll with `?wait=result`. The design doc explains why streaming was replaced by reactivity: [`../design/03-data-model-sor.md`](../design/03-data-model-sor.md).
- **Provider-agnostic models.** Models are specified as `'provider-id/model-id'` strings (e.g. `'anthropic/claude-haiku-4-5'`) resolved through the Vercel AI gateway. For free, deterministic, credential-free dev/CI runs, use the reserved test model `cove-test/mock` (`RESERVED_TEST_MODEL_ID`), which returns byte-stable text `"cove mock response"`.

## The core mental model

### Agents

An **agent** is a function you author with `createAgent(initialize)`. `createAgent` is *defined* in `src/runtime/agent-definition.ts` and re-exported from the pure runtime barrel `src/runtime/index.ts` (conceptually `@cove/runtime` — see the note below). The `initialize` callback receives an `AgentCreateContext` (`{ id, env, payload }`) and returns an `AgentRuntimeConfig`:

```ts
// "@cove/runtime" is a conceptual name; the barrel is src/runtime/index.ts.
// There is no path alias yet, so real code imports via the relative .ts path:
import { createAgent } from "../runtime/index.ts"; // re-exported from src/runtime/agent-definition.ts

export const researcher = createAgent((ctx) => ({
  model: "anthropic/claude-haiku-4-5",
  instructions: "You are a focused research assistant.",
  // tools, skills, subagents, extensions, mcpServers, thinkingLevel, compaction, durability, cwd, sandbox ...
}));
```

> **A note on `@cove/runtime` / `@cove/sdk`.** These are *conceptual* names for the two barrels — `src/runtime/index.ts` and `src/sdk/index.ts` — not resolvable import specifiers. The repo has **no path alias** (`tsconfig.json` has no `paths` key) and **no package `exports`/self-reference** (the package name is `cove`). Every `@cove/runtime`/`@cove/sdk` mention in the source is inside a header comment, never an actual `import`. Real code imports via relative paths carrying the literal `.ts` extension (e.g. `src/sdk/index.ts` imports `../runtime/context.ts`; `convex/*` import `../../src/runtime/*.ts`), enabled by `moduleResolution: "Bundler"` + `allowImportingTsExtensions`. The naming is not fully settled — `README.md` calls the same surface `@cove-harness/runtime`. Treat the `@cove/*` spellings throughout this page as nicknames; use relative `.ts` paths in code until an alias exists.

Key facts that shape the model:

- `createAgent` returns an opaque, frozen `CreatedAgent` branded `__coveCreatedAgent: true`. The `initialize` callback runs **every time** a harness is initialized from the agent — it is *not* a one-time constructor, so don't stash per-invocation state in a closure expecting it to be a singleton.
- There is **no `name` field** on `AgentRuntimeConfig`. An agent is addressed by its **registry key**, not a self-declared name. (`name` exists only on `AgentProfile`, where it's required to select a profile as a subagent.)
- Authors set `instructions`, **not** `systemPrompt`. The final system prompt is composed internally from `instructions` plus the resolved skill catalog.
- To make agents addressable, register a `name -> CreatedAgent` map with `defineAgentRegistry({...})` — but note this is **Convex-app-bound** (`convex/agentRegistry.ts`), *not* on the `@cove/runtime` barrel. See [Defining Agents](02-defining-agents.md).

### Sessions

Cove addresses **every session by the tuple `(instanceId, harnessName, sessionName)`** — there is no opaque public session id at the API surface. The `sessions` table resolves the tuple via the `by_instance_harness_session` index.

- **Multi-turn continuity is implicit: reuse the same tuple.** `getOrCreate` is idempotent on the tuple, so a second prompt with the same `(instanceId, harnessName, sessionName)` reattaches to the same entry tree. A different `sessionName` starts a fresh conversation. There is no explicit "resume" call.
- All three default to `"default"` when omitted.
- Session names beginning with `task:` are **reserved** for delegated subagent tasks (`assertPublicSessionName` rejects them).
- Only two session functions are PUBLIC: the `exists` query and the `remove` mutation (both in `convex/sessions/store.ts`). `remove` cascades to child task sessions and refuses while any descendant request is still active.

The persisted conversation is a parent-linked **entry tree** (`SessionData`, version `6`); the in-memory view is `SessionHistory` (`src/runtime/session-history.ts`). See [Sessions & Compaction](05-sessions-and-compaction.md).

### The durable workflow loop

A **submission** (a prompt) becomes one row in the `agentRequests` table and drives one durable workflow. The lifecycle is the request `status`:

```
pending  →  running  →  completed | failed | cancelled
```

`pending` (admitted, not yet started) → `running` (workflow active, OR parked on a HITL approval) → a terminal status (`completed` with `finalText`/`result`, `failed` with `error`, or `cancelled` with `cancelReason`). The loop reads only **frozen** state (the resolved plan snapshotted at admission) so replay never drifts. The per-step streaming substrate is the `agentRequestSteps` table, whose reactive queries *are* Cove's SSE replacement. The full loop is documented in [`../design/04-durable-engine.md`](../design/04-durable-engine.md) and [Deployment & Operations](08-deployment-and-operations.md).

### The Convex system-of-record

The entire agent state lives in your Convex deployment's tables (`convex/schema.ts`). You don't manage these directly, but knowing the SOR explains where everything is and why durability/reactivity work:

| Table | What it holds |
| --- | --- |
| `sessions` | One row per session (the header for the `(instanceId, harnessName, sessionName)` tuple). |
| `sessionEntries` | One row per entry-tree node (`MessageEntry \| CompactionEntry`). |
| `agentRequests` | One row per submission/turn; the durable workflow's anchor and the `status` you subscribe to. |
| `agentRequestSteps` | One row per agent-loop step; streaming text patched in place, then finalized. **Reactivity here replaces SSE.** |
| `runs` | Top-level workflow runs (inspect surface). |
| `events` | Durable + reactive event log. |
| `approvals` | HITL approval gates. |
| `skills` | The knowledge catalog the skill tool reads at runtime. |
| `imageChunks` | Content-addressed image blob store. |
| `meta` | Schema-version / kv (also the channel webhook dedup ledger). |

### Reactive queries instead of SSE

Because the loop writes its progress into `agentRequests`/`agentRequestSteps` rows, you watch a run the way you watch any Convex data — with a reactive query that re-renders on each patch:

```tsx
// Native Convex client (e.g. React)
const snap = useQuery(api.requests.get, { requestId });
// snap: { status, finalText, result, error, cancelReason, usage,
//         totalTokens, totalSteps, totalToolCalls, durationMs } | null
if (snap?.status === "completed") render(snap.finalText);
```

`api.requests.get` returns a point-in-time `Snapshot` (or `null`); the *reactivity* makes it live. For non-reactive consumers (HTTP), use the `?wait=result` long-poll on `POST /agents/:name/:id` (400ms interval, 60s deadline). See [Invoking Agents](03-invoking-agents.md).

## The 3-layer architecture

Cove is a single standalone Convex app (`cove-harness/`) with a strict three-layer layout and a **one-way dependency rule**.

```
┌──────────────────────────────────────────────────────────────┐
│  src/sdk/        Convex-native consumer client                 │
│                  createCoveClient(client, refs, opts)          │
│                  — what YOU call from your app                  │
└───────────────┬──────────────────────────────────────────────┘
                │ drives via Convex function references
                ▼
┌──────────────────────────────────────────────────────────────┐
│  convex/         The Convex backend (system-of-record schema,  │
│                  durable engine, sessions, invoke, HTTP,       │
│                  providers, channels). MAY import src/runtime/* │
└───────────────┬──────────────────────────────────────────────┘
                │ imports (verbatim, with .ts extensions)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  src/runtime/    Portable, pure, V8-safe core.                 │
│                  The @cove/runtime barrel (src/runtime/index.ts)│
│                  Imports NONE of: ai/@ai-sdk/*, @upstash/box,  │
│                  node builtins, Convex.                         │
└──────────────────────────────────────────────────────────────┘
```

**`src/runtime/` — the pure core.** Portable, V8-safe logic and the public `@cove/runtime` surface (barrel: `src/runtime/index.ts`). The authoring API lives here: `createAgent`, `defineAgentProfile`, `defineTool`, `createCoveContext`, plus the full type contract (`AgentRuntimeConfig`, `ToolDefinition`, `Skill`, `SessionData`, the error classes, etc.). It imports **none** of `ai`/`@ai-sdk/*`, `@upstash/box`, node builtins, or Convex.

**`convex/` — the backend.** The system-of-record schema, durable engine, sessions, invoke, providers, channels, and HTTP routes. `convex/*.ts` MAY import `src/runtime/*` (verbatim, carrying the literal `.ts` extension — tsconfig uses `moduleResolution: "Bundler"` with `allowImportingTsExtensions`). The Convex-*app-bound* authoring constructs live here, **not** on the `@cove/runtime` barrel: `defineAgentRegistry`/`registerAgentRegistry` (`convex/agentRegistry.ts`), and `defineWorkflow`/`defineWorkflowRegistry`/`registerWorkflowRegistry` (`convex/workflowRegistry.ts`).

**`src/sdk/` — the consumer client.** The Convex-native client you wire into your app (`createCoveClient` over a `ConvexReactClient` or `ConvexHttpClient`). This is your entry point for driving runs in code.

### The one-way dependency rule

> `convex/*` may import `src/runtime/*`. **`src/runtime/*` must NEVER import from `convex/`.**

In practice this also means: pure modules (queries/mutations and all of `src/runtime`) stay **AI-SDK-free and box-free**. Only files whose **first statement** is `"use node"` may import `ai`/`@ai-sdk/*`, `@upstash/box`, or node builtins — and those are reached only from `"use node"` engine *actions*, never from queries/mutations or the V8-safe core. The rationale is in [`../design/08-conventions-and-execution-boundary.md`](../design/08-conventions-and-execution-boundary.md).

## What you can build

### Drive agents from code (the SDK facade)

You wire Cove to your Convex backend by passing your Convex client plus the 5 deployed function references into `createCoveClient`. The package is intentionally decoupled from `convex/_generated` — **you supply the refs yourself** from your app's generated `api`:

```ts
// "@cove/sdk" is a conceptual name; the barrel is src/sdk/index.ts (no path alias yet),
// so real code imports via the relative .ts path:
import { createCoveClient } from "../src/sdk/index.ts";
import { api } from "../convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import * as v from "valibot";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

const cove = createCoveClient(client, {
  submitPrompt:  api.invoke.submit.submitPrompt,
  stopActive:    api.invoke.submit.stopActive,
  getRequest:    api.requests.get,
  sessionExists: api.sessions.store.exists,
  deleteSession: api.sessions.store.remove,
});

// Authoring chain: context → init(agent) → session → prompt
const ctx = cove.context({ id: "user-42" });           // CoveContextInit; only `id` is required
const harness = await ctx.init(researcher);            // → CoveHarness (resolves the profile, derives defaultModel)
const session = await harness.session("default");      // → CoveSession

const { text, usage, model } = await session.prompt("Summarize the news.");
```

`prompt()` returns a `CallHandle` — a thenable you `await`, that also exposes `.signal` and `.abort(reason?)` for cancellation. Without a result schema you get back `{ text, usage, model }`. With one, you get validated structured output:

```ts
const Schema = v.object({ headline: v.string(), score: v.number() });
const { data } = await session.prompt("Rate this article.", { result: Schema });
// `data` is RE-VALIDATED locally with valibot before resolving.
```

The result-schema contract is the load-bearing detail: the valibot schema you pass is converted to JSON Schema for the server, the server captures the structurally-valid value, then the facade **re-validates** the captured value locally with `v.safeParse` before resolving. You either get validated `data` or a thrown `ResultUnavailableError` — **never** unvalidated data.

> Note: `model` must be resolvable at call time — it's `options.model ?? harness defaultModel` (derived from the agent's `profile.model`), or it throws `ModelNotConfiguredError`. And in this cut only `prompt()` is wired; `session.skill/task/shell/compact` and `harness.shell/fs` reject with `not_implemented`.

### Drive agents directly over Convex or HTTP

If you don't want the facade, you can call the backend directly. **Native Convex clients** call the `submitPrompt` mutation and watch `api.requests.get`:

```ts
// returns AdmitResult: { sessionId, requestId, submissionId, workflowId }
const { requestId } = await client.mutation(api.invoke.submit.submitPrompt, {
  prompt: "Hello",
  model: "anthropic/claude-haiku-4-5",
  // instanceId / harnessName / sessionName each default to "default"
});
```

`submitPrompt` **always supersedes** any in-flight request on the same session (cancelReason `"superseded"`). For a non-superseding dev driver use `api.dev.startPrompt` (and drive it with `cove-test/mock` for free deterministic runs). `stopActive` aborts in-flight work on a session.

**HTTP clients** POST JSON to `/agents/:name/:id` (body `{ message | prompt, model?, sessionName?, result | resultSchema? }`) → `{ sessionId, requestId, submissionId }`; add `?wait=result` to block until terminal. `GET /runs/:runId` returns a point-in-time snapshot. See [Invoking Agents](03-invoking-agents.md).

### Define your capabilities

- **Tools** — `ToolDefinition` entries (`{ name, description, parameters, execute }`); `parameters` is a valibot `v.object({...})` schema or a raw JSON Schema object, `execute` returns `Promise<string | ToolResult>` (a plain string, or a `ToolResult` for images / side-channel `details` / an `isError` flag). Plus 6 built-in framework tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`) and a built-in `task` tool — baked in automatically, not registered by you.
- **Skills** — a Convex-managed catalog (`convex/skills.ts`): `importSkill({ slug, content })` with SKILL.md text, `listSkills`, `getSkill`, `deactivateSkill`. The agent loads one at runtime via the synthetic `activate_skill` tool (present only when the catalog has active skills).
- **Extensions** — a first-class, declarable surface for augmenting a run. An extension is a factory `(cove) => { ... }` that can register system-prompt fragments and tools and subscribe **hooks** (content-mutation hooks that purely shape context/tool calls/compaction, and fire-and-forget notify hooks). You declare them on an agent via the `extensions` field — by registered name (`defineExtensionRegistry` in `convex/extensionRegistry.ts`) or as an inline factory. See [Tools, Skills & Human-in-the-Loop — Extensions](04-tools-skills-hitl.md#extensions) and [Defining Agents](02-defining-agents.md#extensions-and-mcpservers).
- **MCP servers** — mount remote MCP servers on an agent via the `mcpServers` field (or per request); their tools surface to the model as `mcp__<server>__<tool>`. See [Defining Agents](02-defining-agents.md#extensions-and-mcpservers).
- **Human-in-the-loop** — gate tool calls by setting `request.approvalTools`; subscribe to `listPending({ requestId })` to render approval cards and resolve each with the `submitApproval` mutation.

See [Tools, Skills & Human-in-the-Loop](04-tools-skills-hitl.md).

### Delegate to subagents and orchestrate workflows

- **Subagents** — the model delegates a focused task to a detached child agent via the built-in `task` tool. Each child runs as its own durable workflow on a reserved `task:<parentSession>:<toolCallId>` session, depth-capped at `MAX_TASK_DEPTH = 8`. See [Subagents & Workflows](06-subagents-and-workflows.md).
- **Code-orchestrated workflows** — wrap a handler with `defineWorkflow((ctx, input) => result)` (from `convex/workflowRegistry.ts`) where `ctx` is a `CoveContext` whose `ctx.init(agent, options)` spins up a harness, then register them with `defineWorkflowRegistry({...})`. **Caveat:** the `POST /workflows/:name` route is currently a stub that always returns `404 workflow_not_found` — workflows aren't drivable over HTTP yet.

### Add inbound channels

A pre-built Slack webhook is registered at `POST /channels/slack` (set `SLACK_SIGNING_SECRET` and point your Slack app's Event Subscriptions there). It maps each channel to one session (`instanceId: slack:<team>`, `sessionName: slack:<channel>`) and drives `submitPrompt`. To add another channel, author a pure V8-safe adapter under `src/runtime/channels/` mirroring `slack.ts` and add a matching `http.route` in `convex/http.ts`. **Inbound only** — outbound replies are not implemented yet. See [Channels (Slack & beyond)](07-channels.md).

### Gate access

Install an `authorize` hook at module scope with `configureAuthorize(hook)` (`convex/auth.ts`). The hook `(ctx, req) => identity | throws` runs at admission on every `/agents` and `/runs` route; throwing (e.g. `UnauthorizedError`) yields a 401. **With no hook installed, the HTTP surface is open** — and the hook is not persisted across cold boots, so your generated app entry must re-install it each boot. See [Deployment & Operations](08-deployment-and-operations.md).

## Where to go next

1. **[Getting Started](01-getting-started.md)** — deploy the app, run a free `cove-test/mock` round-trip.
2. **[Defining Agents](02-defining-agents.md)** — `createAgent`, profiles, registries.
3. **[Invoking Agents](03-invoking-agents.md)** — the SDK facade, native Convex, and HTTP.
4. **[Tools, Skills & Human-in-the-Loop](04-tools-skills-hitl.md)**
5. **[Sessions & Compaction](05-sessions-and-compaction.md)**
6. **[Subagents & Workflows](06-subagents-and-workflows.md)**
7. **[Channels (Slack & beyond)](07-channels.md)**
8. **[Deployment & Operations](08-deployment-and-operations.md)**

For design rationale behind any of the above, see the design docs under [`../design`](../design/README.md).
