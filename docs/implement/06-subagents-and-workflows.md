# Subagents & Workflows

Cove gives you two ways to coordinate more than one agent run, and they sit at opposite ends of a spectrum:

1. **Subagent delegation (the `task` tool)** — *model-driven*. The agent itself decides, mid-run, to spawn a focused child agent to do isolated work, then folds the child's final answer back into its own conversation. You don't write the orchestration; the model calls a built-in tool.
2. **Workflows (`defineWorkflow`)** — *code-driven*. You write a deterministic TypeScript handler that spins up one or more harnesses and stitches their results together with ordinary control flow. The model never decides the shape of the orchestration — your code does.

This page covers both, the depth cap that protects nested delegation, how results flow back, and how to choose. For the single-agent invocation chain (`ctx.init(agent).session().prompt()`), see [Invoking Agents](03-invoking-agents.md). For how the session tree underneath all of this works, see [Sessions & Compaction](05-sessions-and-compaction.md).

> **Implementation status.** The model-facing `task` *tool* (what the engine exposes to a running agent) is wired and durable. The SDK-facade method `session.task(...)` is **not yet implemented** — calling it rejects with a `CoveError` whose `code` is `"not_implemented"` (deferred to phase P6). Workflow handlers (`defineWorkflow` / `defineWorkflowRegistry`) are authorable today; the HTTP route that drives them (`POST /workflows/:name`) is still a stub that returns `404 workflow_not_found` until phase P8.5. Both gaps are called out in detail below so you know exactly what runs and what doesn't.

---

## When to use each

| | **Subagent (`task` tool)** | **Workflow (`defineWorkflow`)** |
|---|---|---|
| Who orchestrates | The model, at runtime | Your code, deterministically |
| Entry point | Built-in tool the agent calls | `defineWorkflow((ctx, input) => result)` |
| Context isolation | Child gets a fresh context tree; only its final answer returns | Each `ctx.init(agent)` is its own harness/session |
| Good for | Open-ended exploration, fan-out research, "go figure this out" | Fixed pipelines, multi-stage review, fan-out you control |
| Reproducibility | Depends on the model's choices | Deterministic given the same input |
| Where it's defined | Nothing to define — it's automatic | `convex/` module, registered in a `WorkflowRegistry` |

Rule of thumb: if *you* know the steps ahead of time, write a **workflow**. If the *agent* should decide whether and how to delegate, let it use the **`task` tool**.

---

## Part 1 — Subagent delegation (the `task` tool)

### What it is

`task` is one of the built-in tools the engine bakes into every run (alongside `read`, `write`, `edit`, `bash`, `grep`, `glob`, and the conditional `activate_skill` / result tools — see [Tools, Skills & HITL](04-tools-skills-hitl.md)). You do **not** register it. In `convex/engine/setup.ts`'s `run` mutation, after freezing the six framework tools the engine appends `task` (`kind:"task"`) unconditionally. The model calls it; the engine runs the child as its own durable workflow and hands the child's final answer back as the tool result.

The model-facing contract is the exported `TASK_PARAMS` / `TASK_DESCRIPTION` constants in `convex/engine/task.ts`:

```ts
// convex/engine/task.ts
export const TASK_PARAMS = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Focused instructions for the child agent" },
    description: { type: "string", description: "Short human-readable label for the delegated work" },
    agent: { type: "string", description: "Declared subagent profile to use (optional)" },
    cwd: { type: "string", description: "Working directory for the child agent (optional)" },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

export const TASK_DESCRIPTION =
  "Delegate a focused task to a detached child agent with its own context. Use this for independent " +
  "research, file exploration, or parallel work. The task returns only its final answer to this conversation.";
```

**Parameters:**

- `prompt` *(required, string)* — the focused instructions for the child agent.
- `description` *(optional, string)* — a short human-readable label for the delegated work.
- `agent` *(optional, string)* — the name of a **declared subagent profile** to run the child as (see below).
- `cwd` *(optional, string)* — a working directory for the child.

