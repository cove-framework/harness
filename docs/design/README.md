# cove-harness — Cove Rewrite Plan & Design

A comprehensive plan for rewriting **flue** (the agent harness framework) as
**Cove**, a **Convex-native** product — preserving flue's authoring surface while
replacing the entire engine underneath. (Cove = Con**ve**x + *cove*: the sheltered
harbor where the sandbox does its work. The product is `Cove`; the package is
`@cove/runtime`; the folder stays `cove-harness/`.)

This is the design-of-record. The in-repo [`cove-harness/PLAN.md`](../../PLAN.md)
is the short, build-facing summary; these documents are the long form — the
"why", the data model, the engine, the API contract, and the phase-by-phase
roadmap with acceptance criteria.

## TL;DR

- **Philosophy:** Convex is the entry point and owns the durable agent loop; it
  invokes the LLM, dispatches tool calls into a sandbox scoped to one designated
  workspace folder, watches the results, and decides the next step. Convex
  orchestrates and watches; the sandbox executes; the LLM decides but does not
  control flow. (Formalized in [08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md).)
- **Goal:** keep flue's authoring surface (`createAgent`, `defineTool`,
  `defineAgentProfile`, the `CoveContext` / `CoveHarness` / `CoveSession` types,
  and the consumer SDK) **signature-compatible**, while the implementation
  becomes fully Convex-native.
- **Engine:** flue's in-process `pi-agent-core` `Agent` loop → a **durable
  workflow** (`@convex-dev/workflow`) of `setup → llmStep → dispatchTools →
  finalize` steps.
- **System-of-record:** flue's SQL `SessionStore`/`AgentExecutionStore` →
  **Convex tables** + reactive queries. Convex's reactivity is also the
  streaming transport, so **SSE is gone**.
- **Sandbox:** flue's `SandboxApi`/`bash()` → **`@upstash/box`**, behind the
  unchanged `SandboxFactory` seam.
- **LLM:** flue's `pi-ai` → **AI SDK** (`@ai-sdk/*` gateway). pi's *message
  model* is kept as the internal canonical shape so `SessionData` stays
  wire-compatible; only the provider boundary maps to the AI SDK.
- **New:** **HITL** (human-in-the-loop approval gate) as an additive capability,
  natural on a durable workflow via `awaitEvent`.

## The stack (technology direction)

| Concern | Technology |
| --- | --- |
| Database + realtime + SOR | **Convex** (reactive queries, no SSE) |
| Durable execution | **`@convex-dev/workflow`** |
| Sandbox | **`@upstash/box`** |
| LLM | **AI SDK** (`@ai-sdk/gateway`, `@ai-sdk/anthropic`, `@ai-sdk/google`, …) |
| Schema / validation | **valibot** (ported tool layer) + **zod** (AI SDK) |

## Reading order

1. **[01 — Overview & Goals](01-overview-and-goals.md)** — the thesis, scope, what we keep vs. replace.
2. **[02 — Architecture & Concept Map](02-architecture-and-mapping.md)** — every flue concept → its Convex/Upstash realization.
3. **[03 — Data Model (System-of-Record)](03-data-model-sor.md)** — the Convex schema, indexes, and record lifecycles.
4. **[04 — The Durable Engine](04-durable-engine.md)** — the workflow loop, streaming, abort, and HITL.
5. **[05 — Public API & SDK](05-public-api-and-sdk.md)** — the preserve list, what changes, and the client story.
6. **[06 — Phase Roadmap](06-phase-roadmap.md)** — 12 phases with deliverables, dependencies, and acceptance.
7. **[07 — Risks & Decisions](07-risks-and-decisions.md)** — locked decisions, defaults, and the risk register.
8. **[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md)** — the canonical anchor: naming, the reference-header convention, the orchestration ↔ execution boundary, and the hardened engine contracts.

## Source anchors

- flue runtime: [`flue/packages/runtime/src`](../../../flue/packages/runtime/src) — the surface being preserved.
- flue SDK: [`flue/packages/sdk/src`](../../../flue/packages/sdk/src).
- pi message model: [`pi/packages/ai/src/types.ts`](../../../pi/packages/ai/src/types.ts).
- The new code: [`cove-harness/`](../../) — `src/runtime/` (portable core) + `convex/` (backend).

> Companion deep-dive on how flue is built on pi today: [`documents/start`](../../../documents/start/README.md).
