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

## Status

Early scaffold. Built phase-by-phase per the roadmap in `PLAN.md`. The portable, V8-safe
core (`src/runtime/`) is ported directly from flue (each file notes its flue/pi origin in a
header comment); the Convex backend (`convex/`) is new.

## Layout

- `src/runtime/` — portable pure logic, the public `@cove-harness/runtime` surface.
- `convex/` — the Convex backend: schema (SOR), durable engine, sessions, invoke, sandbox,
  providers, events, HTTP.
- `src/sdk/` — Convex-native consumer client (later phase).
