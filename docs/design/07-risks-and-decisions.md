# 07 — Risks & Decisions

Naming, the orchestration ↔ execution boundary, and the hardened engine contracts
referenced throughout this doc are defined once in
[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md);
this doc links to them rather than restating.

## Decisions

### Locked (chosen by the product owner)

| # | Decision | Choice | Consequence |
| --- | --- | --- | --- |
| D1 | Scope | **Full parity, phased** | Runtime core first; SDK; then channels. SQL adapters obsolete → collapse into the Convex adapter. |
| D2 | Transport | **Convex-native + minimal HTTP submit** | Reactive subscriptions are primary; **no SSE**. A submit/poll httpAction serves non-Convex callers. |
| D3 | Auth | **Pluggable, none by default** | Ship an `authorize` hook; no provider wired in. Clerk/Convex Auth/bearer drop in later. |
| D4 | HITL | **Add as additive capability** | New `CoveSession` approval gate via workflow `awaitEvent`; existing surface unaffected. State machine pinned in [08 §4.4](08-conventions-and-execution-boundary.md). |
| D11 | Brand rename | **`Flue`/`Pi` → `Cove`** | The rewrite is its own product. Brand-prefixed types rename (`FlueContext`→`CoveContext`, `createFlueClient`→`createCoveClient`, `[flue]`→`[cove]`); generic verbs/domain types (`createAgent`, `defineTool`, `SessionData`, …) stay. Full table in [08 §1](08-conventions-and-execution-boundary.md). |
| D12 | Deployment target | **Convex-only; Cloudflare dropped** | flue's `cloudflare/*` (13 files) + `cloudflare-model.ts` remain reference-only. No second backend abstraction to maintain. See [08 §5](08-conventions-and-execution-boundary.md). |
| D18 | Workflow restored as a first-class construct (full parity with flue) | **`defineWorkflow` restored** | Honors locked D1 full parity. `defineWorkflow((ctx) => result)` returns a `WorkflowHandler`, restored beside `defineAgentRegistry` and **Convex-app-bound** (exported from the app/CLI surface under `convex/` — e.g. `convex/workflows/` + `convex/workflowRegistry.ts` — **not** on the `@cove/runtime` barrel). HTTP `POST /workflows/:name`; SDK `client.workflows.invoke(name, input)`. Workflow runs are a **distinct run kind** from agent runs: the `runs` table gains a `kind: 'agent' \| 'workflow'` discriminator, resolving the agentName-rekey conflation. See [02 — Architecture & Mapping](02-architecture-and-mapping.md), [05 — Public API & SDK](05-public-api-and-sdk.md), [06 P8/P8.5](06-phase-roadmap.md). |

### Defaulted (sensible defaults; revisit anytime)

