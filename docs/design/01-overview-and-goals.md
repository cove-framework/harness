# 01 — Overview & Goals

> **Cove** is the Convex-native rewrite of the flue agent-harness framework
> (Con**ve**x + *cove*: the sheltered harbor where the sandbox does its work).
> It keeps flue's authoring/consuming API and replaces the entire engine with a
> Convex backend. For naming, the reference-header convention, and the formal
> execution boundary this overview rests on, see
> [08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md).

## What flue is today

[flue](../../../flue/README.md) is "The Agent Harness Framework." You author an
agent with [`createAgent`](../../../flue/packages/runtime/src/agent-definition.ts),
give it tools, skills, instructions, a model, and a sandbox, and flue gives that
model the environment to do autonomous work: durable **sessions**, **tools**,
**skills**, a **sandbox** to run in, and an HTTP runtime to expose it.

Under the hood flue:

- Embeds pi's low-level, **stateless** `Agent` loop
  ([`pi/packages/agent/src/agent.ts`](../../../pi/packages/agent/src/agent.ts)) for one turn at a time.
- Owns its own **system-of-record** — DB-backed sessions, runs, and an event
  stream — via a pluggable storage contract
  ([`SessionStore`](../../../flue/packages/runtime/src/sql-agent-execution-store.ts),
  [`RunStore`](../../../flue/packages/runtime/src/sql-run-store.ts)).
- Streams activity to clients over **Durable Streams** (SSE-style long-poll).
- Runs model-callable work in a **sandbox** (`SessionEnv`) — local, Daytona, E2B,
  Cloudflare Containers, etc. — behind a `SandboxFactory`.

The full reverse-engineering of this is in [`documents/start`](../../../documents/start/README.md).

## What the rewrite does

Keep the **outside** (the authoring + consuming API), replace the **inside**
(the engine, storage, transport, sandbox, and LLM layers) with a Convex-native
implementation. All new code lives in [`cove-harness/`](../../); the
original [`flue/`](../../../flue/) tree is untouched and remains the reference. The
rewrite is its own product, **Cove**, shipping as `@cove/runtime` — only the
brand-prefixed `Flue*` identifiers rebrand to `Cove*`; the generic verbs and
domain types (`createAgent`, `defineTool`, `SessionEnv`, `SandboxFactory`,
`SessionData`, …) are kept. The full rename table is in
[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md).

### The four substitutions

1. **In-process loop → durable workflow.** flue runs pi's `Agent` loop in
   memory and checkpoints each turn into storage. Cove runs the loop as a
   `@convex-dev/workflow` definition: `setup → (llmStep → dispatchTools)* →
   finalize`. Crash/redeploy resumes from the last committed step instead of
   restarting the turn. See [04 — The Durable Engine](04-durable-engine.md).

2. **SQL stores → Convex tables.** The `SessionData` v6 blob (an entry *tree*)
   and the run/event stores collapse into relational Convex tables that the
   engine reads/writes as scalars and the UI subscribes to reactively. See
   [03 — Data Model](03-data-model-sor.md).

3. **Durable-Streams SSE → Convex reactivity.** Token/tool deltas are written
   into step rows as they arrive; clients **subscribe to a reactive query** and
   Convex pushes every update. No SSE, no reconnect/backoff, no stream offsets on
   the hot path. See [05 — Public API & SDK](05-public-api-and-sdk.md).

4. **pi-ai → AI SDK.** Multi-provider LLM calls move to the AI SDK gateway. pi's
   **message model** ([`pi/packages/ai/src/types.ts`](../../../pi/packages/ai/src/types.ts))
   is retained as the internal canonical shape so the version-6 `SessionData`
   wire format and the pure tree logic survive unchanged; only the provider call
   site converts to/from the AI SDK's `ModelMessage`.

## Architecture Philosophy — the orchestration principle

Cove has one organizing idea: **Convex is the entry point for every agent
execution and owns the durable loop.** Every run starts with a Convex mutation,
and the durable workflow drives the cycle `setup → llmStep → dispatchTools →
finalize`. Convex invokes the LLM, dispatches the model's tool calls into the
sandbox, watches the results (the LLM stream *and* the sandbox output), persists
everything, and decides the next step.

Three actors, one authority:

- The **sandbox executes** but does **not** orchestrate — it runs tools,
  commands, and file ops inside its workspace folder and returns results.
- The **LLM generates** text and tool calls but does **not** control flow — it
  is a pure decision engine, called when Convex asks.
