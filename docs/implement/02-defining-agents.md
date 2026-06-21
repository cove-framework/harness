# Defining Agents

An **agent** in Cove is a function that produces a runtime config. You author one with `createAgent(initialize)`, make it addressable with `defineAgentRegistry({...})`, and either invoke it directly (see [Invoking Agents](03-invoking-agents.md)) or orchestrate several of them from code with `defineWorkflow`.

This page covers every config field you can return from `createAgent`, how to register agents, how to author custom tools, and how to wire code-orchestrated multi-agent runs. If you haven't run a "hello world" yet, start with [Getting Started](01-getting-started.md); for the conceptual map see [Overview & Mental Model](00-overview.md).

## The import boundary (read this first)

Cove has a strict three-layer layout with a one-way dependency rule, and it shows up directly in your imports:

- **Pure runtime** (`src/runtime/...`, the `@cove/runtime` barrel) — `createAgent` and `defineAgentProfile` (plus `defineTool`, `createCoveContext`) and the whole type contract. V8-safe, no Convex, no AI SDK. Note: `extendAgentProfile` is a pure-runtime export too, but it lives only on `src/runtime/agent-definition.ts` — it is **not** surfaced on the `@cove/runtime` barrel.
- **Convex-app-bound** (`convex/...`) — `defineAgentRegistry` / `registerAgentRegistry` (in `convex/agentRegistry.ts`) and `defineWorkflow` / `defineWorkflowRegistry` / `registerWorkflowRegistry` (in `convex/workflowRegistry.ts`). These are **not** on the `@cove/runtime` barrel — import them from `convex/`.

```ts
// Pure runtime — authoring primitives:
import { createAgent, defineAgentProfile, extendAgentProfile } from "../src/runtime/agent-definition.ts";

// Convex-app-bound — registries + workflows:
import { defineAgentRegistry, registerAgentRegistry } from "./agentRegistry.ts";
import { defineWorkflow, defineWorkflowRegistry, registerWorkflowRegistry } from "./workflowRegistry.ts";
```

> Intra-repo imports carry the literal `.ts` extension (tsconfig uses `moduleResolution: "Bundler"` with `allowImportingTsExtensions`). `convex/*` may import `src/runtime/*`, but `src/runtime/*` must **never** import from `convex/`.

## `createAgent()`

```ts
function createAgent<TPayload = unknown, TEnv = Record<string, any>>(
  initialize: (context: AgentCreateContext<TPayload, TEnv>) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): CreatedAgent<TPayload, TEnv>
```

You pass an **initializer** — a function (sync or async) that receives an `AgentCreateContext` and returns an `AgentRuntimeConfig`. `createAgent` returns an opaque, frozen `CreatedAgent` carrying the `__coveCreatedAgent: true` brand. That brand is what `defineAgentRegistry` and `ctx.init()` check.

```ts
import { createAgent } from "../src/runtime/agent-definition.ts";

export const helloAgent = createAgent(() => ({
  model: "anthropic/claude-haiku-4-5",
  description: "A minimal greeter.",
  instructions: "You are a friendly assistant. Greet the user and keep it short.",
}));
```

Two things that trip people up:

- **The initializer runs every time** the runtime initializes a harness from this agent — it is **not** a one-time constructor. Do not stash a persistent instance id in a closure assuming single invocation.
- If `initialize` is not a function, `createAgent` throws `'[cove] createAgent() requires an initializer function.'`.

### `AgentCreateContext` — what the initializer receives

```ts
interface AgentCreateContext<TPayload = unknown, TEnv = Record<string, any>> {
  readonly id: string;                 // agent instance id, or workflow run id when via ctx.init()
  readonly env: TEnv;                  // platform env bindings
  readonly payload: TPayload | undefined;  // workflow payload via ctx.init(); otherwise undefined
}
```

Use it to make the config depend on the invocation. For example, vary instructions by an env binding or a workflow payload:

```ts
interface BriefPayload { topic: string }

export const researcher = createAgent<BriefPayload>(({ payload }) => ({
  model: "anthropic/claude-sonnet-4-5",
  instructions: payload?.topic
    ? `Research the topic: ${payload.topic}. Be concise and cite sources.`
    : "Research the user's request. Be concise and cite sources.",
}));
```

