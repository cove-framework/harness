# Phase G3.3 — Cove as an AI-SDK harness adapter (`coveHarness`)

> The strategic **invert-expose** play: publish Cove **as** an AI-SDK harness adapter — `coveHarness`,
> a peer to `claudeCode` / `codex` / `pi` — so the AI-SDK ecosystem (`useChat`, the agent interface,
> terminal UI) can drive a **Convex-durable** session, while Convex keeps the loop. Cove is **not** a
> consumer of `HarnessAgent`; it **is** a harness, ~80% structurally there already. Design-of-record:
> [01 — Goals](../../design/01-overview-and-goals.md), [05 — Public API & SDK](../../design/05-public-api-and-sdk.md),
> [08 — Conventions](../../design/08-conventions-and-execution-boundary.md). Decision: [G3-D3](README.md#decision-log).

> **Status — DEFERRED, gated on the harness API leaving canary.** The v7 harness packages
> (`@ai-sdk/harness`, `HarnessAgent`, `SandboxSession`, the `claudeCode`/`codex`/`pi` adapters) are
> **canary/experimental** — the docs explicitly say "expect breaking changes between releases." A
> **published** `coveHarness` adapter pinned to that moving contract breaks Cove's public surface, not
> just internal code, on every churn. So this phase is **adopt-later**, not adopt-now: author it only
> once the harness interface stabilizes. It does **not** block [g3.1](phase-g3.1-ai-sdk-7-upgrade.md)
> or [g3.2](phase-g3.2-native-leverage.md).

## Goal & scope

Define the `coveHarness` adapter shim: a thin compatibility layer that presents Cove's durable session
as the harness/AI-SDK surface `HarnessAgent` abstracts, **without** surrendering the loop. **In scope
(spec only, build deferred):** the adapter contract (named harness, session lifecycle, sandbox slot,
`fullStream` bridge), the ~80%-there evidence, and the Tier-3 "never consume" guardrails.

**Out of scope — the hard skips ([README §Tier 3](README.md#tier-3--explicitly-do-not-adopt)):**

- **Never CONSUME `HarnessAgent`.** `agent.stream()` owns its own loop inside `createVercelSandbox` —
  consuming it discards the `@convex-dev/workflow` journal, replay determinism, the HITL
  `step.awaitEvent` gate ([loop.ts:119-122](../../../convex/engine/loop.ts)), and out-of-band tool
  dispatch (tools have **no** `execute`, [decode.ts:339-349](../../../convex/engine/decode.ts)) — the
  entire reason Cove exists.
- **Never CONSUME `WorkflowAgent` / `@ai-sdk/workflow`.** A competing durability engine —
  [runHandler.ts](../../../convex/engine/runHandler.ts) **is** this, natively, on Convex.
- **Never CONSUME `SandboxSession`'s stateful-session ownership.** cwd/history/approvals/runtime stay in
  the Convex journal; the sandbox handle stays ephemeral ([README §Tier 3](README.md#tier-3--explicitly-do-not-adopt)).

The inversion direction is the only thesis-aligned move: expose Cove **outward** as the surface; consume
**nothing** inward.

## Dependencies

| Must hold | Why |
| --- | --- |
| **G3.1 — the v7 bump** | The adapter must be authored against the **v7-line** harness interface; on v5 the harness packages do not exist. The published adapter pins the harness contract. |
| **The harness API has left canary** | The gating condition. Pinning a published `coveHarness` to a canary surface that "expects breaking changes" exposes Cove's public contract to churn. Wait for stabilization. |
| **G2.1 — reactive events substrate** (group 2) | The `fullStream`/`toUIMessageStream` bridge reads Cove's reactive Convex event stream; the SDK-shaped `text-delta` consumer path depends on it. |
| Cove's existing harness surface (on disk) | `CoveHarness`/`CoveSession`, the sandbox seam, skills, `task()`/subagents, compaction, and the `text-delta`-emitting engine — the ~80% (below). |

## The ~80%-there evidence

Cove already ships almost the entire surface `HarnessAgent` abstracts — it is a **peer** of the existing
adapters, not a consumer. (Note: `HarnessAgent` already ships a **`pi`** adapter — Cove's direct
ancestor — so a `coveHarness` peer is a natural addition.)

| `HarnessAgent` surface | Cove's native equivalent | Site |
| --- | --- | --- |
| `new HarnessAgent({ harness, tools, skills })` | `ctx.init(agent, { name, tools, skills, subagents })` → `makeHarness`/`makeSession` | [context.ts:126-171](../../../src/runtime/context.ts), [types.ts:371-380](../../../src/runtime/types.ts) |
| `agent.createSession()` / `session.destroy()` | `sessions.create` / `session.delete` | [types.ts:431-528](../../../src/runtime/types.ts) |
| `sandbox: createVercelSandbox(...)` | `AgentRuntimeConfig.sandbox?: SandboxFactory` (the swap seam, two adapters) | [types.ts:367/751](../../../src/runtime/types.ts) |
| `result.fullStream` with `part.type === 'text-delta'` | the engine **already** streams `streamText` and emits `text-delta` on `fullStream` | [decode.ts:152-212](../../../convex/engine/decode.ts), esp. [:168-170](../../../convex/engine/decode.ts) |
| AI-SDK `UIMessage` / `useChat` consumer | Cove's `UIMessage`/`UIMessagePart` **mirror `ai@5.x` verbatim**; `useRunEvents` assembles `UIMessage[]` from the reactive stream | [ui-types.ts:2,19-28](../../../src/react/ui-types.ts), [use-run-events.ts:43-62](../../../src/react/use-run-events.ts) |
| skills / sub-agents / compaction (the layers above the model call) | native: skills catalog, `task()` delegation, incremental compaction | [skills.ts](../../../convex/skills.ts), [loop.ts](../../../convex/engine/loop.ts), [compact.ts](../../../convex/engine/compact.ts) |

**The gap is a thin compatibility shim, not a rebuild:** a `coveHarness` export satisfying the adapter
interface, plus a bridge from Cove's reactive Convex event stream to a `fullStream`/`toUIMessageStream` so
Cove plugs into `useChat`. `ui-types.ts` already mirrors the AI-SDK `UIMessage`, and decode already emits
`text-delta` — so the shim reconciles two near-identical shapes rather than inventing one.

## Deliverables (spec; build deferred)

| File (proposed) | Purpose |
| --- | --- |
| `src/harness-adapter/cove-harness.ts` | The `coveHarness` export — a named adapter satisfying the v7 harness interface (session create/destroy, sandbox slot, tools/skills), backed by Cove's `CoveHarness`/`CoveSession`. Convex stays the loop owner; the adapter is a façade. |
| `src/harness-adapter/full-stream-bridge.ts` | Bridge the reactive Convex event stream (G2.1) → an AI-SDK `fullStream` / `toUIMessageStream` emitting `text-delta`/`reasoning`/tool parts, so `useChat` and the agent UI drive a Convex-durable session. |
| `src/harness-adapter/index.ts` + a `./harness` package export | Public entry; a new `exports` subpath peer to `./runtime`/`./sdk`/`./react`/`./cli`. |
| (doc) reference-header + a §05 public-API note | Record `coveHarness` as a published surface; cite its peer relationship to `claudeCode`/`codex`/`pi`. |

## Hardened-contract obligations

The inversion exists **precisely** to keep these — they are the difference between exposing Cove and
surrendering it:

1. **Convex still owns the loop.** The adapter is a façade over `runHandler.agentRun` — the SDK caller's
   `stream()`/`generate()` triggers a Cove submission, but the durable `(llmStep → dispatchTools)*` loop,
   the journal, and replay stay in Convex. The adapter **must not** drive a step loop itself.
2. **The replay guard is untouched.** The `fullStream` bridge reads **persisted/reactive** events
   ([decode.ts:168](../../../convex/engine/decode.ts) emits, G2.1 persists); it is a projection, not a
   second source of truth. A replay re-emits the same events; the bridge is idempotent on them.
3. **Tools keep no `execute`.** The adapter exposes Cove's out-of-band dispatch; it **must not** hand the
   SDK tools with `execute` (that re-internalizes execution). The `coveHarness` tool surface mirrors Cove's
   frozen descriptors.
4. **HITL stays a Convex `step.awaitEvent`.** Approval suspension stays durable
   ([runHandler.ts:70-94](../../../convex/engine/runHandler.ts)); the adapter surfaces `submitApproval` /
   the pending feed, it does not relocate the pause into the SDK loop.
5. **Sandbox state stays in Convex.** The adapter's `sandbox` slot wires a `SandboxFactory` (g3.2 item D);
   it does **not** adopt `SandboxSession`'s stateful ownership of cwd/history/approvals.

## Implementation tasks (when un-gated)

Ordered; do **not** start until the harness API leaves canary and g3.1 has landed.

- [ ] **1 — Pin the stabilized harness interface.** Author against the released (non-canary) `@ai-sdk/harness`
  adapter contract; record the exact version the `coveHarness` surface targets.
- [ ] **2 — `coveHarness` adapter.** Implement the named adapter over `CoveHarness`/`CoveSession`
  ([context.ts:126-171](../../../src/runtime/context.ts)): session create/destroy → `sessions.create`/`delete`;
  tools/skills → Cove's frozen descriptors + catalog; sandbox slot → `AgentRuntimeConfig.sandbox`.
- [ ] **3 — `fullStream` bridge.** Map the reactive Convex event stream (G2.1) → an AI-SDK `fullStream` /
  `toUIMessageStream` (`text-delta`/`reasoning`/tool parts), reusing the `UIMessage` mirror
  ([ui-types.ts](../../../src/react/ui-types.ts)) so `useChat` consumes it directly.
- [ ] **4 — Package export.** Add the `./harness` subpath to [`package.json`](../../../package.json) `exports`
  (peer to `./runtime`/`./sdk`/`./react`/`./cli`); wire the `tsup` build entry.
- [ ] **5 — Conformance + guardrail tests.** Assert the adapter satisfies the harness interface; assert it
  **never** imports `HarnessAgent`/`WorkflowAgent`/`ToolLoopAgent` and never hands the SDK a tool with
  `execute` (the boundary guardrail). Assert a replay re-emits identical bridge output.

## Acceptance

- [ ] **`coveHarness` is a drop-in peer.** An AI-SDK consumer can swap `claudeCode`/`codex`/`pi` → `coveHarness`
  and drive a Convex-durable session through the harness interface.
- [ ] **`useChat`/`fullStream` works.** The bridge yields `text-delta`/`reasoning`/tool parts the AI-SDK UI
  renders; the `UIMessage` shapes reconcile with zero adapter-side rebuild.
- [ ] **Convex still owns the loop — proven.** A run driven via `coveHarness` survives a simulated redeploy
  (the journal persists), parks/resumes a HITL approval durably, and dispatches tools out-of-band — none of
  which a consumed `HarnessAgent` could do.
- [ ] **No inward consumption — grep-proven.** The adapter imports **no** `HarnessAgent`/`WorkflowAgent`/
  `ToolLoopAgent`/`SandboxSession` and hands the SDK no tool with `execute`.
- [ ] **Green gate.** `tsc --noEmit` 0; vitest green incl. the conformance + guardrail tests; `tsup` builds the
  new `./harness` entry.

## Risks & gotchas

- **Canary churn is the headline risk — hence deferred.** The harness packages "expect breaking changes
  between releases." A published `coveHarness` pins that contract; until it stabilizes, every churn breaks
  Cove's **public** surface. Do not publish against canary.
- **Resist scope-creep into consumption.** The entire value is the inversion. Consuming any of `HarnessAgent`/
  `WorkflowAgent`/`ToolLoopAgent`/`SandboxSession` to "save shim work" surrenders the durable loop — the
  net-negative outcome the Tier-3 verdicts reject.
- **`pi` is the precedent, not the template.** `HarnessAgent` ships a `pi` adapter (Cove's ancestor); `coveHarness`
  is a peer, but Cove is durable-by-Convex where `pi` is in-process — the adapter must surface that durability
  (survives redeploy, parks HITL), not flatten it to match `pi`.
- **The bridge is a projection, not a loop.** The `fullStream` bridge must read persisted/reactive events and stay
  idempotent on replay; it must never become a second place that advances the agent.
- **Provider-version coupling.** The published adapter couples Cove's release to the harness major; budget for
  tracking the harness line the way Cove tracks the `@ai-sdk/*` provider majors.