> **Schema vs. consumed fields.** `TASK_PARAMS` declares all four properties so the model can express intent, but the spawn mutation `createChildRequest` currently consumes **only `prompt` and `agent`** — `toolCallId` is supplied by the engine, not the model. `description` and `cwd` are sent to the model but not persisted by the spawn path. Don't rely on `cwd` actually changing the child's working directory yet.

### Declaring subagents an agent may target

The optional `agent` parameter is not a free-for-all. It must name a subagent profile the agent **declared** in its config. You declare subagents via the `subagents` array on the agent's `AgentRuntimeConfig` (or its base `AgentProfile`), where each entry is an `AgentProfile` with a required `name`:

```ts
import { createAgent, defineAgentProfile } from "../src/runtime/agent-definition.ts";

// A reusable, named subagent profile.
const researcher = defineAgentProfile({
  name: "researcher",            // required for subagents; must match /^[A-Za-z][A-Za-z0-9_-]*$/
  description: "Reads files and summarizes findings.",
  instructions: "You explore the workspace and report concise findings. Do not modify files.",
  // NOTE: a subagent profile may NOT declare `durability` — that throws. Set durability on the parent.
});

export const orchestrator = createAgent(() => ({
  model: "anthropic/claude-sonnet-4-5",
  instructions: "Coordinate work. Delegate research to the `researcher` subagent when useful.",
  subagents: [researcher],       // now the model may call task({ prompt, agent: "researcher" })
}));
```

Two guards back this up (`src/runtime/session-identity.ts`):

- `assertSubagentDeclared(name, declared)` — a no-op when `agent` is `undefined` (the default, unnamed subagent is always allowed), otherwise throws `SubagentNotDeclaredError` unless `declared.includes(name)`. **Heads up:** this guard is defined and unit-tested but is **not yet wired into the spawn path in this cut** — `createChildRequest` (and `runTaskDelegation` in `dispatchTools.ts`) only call `assertTaskDepth` and store the `agent` value as the child's `target` with no declaration check. So at runtime `task({ agent: "researcher" })` currently does **not** reject an undeclared name; the helper has to be invoked from `createChildRequest`/`runTaskDelegation` before declaration is enforced. (The `dispatchTools.ts` comment mentions a "depth/declaration guard failure", but only the depth guard actually runs today.)
- `subagents` profiles **must not** be circular, must each have a unique name, the name must match `/^[A-Za-z][A-Za-z0-9_-]*$/`, and (as noted) must not declare `durability` — delegated task sessions run *inside* the parent operation. See [Defining Agents](02-defining-agents.md) for the full profile rules.

### How a delegated task runs

When the model calls `task`, the engine drives this lifecycle. The child-request lifecycle *helpers* — `createChildRequest`, `getChildResult`, and the `formatTaskResult` definition — live in `convex/engine/task.ts` (no `"use node"`), but the **orchestration that drives them** (partitioning `task` calls out of the step, starting/polling the child to terminal, and calling `formatTaskResult`) runs in `convex/engine/dispatchTools.ts` `runTaskDelegation`, which begins with `"use node"` (it resolves the sandbox and drives the child poll):

1. **Spawn (idempotent).** `createChildRequest` (an `internalMutation`) creates the child `agentRequest` and a **reserved child session** named `task:<parentSession>:<toolCallId>` (built with `createTaskSessionName(parentSession, taskId)` from `src/runtime/session-identity.ts`). The child's `submissionId` is the deterministic string `task:<parentRequestId>:<toolCallId>`, so a `dispatchTools` replay reuses the existing child instead of spawning a duplicate.
2. **Inherit.** The child inherits the parent's `model` and `instanceId`; its request `kind` is `"task"` and its `target` is the `agent` name.
3. **Start.** Inside that same mutation, `workflow.start(...)` kicks off the child's own durable workflow (`internal.engine.runHandler.agentRun`), and the parent's `taskSessions` is patched to link the child for the cascade delete.
4. **Poll.** `getChildResult` (an `internalQuery`, defined in `task.ts`) is the poll target — it returns the child's terminal snapshot `{ status, finalText, error }` or `null`. The poll *loop* that calls it repeatedly until the child reaches a terminal state runs in `runTaskDelegation` inside the `"use node"` `dispatchTools.ts` action, not in `task.ts`.
5. **Fold back.** `formatTaskResult(snap, taskId, sessionName)` shapes that snapshot into a `TaskResult` and that becomes the parent's `task` tool result.