`payload` is only populated when the agent is initialized via a workflow's `ctx.init()`; for direct/HTTP invocation it is `undefined`.

### `AgentRuntimeConfig` — the returned config

The object your initializer returns. Allowed top-level fields are **exactly**:

```ts
interface AgentRuntimeConfig {
  profile?: AgentProfile;
  description?: string;
  model?: ModelConfig;               // 'provider-id/model-id' | false
  instructions?: string;
  skills?: Skill[];
  tools?: ToolDefinition[];
  subagents?: AgentProfile[];
  thinkingLevel?: ThinkingLevel;
  compaction?: false | CompactionConfig;
  durability?: DurabilityConfig;
  cwd?: string;
  sandbox?: SandboxFactory;
}
```

Validation is **strict and lazy** (it runs when the runtime initializes the agent):

- A non-object, an array, or `null` throws `'[cove] createAgent() initializer must return an agent runtime config object.'`.
- **Any unknown top-level field** throws `'[cove] createAgent() initializer returned unknown runtime config field "<key>"'`.

Two fields that are deliberately **absent**, and a common source of confusion:

- **No top-level `name`.** A created agent is addressed by its **registry key**, so there is nothing for a config-level `name` to control. `name` exists only on `AgentProfile` (and is required there only to select a profile as a subagent).
- **No `systemPrompt`.** Authors set `instructions`. The final system prompt is composed internally at setup from your `instructions` plus the resolved skill catalog. (`AgentConfig.systemPrompt` exists in the types but is internal-only — do not put it in a config or profile.)

The rest of this section walks each field.

## `model`

```ts
type ModelConfig = string | false;
```

A model specifier is the `'provider-id/model-id'` string form, e.g. `"anthropic/claude-sonnet-4-5"` or `"openai/gpt-4o"`. It becomes the agent-wide default model.

`false` means **"no agent-wide default"** — every model-using call (`prompt` / `skill` / `task`) must then pass a call-level `options.model`, or it errors. Use this when the model is always chosen at the call site.

```ts
// Hardcoded default:
createAgent(() => ({ model: "anthropic/claude-sonnet-4-5" }));

// Caller must choose the model on every call:
createAgent(() => ({ model: false }));
```

> For free, deterministic, no-credential dev/CI runs, use the reserved test model `"cove-test/mock"`. It resolves to an in-process mock — no provider, no API key — and returns byte-stable text `"cove mock response"`. See [Deployment & Operations](08-deployment-and-operations.md).

How the default flows through invocation: `ctx.init(agent)` derives the harness `defaultModel` from the resolved `profile.model` (only when it is a string), and `prompt()` resolves the model as `options.model ?? harness defaultModel`. If neither is set, it throws `ModelNotConfiguredError`. In the response, `PromptModel` is parsed by splitting the model string on the first `/`: `"anthropic/claude-x"` → `{ provider: "anthropic", id: "claude-x" }`; a string with no `/` yields `{ provider: "", id: model }`.

## `instructions`

A plain string prepended ahead of the resolved skill/workspace context to form the system prompt. This is your only knob for the agent's persona/behavior text — there is no `systemPrompt` field.

```ts
createAgent(() => ({
  model: "anthropic/claude-sonnet-4-5",
  instructions: [
    "You are a release-notes assistant.",
    "Summarize merged PRs into a changelog grouped by Added / Changed / Fixed.",
    "Be terse; no marketing language.",
  ].join("\n"),
}));
```

## `tools` — custom tools