| # | Decision | Default | Rationale |
| --- | --- | --- | --- |
| D5 | Recovery ownership | `@convex-dev/workflow` owns it | Don't double-implement; drop flue's turn-journal/lease/attempt machinery. |
| D6 | Agent addressing | explicit `defineAgentRegistry` | Convex has no filesystem-module addressing; `createAgent` signature unchanged. |
| D7 | Sandbox extensibility | `SandboxFactory` stays open; **two built-ins ship** — `@upstash/box` (default isolated sandbox) **+ a local in-process `bash()` adapter** (the **real-machine** target, ported from flue's `createBashSessionEnv`) | Preserves flue's seam; sandbox *and* real-machine execution both work out of the box. `BashFactory`/`BashLike` are the consumed contract; flue's Daytona/E2B/Cloudflare adapters stay third-party (not ported). Rules a real-machine factory must obey are in [08 §3](08-conventions-and-execution-boundary.md#execution-targets-beyond-the-box-real-machine--network). |
| D8 | Repo layout | standalone Convex app in `cove-harness/`; drop `pi-agent-core`/`pi-ai` deps | AI SDK replaces the loop + providers; pi's message *shape* is copied, not depended on. |
| D9 | Delta-batch cadence | ~400 ms / ~480 chars, configurable | Balances live-streaming UX against Convex mutation cost. Commit ordering pinned in [08 §4.6](08-conventions-and-execution-boundary.md). |
| D10 | Canonical message model | keep **pi's** message model internally | `SessionData` v6 stays wire-compatible; `session-history` ports verbatim; map to AI SDK only at the provider boundary. |
| D13 | Workspace context discovery | **skills-catalog table + on-demand `SessionEnv` reads** | flue's filesystem `AGENTS.md`/`.agents` walk has no Convex analogue. Replace it with a queryable skills catalog table (seeded by an import action) the agent reads via query; supplement with optional on-demand `SessionEnv` reads of in-workspace files when a run needs them. No filesystem walk at startup. The system-prompt **Directory-structure** listing is likewise **deferred to an on-demand `SessionEnv` read** — setup stays "resolve only" and provisions no box; `HEADLESS_PREAMBLE` + the Available-Skills rendering are composed at setup from catalog rows. |
| D14 | Channel inbound model | **reuse `agentRequests` + HTTP submit** | Channels land through the existing submit httpAction into `agentRequests`; per-channel signature verification + idempotent dedup (by provider message id) guard the boundary. No separate inbound table initially — add one only if a channel needs richer inbound state. |
| D15 | MCP integration | **declarative `mcpServers` on the agent profile; a `convex/mcp/` `"use node"` module owns connections** | The call site declares its own tools (profile/runtime/init/op `tools`) *and* MCP servers. MCP `execute` is the one sanctioned **network** exception to box-binding: the frozen descriptor carries **server identity + transport** (not a closure), `buildTools` re-resolves a client per step, and replay is de-duped by `toolCallId`. Pinned in [08 §3](08-conventions-and-execution-boundary.md#execution-targets-beyond-the-box-real-machine--network) / [08 §4.5](08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors); lifecycle in [06 P10](06-phase-roadmap.md). |
| D16 | Step cap | **`maxSteps` defense-in-depth ceiling (default 100); *not* flue's no-cap model** | flue has no framework turn cap (the model terminalizes via `finish`/`give_up`). Cove adds a runaway ceiling resolved from `DurabilityConfig.maxSteps`, frozen on the plan; reaching it terminalizes `failed` with `step_limit_exceeded`. Pinned in [08 §4.9](08-conventions-and-execution-boundary.md#49-step-cap--loop-termination). |
| D17 | pi loop extras (steering, tool hooks, exec mode) | **deferred, not dropped** | In-turn steering / follow-up queues, `beforeToolCall`/`afterToolCall` hooks, and sequential `ToolExecutionMode` are out of the initial parity scope (HITL covers approvals; `dispatchTools` is `Promise.all`-parallel). Re-expressible later as a pending-input table / dispatch seam. Recorded in [08 §5](08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit). |
| D19 | Shell env redaction in transcripts | **retained security invariant** | `ShellOptions.env` values are emitted **keys-only** (`<redacted>`) in every shell `tool_start`/`tool` event **and** in the persisted `sessionEntries` triple; only `env.exec` receives the real values. A security invariant ported verbatim from flue, not a default to revisit. Pinned in [08 §4.11](08-conventions-and-execution-boundary.md#411-shell-tool-event-envelope--env-redaction). |

### Resolved design contracts

Six loop-correctness items were open risks at planning time; each is now pinned as a
non-negotiable contract in [08 §4 — Hardened engine contracts](08-conventions-and-execution-boundary.md)
(prose in [04 — The Durable Engine](04-durable-engine.md)). Listed here so the
decision trail is visible from the risk doc:

- **`llmStep` replay guard** — on workflow replay the action re-runs but must *not*
  re-call the model; a finalized `agentRequestSteps` row is the source of truth.
  ([08 §4.1](08-conventions-and-execution-boundary.md))
- **Action budgets & timeouts** — `llmStep` stream deadline ≈ 240 s (force-finalize
  on deadline), per-tool timeout ≈ 30 s, default box `exec` `timeoutMs` = 30 s.
  ([08 §4.2](08-conventions-and-execution-boundary.md))
- **Cancel short-circuit** — `dispatchTools` checks `agentRequests.status` before
  each tool and discards late results; the abort sequence is one atomic mutation.
  ([08 §4.3](08-conventions-and-execution-boundary.md))
- **HITL state machine** — globally-unique event key, idempotent fail-loud
  `submitApproval`, durable/queued workflow event, re-validated approver-edited args,
  timeout-while-parked → `cancelled`. ([08 §4.4](08-conventions-and-execution-boundary.md))
- **`buildTools` authority** — the frozen tool descriptor on the request is
  authoritative for the whole run; `buildTools` failure → error tool-result, never a
  step crash; idempotent `appendToolResult`. ([08 §4.5](08-conventions-and-execution-boundary.md))
- **Streaming commit ordering** — the delta-batcher flush must commit *before* the
  workflow advances; deltas coalesce into the step row in-position.
  ([08 §4.6](08-conventions-and-execution-boundary.md))

## Risk register

Ordered by depth. Each has a mitigation and an owner phase
([06 — Roadmap](06-phase-roadmap.md)).

### R1 — Streaming model mismatch *(highest)*
flue streams via DS long-poll + a synchronous in-process `CallHandle` await;
Convex httpActions return immediately and stream only via reactive queries.
- **Mitigation:** native clients use reactive queries; HTTP callers get a
  `?wait=result` poll-to-terminal shim. Per-token deltas are **delta-batched**
  (D9) so the streaming write path doesn't overwhelm Convex. Commit ordering is
  contract-pinned ([08 §4.6](08-conventions-and-execution-boundary.md)).
- **Owner:** P4 (batcher), P8/P9 (shim + client).

### R2 — Abort across the action boundary
`CallHandle.abort()` / `session.abort()` degrade from synchronous in-flight
cancellation to an async `workflow.cancel`. A tool mid-exec won't see the cancel
until its action returns.
- **Mitigation:** the abort sequence is atomic and the cancel short-circuit
  (`dispatchTools` checks status before each tool) bounds remaining work; the box
  `exec` `timeoutMs` bounds the worst-case tool tail. Document the weakened mid-tool
  abort semantics. Contract: [08 §4.3](08-conventions-and-execution-boundary.md).
- **Owner:** P6.

### R3 — Recovery double-implementation
flue's `classifySubmissionState`/`repairInterruptedToolCalls`/turn-journal overlaps
the workflow's own crash recovery; doing both risks contradiction.
- **Mitigation:** D5 — rely solely on workflow replay + idempotent step rows +
  idempotent `appendToolResult` ([08 §4.5](08-conventions-and-execution-boundary.md)).
  Accept non-byte-identical interrupted-tool repair (a documented non-goal).
- **Owner:** P4.

### R4 — Tool/closure serialization
valibot/zod schemas and `execute` closures can't survive the workflow journal.
- **Mitigation:** persist **frozen tool descriptors** (name/description/JSON-Schema)
  in the plan; rebuild tools per `llmStep` via `buildTools`; strip `execute` for the
  model call; run `execute` in `dispatchTools`. The frozen descriptor is
  authoritative for the whole run ([08 §4.5](08-conventions-and-execution-boundary.md)).
- **Owner:** P4.

### R5 — Sandbox lifecycle across stateless actions
flue calls `createSessionEnv` once per harness and shares it; Upstash boxes are
long-lived but actions are stateless and may run on different machines, so the
in-process box-handle cache won't persist.
- **Mitigation:** resolve the box **by name** (`Box.list/get`) on each cold action
  and cache per-process; key box resources on `ctx.id` (see the `sandboxName`
  convention in [08 §3](08-conventions-and-execution-boundary.md)). Round `timeoutMs`
  up to box-second granularity; handle signal-blind exec at the `SessionEnv` seam.
- **Owner:** P2.

### R6 — Convex action limits
LLM streaming + tool dispatch run in `"use node"` actions with execution-time and
memory caps. Long turns, large reads (flue's 64 MB exec cap), and image chunking
can hit per-function limits.
- **Mitigation:** keep each `llmStep`/`dispatchTools` to one decode / one tool
  batch (the loop already chunks work per step); stream rather than buffer; move
  large images to `_storage` (inline threshold ~100 KB, [08 §4.8](08-conventions-and-execution-boundary.md));
  cap tool output sizes.
- **Owner:** P4, P2.

### R7 — `SessionData` v6 affinity/image fidelity
Preserving the blob shape is feasible, but per-entry image hoisting and
`affinityKey` routing assume SQL/KV semantics; mapping `affinityKey` to a Convex
region is non-trivial.
- **Mitigation:** keep `affinityKey` as an opaque stored value (prompt-cache
  identity), don't attempt region routing initially; accept possible provider
  cache-affinity regressions and revisit if measured. **(Resolved — see Open
  questions.)**
- **Owner:** P5.

### R8 — `observe()` semantic change
flue's `observe()` is in-process, module-scoped, synchronous `(event, ctx)`. There
is no clean way to preserve that exact contract on Convex.
- **Mitigation:** re-express as reactive queries over `events`; keep server-side
  emit only to *write* deltas. Document the semantic change for consumers relying
  on `observe()`.
- **Owner:** P9.

### R9 — Cost of fine-grained streaming
Tighter delta-batching improves UX but multiplies Convex mutation cost.
- **Mitigation:** D9 default cadence; expose it as config; monitor mutation
  volume per run.
- **Owner:** P4.

## Open questions (to revisit during build)

**Resolved**

- ~~Should `affinityKey` ever drive Convex routing, or stay a pure prompt-cache
  token?~~ **Resolved (R7): stays opaque** — a pure prompt-cache identity, no region
  routing initially. Revisit only if cache-affinity regressions are measured.
- ~~Do channels need their own inbound-event table, or is the HTTP submit surface +
  `agentRequests` enough?~~ **Resolved (D14): reuse `agentRequests` + HTTP submit**
  with per-channel signature verification + idempotent dedup. Add a dedicated inbound
  table only if a channel needs richer inbound state.
- ~~Image storage threshold for inline `imageChunks.data` vs `_storage`.~~
  **Resolved (R6 / [08 §4.8](08-conventions-and-execution-boundary.md)): ~100 KB**
  inline; larger payloads go to Convex `_storage`.

**Still open**

- How rich does the D13 skills catalog need to be (flat table vs. per-skill metadata
  + versioning), and when does an on-demand `SessionEnv` read beat a catalog row? (P2)