The child runs as its **own** durable workflow with its **own** context tree. Only its final answer crosses back — the parent never sees the child's intermediate steps. That isolation is the whole point: the child can burn through a large context, and the parent only pays for the summary it returns.

### How results flow back

`formatTaskResult` is the seam (`convex/engine/task.ts`):

```ts
export interface TaskResult {
  content: { type: "text"; text: string }[];
  details: { taskId: string; session: string; status?: string };
  isError: boolean;
}

export function formatTaskResult(
  snap: { status: string; finalText?: string; error?: string } | null,
  taskId: string,
  sessionName: string,
): TaskResult {
  if (snap?.status === "completed") {
    return {
      content: [{ type: "text", text: snap.finalText ?? "" }],
      details: { taskId, session: sessionName },
      isError: false,
    };
  }
  const status = snap?.status ?? "unknown";
  return {
    content: [{ type: "text", text: `[cove] task did not complete (${snap?.error ?? status}).` }],
    details: { taskId, session: sessionName, status },
    isError: true,
  };
}
```

Key behavior:

- **Success** requires `snap.status === "completed"`. The child's `finalText` (or `""`) becomes the tool result, `isError` is `false`.
- **Any other status** — `failed`, `cancelled`, or `unknown` (when `snap` is `null`) — yields `isError: true` and the text `[cove] task did not complete (<error|status>).`. The model sees the failure and can react.

### The depth cap

Nested delegation is bounded so a runaway agent can't spawn an unbounded tree. The ceiling is `MAX_TASK_DEPTH = 8` (`src/runtime/session-identity.ts`):

```ts
export const MAX_TASK_DEPTH = 8;

export function assertTaskDepth(depth: number, max = MAX_TASK_DEPTH): void {
  if (depth >= max) throw new TaskDepthExceededError(max);   // note: >=, not >
}
```

`createChildRequest` calls `assertTaskDepth(parent.taskDepth + 1)`. Because the check is `>=` and it's evaluated against the *child's* depth:

- A request at `taskDepth` 0..6 can spawn children (child depth 1..7, all `< 8`).
- A request at `taskDepth` **7** trying to spawn a child (depth **8**) is **rejected** with `TaskDepthExceededError`.

So the effective ceiling is **8 levels of nesting**, and you get a clean error rather than silent recursion. The depth is defense-in-depth — most agents never nest more than a level or two.

### Reserved session names

Because delegated children live on `task:<...>` sessions, that namespace is **reserved**. If you let users supply a `sessionName` anywhere (e.g. via the HTTP `sessionName` field or the SDK `harness.session(name)`), validate it first:

```ts
// assertPublicSessionName is NOT re-exported from the @cove/runtime barrel in this cut.
// Import it from the module that defines it. There is no path alias, so use the
// relative .ts path:
import { assertPublicSessionName } from "../src/runtime/session-identity.ts";
// (the in-repo importers — convex/invoke/admit.ts and src/runtime/context.ts —
//  use the relative "./session-identity.ts" path.)

assertPublicSessionName(userSuppliedName);
// throws: '[cove] Session names beginning with "task:" are reserved for delegated tasks.'
```