Each entry is a `ToolDefinition` describing a model-callable tool. See [Authoring custom tools](#authoring-custom-tools) below for the full shape and examples. Built-in framework tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`, plus `task` and conditionally `activate_skill`/result tools) are baked in by the engine — you do **not** register those; see [Tools, Skills & Human-in-the-Loop](04-tools-skills-hitl.md).

## `subagents` — named profiles for delegation

`subagents` is an array of `AgentProfile` objects. The model selects one at call time via the `task` tool (and, once implemented, `session.task({ agent })`). A subagent must have a `name` (matching `/^[A-Za-z][A-Za-z0-9_-]*$/`), and:

- **Subagents may not declare `durability`** — it throws. Delegated task sessions run inside the parent operation; configure durability on the created agent instead.
- Subagents may not be circular, and names must be unique within the list.

```ts
import { createAgent, defineAgentProfile } from "../src/runtime/agent-definition.ts";

const reviewer = defineAgentProfile({
  name: "reviewer",
  description: "Reviews a diff for correctness bugs.",
  model: "anthropic/claude-sonnet-4-5",
  instructions: "Review the provided diff. List concrete bugs only.",
});

export const lead = createAgent(() => ({
  model: "anthropic/claude-sonnet-4-5",
  instructions: "Coordinate the work; delegate code review to the reviewer subagent.",
  subagents: [reviewer],
}));
```

For the depth limit, child-session naming, and how delegation results are shaped, see [Subagents & Workflows](06-subagents-and-workflows.md).

## `thinkingLevel`

```ts
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
```

The agent-wide default reasoning effort; per-call `options.thinkingLevel` overrides it. Anything outside the valid set throws `'[cove] <label> thinkingLevel must be one of: off, minimal, low, medium, high, xhigh.'`.

```ts
createAgent(() => ({ model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" }));
```

## `compaction`

Controls automatic conversation compaction. Accepts `false` or a `CompactionConfig`:

```ts
interface CompactionConfig {
  reserveTokens?: number;     // non-negative integer; model-aware default capped at 20000
  keepRecentTokens?: number;  // non-negative integer; default 8000
  model?: string;             // 'provider-id/model-id'; defaults to the session's model
}
```

- `false` **disables threshold compaction**, but overflow recovery and an explicit `session.compact()` still run.
- A `CompactionConfig` object overrides individual fields. **Only** `reserveTokens`, `keepRecentTokens`, and `model` are allowed — any other key throws `'compaction received unknown field'`. `reserveTokens`/`keepRecentTokens` must be non-negative integers; `model` must be a string.

```ts
createAgent(() => ({
  model: "anthropic/claude-sonnet-4-5",
  compaction: { reserveTokens: 16000, keepRecentTokens: 12000, model: "anthropic/claude-haiku-4-5" },
}));

// Or turn off threshold compaction entirely:
createAgent(() => ({ model: "anthropic/claude-sonnet-4-5", compaction: false }));
```

Compaction mechanics (the boundary, the summary, how it's served back into context) are covered in [Sessions & Compaction](05-sessions-and-compaction.md).

## `durability`

```ts
interface DurabilityConfig {
  maxAttempts?: number;   // positive integer; default 10
  timeoutMs?: number;     // positive integer; default 3,600,000 (1h)
  maxSteps?: number;      // resolved at setup — NOT author-supplied here
  maxFollowUps?: number;  // resolved at setup — NOT author-supplied here
}
```

**Validation gotcha:** even though the TypeScript interface declares `maxSteps` and `maxFollowUps`, the runtime validator `assertDurability` permits **only** `maxAttempts` and `timeoutMs`. Passing `maxSteps` or `maxFollowUps` throws `'[cove] <label> durability received unknown field "<key>"'`. Those two are resolved at setup time (defaults `maxSteps` 100, `maxFollowUps` 32), not supplied by you here. `maxAttempts` and `timeoutMs` must be positive integers.

```ts
createAgent(() => ({
  model: "anthropic/claude-sonnet-4-5",
  durability: { maxAttempts: 5, timeoutMs: 600_000 }, // 5 attempts, 10-minute cap
}));
```

Set `durability` on the created agent (or its base profile) — **not** on a subagent profile (subagents throw on `durability`).

## `cwd` and `sandbox`

`cwd` sets the working directory inside the initialized sandbox; `sandbox` is a `SandboxFactory` that constructs the session environment (wrapping an external sandbox into Cove's `SessionEnv`). These are advanced fields tied to the sandbox/sandboxed-tool layer and are not needed for SDK or mock-model runs.

## Reusable profiles: `profile`, `defineAgentProfile`, `extendAgentProfile`

To factor out reusable behavior, build an `AgentProfile` and use it either as a baseline (`AgentRuntimeConfig.profile`) or as a named subagent.

```ts
function defineAgentProfile(profile: AgentProfile): AgentProfile
```

`defineAgentProfile` validates and returns a profile. It throws on unknown fields, invalid capabilities, duplicate capability names, or circular subagents. `AgentProfile` mirrors the runtime config but adds `name` and **omits** `cwd`/`sandbox`/`profile`:

```ts
interface AgentProfile {
  name?: string;          // required to select this profile via task({ agent }); matches /^[A-Za-z][A-Za-z0-9_-]*$/
  description?: string;   // must be non-empty if present
  model?: ModelConfig;
  instructions?: string;
  skills?: Skill[];
  tools?: ToolDefinition[];
  subagents?: AgentProfile[];
  thinkingLevel?: ThinkingLevel;
  compaction?: false | CompactionConfig;
  durability?: DurabilityConfig;
}
```

Profile validation is strict (a valibot `strictObject`): unknown fields throw `'received unknown agent profile field <field>'`; tools/skills/subagents names must each be unique within their list.

### Using a profile as a baseline

When a created-agent config carries a `profile`, the two are **merged** with these rules:

- **Scalar fields** (`model`, `instructions`, `description`, `thinkingLevel`, `compaction`, `durability`) — the config value **replaces** the profile value when the config sets that own property.
- **Array fields** (`skills`, `tools`, `subagents`) — **concatenated**, base profile first, then config additions. (Duplicate names across the merge will fail uniqueness validation downstream, so keep names distinct.)

```ts
const base = defineAgentProfile({
  name: "base",
  model: "anthropic/claude-sonnet-4-5",
  instructions: "Be concise.",
  tools: [searchTool],
});

export const specialized = createAgent(() => ({
  profile: base,
  instructions: "Be concise, and always cite sources.", // replaces base.instructions
  tools: [fetchTool],                                    // concatenated -> [searchTool, fetchTool]
}));
```

### Extending a profile's capabilities

```ts
function extendAgentProfile(
  profile: AgentProfile,
  extensions: Pick<AgentProfile, "skills" | "tools" | "subagents">,
): AgentProfile
```

`extendAgentProfile` returns a **new** profile with `skills`/`tools`/`subagents` merged (base first, then extensions). It does **not** re-validate, so feed it already-valid inputs.

```ts
const withExtraTools = extendAgentProfile(base, { tools: [fetchTool] });
```

## Authoring custom tools

A custom tool is a `ToolDefinition`:

```ts
interface ToolDefinition<TParams extends ToolParameters = ToolParameters> {
  name: string;        // unique across built-in and custom tools
  description: string; // non-empty; tells the model when/how to use it
  parameters: TParams; // a valibot object schema OR a raw JSON Schema object
  execute: (args: ToolArgs<TParams>, signal?: AbortSignal) => Promise<string>;
}
```

All four fields are required and validated at agent-profile/config validation time:

- `name` and `description` must be non-empty strings; `name` must be unique across all tools (built-in + custom).
- `parameters` is required and must be an object.
- `execute` must be a function returning `Promise<string>` — its return string is sent back to the model. **Thrown errors become tool errors** delivered to the model, so throw with a useful message.

### Typed parameters with valibot (recommended)

```ts
type ToolParameters = v.GenericSchema | object;
type ToolArgs<TParams> = [TParams] extends [v.GenericSchema] ? v.InferOutput<TParams> : Record<string, any>;
```

When `parameters` is a valibot `v.object({...})` schema, `args` in `execute` is **typed** as the schema's inferred output:

```ts
import * as v from "valibot";
import type { ToolDefinition } from "../src/runtime/tool-types.ts";

const getWeather: ToolDefinition = {
  name: "get_weather",
  description: "Look up the current weather for a city. Use when the user asks about weather.",
  parameters: v.object({
    city: v.string(),
    units: v.optional(v.picklist(["metric", "imperial"]), "metric"),
  }),
  async execute(args, signal) {
    // args is typed: { city: string; units: "metric" | "imperial" }
    const res = await fetch(`https://example.com/weather?q=${encodeURIComponent(args.city)}`, { signal });
    const data = await res.json();
    return `It is ${data.temp}° (${args.units}) in ${args.city}.`;
  },
};
```

The optional `signal: AbortSignal` lets you cancel in-flight work (e.g. pass it to `fetch`) when the call is aborted.

### Raw JSON Schema parameters (interop escape hatch)

If you already have a JSON Schema document — e.g. from an MCP adapter or a TypeBox schema (structurally JSON Schema) — pass it directly as `parameters`. The args type then degrades to `Record<string, any>`:

```ts
const mcpTool: ToolDefinition = {
  name: "search_docs",
  description: "Search the docs index.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(args) {
    // args is Record<string, any>
    return await searchIndex(String(args.query));
  },
};
```

### Attaching tools to an agent

Tools live in the `tools` array of a profile, a runtime config, or — for a workflow-initialized harness — `AgentHarnessOptions.tools`:

```ts
export const weatherAgent = createAgent(() => ({
  model: "anthropic/claude-sonnet-4-5",
  instructions: "Answer weather questions. Use the get_weather tool.",
  tools: [getWeather],
}));
```

## Registering agents with `defineAgentRegistry`

Convex has no filesystem-module addressing for agents, so you register an explicit **name → `createAgent()`** map. This is Convex-app-bound — import it from `convex/agentRegistry.ts`.

```ts
function defineAgentRegistry(map: Record<string, CreatedAgent>): AgentRegistry
```

```ts
// convex/agents.ts
import { createAgent } from "../src/runtime/agent-definition.ts";
import { defineAgentRegistry, registerAgentRegistry } from "./agentRegistry.ts";

