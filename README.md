# cove-harness

A **Convex-native** rewrite of [flue](../flue), the agent harness framework.

flue's public interfaces (`createAgent`, `defineTool`, `defineAgentProfile`, the
`CoveContext` / `CoveHarness` / `CoveSession` surface) are preserved; the engine
underneath is replaced:

- **Convex DB** is the system-of-record and the realtime transport (no SSE — clients
  subscribe to reactive queries).
- **`@convex-dev/workflow`** runs the agent loop as a durable, crash-recoverable workflow.
- **`@upstash/box`** is the sandbox, behind flue's existing `SandboxFactory` seam.
- **AI SDK** (`@ai-sdk/*` gateway) replaces `pi-ai` for multi-provider LLM calls.

See **[PLAN.md](./PLAN.md)** for the full architecture mapping, locked decisions, module
layout, and phase roadmap.

## Install

Cove ships as **two halves** because a Convex backend can't be an ordinary npm import —
Convex deploys functions from *your own* `convex/` directory.

```bash
# 1. Install the CLI + client surfaces.
npm install @cove-framework/cove

# 2. Scaffold a project (vendors the backend you own + an example agent).
npx cove init my-agent
cd my-agent && npm install
npx convex dev          # link a Convex deployment
npm run dev             # cove dev: codegen + validate, then convex dev
```

- **npm package (`cove`)** — the `cove` CLI plus the client/authoring surfaces, imported via
  subpath exports built to `dist/`:
  - `@cove-framework/cove/runtime` — the V8-safe core (`createAgent`, `defineTool`, types).
  - `@cove-framework/cove/sdk` — the Convex-native consumer client (`createCoveReactiveClient`, no SSE).
  - `@cove-framework/cove/react` — `CoveProvider` + hooks (`useAgentPrompt`, `useCoveRun`, …).
  - `@cove-framework/cove/cli` — `defineCoveConfig` + programmatic build/codegen entry points.
- **`cove init` scaffold** — copies this package's `convex/` engine + `src/runtime/` core into
  your project (you own and deploy them), then writes `cove.config.ts`, a starter
  `agentRegistry.ts`, env/tsconfig, and a README.

Build the package from source with `npm run build` (tsup → `dist/`); `npm pack` produces the
publishable tarball (`prepack` runs the build).

## Status

Early scaffold. Built phase-by-phase per the roadmap in `PLAN.md`. The portable, V8-safe
core (`src/runtime/`) is ported directly from flue (each file notes its flue/pi origin in a
header comment); the Convex backend (`convex/`) is new.

## Layout

- `src/runtime/` — portable pure logic, the public `@cove-harness/runtime` surface.
- `convex/` — the Convex backend: schema (SOR), durable engine, sessions, invoke, sandbox,
  providers, events, HTTP.
- `src/sdk/` — Convex-native consumer client (later phase).