The admission path already does this (`admitPrompt` rejects `task:*` session names), but if you build your own driver, call it yourself before `getOrCreate`. See [Sessions & Compaction](05-sessions-and-compaction.md#session-addressing-the-instanceid-harnessname-sessionname-tuple) for the addressing model.

### The SDK `session.task()` method (not yet wired)

The authoring facade *declares* `session.task(text, options?)` (with `TaskOptions` carrying `agent`, `cwd`, `result`, `model`, etc.), but in this cut it rejects:

```ts
const harness = await ctx.init(orchestrator);
const session = await harness.session();

// ⚠️ Rejects with CoveError { code: "not_implemented" } today (P6).
await session.task("Summarize the auth module", { agent: "researcher" });
```

Only `session.prompt()` is implemented on the facade. To exercise delegation today, run an agent that *itself* calls the `task` tool (the engine path above), and drive it through `prompt()` or the HTTP/`submitPrompt` admission surfaces from [Invoking Agents](03-invoking-agents.md).

---

## Part 2 — Workflows (`defineWorkflow`)

### What it is

A workflow is a plain TypeScript handler you author for **deterministic, code-orchestrated** runs over agents. You get a `CoveContext`, you call `ctx.init(agent, options?)` to spin up however many harnesses you need, and you return a result. Cove doesn't decide the steps — your code does.

`defineWorkflow` is **Convex-app-bound**: it lives in `convex/workflowRegistry.ts` and you import it from `convex/`, **not** from the `@cove/runtime` barrel. (This is the same import boundary as `defineAgentRegistry` — see [Defining Agents](02-defining-agents.md#the-import-boundary-read-this-first).)

```ts
// convex/workflowRegistry.ts
export type WorkflowHandler<TInput = unknown, TResult = unknown> = (
  ctx: CoveContext,
  input: TInput,
) => TResult | Promise<TResult>;

export function defineWorkflow<TInput = unknown, TResult = unknown>(
  handler: WorkflowHandler<TInput, TResult>,
): WorkflowHandler<TInput, TResult>;
```

`defineWorkflow` just validates that you passed a function (throwing `[cove] defineWorkflow() requires a handler function.` otherwise) and returns it marked as a handler. The real work is the body you write.

### Authoring a workflow

The handler receives a `CoveContext` and your typed `input`. The `CoveContext` exposes `id`, `payload`, `env`, `req`, `log`, and the key method `init(agent, options?): Promise<CoveHarness>`. From there you're back on the familiar `harness.session().prompt(...)` chain:

```ts
// convex/myWorkflows.ts
import { defineWorkflow } from "./workflowRegistry.ts";
import { writer, reviewer } from "./agents.ts"; // each a createAgent(...)

interface ReviewInput { topic: string }
interface ReviewResult { draft: string; verdict: string }

export const draftAndReview = defineWorkflow<ReviewInput, ReviewResult>(
  async (ctx, input) => {
    // Stage 1: a writer agent produces a draft.
    const writerHarness = await ctx.init(writer, { name: "writer" });
    const draft = await writerHarness.session().prompt(
      `Write a short brief on: ${input.topic}`,
      { model: "anthropic/claude-sonnet-4-5" },
    );

    // Stage 2: a reviewer agent critiques it — deterministic ordering, your control flow.
    const reviewHarness = await ctx.init(reviewer, { name: "reviewer" });
    const review = await reviewHarness.session().prompt(
      `Review this draft and give a one-line verdict:\n\n${draft.text}`,
      { model: "anthropic/claude-sonnet-4-5" },
    );

    return { draft: draft.text, verdict: review.text };
  },
);
```

Notes that follow the real contracts:

- **`ctx.init(agent, options?)`** calls `agent.initialize({ id, env, payload })`, derives the harness's `defaultModel` from the resolved profile's `model`, and returns a `CoveHarness`. In this cut the implementation applies **only `options.name`** (the harness name, default `"default"`) — it calls `makeHarness(transport, id, options?.name ?? "default", defaultModel)`. Although the `AgentHarnessOptions` type also declares `options.tools` / `options.skills` / `options.subagents`, those fields are accepted by the type but **not yet wired into** `ctx.init`; they add no extra capabilities today.
- **`prompt()` needs a model.** It resolves `options.model ?? harness defaultModel` and throws `ModelNotConfiguredError` if neither is set. If your agent's profile sets `model: false` (no agent-wide default), every `prompt`/`task` call must pass `options.model`. See [Defining Agents](02-defining-agents.md#model).
- **Inside the workflow, `AgentCreateContext.id` is the workflow run id**, and `payload` is the workflow payload (rather than `undefined`). The agent initializer runs every time you `ctx.init(...)`, so don't stash per-run state expecting a single invocation.
- **Fan-out** is just `Promise.all` over multiple `ctx.init(...).session().prompt(...)` calls — each is an independent harness/session. You own the concurrency.

### Typed results inside a workflow

Each `prompt()` can request validated structured output by passing `options.result` as a valibot schema — the facade re-validates the captured value locally before resolving, so you get `{ data, usage, model }` or a thrown `ResultUnavailableError`, never unvalidated data:

```ts
import * as v from "valibot";

const Verdict = v.object({ pass: v.boolean(), reason: v.string() });

const review = await reviewHarness.session().prompt(
  `Review this draft:\n\n${draft.text}`,
  { model: "anthropic/claude-sonnet-4-5", result: Verdict },
);
// review.data is { pass: boolean; reason: string }, re-validated.
if (!review.data.pass) { /* branch on it deterministically */ }
```

This is the same result-schema contract documented in [Invoking Agents](03-invoking-agents.md#typed-results-with-optionsresult) — it just composes naturally into workflow control flow.

### Registering workflows

A handler isn't reachable until you put it in a `WorkflowRegistry` and install it. `defineWorkflowRegistry` validates a `name -> handler` map and freezes it:

```ts
// convex/workflowRegistry usage
import { defineWorkflowRegistry, registerWorkflowRegistry } from "./workflowRegistry.ts";
import { draftAndReview } from "./myWorkflows.ts";

export const workflows = defineWorkflowRegistry({
  draftAndReview,          // name must match /^[A-Za-z][A-Za-z0-9_-]*$/
});

// Install it into module-scoped active state (re-run per cold boot — see below).
registerWorkflowRegistry(workflows);
```

`defineWorkflowRegistry` throws if the argument isn't a plain object, if any key fails the name regex, or if any value isn't a function. The returned `WorkflowRegistry` is `{ get(name), has(name), readonly names }`. Companion helpers: `getRegisteredWorkflow(name)`, and `resetWorkflowRegistryForTests()` for tests.

> **Cold-boot caveat.** `registerWorkflowRegistry` writes module-scoped state (last-write-wins) and is **not** persisted across cold boots — the generated app entry re-calls it on each boot. Mirror that if you wire registration yourself.

### Driving a workflow over HTTP (stubbed today)

The route `POST /workflows/:name` exists in `convex/http.ts` and resolves against the registered workflow registry — but in this cut it **always returns `404 workflow_not_found`** (via `WorkflowNotFoundError`) until the registry + codegen wiring lands in **P8.5**. The error envelope is real (`{ error: { code: "workflow_not_found", message, status } }`, per `renderHttpError`), so a client will see a well-formed 404, but no workflow actually executes through HTTP yet.

```bash
# Live route, but always 404 until P8.5:
curl -X POST https://<deployment>.convex.site/workflows/draftAndReview \
  -H 'content-type: application/json' \
  -d '{ "topic": "rate limiting" }'
# -> 404 { "error": { "code": "workflow_not_found", ... } }
```

Until then, exercise workflow *handlers* directly as plain functions in unit tests (they're pure relative to an injected `CoveContext` / fake transport), which is the recommended testing approach anyway — Convex functions themselves can't be unit-tested in this repo (see [Deployment & Operations](08-deployment-and-operations.md)).

---

## Putting it together

- Reach for the **`task` tool** when the *agent* should decide to delegate — research fan-out, isolated exploration, "go do this sub-problem and report back". It's automatic, durable, depth-capped at 8, and returns only the child's final answer. Declare any named subagents the agent may target via the `subagents` array.
- Reach for **`defineWorkflow`** when *you* know the pipeline — multi-stage generation/review, deterministic fan-out, branching on typed results. Author it in `convex/`, register it in a `WorkflowRegistry`, and (once P8.5 lands) drive it over `POST /workflows/:name`.

Both build on the same primitives you already know: agents from [Defining Agents](02-defining-agents.md), the `prompt()` chain from [Invoking Agents](03-invoking-agents.md), and the session tree from [Sessions & Compaction](05-sessions-and-compaction.md).