export const helloAgent = createAgent(() => ({
  model: "cove-test/mock",
  instructions: "Greet the user.",
}));

export const registry = defineAgentRegistry({
  hello: helloAgent,
  weather: weatherAgent,
});

// Install the registry into module-scoped active state so setup can resolve by name.
// The generated app entry re-installs this on each cold boot.
registerAgentRegistry(registry);
```

Validation is load-bearing (there is no filesystem to guard names):

- The argument must be a plain object (not an array).
- Each key must match `/^[A-Za-z][A-Za-z0-9_-]*$/` (and keys are unique by object-key semantics) — otherwise it throws `'[cove] defineAgentRegistry: agent name "<name>" must start with a letter and contain only letters, numbers, "_", or "-".'`.
- Each value must carry `__coveCreatedAgent === true` (i.e. be a real `createAgent()` result) — otherwise `'[cove] defineAgentRegistry: "<name>" is not a createAgent() value.'`.

The returned `AgentRegistry` exposes:

```ts
interface AgentRegistry {
  get(name: string): CreatedAgent | undefined;
  has(name: string): boolean;
  listAgents(): AgentManifestEntry[]; // AgentManifestEntry = { name: string }
  readonly names: readonly string[];
}
```

`registerAgentRegistry(registry)` installs the active registry (companions: `getRegisteredAgent(name)`, `listRegisteredAgents()`, `resetAgentRegistryForTests()`). After adding or changing agents, redeploy so the functions are bundled and callable:

```bash
node node_modules/convex/bin/main.js dev --once
```

The registry name is what HTTP callers use as `:name` in `POST /agents/:name/:id`. See [Invoking Agents](03-invoking-agents.md) for the call surfaces.

## Code-orchestrated runs with `defineWorkflow`

A **workflow** is a handler you write that orchestrates one or more agents in code. It is Convex-app-bound — import from `convex/workflowRegistry.ts`.

```ts
type WorkflowHandler<TInput = unknown, TResult = unknown> =
  (ctx: CoveContext, input: TInput) => TResult | Promise<TResult>;