- **Convex orchestrates** all three — it is the only actor that owns the loop,
  the state, and the next-step decision.

This executor/orchestrator/decider split is the source of Cove's durability:
because no orchestration lives in the sandbox or the LLM, both are stateless and
replaceable, and a crash anywhere resumes from Convex's journal. The boundary is
formalized — including which Convex functions may touch the box, and the
per-session **designated workspace folder** the sandbox is scoped to — in
[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md).
The loop mechanics are in [04 — The Durable Engine](04-durable-engine.md).

## Goals

- **G1 — Interface fidelity.** `createAgent`, `defineTool`, `defineAgentProfile`,
  and the entire `CoveContext`/`CoveHarness`/`CoveSession` type contract compile
  and behave the same for agent authors. Existing agent code should port with
  near-zero changes.
- **G2 — Realtime by default.** Every byte of agent progress is a reactive
  Convex read. UIs get live streaming with zero transport code.
- **G3 — Durable by construction.** A turn survives crashes/redeploys because the
  **Convex workflow journal owns crash recovery**: on replay the workflow resumes
  from the last committed step rather than restarting the turn. The sandbox and
  the LLM are **stateless and implement no durability of their own** — persistence
  and recovery are Convex's responsibility alone. flue's bespoke
  turn-journal/lease machinery is not re-implemented. See
  [04 — The Durable Engine](04-durable-engine.md).
- **G4 — Sandbox parity.** The `SandboxFactory`/`SessionEnv` seam is unchanged;
  `@upstash/box` is simply the built-in implementation, and other sandboxes can
  still be plugged in.
- **G5 — Additive HITL.** A first-class approval gate that existing flue lacks,
  without breaking the existing surface.
- **G6 — Extensible by plugin.** An in-process **extensions** subsystem lets authors
  contribute tools, system-prompt fragments, and lifecycle handlers (via
  `defineExtensionRegistry` or an inline profile `extensions` field), with a
  determinism-class contract that keeps the durable loop replay-safe. See
  [08 §4.12](08-conventions-and-execution-boundary.md#412-extensions--the-determinism-class-contract).
- **G7 — Pluggable providers.** Provider behavior is registry-driven
  (`ProviderPlugin` + self-registering built-ins) so new providers and capabilities
  drop in without editing the engine — the legacy hardcoded switch stays only as a
  fallback. See [08 §4.14](08-conventions-and-execution-boundary.md#414-provider-plugins).

## Non-goals (initially)

- **Cloudflare Workers target — dropped.** Cove is **Convex-only**; flue's
  `cloudflare/*` (and `cloudflare-model.ts`) stays **reference-only** and is not
  ported. See the dropped/obsolete list in
  [08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md).
- **Byte-identical interrupted-tool repair.** flue's `classifySubmissionState` /
  `repairInterruptedToolCalls` reconciliation is largely subsumed by the workflow
  journal; we rely on idempotent step replay rather than reproducing it exactly.
- **The Durable-Streams wire protocol.** We are intentionally dropping SSE; the
  DS-compatible offset endpoints are not a goal (a poll-to-terminal HTTP shim
  covers non-Convex callers).
- **Filesystem agent addressing.** "drop a file in `agents/`" becomes an explicit
  `defineAgentRegistry({ name: createAgent(...) })` because Convex has no
  filesystem-module addressing. `createAgent`'s signature is unchanged.

## Scope (locked: full parity, phased)

Everything ships eventually, in dependency order:

- **Runtime core** (the engine, sessions, tools, sandbox, providers, invoke) —
  first and foundational.
- **Consumer SDK** — Convex-native client.
- **Channels** (slack/github/discord/teams/telegram/…) — after the core proves
  out.
- **Storage adapters** (postgres/libsql/mysql/mongodb/redis) — **obsolete**;
  Convex *is* the database. They collapse into the single Convex adapter and are
  otherwise dropped.

The full phase breakdown with acceptance criteria is in
[06 — Phase Roadmap](06-phase-roadmap.md).

## Success criteria

A developer can:

1. Author an agent with `createAgent(() => ({ model, tools, skills, sandbox:
   upstashBox(), instructions }))` — identical to flue.
2. Register it in `defineAgentRegistry`, deploy to Convex.
3. From a client, `prompt()` the agent and **watch tokens stream in via a
   reactive query** — no SSE.
4. Have the run **survive a redeploy** mid-turn and resume.
5. Gate a tool behind **human approval** and resume on decision.
