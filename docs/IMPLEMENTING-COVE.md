# Cove Implementation Handbook

A comprehensive guide for engineers at other projects who want to **use**, **package**, or **understand** Cove — the Convex-native agent-harness framework published as `@cove-framework/cove`.

## Who this is for & how to read it

- **Building an agent on Cove?** Read §1 (Overview & Quick Start), then §2 (Adoption Guide).
- **Shipping your own Convex-native framework as a downloadable package?** Read §3 (Packaging Playbook) — it generalizes Cove's two-half distribution model into a reusable recipe.
- **Contributing to, or integrating deeply with, Cove?** Read §4 (Architecture Deep-Dive).

> Every API signature, file path, CLI command, flag, and config value below was extracted from and fact-checked against the Cove source. Where the type system and the runtime validator disagree, or a feature is partial, the text says so explicitly rather than papering over it.

## Table of Contents

1. [Overview & Quick Start](#1-overview--quick-start)
2. [Adoption Guide — Building on Cove](#2-adoption-guide--building-on-cove)
3. [Packaging Playbook — Shipping a Convex-Native Framework](#3-packaging-playbook--shipping-a-convex-native-framework)
4. [Architecture Deep-Dive](#4-architecture-deep-dive)


---

## 1. Overview & Quick Start

### What Cove is

Cove is a Convex-native agent-harness framework, published as the npm package `@cove-framework/cove`. It gives you a durable, crash-recoverable agent backend that runs on your own Convex deployment: you author agents and workflows as plain TypeScript registries, and Cove's CLI validates them and generates the wiring that exposes them over HTTP. The portable, V8-safe core (`createAgent`, `defineTool`, types) preserves the same public interface flue exposed; the engine underneath is Convex-native — Convex DB is the system-of-record and realtime transport (clients subscribe to reactive queries, no SSE), `@convex-dev/workflow` runs the agent loop durably, and the AI SDK gateway handles multi-provider LLM calls.

#### The problem it solves

Building an agent backend usually means hand-rolling durability (so a crashed run can resume), realtime streaming to a frontend, multi-provider model routing, and the HTTP plumbing that ties prompts to runs. Cove collapses that into two artifacts you author — `convex/agentRegistry.ts` and `convex/workflowRegistry.ts` — and a CLI that does the rest: it loads and validates those registries, emits byte-stable resolver code, and patches your `convex/http.ts` to bind the routes. Everything runs on your own Convex deployment, so you own the data and the functions.

### The two-half distribution model

Cove ships as **two coupled halves**, and understanding why is the key to everything else.

- **Half A — the published npm package** `@cove-framework/cove`. This is a `tsup`-built `dist/` exposing four subpath surfaces plus the `cove` CLI binary. You `npm install` it like any library.
  - `@cove-framework/cove/runtime` — the V8-safe core (`createAgent`, `defineTool`, types).
  - `@cove-framework/cove/sdk` — the Convex-native consumer client (`createCoveReactiveClient`, no SSE).
  - `@cove-framework/cove/react` — `CoveProvider` + hooks (`useAgentPrompt`, `useCoveRun`, …).
  - `@cove-framework/cove/cli` — `defineCoveConfig` + programmatic build/codegen entry points (this is what your `cove.config.ts` imports from).
- **Half B — the vendored Convex backend.** The `convex/` engine tree and the `src/runtime/` core are copied *into your project* by `cove init`. You own these files and deploy them.

#### Why a vendored backend instead of an ordinary import

A Convex backend **cannot be an ordinary npm import**: Convex deploys functions only from the consumer's *own* `convex/` directory. Code that lives inside `node_modules/@cove-framework/cove/convex/` would never be deployed. So the published tarball ships `convex/` and `src/runtime/` **as source** (the `files` allowlist in `package.json` includes them, while excluding tests, sourcemaps, `convex/_generated/`, and `convex/_cove/`), and `cove init` **vendors** those two trees into your new project. `tsup` deliberately does *not* build `convex/**` — it is source, not a compiled artifact.

The practical consequence: after `cove init`, the backend is *your* code. You edit `convex/agentRegistry.ts` and `convex/workflowRegistry.ts`; you treat the vendored `src/runtime/` core as read-only; and the CLI keeps the generated glue (`convex/_cove/`) and `convex/http.ts` in sync with what you've declared.

### The high-level mental model

```
@cove-framework/cove (npm)
        │  npm install  →  CLI + client surfaces (runtime/sdk/react/cli)
        │  npx cove init →  VENDORS convex/ + src/runtime/ into your project
        ▼
your-project/
  convex/                      ← you own this; it deploys to Convex
    agentRegistry.ts           ← you author:  export const registry  = defineAgentRegistry({...})
    workflowRegistry.ts        ← you author:  export const workflows = defineWorkflowRegistry({...})
    http.ts                    ← cove patches the POST /workflows/:name route + installs seams
    _cove/                     ← GENERATED resolvers (do not edit)
      agentResolver.ts
      workflowResolver.ts
    _generated/                ← Convex's own codegen (regenerated by `convex dev`)
  src/runtime/                 ← vendored V8-safe core (do not edit)
  cove.config.ts               ← { convexDir: "convex" }
```

The CLI's loop, regardless of which command you run, is:

1. **Resolve config** — find and load `cove.config.ts` (`root`, `convexDir`, `skills`).
2. **Load + validate registries** — import `convex/agentRegistry.ts` and `convex/workflowRegistry.ts` inside a short-lived isolated `tsx` child (so live Convex module globals never leak into the CLI process), validating each registry where the live objects exist.
3. **Codegen** — emit two pure, byte-stable resolver files (`convex/_cove/agentResolver.ts`, `convex/_cove/workflowResolver.ts`) and patch `convex/http.ts` to install the registry seams and bind `POST /workflows/:name`. Codegen is content-compared — a no-op rebuild writes zero files, so `convex dev`'s watcher doesn't churn.

The three top-level commands layer on top of that loop:

- **`cove build`** — runs the loop, optionally packages skills (only when `skills` is set), then gates on `tsc --noEmit`.
- **`cove dev`** — runs codegen once (skipping `tsc`, since `convex dev` type-checks itself), spawns `npx convex dev`, and re-codegens on a 150 ms-debounced watcher over `cove.config.*` plus the two registry files.
- **`cove deploy`** — **fail-closed**: runs the full `build` first (including `tsc`) and only spawns `npx convex deploy` if build succeeds. There is **no standalone `codegen` command** — codegen is a build step.

### Prerequisites

| Requirement | Detail |
| --- | --- |
| **Node.js** | `>=22.18` (the package's `engines.node`). The CLI launcher also accepts `>=23.6`, but **rejects Node 23.0–23.5** — those versions lack default TypeScript type-stripping, which Cove relies on. The human-readable label is `">=22.18 or >=23.6"`. |
| **Convex** | A Convex account and a deployment. `npx convex dev` links/creates one; `cove dev`/`deploy` spawn the Convex CLI under the hood. |
| **AI gateway key** | An `AI_GATEWAY_API_KEY` set in the **Convex deployment env** (`npx convex env set …`), *not* in the CLI/process env. Provider keys and auth secrets live in the deployment, not in your local `.env`. |

> Cove is ESM-only (`"type": "module"`). The `cove` CLI command runs even on a fresh install because the bin is a plain-JS launcher (`bin/cove.mjs`) that gates the Node version, then runs the compiled CLI (`dist/bin/cove.js`) on your Node — no `tsx` needed in a published install.

### 5-minute Quick Start

```bash
# 1. Install the CLI + client surfaces.
npm install @cove-framework/cove

# 2. Scaffold a project (vendors the backend you own + an example "assistant" agent).
npx cove init my-agent

# 3. Install the scaffolded project's dependencies.
cd my-agent
npm install

# 4. Link a Convex deployment (creates convex/_generated/ and prompts for login).
npx convex dev

# 5. Set your AI gateway key on the Convex DEPLOYMENT (not a local .env).
npx convex env set AI_GATEWAY_API_KEY <your-key>

# 6. Run cove dev: initial codegen + validation, then `convex dev` with a re-codegen watcher.
npm run dev
```

`npx cove init my-agent` scaffolds into `my-agent/` (refusing a non-empty directory unless you pass `--force`). It vendors `convex/` and `src/runtime/`, appends a starter agent registry, regenerates `convex/_cove/`, and writes the project files. The generated `cove.config.ts` is minimal:

```ts
import { defineCoveConfig } from "@cove-framework/cove/cli";

// Cove project configuration. `cove dev`/`build`/`deploy` read this.
export default defineCoveConfig({
	convexDir: "convex",
});
```

The generated `package.json` wires the project scripts to the CLI:

```json
{
  "scripts": {
    "dev": "cove dev",
    "build": "cove build",
    "deploy": "cove deploy",
    "convex": "convex dev"
  }
}
```

The starter `convex/agentRegistry.ts` ships one agent named `assistant`:

```ts
export const registry = defineAgentRegistry({
  assistant: createAgent(() => ({
    model: "anthropic/claude-sonnet-4-6",
    instructions: "You are a helpful assistant scaffolded by `cove init`.",
  })),
});
```

#### Your first prompt

Once `npm run dev` is up (codegen passed, `convex dev` running), call the agent over HTTP. The route is `POST /agents/:name/:id` — `:name` is the registry key (`assistant`) and `:id` is a caller-chosen **instance id** (a stable string that addresses one conversation/instance of the agent; it's passed through as `instanceId`). `$CONVEX_SITE_URL` is your deployment's HTTP URL:

```bash
curl -X POST "$CONVEX_SITE_URL/agents/assistant/my-first-chat" \
  -H "Content-Type: application/json" \
  -d '{ "message": "Hello, Cove!" }'
```

The JSON body field is `message` (with `prompt` accepted as a fallback alias), plus optional `model`, `sessionName` (defaults to `"default"`), and `result`/`resultSchema` for structured output. The immediate response is:

```json
{ "sessionId": "...", "requestId": "...", "submissionId": "..." }
```

Append `?wait=result` to block until the run reaches a terminal state and merge the request snapshot into the response; otherwise the call returns immediately and you subscribe to the result reactively via the SDK. The route runs Cove's pluggable auth seam (`runAuthorize`) before admitting the prompt, so a configured auth provider can reject the request.

To set the model, edit the agent in `convex/agentRegistry.ts` — the model is a `"provider-id/model-id"` string returned from `createAgent(() => ({ model: "…" }))`. To add another agent, add a key to the same `defineAgentRegistry({...})` object; the watcher re-runs codegen and exposes it at `POST /agents/<key>/:id`.

### When to use Cove

Reach for Cove when:

- You want a **durable, crash-recoverable agent backend** without hand-building the workflow engine, and you're comfortable on **Convex** as your system-of-record and realtime transport.
- You want **reactive, no-SSE** streaming to a frontend (subscribe to Convex queries via `@cove-framework/cove/react` / `@cove-framework/cove/sdk`).
- You author agents/workflows as **typed registries** and want the HTTP wiring, validation, and codegen handled for you — with a fail-closed deploy path.
- You're on **Node `>=22.18` (or `>=23.6`)** and can run an ESM-only toolchain.

It's a less natural fit if you don't want to adopt Convex as your backend, or you need a runtime you import as a plain library rather than one you own and deploy — the vendored-backend model is intrinsic to how Convex deploys functions.

---

## 2. Adoption Guide — Building on Cove

### 2.1 Prerequisites and install

Cove requires **Node `>=22.18`** (Node `23.0`–`23.5` is explicitly rejected — those versions lack default TypeScript type-stripping; use `>=23.6` if on the 23 line). The `cove` bin enforces this at launch and exits `1` with a `"Node.js v<v> is not supported by Cove..."` message otherwise.

```bash
# scaffold into the current directory (or pass a dir)
npx @cove-framework/cove init my-agent
cd my-agent
npm install
```

`init` does **not** read any `.env` and does **not** install dependencies — it only writes files. The generated `package.json` already declares `@cove-framework/cove` plus every dependency the vendored backend needs (`convex`, `ai`, the `@ai-sdk/*` providers, `@convex-dev/workflow`, etc.), so `npm install` is the next step.

### 2.2 The project layout produced by `init`

`cove init` exists because of a structural constraint: **Convex deploys functions only from the consumer's own `convex/` directory**, so the backend cannot be a normal npm import. `init` therefore *vendors* two source trees — `convex/` (the engine + authoring surface) and `src/runtime/` (the V8-safe pure core) — into your project. They are copied from the published tarball, which ships them as source.

```
my-agent/
  convex/                      # vendored, USER-OWNED — this is what deploys to Convex
    agentRegistry.ts           # vendored + a starter `export const registry` appended
    workflowRegistry.ts        # vendored + a starter `export const workflows` appended
    http.ts                    # the HTTP submit/poll surface (patched by build to install seams)
    schema.ts, auth.ts, convex.config.ts, dev.ts, requests.ts, runs.ts, steps.ts, skills.ts, workflow.ts
    _cove/                     # GENERATED (not copied) — registry resolver sidecars
      agentResolver.ts
      workflowResolver.ts
    engine/ events/ invoke/ mcp/ observability/ providers/ sandbox/ sessions/ channels/   # vendored subtrees
    # _generated/ is created by `npx convex dev`; __tests__/ are not copied
  src/runtime/                 # vendored, V8-safe pure core — DO NOT EDIT
    index.ts, agent-definition.ts, types.ts, tool.ts, http.ts, context.ts, errors.ts, ...
  cove.config.ts               # generated
  package.json                 # generated
  tsconfig.json                # generated
  .gitignore                   # generated
  .env.example                 # generated
  README.md                    # generated
```

Two practical rules fall out of this:

- **You own and edit `convex/agentRegistry.ts`, `convex/workflowRegistry.ts`, and your own files under `convex/` and `src/`.** You generally do not edit `src/runtime/` (the pure core) or `convex/_cove/` (codegen output — overwritten on every build).
- The vendoring filter drops `_generated`, `_cove`, `__tests__`, `.DS_Store`, and `*.test.ts`. The `_cove/` resolvers you get are **freshly generated** from the starter registries, not copied demo files.

The generated `package.json` wires the lifecycle scripts to the CLI:

```jsonc
{
  "type": "module",
  "scripts": {
    "dev": "cove dev",
    "build": "cove build",
    "deploy": "cove deploy",
    "convex": "convex dev"
  }
}
```

The generated `tsconfig.json` is tuned for this layout: `moduleResolution: "Bundler"`, `allowImportingTsExtensions: true`, `verbatimModuleSyntax: true`, `noEmit: true`, `isolatedModules: true`, `strict: true`. This is why imports across vendored files carry explicit `.ts` extensions (e.g. `from "../src/runtime/agent-definition.ts"`).

> Note: secrets do not live in `.env`. The generated `.env.example` is comments only — provider keys and auth secrets belong in the **Convex deployment env** (`npx convex env set ...`), not in any CLI-loaded file. See §2.7.

### 2.3 Defining an agent with `createAgent`

Agents are authored against the pure runtime, imported from the `@cove-framework/cove/runtime` subpath (there is **no root export**).

`createAgent` takes an **initializer function**, not a config object:

```ts
export function createAgent<TPayload = unknown, TEnv = Record<string, any>>(
  initialize: (
    context: AgentCreateContext<TPayload, TEnv>,
  ) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): CreatedAgent<TPayload, TEnv>
```

Key semantics:

- The initializer **runs every time** the runtime builds a harness from this agent — it is not a one-time constructor. Use it to read per-run context.
- `AgentCreateContext` is `{ readonly id: string; readonly env: TEnv; readonly payload: TPayload | undefined }`. `id` is the agent-instance id (or the workflow run id when used via `ctx.init()`).
- It must return an `AgentRuntimeConfig`. The model is a `'<provider>/<model>'` string, or `false` to force call-level model selection, or carried on a `profile`.
- `createAgent` throws `"[cove] createAgent() requires an initializer function."` if you pass a non-function. It returns a frozen branded object (`__coveCreatedAgent: true`); the registry validates that brand.

`AgentRuntimeConfig` fields the runtime validator accepts (all optional): `profile`, `description`, `model`, `instructions`, `skills`, `tools`, `subagents`, `thinkingLevel`, `compaction`, `durability`, `cwd`, `sandbox`. Unknown top-level fields throw. (`mcpServers` exists on the *type* but the validator currently **rejects** it on the agent config — MCP servers are configured **per request**, not per agent; see §2.4.)

A minimal agent (`convex/agents.ts` is a convenient place to keep them):

```ts
// convex/agents.ts
import * as v from "valibot";
import { createAgent, defineTool } from "@cove-framework/cove/runtime";

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: v.object({ city: v.string() }), // MUST be a top-level object schema
  async execute({ city }) {                    // args arrive typed + already validated
    return `It is sunny in ${city}.`;
  },
});

export const assistant = createAgent(() => ({
  model: "anthropic/claude-haiku-4-5",          // '<provider>/<model>' (or false)
  instructions: "You are a helpful weather assistant.",
  tools: [getWeather],
}));
```

Reading per-run context (note the typed `payload`/`env`):

```ts
export const greeter = createAgent<{ name: string }>(({ payload, env, id }) => ({
  model: "anthropic/claude-haiku-4-5",
  instructions: `You are greeting ${payload?.name ?? "a guest"} (run ${id}).`,
}));
```

#### Reusable behavior with `defineAgentProfile`

`defineAgentProfile(profile: AgentProfile): AgentProfile` validates and returns the profile unchanged; you can pass it back via `AgentRuntimeConfig.profile`. Scalar fields use call-over-profile precedence; `skills`/`tools`/`subagents` are **concatenated** with the call-level config.

```ts
import { defineAgentProfile, createAgent } from "@cove-framework/cove/runtime";

const base = defineAgentProfile({
  name: "support",                       // required if used as a subagent via session.task()
  model: "anthropic/claude-haiku-4-5",
  instructions: "Be concise and accurate.",
  thinkingLevel: "low",                  // "off"|"minimal"|"low"|"medium"|"high"|"xhigh"
});

export const support = createAgent(() => ({ profile: base, tools: [/* ... */] }));
```

`AgentProfile` validation rules worth knowing: it is a strict object (unknown fields throw `"received unknown agent profile field <x>"`); `name` must match `/^[A-Za-z][A-Za-z0-9_-]*$/`; tool/skill/subagent names must be unique; subagents may not declare `durability`; circular subagents are rejected.

`compaction` accepts `{ reserveTokens?, keepRecentTokens?, model? }` (or `false`). `durability` accepts `{ maxAttempts?, timeoutMs? }`.

> **Known discrepancy:** `DurabilityConfig` declares `maxSteps`/`maxFollowUps` on the type, but the profile validator's strict key-check only allows `maxAttempts`/`timeoutMs` — passing `maxSteps`/`maxFollowUps` on a profile currently throws `durability received unknown field`. Treat it as a known discrepancy, not a supported option, until resolved upstream.

### 2.4 Defining tools with `defineTool`

```ts
export function defineTool<TParams extends ToolParameters>(
  tool: ToolDefinition<TParams>,
): ToolDefinition
```

```ts
interface ToolDefinition<TParams extends ToolParameters = ToolParameters> {
  name: string;          // unique across built-in + custom tools
  description: string;   // tells the LLM when/how to use it
  parameters: TParams;   // valibot object schema OR raw JSON Schema object
  execute: (args: ToolArgs<TParams>, signal?: AbortSignal) => Promise<string>;
}
```

How valibot input schemas are handled (the normal authoring path):

- `parameters` **must be a top-level object schema** — `v.object(...)`, `v.strictObject(...)`, `v.looseObject(...)`, or `v.objectWithRest(...)`. Anything else throws `parameters must be a top-level object schema (v.object({ ... }))`.
- At definition time the schema is converted **once** to JSON Schema (and cached) for the model to see. Refinements/transforms are dropped from the *emitted* JSON Schema but are still **enforced at runtime**.
- At call time, model-supplied args are `safeParse`d against the original schema before your `execute` runs. On failure the runtime throws `ToolInputValidationError`, which the agent loop surfaces back to the model as an error tool-result for self-correction. Your callback receives the parsed/transformed (typed) output.
- `execute` returns a `Promise<string>` — that string is sent back to the LLM. Thrown errors become tool errors.

```ts
import * as v from "valibot";
import { defineTool } from "@cove-framework/cove/runtime";

export const createTicket = defineTool({
  name: "create_ticket",
  description: "Open a support ticket. Use when the user reports a problem.",
  parameters: v.object({
    title: v.string(),
    priority: v.picklist(["low", "high"]),   // enforced at runtime even though not in the JSON Schema
    tags: v.optional(v.array(v.string())),
  }),
  async execute({ title, priority, tags }, signal) {
    // ... persist; honor `signal` for cancellation if your work is long-running
    return `Created ticket "${title}" (${priority}).`;
  },
});
```

`defineTool` throws (all `[cove]`-prefixed) if `tool` is not an object, `name`/`description` are not non-empty strings, `parameters` is missing/not an object, or `execute` is not a function.

**Interop escape hatch:** `parameters` may instead be a raw JSON Schema `object` (for MCP/TypeBox/etc.). It passes through unchanged, and your callback receives `Record<string, any>` (no runtime parse is applied).

**MCP servers are declared per request, not per agent.** The `submitPrompt` mutation and the `agentRequests` table accept an optional `mcpServers` array; when a request declares them, a `"use node"` discovery hop under `convex/mcp/` connects to each server and exposes its tools to the model as `mcp__<server>__<tool>`. (`mcpServers` appears on the `AgentRuntimeConfig`/`AgentProfile` *types*, but the agent-definition validator rejects it — treat it as a request-level option until that discrepancy is resolved.)

### 2.5 Registering agents and workflows

Registries are **Convex-app-bound** — they are deliberately NOT exported from the runtime barrel. They live in your `convex/agentRegistry.ts` and `convex/workflowRegistry.ts`, and you import the `define*`/`register*` helpers from those files by relative path. The starter files already contain these declarations after `init`; you extend them.

#### The export names the loader expects

`cove build`/`dev` load your registries by spawning an isolated `tsx` child that imports the file and looks for specific export names, in order:

- **Agent registry:** `registry`, then `agents`, then `default` — each candidate export is accepted only if it duck-types as a registry (`get`/`has` functions + an array `names`); there is no broader scan of other exports.
- **Workflow registry:** `workflows`, then `registry`, then `default`.

The starter scaffold uses the canonical names — keep them: **`export const registry`** for agents and **`export const workflows`** for workflows. If the loader finds none, it errors with, e.g., ``[cove] <file> must export an AgentRegistry (e.g. `export const registry = defineAgentRegistry({...})`).``

#### `convex/agentRegistry.ts`

`defineAgentRegistry(map: Record<string, CreatedAgent>): AgentRegistry` validates that the map is a non-array object, every key matches `/^[A-Za-z][A-Za-z0-9_-]*$/`, and every value carries `__coveCreatedAgent === true`; it freezes a copy. The **registry key is the public route name** (e.g. `POST /agents/<key>/...`).

```ts
// convex/agentRegistry.ts  (your edits go below the vendored helpers)
import { createAgent } from "../src/runtime/agent-definition.ts";
import { assistant, support } from "./agents.ts";

// `cove build` resolves agents by this export name.
export const registry = defineAgentRegistry({
  assistant,                                      // → POST /agents/assistant/:id
  support,                                        // → POST /agents/support/:id
});
```

> Note: `defineAgentRegistry`, `registerAgentRegistry`, `getRegisteredAgent`, and `listRegisteredAgents` are defined within `convex/agentRegistry.ts` itself (the vendored portion of the file). You author the `registry` export at the bottom; you do **not** call `registerAgentRegistry` here — the generated `convex/_cove/agentResolver.ts` does that.

#### `convex/workflowRegistry.ts`

A workflow handler is `(ctx: CoveContext, input: TInput) => TResult | Promise<TResult>`. `defineWorkflow(handler)` validates it is callable and returns it. `defineWorkflowRegistry(map)` validates a non-array object whose keys match the name regex and whose values are functions.

```ts
// convex/workflowRegistry.ts
// defineWorkflow / defineWorkflowRegistry are defined earlier IN this same vendored file — no import needed.

// `cove build` resolves workflows by this export name.
export const workflows = defineWorkflowRegistry({
  echo: defineWorkflow((_ctx, input) => input),       // → POST /workflows/echo
});
```

#### What the generated `_cove` resolvers do

On `build`/`dev`/`init`, codegen emits two byte-stable sidecars that install the registry "seam" as a module side-effect when imported by `convex/http.ts`. You never edit these; for reference the agent resolver is essentially (minus the auto-generated banner comment):

```ts
// convex/_cove/agentResolver.ts  (auto-generated — do not edit)
import { registerAgentRegistry, registry } from "../agentRegistry.ts";
registerAgentRegistry(registry);
export { getRegisteredAgent, listRegisteredAgents } from "../agentRegistry.ts";
```

The workflow resolver mirrors this (`registerWorkflowRegistry(workflows)` + re-export of `getRegisteredWorkflow`). Workflows are kept out of the agent resolver intentionally — a workflow run is a distinct run kind.

> Reserved test model: use `"cove-test/mock"` as the `model` for free, deterministic local runs (no provider key needed).

### 2.6 Configuring `cove.config.ts`

Authored with the `defineCoveConfig` identity helper, imported from the **`@cove-framework/cove/cli`** subpath. Only three keys are accepted; unknown keys throw `[cove] Invalid config ... unknown field "<key>"`.

```ts
// cove.config.ts  (generated by init)
import { defineCoveConfig } from "@cove-framework/cove/cli";

export default defineCoveConfig({
  convexDir: "convex",
});
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `root` | `string` | the config's directory (else the search dir) | Project root. Relative *file* values resolve from the config dir; relative *inline* (`--root`) values from cwd. |
| `convexDir` | `string` | `"convex"` (i.e. `<root>/convex`) | The Convex app dir. Holds `agentRegistry.ts`, `workflowRegistry.ts`, generated `_cove/`, and `http.ts`. |
| `skills` | `string[]` | `[]` (packaging **off**) | Optional skill source dirs (each containing `<name>/SKILL.md`). Packaging only runs when set. |

Config discovery: the CLI searches these basenames in order — `cove.config.ts`, `.mts`, `.mjs`, `.js`, `.cjs`, `.cts` — unless you pass `--config <path>`. The file is loaded via Node's native dynamic `import()` with TS type-stripping, so it must use **erasable** TypeScript only (no enums, runtime namespaces, parameter properties, or decorators); violating that yields a `[cove]` hint pointing at `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Resolution precedence is **inline (`--root`) → file → defaults**.

### 2.7 Build / dev / deploy lifecycle

All three commands share `--root <path>`, `--config <path>`, and `--env <path>`. They load a CLI env file before running (`<baseDir>/.env` by default, or the `--env` file); **shell-provided values always win** over file values. `init` and `add` do not load env.

> The CLI env is for things the CLI/Convex process needs (e.g. `CONVEX_DEPLOYMENT`). **Provider/auth secrets go in the Convex deployment env** via `npx convex env set ...`, not here.

#### `cove dev` — local development

```bash
npm run dev        # = cove dev
```

What it does, in order:
1. Runs an initial codegen+validation pass (`build` with typecheck skipped — `convex dev` typechecks itself).
2. Spawns `npx convex dev` (cwd = resolved `root`, inherited stdio).
3. Watches a fixed set: the `cove.config.*` candidates plus `<convexDir>/agentRegistry.ts` and `<convexDir>/workflowRegistry.ts` (watched per-parent-directory + basename filter, robust to rename-on-save).
4. On change: a 150ms-debounced **re-codegen only** (`convex dev` owns function hot-reload). A codegen error prints `Codegen failed: ...` and keeps dev alive (`fix the error; dev is still watching`).

`SIGINT`/`SIGTERM` are forwarded to the Convex child; exit codes map `SIGINT→130`, `SIGTERM→143`.

First-run sequence for a new project:

```bash
npm install
npx convex dev                              # creates the deployment + convex/_generated; leave running
npx convex env set AI_GATEWAY_API_KEY <key> # provider key lives in the deployment env
npm run dev
```

#### `cove build` — validate + generate + typecheck

```bash
npm run build                # = cove build
cove build --skip-typecheck  # skip the tsc gate
```

Orchestration: `resolveConfig` → load+validate `agentRegistry.ts` then `workflowRegistry.ts` in an isolated `tsx` child → codegen (`_cove/agentResolver.ts`, `_cove/workflowResolver.ts`, and a patch/validate of `convex/http.ts`), each **content-compared** so a no-op rebuild writes 0 files → optional skill packaging (only if `skills` is set) → `tsc --noEmit` gate (unless `--skip-typecheck`).

Registry validation (run inside the child, where the live objects exist) checks, per agent: the `__coveCreatedAgent` brand + an `initialize` function; runs the initializer with a stub context; the model is provider-resolvable (`<provider>/<model>` shape, or `false`; `undefined` is an error); compaction/durability key allowlists; and that any declared subagents exist in the registry. A failing build throws a single `[cove]` line and (for `build`) a non-zero exit.

The `http.ts` patch has two modes: **patched** (cove owns the route — it installs the resolver side-effect imports and binds `POST /workflows/:name`) or **validated** (cove only ensures the imports, never touching routes) — the validated mode kicks in when `convex/app.ts` exists or `http.ts` carries a `// cove:user-authored` marker. If `convex/http.ts` is absent, build throws `[cove] failed to patch ...: convex/http.ts not found.`

> There is **no `cove codegen` command** — codegen is a build step. (The generator functions are also exported programmatically from `@cove-framework/cove/cli` if you need them: `generateAgentResolver`, `renderAgentResolver`, `generateWorkflowResolver`, `renderWorkflowResolver`, `generateHttpEntry`, `loadAgentRegistry`, `loadWorkflowRegistry`, `writeIfChanged`, etc.)

#### `cove deploy` — fail-closed deploy

```bash
npm run deploy     # = cove deploy
```

Deploy **always runs a full `build` first** (typecheck included; `--skip-typecheck` is ignored). If anything throws, it prints `Error: <msg>`, returns exit code `1`, and **never spawns `convex deploy`**. On success it prints `done validation + codegen passed; deploying via convex` and spawns `npx convex deploy` (cwd = root), surfacing its exit code.

### 2.8 Talking to a deployed agent from a client (SDK)

Everything reactive flows over **Convex reactive queries** — no SSE, no streaming GET. Import from `@cove-framework/cove/sdk`.

```ts
export function createCoveReactiveClient(options: CreateCoveReactiveClientOptions): CoveReactiveClient
```

`options` is `{ convex, refs }`. A `convex/browser` `ConvexClient` satisfies the required `CoveConvexClient` shape (`mutation`, `query`, `onUpdate`) directly. `refs` are `FunctionReference`s pointing at the backend functions:

```ts
import { ConvexClient } from "convex/browser";
import { createCoveReactiveClient } from "@cove-framework/cove/sdk";
import { api } from "../convex/_generated/api";

const convex = new ConvexClient(process.env.CONVEX_URL!);

const cove = createCoveReactiveClient({
  convex,
  refs: {
    submitPrompt: api.invoke.submit.submitPrompt, // mutation (lives in convex/invoke/submit.ts)
    getRequest: api.requests.get,            // query (watched to terminal)
    getRun: api.runs.get,                    // query
    listForStream: api.events.listForStream, // query
  },
});

// fire-and-forget
const { requestId, submissionId } = await cove.agents.send("default", "inst-1", { message: "hi" });

// await the terminal result over a reactive subscription (NOT polling)
const { result } = await cove.agents.prompt("default", "inst-1", { message: "hi" });
console.log(result.text, result.usage);

// stream events (at-least-once async iterator keyed by streamKey = instanceId | runId)
for await (const ev of cove.runs.events("inst-1", { sinceSeq: -1 })) {
  // ev is a CoveEvent: message_start/text_delta/tool_start/run_end/...
}

// point-in-time run record
const run = await cove.runs.get(runId); // RunRecord | null
```

Behavioral gotchas of the SDK client (current state):

- In `agents.send(name, id, options)` / `agents.prompt(...)`, the `name` (agent) argument is **ignored** at the SDK boundary, and `options.images` is **dropped** — the underlying `submitPrompt` mutation takes a plain `prompt` string and an `instanceId`, with no agent/image slot yet. To select an agent, address it over HTTP (§2.9) where the `:name` segment is honored.
- `agents.prompt` resolves when the request reaches a terminal status; on failure it throws `CoveApiError` with `type: "prompt_failed"`, on cancellation `type: "prompt_cancelled"`. The returned `result.model` is currently an empty placeholder.
- `workflows.invoke(...)` always throws `CoveApiError("workflows: not available until G2.4", { type: "not_implemented" })` — invoke workflows over HTTP (§2.9) instead.

For lower-level event streaming, `createCoveEventStream({ convex, listForStreamRef, streamKey | submissionId, sinceSeq?, signal? })` returns an `AsyncIterable` with `.cancel()` and a resumable `.sinceSeq` cursor. Pass exactly one of `streamKey`/`submissionId` (neither throws `"[cove] createCoveEventStream: pass either streamKey or submissionId"`).

### 2.9 Talking to an agent over HTTP

The generated, patched `convex/http.ts` exposes these routes on your Convex **site URL** (`$CONVEX_SITE_URL`). The agent `:name` segment is the registry key from §2.5; here it is resolved server-side via `getRegisteredAgent`.

```bash
# submit a prompt to the `assistant` agent, instance "inst-1" (fire-and-forget)
curl -X POST "$CONVEX_SITE_URL/agents/assistant/inst-1" \
  -H "content-type: application/json" \
  -d '{ "message": "hello" }'
# → { "sessionId": "...", "requestId": "...", "submissionId": "..." }

# submit and block until the run terminalizes, returning the request snapshot
curl -X POST "$CONVEX_SITE_URL/agents/assistant/inst-1?wait=result" \
  -H "content-type: application/json" \
  -d '{ "message": "hello" }'

# point-in-time run record
curl "$CONVEX_SITE_URL/runs/<requestId>"

# invoke a registered workflow by name (empty/absent body allowed)
curl -X POST "$CONVEX_SITE_URL/workflows/echo" \
  -H "content-type: application/json" \
  -d '{ "any": "input" }'
# → { "sessionId", "requestId", "submissionId", "runId" }
```

The agent route accepts `{ message, model?, sessionName?, resultSchema? }` in the JSON body; non-JSON content-type yields a 415, malformed JSON a 400. An unknown workflow returns a `WorkflowNotFoundError`. Every route runs the pluggable `runAuthorize` hook (`convex/auth.ts`) at admission — on `POST /agents/:name/:id` it runs *after* the content-type (415) and malformed-JSON (400) checks; on `/runs`, `/workflows`, and the channels pipeline it runs first.

### 2.10 Talking to an agent from React

Import from `@cove-framework/cove/react`. React requires `react >= 18` (a peer dependency).

The React layer uses its **own** structural `CoveReactiveClient` interface (single-object `agents.send(opts)` + `subscribeEvents`) — distinct from the SDK client. The simplest path is to let the hooks build a client off an ambient Convex provider, or to supply one explicitly via `CoveProvider`.

`CoveProvider` takes a required `client` prop. `createReactiveClientFromConvex(convex)` builds a React-shaped client from a `ConvexReactClient` (it addresses backend functions by name via `anyApi`, so it does not depend on `convex/_generated`).

```tsx
// main.tsx
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { CoveProvider, createReactiveClientFromConvex } from "@cove-framework/cove/react";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);
const cove = createReactiveClientFromConvex(convex);

export function Root({ children }: { children: React.ReactNode }) {
  return (
    <ConvexProvider client={convex}>
      <CoveProvider client={cove}>{children}</CoveProvider>
    </ConvexProvider>
  );
}
```

> Client resolution order used by the hooks (`useResolvedCoveClient`): explicit `client` option → `<CoveProvider>` → an ambient `ConvexReactClient` (via `useConvex()` + `createReactiveClientFromConvex`). If none is resolvable the hook throws `"[cove] Cove hooks require a client option, a <CoveProvider>, or an ambient <ConvexProvider>"`. Because of the ambient fallback, `<CoveProvider>` is optional if you already have a `<ConvexProvider>`.

#### Hooks

**`useAgentPrompt`** — the submit side (no event subscription):

```tsx
import { useAgentPrompt } from "@cove-framework/cove/react";

function Composer() {
  const { submit, status, requestId, error } = useAgentPrompt({ instanceId: "inst-1" });
  // status: "idle" | "submitting" | "submitted" | "error"
  return (
    <button
      disabled={status === "submitting"}
      onClick={() => submit("hello", { model: "anthropic/claude-haiku-4-5" }).catch(() => {})}
    >
      Send {status === "error" ? `(error: ${error?.message})` : ""}
    </button>
  );
}
```

`submit(message, options?)` calls `client.agents.send({ message, images, instanceId, harnessName, sessionName, model })`; per-call `SubmitPromptOptions` override the hook-level options. It rethrows on error after recording `status: "error"`.

**`useRunEvents`** — folds the reactive event stream into `UIMessage[]` via an `AgentStore` + reducer + `useSyncExternalStore`. The first argument is the **events fan-out key** (the agent `instanceId` or a `runId`), **not** the `requestId`:

```tsx
import { useRunEvents } from "@cove-framework/cove/react";

function Conversation() {
  const { messages, status, error, store } = useRunEvents("inst-1");
  // also: store?.sendMessage("hi") for an optimistic submit through the same store
  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>
          <b>{m.role}:</b>{" "}
          {m.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
        </li>
      ))}
    </ul>
  );
}
```

**`useCoveRun`** — a self-contained run view derived purely from the event fold (`logs`, `status`, `result`, `error`), keyed the same way:

```tsx
import { useCoveRun } from "@cove-framework/cove/react";

function RunView() {
  const { events, logs, status, result, error } = useCoveRun("run-123");
  // status: "running" | "completed" | "failed" | "cancelled"
  return <pre>{status}</pre>;
}
```

A typical chat screen combines a submit hook and an events hook on the same `instanceId`:

```tsx
function Chat() {
  const id = "inst-1";
  const { submit, status } = useAgentPrompt({ instanceId: id });
  const { messages } = useRunEvents(id);           // same key
  // render `messages`, call `submit(text)` on send
}
```

### 2.11 Wiring channels (Slack inbound webhook / HTTP)

> Note: the channel surface below is documented from the vendored backend source (`convex/http.ts`, `convex/channels/`), as it is not covered by the provided fact-sheet. Verify against your vendored copy if your version differs.

The patched `convex/http.ts` includes a single generic inbound route:

```
POST /channels/:name   →  resolves a ChannelAdapter and runs the shared pipeline
```

`:name` is a key in `channelRegistry` (`convex/channels/index.ts`). The ship-first set is: `slack`, `github`, `teams`, `discord`, `telegram`, `linear`, `notion`, `google-chat`. An unknown name returns `404 { error: { code: "channel_not_found", ... } }`.

The shared pipeline (`convex/channels/inbound.ts`, `verifyThenAdmit`) is identical for every channel: read the **raw bytes once** → `runAuthorize` → `adapter.verify(req, rawBody)` (signature over the exact bytes) → `adapter.mapPayload(...)` (which can short-circuit a `handshake` echo or `ignore`) → **dedup before admission** (a replayed delivery never spawns a second run) → `submitPrompt` (carrying `replyContext` on the request row) → ack `"ok"`. The agent's reply is posted **after** the run terminalizes (`convex/channels/reply.ts`), never inside the ack window.

#### Slack

The Slack adapter (`convex/channels/slack/index.ts`) is wired and works out of the box once you set two deployment env vars. It verifies the Slack HMAC signature (`v0:{ts}:{body}`, ±300s window) using `SLACK_SIGNING_SECRET`, handles the `url_verification` handshake, ignores bot-echo/non-message events, and posts the terminal reply via Slack's `chat.postMessage` using `SLACK_BOT_TOKEN`. (The generic `postReply` also supports a `response_url`, but the Slack adapter doesn't currently capture one — so the bot-token path is used; with no token set, replying is a best-effort no-op.)

Setup:

```bash
# secrets live in the Convex deployment env, never in .env
npx convex env set SLACK_SIGNING_SECRET <signing-secret>
npx convex env set SLACK_BOT_TOKEN      <xoxb-...>          # required for the bot to post replies (chat.postMessage)
```

Then point your Slack app's **Event Subscriptions / Request URL** at:

```
$CONVEX_SITE_URL/channels/slack
```

Verification specifics:
- If `SLACK_SIGNING_SECRET` is unset, `verify` returns `401 "[cove] Slack signing secret not configured."`; a bad signature returns `401 "[cove] invalid Slack signature."`.
- The `url_verification` handshake is answered automatically (the pipeline echoes `{ challenge }`), so Slack's URL verification passes with no extra code.
- Inbound messages are mapped to a session via `slackSessionRef(team, channel)` (derives `instanceId`/`sessionName`), and the reply address rides on `replyContext` as `{ provider: "slack", target: <channel>, addressing: { team, user } }` — the Slack adapter does not capture `response_url`/`thread_ts`.

You do not register channels yourself — they are part of the vendored `convex/channels/` tree and are bound by the generic route. To add a new channel, add an adapter implementing the `ChannelAdapter` contract (`verify` / `mapPayload` / `postReply`) under `convex/channels/<name>/` and register it in `channelRegistry`.

> **Authoring a custom channel:** consult the `ChannelAdapter` contract in `convex/channels/types.ts` and the existing adapters under `convex/channels/<name>/` in your vendored copy — the per-adapter `verify` / `mapPayload` / `postReply` details vary by provider.

---

Relevant files in a generated project: `cove.config.ts`, `convex/agentRegistry.ts`, `convex/workflowRegistry.ts`, `convex/_cove/agentResolver.ts`, `convex/_cove/workflowResolver.ts`, `convex/http.ts`, `convex/channels/index.ts`, `convex/channels/slack/index.ts`, `convex/channels/inbound.ts`, `convex/auth.ts`.

---

## 3. Packaging Playbook — Shipping a Convex-Native Framework

### Why a Convex backend can't be an ordinary npm import

State this constraint up front because it dictates every later decision:

> Convex deploys functions only from the consumer's own `convex/` directory. Code reachable through `node_modules` is never deployed.

Consequences that ripple through packaging:

- The backend trees (`convex/`, plus the V8-safe pure core `src/runtime/`) **cannot** be exposed through the `exports` map as compiled artifacts. They must reach the user as *editable source files they own*.
- They are therefore shipped **as source** in the tarball (`files` includes `convex` and `src/runtime`) and **not** built by tsup — `tsup.config.ts` builds only the four surfaces + the bin and explicitly leaves `convex/**` alone (header lines 4–6).
- `cove init` is the delivery mechanism for the backend: it copies those source trees into the target project (`VENDOR_DIRS = ["convex", "src/runtime"]`).
- Anything generated *per-project* (Convex codegen `_generated/`, Cove's own `_cove/` resolvers) must be **excluded** from the tarball and **regenerated** in the user's project — shipping a stale copy would be wrong for every consumer.

The mental model: the npm package is both a **library** (Model A, imported) and a **template store** (Model C, copied). The `files` allowlist serves both.

### Model A — the tsup-built library

`tsc` cannot build this package, and the reason is non-obvious enough to call out first.

#### Why tsup (esbuild), not `tsc`

`tsconfig.json` sets `allowImportingTsExtensions: true`, and the source imports siblings with **literal `.ts` specifiers** (e.g. `bin/cove.ts` imports `"../src/cli/commands/build.ts"`, `"../src/cli/lib/env.ts"`). TypeScript refuses to *emit* JS under that flag — it pairs only with `noEmit: true`. So `tsc` is demoted to a typecheck-only role (`typecheck: "tsc --noEmit"`), and the actual build is tsup/esbuild, which rewrites `.ts`→`.js` in specifiers and emits `.d.ts`.

If your framework wants the same ergonomic `.ts`-extension imports in source, you inherit this exact split: **tsup builds, `tsc --noEmit` gates.**

#### `tsup.config.ts`

```ts
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    "runtime/index": "src/runtime/index.ts",
    "sdk/index":     "src/sdk/index.ts",
    "react/index":   "src/react/index.ts",
    "cli/index":     "src/cli/index.ts",
    "bin/cove":      "bin/cove.ts", // → dist/bin/cove.js (the compiled CLI)
  },
  outDir: "dist",
  format: ["esm"],          // matches "type": "module"; the exports map only has `import`
  target: "node22",
  dts: true,                // emits .d.ts per entry + shared .d.ts chunks
  splitting: true,          // shared src/runtime modules become shared chunks, not duplicated
  sourcemap: true,          // .js.map / .d.ts.map — excluded from the tarball later
  clean: true,              // wipe dist/ before each build
  define: { __COVE_VERSION__: JSON.stringify(pkg.version) },
});
```

Key decisions and what they buy you:

- **Entry keys are output sub-paths.** The five keys (`runtime/index`, `sdk/index`, `react/index`, `cli/index`, `bin/cove`) determine the on-disk layout under `dist/`, which the `exports` map and `bin` then point at. Keep keys and the `exports` targets in lockstep.
- **`format: ["esm"]` only.** No CJS condition exists anywhere, so don't build one. This matches `"type": "module"` and the `import`-only `exports`.
- **`target: "node22"`** — the floor your engines enforce (see below).
- **`splitting: true`** is load-bearing here, not cosmetic: `src/runtime` is pulled in by both the `runtime` entry and `sdk`/`react`. Without splitting, esbuild duplicates those modules into every entry; with it, they become shared `dist/chunk-*.js`. If your surfaces share a core, turn this on.
- **`define`-injected version.** `__COVE_VERSION__` is constant-folded at build time so the compiled CLI never has to fs-read `package.json` from a path that shifts under `dist/`. The source declares it as an ambient global so `tsc` is happy:

  ```ts
  // bin/cove.ts
  declare const __COVE_VERSION__: string | undefined;

  function coveVersion(): string {
    if (typeof __COVE_VERSION__ === "string") return __COVE_VERSION__;
    try {
      const pkg = JSON.parse(
        fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
      ) as { version: string };
      return pkg.version;
    } catch { return "0.0.0"; }
  }
  ```

  In the built artifact `dist/bin/cove.js`, the guard collapses to `if (true) return "0.1.0";` — proof the substitution worked. When run from a source checkout via `tsx` (no `define`), it falls through to the fs-read. This "injected constant with an fs fallback" pattern is the clean way to get a version into a compiled binary whose `package.json` location is not stable.

- **Externalization is automatic.** tsup auto-externalizes `dependencies` + `peerDependencies`; node builtins are always external. You do not hand-list externals.

#### The `exports` map (subpath surfaces)

```json
"exports": {
  "./runtime": { "types": "./dist/runtime/index.d.ts", "import": "./dist/runtime/index.js" },
  "./sdk":     { "types": "./dist/sdk/index.d.ts",     "import": "./dist/sdk/index.js" },
  "./react":   { "types": "./dist/react/index.d.ts",   "import": "./dist/react/index.js" },
  "./cli":     { "types": "./dist/cli/index.d.ts",     "import": "./dist/cli/index.js" },
  "./package.json": "./package.json"
}
```

- **Conditional key order matters**: `types` before `import` in every entry. Resolvers read these in order.
- **No `require` condition, no bare `"."` root.** Consumers import the four named subpaths only — there is intentionally no default entry point. Cove's four surfaces are: `./runtime` (V8-safe core: `createAgent`, `defineTool`, types), `./sdk` (Convex-native client: `createCoveReactiveClient`), `./react` (`CoveProvider` + hooks), `./cli` (`defineCoveConfig` + programmatic build/codegen entry points).
- **`"./package.json": "./package.json"` is mandatory.** An explicit `exports` map otherwise *forbids* deep imports — including the manifest. Tooling (and Node itself) need to resolve `package.json` under the strict gate, so you must export it explicitly. Omitting this is a silent footgun.

### The publish manifest (`package.json`)

#### Identity & publish config

```json
{
  "name": "@cove-framework/cove",
  "type": "module",
  "version": "0.1.0",
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=22.18" },
  "peerDependencies": { "react": ">=18" },
  "peerDependenciesMeta": { "react": { "optional": true } },
  "bin": { "cove": "./bin/cove.mjs" }
}
```

- **Scoped name.** Cove uses `@cove-framework/cove` because the bare name `cove` is squatted on npm. The CLI *command* stays the short `cove` regardless (via `bin`) — scoping the package doesn't force an ugly command name. Expect to do this for any framework with a desirable short name.
- **`publishConfig.access=public` is required for any `@scope/...` package.** Scoped packages publish as `restricted` (private) by default; without this you either get a publish error or a private package. Setting it in the manifest means you never have to remember `--access public` on the CLI.
- **`engines.node`** is the floor — here `>=22.18`. Note the deliberate skew vs. the bin shim's human label `">=22.18 or >=23.6"`; the shim is stricter than `engines` can express (see gotchas).
- **Optional peer.** `react` is needed only for the `./react` surface, so it's a peer marked `optional` via `peerDependenciesMeta`. Generalize: any dependency that only one of your surfaces needs belongs in `peerDependencies` + `peerDependenciesMeta.<dep>.optional = true`, not in `dependencies`.

#### The `files` allowlist (and why negations live inside it)

```json
"files": [
  "dist",
  "bin",
  "convex",
  "src/runtime",
  "README.md",
  "!**/__tests__/**",
  "!**/*.test.ts",
  "!**/*.map",
  "!convex/_generated/**",
  "!convex/_cove/**"
]
```

Positive entries: the built `dist/`, the `bin/` shim, the backend `convex/` **as source**, the pure core `src/runtime/` **as source**, and `README.md`.

The critical, non-obvious rule:

> When a directory is listed in `files`, npm includes it **wholesale**, and `.npmignore` **cannot** carve sub-paths back out of a `files`-included directory. The only way to exclude sub-paths is **negated globs inside the `files` array itself.**

That is why every exclusion lives in `files`, not in a `.npmignore`:

- `!**/__tests__/**` and `!**/*.test.ts` strip the test trees that live *under* the included `convex/` and `src/runtime/` dirs (e.g. `convex/__tests__/`, `src/runtime/__tests__/`, `convex/mcp/__tests__/`).
- `!**/*.map` strips the sourcemaps tsup emits into the shipped `dist/`.
- `!convex/_generated/**` strips Convex codegen (`api.d.ts`, `server.js`, etc.) — regenerated per project.
- `!convex/_cove/**` strips the framework's internal generated resolvers (`agentResolver.ts`, `workflowResolver.ts`) — also regenerated per project.

The principle generalizes: **ship source trees positively, then negate every generated/test sub-path inside the same array.**

#### The `bin` shim — compiled-vs-source dispatch + Node gate

```json
"bin": { "cove": "./bin/cove.mjs" }
```

The declared bin is a **plain-JS launcher shim**, not the TS source and not the compiled bundle directly. `bin/cove.mjs` is `#!/usr/bin/env node`, `@ts-nocheck`, and uses only universally-available JS so it runs on whatever Node the user has and is itself never compiled. It does two jobs:

1. **Node-version gate** (`checkNodeVersion()`):
   - Constants: `MIN_NODE_MAJOR = 22`, `MIN_NODE_MINOR = 18`, `ENGINES_LABEL = ">=22.18 or >=23.6"`.
   - Parses `process.versions.node` with `/^(\d+)\.(\d+)/`; if unparseable, **lets it through** (the real CLI fails loudly downstream).
   - Pass condition: `(major !== 23 || minor >= 6)` AND `(major > 22 || (major === 22 && minor >= 18))`. The first clause specifically **rejects Node 23.0–23.5**, which lack default TypeScript type-stripping despite being above the 22.18 floor.
   - On failure: prints `"Node.js v<v> is not supported by Cove.\nCove requires Node.js >=22.18 or >=23.6 for native TypeScript support.\nPlease upgrade: https://nodejs.org/\n"` to stderr and `process.exit(1)`.

2. **Dispatch** (compiled-vs-source):
   - `compiled = path.join(here, "..", "dist", "bin", "cove.js")`.
   - **Published install** (`fs.existsSync(compiled)`): `spawn(process.execPath, [compiled, ...args], { stdio: "inherit" })` — runs the compiled CLI directly on the user's Node, no `tsx` needed.
   - **Source checkout** (`dist/` not built): resolve `tsx/cli` via `createRequire(import.meta.url).resolve("tsx/cli")` and spawn `node <tsxCli> bin/cove.ts ...args`; if resolution throws, fall back to the `tsx` binary on PATH.
   - **Exit forwarding**: on child `"error"` → print + `exit(1)`; on `"exit"` → if a signal, `exit(signal === "SIGINT" ? 130 : 143)`, else `exit(code ?? 0)`.

Why a JS shim at all rather than pointing `bin` at `dist/bin/cove.js` directly? Because the gate must run on the **user's** Node *before* the (possibly type-stripping-dependent) real CLI loads, and because the same package must work both as a published install (run compiled) and as a source checkout (run via `tsx`). The shim is the only piece guaranteed to execute on any supported Node.

#### Scripts (the publish lifecycle)

```json
"build": "tsup",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"prepack": "npm run build",
"prepublishOnly": "npm run build && npm run typecheck && npm test"
```

- **`prepack` → `npm run build`** runs before `npm pack` *and* `npm publish` create the tarball, guaranteeing `dist/` exists in it. Without this, a clean checkout would publish an empty `dist/`.
- **`prepublishOnly`** is the publish gate: build + `tsc --noEmit` + full `vitest run`. It runs only on `npm publish` (not on `npm pack`/`npm install`), so it's the right place for the heavy, must-pass checks.

### Model C — the `cove init` vendoring scaffold

`cove init` is what makes the un-importable backend half actually downloadable. Entry: `initProject(options: InitOptions)` where `InitOptions = { dir?: string; force?: boolean }`. It throws single-line `[cove]` errors on any failure.

#### What `init` does, step by step

1. **`findPackageRoot()`** — walks up ≤12 dirs from the running module for a `package.json` whose `name === "@cove-framework/cove"`. This locates the installed package so init can copy out of it. (Throws `[cove] could not locate the cove package root — is the install intact?` if not found.)
2. **Resolve target** — `targetDir = path.resolve(cwd, options.dir ?? ".")`; `projectName = sanitizePackageName(basename(targetDir))`.
3. **`ensureTargetWritable`** — if the target dir is non-empty (ignoring `.git`/`.DS_Store`) and `!force`, throw `[cove] target directory is not empty ... Pass --force`.
4. **Vendor the two trees** — `VENDOR_DIRS = ["convex", "src/runtime"]`, copied via `copyTreeFiltered` (`fs.cpSync` recursive). The copy filter **drops** any basename in `{_generated, _cove, __tests__, .DS_Store}` and any `*.test.ts`. This is the project-time mirror of the tarball-time `files` negations: never copy generated or test files into the user's project.
5. **Append starter registries** — `fs.appendFileSync` onto the vendored registry files:
   - `convex/agentRegistry.ts` gets `import { createAgent } from "../src/runtime/agent-definition.ts";` plus `export const registry = defineAgentRegistry({ assistant: createAgent(() => ({ model: "anthropic/claude-sonnet-4-6", instructions: "You are a helpful assistant scaffolded by \`cove init\`." })) });`
   - `convex/workflowRegistry.ts` gets `export const workflows = defineWorkflowRegistry({});` (intentionally empty).
6. **Regenerate `_cove/` from the appended registries** using the *same* pure renderers `cove build` uses — never a copied snapshot:
   ```ts
   writeFile("convex/_cove/agentResolver.ts",    renderAgentResolver("registry"));
   writeFile("convex/_cove/workflowResolver.ts", renderWorkflowResolver("workflows"));
   ```
   The test suite asserts these are byte-equal to renderer output. This is the linchpin that makes the fresh project type-check: the dropped `_cove/*` are reconstructed to point at the *user's own* `../agentRegistry.ts`/`../workflowRegistry.ts`.
7. **Write scaffolding** (`writeScaffolding`): `package.json`, `cove.config.ts`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`.
8. **`printNextSteps`** to stderr.

#### Why regenerate codegen instead of copying it

The framework repo's own `convex/_cove/*.ts` are **hand-authored demo wiring** (an inline `demo`/`echo` registry) — shape-compatible with, but textually different from, renderer output. Copying them into a user project would wire the user's app to a demo registry. Excluding them at both tarball time and copy time, then regenerating from the *user's* appended registries via the identical pure renderers, guarantees the fresh project is self-consistent and type-checks. Generalize: **any per-project generated artifact must be excluded everywhere and reproduced from the consumer's own inputs by the same generator your build uses.**

#### The generated project `package.json` (`buildProjectPackageJson`)

```jsonc
{
  "name": "<sanitized-basename>",       // lowercased; [^a-z0-9._-]→'-'; fallback "cove-app"
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "cove dev",
    "build": "cove build",
    "deploy": "cove deploy",
    "convex": "convex dev"
  },
  "dependencies": {
    "@cove-framework/cove": "^<pkg.version>",
    // ...ALL of cove's own `dependencies` copied in, sorted
  },
  "devDependencies": {
    // whichever of typescript, tsx, @types/node, @types/js-yaml exist in cove's devDeps, sorted
  }
}
```

The crucial move: the generated `dependencies` includes `@cove-framework/cove` **plus a copy of every one of cove's own runtime `dependencies`** (`convex`, `ai`, `@ai-sdk/*`, `@convex-dev/workflow`, `js-yaml`, …). This is because the **vendored backend source** imports those packages directly from the user's project — they must be the user project's *own* direct dependencies, not relied upon via hoisting from the framework's `node_modules`. If you vendor source, you must re-declare that source's transitive direct deps in the generated manifest, or the user's project won't resolve them.

`devDependencies` cherry-picks `typescript`, `tsx`, `@types/node`, `@types/js-yaml` from cove's devDeps when present — `@types/js-yaml` specifically because the vendored `src/runtime/skill-frontmatter.ts` imports `js-yaml`, which ships no bundled types.

#### Other scaffolded files (verbatim where load-bearing)

`cove.config.ts` (dogfoods the `./cli` surface):
```ts
import { defineCoveConfig } from "@cove-framework/cove/cli";

// Cove project configuration. `cove dev`/`build`/`deploy` read this.
export default defineCoveConfig({
  convexDir: "convex",
});
```

`tsconfig.json` is tuned for the vendored layout — close to the framework's own, but not identical (the generated one has a smaller `include` and omits the framework's `ignoreDeprecations`): `target/module: ESNext`, `moduleResolution: "Bundler"`, `allowImportingTsExtensions: true`, `verbatimModuleSyntax: true`, `noEmit: true`, `strict: true`, `skipLibCheck: true`, `isolatedModules: true`, `types: ["node"]`, include `["src/**/*.ts", "src/**/*.tsx", "convex/**/*.ts", "cove.config.ts"]`, exclude `["node_modules"]`. The user project gets the *same* `allowImportingTsExtensions` posture so the vendored `.ts`-specifier imports resolve.

`.gitignore`: `node_modules/`, `convex/_generated/`, `.convex/`, `.env`, `.env.local`, `.env.*.local`, `*.log`, `.DS_Store`, `dist/`. Note `convex/_generated/` is git-ignored — it's regenerated by `npx convex dev`, the same reason it's stripped from the tarball.

`.env.example`: comments only, instructing that provider keys / auth secrets belong in the **Convex deployment env** (`npx convex env set`), not a local file. Commented placeholders: `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`.

The resulting fresh project:

```
<project>/
  convex/                  # vendored, user-owned, deploys to Convex
    agentRegistry.ts       # vendored + appended `export const registry`
    workflowRegistry.ts    # vendored + appended `export const workflows`
    http.ts, schema.ts, auth.ts, ...
    _cove/                 # REGENERATED (not copied)
      agentResolver.ts
      workflowResolver.ts
    # _generated/ and __tests__/ are NOT copied (Convex regenerates _generated)
  src/runtime/             # vendored V8-safe core (no __tests__, no *.test.ts)
  cove.config.ts           # generated
  package.json             # generated
  tsconfig.json            # generated
  .gitignore  .env.example  README.md   # generated
```

### The publish flow

```bash
# 1. Local tarball preview — prepack runs `npm run build` automatically first.
npm pack

# 2. Audit the exact tarball contents BEFORE publishing.
npm pack --dry-run        # lists every file npm would ship, no tarball written

# 3. Publish — prepublishOnly gates (build + tsc --noEmit + vitest run);
#    publishConfig.access=public makes the scoped publish public.
npm publish
```

The two gates do different jobs:

- **`prepack`** guarantees `dist/` is freshly built into *any* tarball (`npm pack` and `npm publish` both trigger it).
- **`prepublishOnly`** is the publish-only quality gate: full build + typecheck + tests. A red test blocks the publish.

#### `npm pack` leak audit

Because this tarball ships **source trees** (`convex/`, `src/runtime/`), the leak surface is larger than a normal `dist`-only package. Always audit `npm pack --dry-run` for:

- **Test files** under the included source dirs — must be absent (`__tests__/`, `*.test.ts`).
- **Sourcemaps** (`*.map`) — must be absent.
- **Per-project generated dirs** — `convex/_generated/**` and `convex/_cove/**` must be absent (the demo `_cove/*` resolvers in particular must NOT leak, or every consumer inherits demo wiring).
- **The four `dist/` surfaces** + `dist/bin/cove.js` + shared `dist/chunk-*.js`/`*.d.ts` chunks — must be present.
- **No brand leak** — for a rewrite (Cove was a rewrite of "flue"), grep the tarball to confirm no predecessor brand strings ship. The init test suite asserts no flue-brand leak in the scaffold output.

If any test/map/generated file appears, the fix is always a negation glob *inside `files`* — never a `.npmignore`, which cannot re-exclude a `files`-included directory.

### Non-obvious gotchas (with fixes)

1. **`tsc` can't emit under `allowImportingTsExtensions` + `.ts`-specifier imports.**
   *Symptom:* `tsc` produces no JS / errors when emit is requested. *Cause:* the flag pairs with `noEmit: true`; literal `.ts` import specifiers are illegal to emit. *Fix:* build with **tsup/esbuild** (rewrites `.ts`→`.js`, emits `.d.ts`); keep `tsc` as `--noEmit` typecheck only. Documented in `tsup.config.ts` and `bin/cove.ts` headers.

2. **`tsup`'s `.d.ts` pass needs `ignoreDeprecations: "6.0"`.**
   *Symptom:* the dts build fails on a `baseUrl`-style behavior that TypeScript 6.0 flags as deprecated. *Cause:* `typescript` devDep is `^6`. *Fix:* set `"ignoreDeprecations": "6.0"` in `tsconfig.json` to suppress the would-be error so the dts build passes.

3. **`@types/js-yaml` must be a dev dependency even though `js-yaml` is a runtime dep.**
   *Symptom:* typecheck fails resolving types for `js-yaml`. *Cause:* `js-yaml@^4.2.0` ships no bundled types. *Fix:* add `@types/js-yaml@^4.0.9` to `devDependencies` — and propagate it into the *generated* project's devDeps (init does), because the vendored `skill-frontmatter.ts` imports `js-yaml`.

4. **Scoped name, short command.**
   *Symptom:* the bare name (`cove`) is squatted on npm. *Fix:* publish as `@scope/name` (`@cove-framework/cove`) but keep `bin: { "cove": "./bin/cove.mjs" }` so the CLI command stays short. Scoping the package doesn't dictate the command name.

5. **Scoped packages publish private by default.**
   *Symptom:* `npm publish` errors or produces a restricted package. *Fix:* `publishConfig: { "access": "public" }` in the manifest (or `--access public` every time, which is forgettable).

6. **An `exports` map forbids deep imports — including `package.json`.**
   *Symptom:* tooling can't resolve `<pkg>/package.json` under the strict `exports` gate. *Fix:* add `"./package.json": "./package.json"` to `exports`.

7. **`.npmignore` cannot carve sub-paths out of a `files`-included directory.**
   *Symptom:* tests/maps/generated files leak into the tarball despite a `.npmignore`. *Cause:* a directory in `files` is included wholesale. *Fix:* put negated globs (`!**/__tests__/**`, `!**/*.test.ts`, `!**/*.map`, `!convex/_generated/**`, `!convex/_cove/**`) **inside the `files` array**.

8. **The compiled bin can't reliably fs-read `package.json` for its version.**
   *Symptom:* the version path shifts under `dist/`. *Fix:* inject `define: { __COVE_VERSION__: JSON.stringify(pkg.version) }`, declare `declare const __COVE_VERSION__` as an ambient global so `tsc` passes, and keep an fs-read fallback for the `tsx` source-checkout path.

9. **The Node-version floor is stricter than `engines` can express.**
   *Symptom:* `engines.node: ">=22.18"` would (wrongly) admit Node 23.0–23.5, which lack default TS type-stripping. *Fix:* a runtime gate in `bin/cove.mjs` that rejects 23.0–23.5 via `(major !== 23 || minor >= 6)`. The shim's human label `">=22.18 or >=23.6"` deliberately differs from the coarser `engines` value — keep both, and don't try to make `engines` carry the gap rule.

10. **A naive `bin` pointing at compiled JS breaks source checkouts; pointing at TS breaks published installs.**
    *Fix:* a plain-JS launcher shim that probes `fs.existsSync(dist/bin/cove.js)` and dispatches to the compiled CLI when present, else `tsx bin/cove.ts`. The shim uses only universally-available JS so it runs on any supported Node before the real CLI loads.

11. **Vendored source needs its own direct deps re-declared.**
    *Symptom:* a fresh `cove init` project fails to resolve `convex`/`ai`/etc. *Cause:* vendored backend source imports them directly; hoisting from the framework's `node_modules` is not guaranteed. *Fix:* the generated `package.json` copies *all* of the framework's runtime `dependencies` into the user project's `dependencies` (alongside `@cove-framework/cove` itself).

12. **Don't ship per-project generated code; regenerate it.**
    *Symptom:* the framework's own `_cove/*` are demo wiring; shipping/copying them wires the user to a demo registry. *Fix:* exclude `convex/_cove/**` and `convex/_generated/**` from both the tarball (`files` negation) and the `init` copy filter, then regenerate `_cove/*` in the user project from the user's own registries via the identical pure renderers (`renderAgentResolver`/`renderWorkflowResolver`). Convex's `_generated/` is reproduced by `npx convex dev`.

### Checklist — adapt this to your framework

**Decide the two halves.**
- [ ] Identify which code is **importable** (client/authoring/CLI surfaces → Model A) vs. **un-importable** because it must live in the consumer's own `convex/` (backend → Model C, vendored).
- [ ] Put the un-importable trees under stable source paths (Cove: `convex/`, `src/runtime/`).

**Model A — the library build.**
- [ ] Choose tsup/esbuild if your source uses `allowImportingTsExtensions` + `.ts` specifiers (tsc can't emit). Otherwise tsc is an option.
- [ ] One tsup entry per public surface + one for the CLI bin; entry keys = `dist/` sub-paths.
- [ ] `format: ["esm"]` to match `"type": "module"`; `dts: true`; `splitting: true` if surfaces share a core; `sourcemap: true`; `clean: true`; `target` = your Node floor.
- [ ] Inject the version with `define` + an ambient `declare const` + an fs-read fallback.

**The manifest.**
- [ ] `exports` map: `types` before `import` per entry; add `"./package.json": "./package.json"`; no `require`/root unless you truly support them.
- [ ] `files`: positively list `dist`, `bin`, your vendored source trees, `README.md`; then negate `!**/__tests__/**`, `!**/*.test.ts`, `!**/*.map`, and every per-project generated dir — **inside `files`, not `.npmignore`**.
- [ ] `bin` → a plain-JS launcher shim (compiled-vs-source dispatch + Node-version gate + exit forwarding), not the compiled JS or TS directly.
- [ ] Scoped name if the bare name is taken; `publishConfig.access=public`; `engines.node`; mark single-surface deps as optional peers.
- [ ] devDeps for any runtime dep that ships no types.

**Model C — the init scaffold.**
- [ ] `findPackageRoot()` by your package name so init can copy out of the install.
- [ ] Vendor the backend trees with a copy filter that drops generated + test files (mirror the `files` negations).
- [ ] Append starter registries/config to the vendored files.
- [ ] **Regenerate** all per-project codegen from the user's inputs using the *same* renderers your build uses — never copy snapshots.
- [ ] Generate a project `package.json` that declares `@your/framework` **plus all of the framework's runtime deps** (vendored source needs them as the user's direct deps), and cherry-picks the relevant devDeps.
- [ ] Generate `cove.config.ts`-equivalent, a matching `tsconfig.json`, `.gitignore` (ignore regenerated dirs), and a secrets-aware `.env.example`.
- [ ] Guard with a `--force` / non-empty-dir check.

**Publish.**
- [ ] `prepack` → build (guarantees `dist/` in the tarball).
- [ ] `prepublishOnly` → build + typecheck + tests (publish gate).
- [ ] Audit `npm pack --dry-run`: surfaces present, tests/maps/generated absent, no demo/predecessor-brand leak.

---

Files referenced: `/root/projects/harness-engine/cove-harness/package.json`, `/root/projects/harness-engine/cove-harness/tsup.config.ts`, `/root/projects/harness-engine/cove-harness/tsconfig.json`, `/root/projects/harness-engine/cove-harness/bin/cove.mjs`, `/root/projects/harness-engine/cove-harness/bin/cove.ts`, `/root/projects/harness-engine/cove-harness/src/cli/commands/init.ts`, `/root/projects/harness-engine/cove-harness/src/cli/codegen/generate-agent-registry.ts`, `/root/projects/harness-engine/cove-harness/src/cli/codegen/generate-workflow-registry.ts`, `/root/projects/harness-engine/cove-harness/dist/bin/cove.js`.

---

## 4. Architecture Deep-Dive

### The 3-Layer Split

Cove is physically and logically split into three layers, separated by a strict, one-directional import rule. Understanding this split is the single most important thing for a contributor or integrator: it is what keeps the durable backend deployable to Convex's V8 runtime while still letting agent authoring happen against a portable, AI-SDK-aware surface.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ LAYER 3 — Consumer / authoring surfaces (published from @cove-framework/cove)  │
│                                                                                │
│   src/sdk   (./sdk)     src/react  (./react)     src/cli  (./cli, `cove` bin)  │
│   — inspect/invoke      — React hooks            — init / dev / build / deploy │
│                                                    + pure codegen renderers    │
└──────────────────────────────────────────────────────────────────────────────┘
        │ imports                         ▲ scaffolds (cove init vendors trees)
        ▼                                 │
┌──────────────────────────────────────────────────────────────────────────────┐
│ LAYER 1 — src/runtime  (pure, V8-safe core; published as ./runtime)            │
│                                                                                │
│   createAgent · defineAgentProfile · defineTool · createCoveContext            │
│   types.ts · errors.ts · messages.ts · session-history.ts · compaction.ts      │
│   channels/slack.ts (pure verify) · http.ts (CoveHttpError) · skill-frontmatter│
│                                                                                │
│   NO "use node". NO Convex. NO AI SDK calls. Portable, ported from @flue/runtime│
└──────────────────────────────────────────────────────────────────────────────┘
        ▲ imports ONLY from src/runtime
        │
┌──────────────────────────────────────────────────────────────────────────────┐
│ LAYER 2 — convex/  (backend adapter; deploys to Convex; ONLY home of "use node")│
│                                                                                │
│   schema.ts (10 tables) · workflow.ts · convex.config.ts                       │
│   invoke/{admit,submit} · engine/{runHandler,loop,setup,llmStep,decode,        │
│     dispatchTools,finalize,compact,approvals,task,steps,...}                    │
│   sessions/ · sandbox/ · events/ · channels/ · providers/ · http.ts            │
│   agentRegistry.ts · workflowRegistry.ts · _cove/ (codegen sidecars)           │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 1 — `src/runtime` (pure, V8-safe core)

`src/runtime/` is a portable core ported from "flue" (`@flue/runtime`). It contains no `"use node"` directives, no Convex imports, and makes no live AI-SDK calls. It is published verbatim from `@cove-framework/cove/runtime` (re-exporting `src/runtime/index.ts`). Its value exports are the authoring primitives and error classes:

```ts
// from "@cove-framework/cove/runtime"
import {
  createAgent, defineAgentProfile, defineTool, createCoveContext,
  CoveError, ToolInputValidationError, ModelNotConfiguredError, /* ...error classes */
} from "@cove-framework/cove/runtime";
```

Because it is pure, this layer holds the deterministic logic that both the durable backend and the unit tests depend on: the agent loop's contracts (`types.ts`), the session/entry model (`session-history.ts`, including `buildContextEntries()`), and pure compaction preparation (`compaction.ts`, e.g. `prepareCompaction`, `shouldCompact`, `serializeConversation`). The pure Slack signature verifier (`src/runtime/channels/slack.ts` → `verifySlackSignature`) and the HTTP error hierarchy (`src/runtime/http.ts` → `CoveHttpError` and `renderHttpError`) also live here.

#### Layer 2 — `convex/` (backend adapter)

`convex/` is the backend that actually deploys to Convex, and it is the **only** layer where `"use node"` appears (Layers 1 and 3 never use it). The directive is *widespread* here — roughly **54 of the ~80 backend modules** carry it, because most backend logic runs as Node *actions*: the LLM/decode/dispatch/compact steps (`engine/llmStep.ts`, `engine/decode.ts`, `engine/dispatchTools.ts`, `engine/compact.ts`), the providers (`providers/gateway.ts`, `providers/index.ts`, `providers/messages.ts`, `providers/thinking.ts`, `providers/testModel.ts`), the sandbox adapters (`sandbox/localBash.ts`, `sandbox/upstashBox.ts`, `sandbox/index.ts`), and the channel/MCP/persistence modules. The load-bearing invariant is at the *other* end: the **durable orchestration is deliberately kept V8-only** — `convex/workflow.ts`, `convex/engine/runHandler.ts`, and the pure orchestrator `convex/engine/loop.ts` carry no `"use node"` directive (the string only appears in their comments) — so a crash/replay deterministically reconstructs the same journaled branch, while the Node/AI work is pushed down into the actions those modules invoke.

The strict import rule for this layer is: **`convex/` imports ONLY from `src/runtime`.** It never reaches into `src/sdk`, `src/react`, or `src/cli`. The CLI barrel enforces the same boundary from the other side — `src/cli/index.ts` intentionally does NOT import the runtime barrel, to keep the pure-runtime boundary from leaking into CLI process globals.

#### Layer 3 — `src/sdk` + `src/react` + `src/cli` (consumer/authoring surfaces)

These are the surfaces a consuming engineer touches. They are published as subpath exports — there is **no root export**:

```jsonc
// package.json → exports (each subpath is a { types, import } conditions object; "./package.json" is also exported)
"./runtime": { "types": "./dist/runtime/index.d.ts", "import": "./dist/runtime/index.js" },
"./sdk":     { "types": "./dist/sdk/index.d.ts",     "import": "./dist/sdk/index.js" },
"./react":   { "types": "./dist/react/index.d.ts",   "import": "./dist/react/index.js" },
"./cli":     { "types": "./dist/cli/index.d.ts",     "import": "./dist/cli/index.js" }  // cove.config.ts imports defineCoveConfig from here
```

`./cli` also backs the `cove` bin (`bin.cove` → `./bin/cove.mjs`). The SDK exposes an inspect surface; the live SDK inspect functions (`runs.get`/`listRuns` in `convex/runs.ts`) currently serve an `agentRequests` fallback because nothing writes the `runs` table yet (see schema notes below).

> For the full `src/sdk` and `src/react` public API — the client factory, the hooks, and their exact signatures — see §2.8–2.10 in the Adoption Guide.

#### Why the two-half packaging exists

Cove ships as two coupled halves because **Convex deploys functions only from the consumer's own `convex/` directory** — the backend cannot be an ordinary npm import. So `@cove-framework/cove` ships `convex/` and `src/runtime/` as *source* inside the tarball (`package.json` `files` includes them, with `!convex/_generated/**` and `!convex/_cove/**`), and `cove init` **vendors** those two trees into a new project where the user owns them. The published `dist/` (built by tsup) only contains the Layer-3 surfaces plus `bin/cove` — tsup explicitly does NOT build `convex/**`.

### The Durable Workflow Engine

The backend is built on `@convex-dev/workflow` (`^0.3.12`). The component is registered once in `convex/convex.config.ts`:

```ts
import workflow from "@convex-dev/workflow/convex.config";
import { defineApp } from "convex/server";
const app = defineApp();
app.use(workflow);
export default app;
```

and instantiated as a plain V8 module in `convex/workflow.ts`:

```ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";
export const workflow = new WorkflowManager(components.workflow);
```

The durable run is defined in `convex/engine/runHandler.ts` as `agentRun = workflow.define(...)`. Every `step.run*` call inside it is a **journaled checkpoint**: a crash or redeploy resumes from the last committed step, and on replay each dep returns its cached journal result so the same branch reconstructs deterministically. The orchestration shape is:

```
setup → ( llmStep → [HITL park/await/apply] → dispatchTools )* → finalize
```

#### The pure orchestrator (`convex/engine/loop.ts`)

The control flow itself is pulled out into `runAgentLoop(plan: LoopPlan, deps: RunLoopDeps): Promise<void>` — pure and V8-safe (no Convex, no AI SDK) so it unit-tests against mocks. `runHandler.ts` supplies the `deps`, each wiring a loop operation to a journaled `step.run*`:

| loop dep | journaled step |
|---|---|
| `decode(stepNumber)` | `step.runAction(internal.engine.llmStep.run)` |
| `dispatch(stepNumber)` | `step.runAction(internal.engine.dispatchTools.run)` |
| `getOutcome()` | `step.runQuery(internal.engine.steps.getOutcome)` |
| `appendFollowUp(prompt)` | `step.runMutation(internal.engine.steps.appendFollowUp)` |
| `finalize(input)` | `step.runMutation(internal.engine.finalize.run)` |
| `compact(stepNumber)` | `step.runAction(internal.engine.compact.compact)` |
| `resolveApprovals(stepNumber, gatedCalls)` | `park` → `step.awaitEvent(...)` → `applyApproval` |

The loop is `while (stepNumber < plan.maxSteps)`. Each iteration decodes one step; if there are no tool calls it finalizes (free-form runs complete with `decision.text`; result-schema runs consult `settleResultRun`/`getOutcome`). If there are tool calls, it filters `c.isHitl` and awaits approvals before dispatch, then dispatches, then (threshold mode) compacts if `decision.shouldCompact` before the next decode. Falling out of the `while` (cap reached) finalizes `failed`/`step_limit_exceeded`.

#### Durability / replay invariants

These are load-bearing guarantees, taken verbatim from source:

- Every `step.run*` is a journaled checkpoint → a crash/redeploy resumes from the last committed step.
- **The model is called at most once per *finalized* step** (the replay guard in `decode.ts`: `const existing = await deps.loadStep(); if (existing?.isFinalized) return reconstructDecision(existing, deps);`).
- Step cap default **100** → `finalize failed/step_limit_exceeded`.
- Result re-nudge budget default **32** → `finalize failed/result_followups_exhausted` + `ResultUnavailableError`.
- `DurabilityConfig` defaults: `maxAttempts` 10, `timeoutMs` 3,600,000 (1h), `maxSteps` 100, `maxFollowUps` 32.

`agentRun`'s top-level try/catch swallows `ResultUnavailableError` (the request is already finalized failed) but rethrows other errors, and after finalize runs a journaled, replay-idempotent `step.runAction(internal.channels.reply.dispatch, { requestId })` (a no-op for native/HTTP runs).

### Schema as System-of-Record + Reactive Transport (No SSE)

`convex/schema.ts` is the system of record. flue's monolithic `SessionData` v6 blob (an entry *tree* + leaf cursor + task-session refs) is decomposed into **10 relational tables**. Two shared validators sit at the top: `frozenPlanValidator` (the resolved agent plan snapshotted at admission — `model`, `instructions`, `systemPrompt`, `thinkingLevel`, `compaction`, `durability`, `maxSteps`, `maxFollowUps`, tool *descriptors* only, `skills`, `subagents`, `cwd`, `resultSchema`, `approvalTools`) and `usageValidator` (full `PromptUsage` with nested `cost`).

| # | Table | Purpose |
|---|---|---|
| 1 | `sessions` | one row per session header; tuple `(instanceId, harnessName, sessionName)` is the stable lookup key; holds `leafId`, `taskSessions[]`, `state`, frozen `plan` |
| 2 | `sessionEntries` | one row per entry-tree node (`message` \| `compaction`); stored flat, active path rebuilt in app logic; images hoisted to `imageChunks` |
| 3 | `agentRequests` | one row per admitted turn; drives the workflow; carries `submissionId`, `status`, `finalText`, `result`, `convexWorkflowId`, usage rollups |
| 4 | `agentRequestSteps` | one row per loop step; **the streaming substrate AND finalized step data** |
| 5 | `runs` | top-level run inspect surface; nothing writes it yet — `runs.get` falls back to the `agentRequests` view |
| 6 | `events` | durable + reactive `CoveEvent` log (the `observe()` substitute); per-`streamKey` `seq` |
| 7 | `approvals` | HITL gates; `pending`/`approved`/`rejected` |
| 8 | `skills` | knowledge catalog the skill tool reads at runtime |
| 9 | `imageChunks` | content-addressed image blob store (refCount, inline base64 or `_storage`) |
| 10 | `meta` | schema-version / kv (also the channel dedup ledger) |

#### The reactive transport: `agentRequestSteps` replaces SSE

The pivotal design decision: **there is no SSE and no streaming HTTP GET.** The `agentRequestSteps` table doubles as the streaming substrate. During a decode, `decode.ts` streams the model's `fullStream` and a `DeltaBatcher` patches the `text`/`reasoning` columns roughly 10–20 times per turn (`patchStreaming` appends coalesced deltas: `row.text + text`). Clients observe progress purely through Convex's reactivity:

```ts
// native client — reactive, no SSE
const snap = useQuery(api.requests.get, { requestId });
// → { submissionId, status, finalText, result, error, cancelReason,
//     usage, totalTokens, totalSteps, totalToolCalls, durationMs }
// watch status flip to "completed" | "failed" | "cancelled"
```

The `events` table is the second reactive channel — a durable `CoveEvent` log keyed by `streamKey` (`runId`, `instanceId`, or `${instanceId}:${session}`) with a monotonic `seq` per key. Image content blocks in events keep `mimeType` but carry `IMAGE_DATA_OMITTED`.

### Registries + Codegen

#### Why registries are Convex-app-bound

Agents and workflows are made addressable by name through registries that are **deliberately not in the runtime barrel** — they live in `convex/agentRegistry.ts` and `convex/workflowRegistry.ts` and are Convex-app-bound. The runtime barrel exports `createAgent`/`defineTool`/etc., but `defineAgentRegistry`, `registerAgentRegistry`, `getRegisteredAgent`, `defineWorkflowRegistry`, and `defineWorkflow` are imported relatively in app code (e.g. `convex/_cove/agentResolver.ts` does `import { defineAgentRegistry, registerAgentRegistry } from "../agentRegistry.ts"`).

```ts
// convex/agentRegistry.ts — the addressing surface
defineAgentRegistry(map: Record<string, CreatedAgent>): AgentRegistry
registerAgentRegistry(registry: AgentRegistry): void
getRegisteredAgent(name: string): CreatedAgent | undefined   // setup.run resolves here
```

`defineAgentRegistry` validates the map is a non-array object, every key matches `/^[A-Za-z][A-Za-z0-9_-]*$/`, and every value carries the `__coveCreatedAgent === true` brand, then freezes a copy. The workflow registry mirrors this for `WorkflowHandler = (ctx, input) => TResult | Promise<TResult>`.

#### The `_cove` resolvers and the tsx registry-loader

`cove build`/`cove dev` perform pure, byte-stable codegen that installs the registry seams. Two jobs:

1. **Load + validate** the user's `convex/agentRegistry.ts` and `convex/workflowRegistry.ts`. To avoid dragging Convex module globals into the CLI process, `src/cli/codegen/registry-loader.ts` isolates the import in a short-lived `tsx` child (`spawn(process.execPath, [tsxBinaryPath(), importerPath, kind, file])`). The child `import()`s the registry via a `file://` URL, runs `validateAgentRegistry`/`validateWorkflowRegistry` *where the live objects exist*, and reports back a single JSON stdout line: `{ ok: true, names: [...], exportName }` or one `[cove]` diagnostic. Export discovery is duck-typed (a registry has `get`/`has` functions and an array `names`) over preferred names `["registry","agents","default"]` (agents) / `["workflows","registry","default"]` (workflows).

2. **Render** two sidecar resolvers. `renderAgentResolver(exportName)` is deterministic and byte-stable — it imports the registry *wholesale* (no per-name interpolation):

   ```ts
   // convex/_cove/agentResolver.ts (auto-generated; do not edit)
   import { registerAgentRegistry, registry } from "../agentRegistry.ts";
   registerAgentRegistry(registry);
   export { getRegisteredAgent, listRegisteredAgents } from "../agentRegistry.ts";
   ```

   `renderWorkflowResolver` follows the same pattern (`registerWorkflowRegistry` + re-export `getRegisteredWorkflow`). Workflows are kept OUT of the agent resolver (D18 — a workflow run is a distinct `kind:"workflow"` run). Both emitted files are pure: no `"use node"`, no box, no LLM. The side-effect import installs the registry seam at module load — codegen injects these resolver imports into `convex/http.ts` for scaffolded projects (in the framework's own dev app, the agent resolver is instead installed via a side-effect import in `convex/engine/setup.ts`).

Codegen also patches `convex/http.ts` to install the resolver imports and bind the `POST /workflows/:name` route (two modes: *validated* — don't overwrite when `convex/app.ts` exists or the `// cove:user-authored` marker is present; otherwise *patched*). Idempotency is guaranteed by `writeIfChanged` (content-compare → 0 files written on a no-op rebuild, so `convex dev`'s watcher does not churn). `cove dev` re-codegens on a 150ms-debounced watcher over the config + the two registry files; `cove deploy` is fail-closed (full `build` with `tsc --noEmit` first; `convex deploy` spawns only on success).

### Providers (AI Gateway)

Model specifiers are `'<provider>/<model>'` strings (or `false` to force call-level selection). They resolve through `resolveModel(model)` in `convex/providers/gateway.ts` (`"use node"`, imports `@ai-sdk/gateway`), in this order:

1. `false`/`undefined` → `undefined`.
2. **Mock seam first** — `isTestModelId(...)` → `makeTestModelHandle()` (bypasses the slash split; the reserved test model is `cove-test/mock`).
3. Split on the first `/`; no slash → throws a `"provider-id/model-id"` format error.
4. **Module-scoped registry** (`resolveRegisteredModel`) — registry wins over catalog.
5. Else the **built-in capability catalog** (`convex/providers/capabilities.ts`, V8-safe, no AI SDK) via `lookupCaps`, plus a Vercel AI SDK gateway model.

`buildLanguageModel(providerId, modelId)` prefers a custom `getApiProvider(providerId)?.factory(modelId)`, otherwise `gateway(`${providerId}/${modelId}`)`. The catalog (`CAPABILITIES`) carries `ModelCaps` — `contextWindow`, `maxOutputTokens`, `supportsVision`, `supportsReasoning`, `thinkingLevelMap`, and per-1M-token `cost` — for anthropic/openai/google/bedrock model subsets. An unknown model resolves to `contextWindow: 0`, which compaction treats as "unknown window" (threshold disabled). `hasCredentialsFor(providerId)` reads `process.env` for diagnostics only — `resolveModel` does NOT gate on credentials (the gateway surfaces credential errors at request time). Crucially, the registry maps are **empty on every cold action boot** (re-imported per isolate); the generated app entry / tests re-apply registrations. Default model fallbacks: admission/setup use `"cove-test/mock"`; the compaction summarizer defaults to `"anthropic/claude-haiku-4-5"`.

### Channels

The generic `POST /channels/:name` webhook route resolves an adapter from `channelRegistry` (`convex/channels/index.ts`, keyed `slack`, `github`, `teams`, `discord`, `telegram`, `linear`, `notion`, `google-chat`) and runs the **shared inbound pipeline** `verifyThenAdmit(ctx, adapter, req)`:

```
read-raw-bytes-once → runAuthorize → verify (401) → handshake/ignore → dedup → submit → ack
```

The ordering is deliberate: `const rawBody = await req.text()` reads bytes once (re-serializing JSON would break HMAC/Ed25519/JWT); `runAuthorize` runs the framework gate *before* verify/admission; dedup (`markWebhookSeen`, idempotent over the `meta` table via `dedupKey(provider, eventId)`) happens *before* admit. All adapters share one `ChannelAdapter` contract (`verify(req, rawBody)` → `VerifyResult`, `mapPayload(parsed, req)` → `submit`|`handshake`|`ignore`, `postReply(replyContext, terminal)`). The Slack adapter verifies HMAC-SHA256 over `v0:{ts}:{body}` with a ±300s replay window and a constant-time compare. Outbound replies are deferred: `convex/channels/reply.ts` `dispatch` is the journaled `step.runAction(internal.channels.reply.dispatch)` fired *after* finalize (never in the ~3s ack window), guarded for missing `replyContext` (native/HTTP), `repliedAt` (replay double-post), and non-terminal status, then `markReplied` stamps `repliedAt` for exactly-once delivery.

### The Sandbox Seam (`@upstash/box`)

Tool execution runs against a `SessionEnv` produced by a `SandboxFactory` — a single seam behind which any sandbox mode plugs in:

```ts
// src/runtime/types.ts
export interface SandboxFactory {
  createSessionEnv(options: { id: string }): Promise<SessionEnv>;  // id = ctx.id
  tools?: SessionToolFactory;
}
```

`SessionEnv` is the universal env every mode implements: `exec(command, { cwd?, env?, timeoutMs?, signal? })`, the fs ops (`readFile`/`writeFile`/`stat`/`readdir`/`exists`/`mkdir`/`rm`/…), `cwd`, and `resolvePath`. `timeoutMs` is the **primary cancellation contract** (adapters round up, never down); `signal` is optional. The pure scaffolding in `convex/sandbox/sessionEnv.ts` (no `"use node"`) supplies `resolveWithinWorkspace` (rejects `../` escapes with `SandboxOperationUnsupportedError` — a correctness delta vs flue), `createCwdSessionEnv` (routes every method through the resolver), and `createSandboxSessionEnv` (centralizes pre/post abort checks because most provider SDKs, including `@upstash/box`, don't accept an `AbortSignal`).

The **default** adapter is the in-process `localBash` (`convex/sandbox/localBash.ts`, `"use node"`): `nodeBashLike(cwd)` over `spawn("bash", ["-lc", command], ...)` + `fs/promises`, wrapped in `createCwdSessionEnv`. `dispatchTools.resolveSandbox(sessionId, cwd)` currently hardcodes it (`mkdir(cwd ?? /tmp/cove-workspace/<sessionId>)` then `localBash({cwd}).createSessionEnv({id:sessionId})`).

`@upstash/box` (`^0.4.4`) plugs in behind the *same* seam via `convex/sandbox/upstashBox.ts` (`"use node"`): `upstashBox(options?)` returns a `SandboxFactory` whose `createSessionEnv({id})` uses `id` as the box `sandboxName`, lazily resolving by name (`Box.list` → match → `Box.get`, else `Box.create({ name, keepAlive: true, size })`) with a per-action warm-handle cache and box-gone re-resolve. `exec` base64-encodes a script and runs it under `timeout <ceilSecs>s bash -lc "$(... base64 -d)"` (the coreutil `timeout`, because `exec.command` has no native timeout); `stat`/`exists`/`mkdir`/`rm` are shelled out via `box.exec.command`. `UpstashBoxClient` is an injectable seam (default = real `Box`) so tests substitute an in-memory fake. **Swapping the engine's `resolveSandbox` from `localBash` to `upstashBox(...)` is the documented integration point — both return a `SandboxFactory`/`SessionEnv`, so no loop semantics change.**

### End-to-End: A Single Prompt, Client → Durable Run → Reactive Result

The walk below traces one prompt from a client call through admission, the durable loop, and the reactive result. All admission paths (native, HTTP `POST /agents/:name/:id`, and channel webhooks) converge on `api.invoke.submit.submitPrompt` → `admitPrompt`.

```
CLIENT                          ADMISSION (mutation)            DURABLE WORKFLOW (agentRun)              REACTIVE RESULT
──────                          ────────────────────            ──────────────────────────              ───────────────
                                convex/invoke/{submit,admit}    convex/engine/runHandler.ts

useMutation(submitPrompt) ─┐
   or                       ├──▶ submitPrompt(args)
POST /agents/:name/:id ─────┤       └─ admitPrompt(ctx,{...})
   or                       │            1. assertPublicSessionName (reject task:*)
POST /channels/:name ──────┘            2. getOrCreateSessionId  ───────────────▶ [sessions row]
  (verifyThenAdmit:                     3. if supersede: cancelActiveRequests("superseded")
   rawBody→authorize→verify             4. insert agentRequests (kind:prompt,
   →dedup→submitPrompt)                    status:pending, model ?? cove-test/mock) ▶ [agentRequests row]
                                        5. appendCanonicalEntry(`u-${requestId}`) ▶ [sessionEntries: user turn]
                                        6. workflowId = workflow.start(
                                              internal.engine.runHandler.agentRun,
                                              { requestId })  ───────────────────────┐
                                        7. patch convexWorkflowId                     │
                                        returns {sessionId,requestId,submissionId}    │
   ◀────────────────────────────────────────────────────────────────────────────────┘ (return)
                                                                  │
   useQuery(api.requests.get,{requestId}) ─── reactive ───┐      ▼ (durable, journaled)
                                                          │   agentRun(step,{requestId}):
                                                          │     ① MCP discovery hop (getMcpServers → discover)
   [streaming: agentRequestSteps.text                     │     ② plan = step.runMutation(setup.run)
    patched 10-20×/turn via DeltaBatcher] ◀───────────────┤          • getRegisteredAgent(target)→initialize→resolveProfile
                                                          │          • freeze sessions.plan; status=running; emit operation_start
   status: "running" ◀────────────────────────────────────┤     ③ runAgentLoop(plan, deps):  while(step<maxSteps):
                                                          │          decode  = step.runAction(llmStep.run)  ["use node", streamed]
                                                          │            └─ replay guard: model called ≤1×/finalized step
                                                          │          [HITL] filter c.isHitl → park → step.awaitEvent → applyApproval
                                                          │          dispatch= step.runAction(dispatchTools.run) [resolveSandbox]
                                                          │          [compact if decision.shouldCompact]
                                                          │     ④ finalize = step.runMutation(finalize.run)
   status: "completed" | "failed" ◀───────────────────────┤          • roll up usage; patch agentRequests; emit idle
   { finalText, result, usage, totalSteps, ... }          │     ⑤ step.runAction(channels.reply.dispatch) [no-op for native/HTTP]
                                                          ┘
HTTP `?wait=result`: pollTerminal(ctx, requestId) loops api.requests.get every 400ms (POLL_DEADLINE 60s) → returns snapshot
```

Step by step:

1. **Client invoke.** A native client calls `api.invoke.submit.submitPrompt` (via `useMutation`), or an HTTP client `POST`s `/agents/:name/:id` (which calls `submitPrompt` with `agent: :name` for registry resolution), or a channel webhook lands on `POST /channels/:name` and runs `verifyThenAdmit` (read-once → authorize → verify → dedup → `submitPrompt`).

2. **Admission (`admitPrompt`, a mutation).** It asserts the session name is public (rejects `task:*`), gets-or-creates the `sessions` row by `(instanceId, harnessName, sessionName)`, supersedes any in-flight requests (`cancelActiveRequests` does `workflow.cancel` + `status:"cancelled"`), inserts the `agentRequests` row (`kind:"prompt"`, `status:"pending"`, `model: args.model ?? "cove-test/mock"`), appends the user turn via `appendCanonicalEntry(`u-${requestId}`, ...)`, then `workflow.start(internal.engine.runHandler.agentRun, { requestId })` and patches `convexWorkflowId`. It returns `{ sessionId, requestId, submissionId, workflowId }` immediately — the run continues durably in the background. (`admitCompact` is the exception: it schedules `compact.compact` via `ctx.scheduler.runAfter(0, ...)` with no workflow.)

3. **The durable run (`agentRun`).** (①) An MCP discovery hop freezes any MCP tools. (②) `setup.run` resolves and **freezes the plan** onto `sessions.plan` — model (`registeredModel ?? request.model ?? session.model ?? "cove-test/mock"`), `systemPrompt` (the `SYSTEM_PREAMBLE` plus instructions), frozen tool *descriptors* (framework/`task`/`activate_skill`/result/MCP — schema only, `execute` rebound per action), derived compaction, `maxSteps`/`maxFollowUps` — sets `status:"running"`, and emits `operation_start`. (③) `runAgentLoop` runs `decode → [HITL] → dispatch → [compact]` over journaled steps; `decode` streams the model and patches `agentRequestSteps.text`/`reasoning` ~10–20×/turn; `dispatch` resolves the sandbox and runs the step's tools (partitioned into `task`, `activate_skill`, and `other`), writing tool-results idempotently. (④) `finalize.run` aggregates usage over `agentRequestSteps`, patches the `agentRequests` terminal fields, and emits `idle`. (⑤) `channels.reply.dispatch` runs (no-op for native/HTTP).

4. **Reactive result.** Native clients have been subscribed to `useQuery(api.requests.get, { requestId })` the whole time — they see `status` flow `pending → running → completed`/`failed`, plus the live `agentRequestSteps` text deltas, with no SSE. HTTP callers either get `{ sessionId, requestId, submissionId }` back immediately, or, with `?wait=result`, `pollTerminal` loops `api.requests.get` every 400ms (`POLL_INTERVAL_MS`) up to a 60s deadline (`POLL_DEADLINE_MS`) and returns `{ sessionId, requestId, submissionId, ...snap }`.

This is the whole point of the architecture: admission is a fast, atomic mutation; execution is a crash-safe journaled workflow; and the result is delivered by Convex reactivity over relational tables rather than a streaming connection.