function defineWorkflow<TInput, TResult>(handler: WorkflowHandler<TInput, TResult>): WorkflowHandler<TInput, TResult>;
```

`defineWorkflow` just marks a function as a workflow handler (it throws `'[cove] defineWorkflow() requires a handler function.'` if not callable). The handler receives a `CoveContext` and your input, and returns a result.

`CoveContext` gives you `id`, `payload`, `env`, `req: Request | undefined`, `log: CoveLogger`, and the key method:

```ts
init(agent: CreatedAgent, options?: AgentHarnessOptions): Promise<CoveHarness>
```

`ctx.init(agent, options?)` spins up a harness for this invocation (it calls the agent's `initialize` with `{ id, env, payload }`). `AgentHarnessOptions` lets you name the harness and add extra capabilities to its sessions:

```ts
interface AgentHarnessOptions {
  name?: string;             // harness name; defaults to 'default'
  tools?: ToolDefinition[];  // additional tools for the initialized sessions
  skills?: Skill[];          // additional skills
  subagents?: AgentProfile[];// additional named subagent profiles
}
```

A workflow that drives an agent and returns its text:

```ts
// convex/workflows.ts
import { defineWorkflow, defineWorkflowRegistry, registerWorkflowRegistry } from "./workflowRegistry.ts";
import { researcher } from "./agents.ts";

interface ResearchInput { topic: string }

export const research = defineWorkflow<ResearchInput, { summary: string }>(async (ctx, input) => {
  ctx.log.info("research workflow start", { topic: input.topic });

  const harness = await ctx.init(researcher);          // resolves the agent's default model
  const session = await harness.session();             // sessionName defaults to "default"
  const { text } = await session.prompt(`Research: ${input.topic}`);

  return { summary: text };
});
```

Multi-agent orchestration is just calling `ctx.init` more than once (one harness per name) and stitching results in plain code:

```ts
export const reviewAndSummarize = defineWorkflow(async (ctx, input: { diff: string }) => {
  const reviewerHarness = await ctx.init(reviewerAgent, { name: "reviewer" });
  const writerHarness = await ctx.init(writerAgent, { name: "writer" });

  const review = await (await reviewerHarness.session()).prompt(`Review this diff:\n${input.diff}`);
  const notes = await (await writerHarness.session()).prompt(`Turn this review into release notes:\n${review.text}`);

  return { review: review.text, releaseNotes: notes.text };
});
```

### Registering workflows

```ts
function defineWorkflowRegistry(map: Record<string, WorkflowHandler>): WorkflowRegistry
```

```ts
export const workflows = defineWorkflowRegistry({
  research,
  reviewAndSummarize,
});

registerWorkflowRegistry(workflows);
```

Validation mirrors the agent registry: the argument must be a plain object, each key must match `/^[A-Za-z][A-Za-z0-9_-]*$/`, and each value must be a function. The returned `WorkflowRegistry` exposes `get(name)`, `has(name)`, and `readonly names`. `registerWorkflowRegistry` installs the active registry (companions: `getRegisteredWorkflow(name)`, `resetWorkflowRegistryForTests()`).

> **Documented gap:** the HTTP route `POST /workflows/:name` resolves against the registered workflow registry, but in the current cut it always returns `404 workflow_not_found` (the codegen that wires it lands in P8.5). Author and register workflows now; just don't rely on driving them over HTTP yet. Deeper coverage is in [Subagents & Workflows](06-subagents-and-workflows.md).

## What's wired vs. deferred

This is an early scaffold; a few authoring-adjacent surfaces aren't fully wired yet:

- Through the SDK facade, **only `session.prompt()` is implemented**. `session.skill(...)`, `session.task(...)`, `session.shell(...)`, `session.fs`, `session.compact()`, `harness.shell(...)`, and `harness.fs` currently reject with a `CoveError` whose code is `'not_implemented'`. (You can still **declare** `subagents`, `tools`, and `compaction` on your agents — those are validated and stored; the call-site surfaces are what's pending.)
- `POST /workflows/:name` is a live route that currently returns `404 workflow_not_found`.

These gaps are called out in the relevant guides rather than implied to exist.

## Next steps

- [Invoking Agents](03-invoking-agents.md) — the SDK chain, HTTP routes, and `dev:startPrompt`.
- [Tools, Skills & Human-in-the-Loop](04-tools-skills-hitl.md) — built-in tools, the skills catalog, and approvals.
- [Sessions & Compaction](05-sessions-and-compaction.md) — the `(instanceId, harnessName, sessionName)` key and compaction internals.
- [Subagents & Workflows](06-subagents-and-workflows.md) — delegation depth limits and code-orchestrated runs in depth.
- [Deployment & Operations](08-deployment-and-operations.md) — env layout, the one-way dependency rule, and the `cove-test/mock` model.
