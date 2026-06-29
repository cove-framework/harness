# Phase G5.2 — Pending-input substrate — steering, follow-up, gating

> Build the **ONE durable pending-input table** Cove's design already prescribes (D17 /
> [08 §5](../../design/08-conventions-and-execution-boundary.md)) — drained per `llmStep` from a
> journaled step — then layer the capabilities it unlocks: mid-run **steering**, **follow-up** turns,
> per-step **`activeTools`/`toolChoice`** gating, opt-in **sequential** tool mode, the public async
> **`dispatch()`** admission surface, and observational **tool-progress** streaming. Every item is the
> **Convex-native** re-expression of pi's in-memory steering/follow-up — a durable table in Convex, **not**
> pi's process-global `PendingMessageQueue`. Design-of-record:
> [04 — Durable Engine](../../design/04-durable-engine.md),
> [08 — Conventions](../../design/08-conventions-and-execution-boundary.md) (§5 deferred-loop-extras,
> §4.10 result re-nudge), [07 — Risks & Decisions](../../design/07-risks-and-decisions.md) (D17).

## Goal & scope

The thesis boundary: **durable state stays in Convex, the loop stays a pure orchestrator over journaled
`step.run*` deps** ([loop.ts:73](../../../convex/engine/loop.ts),
[runHandler.ts:28-96](../../../convex/engine/runHandler.ts)), **and the AI SDK stays at the model
boundary** ([decode.ts:152](../../../convex/engine/decode.ts) only). **In scope:** the pending-input
table (A), the steering drain (A) and the thin follow-up add-on (B) on top of it, per-step tool gating
(C), opt-in sequential dispatch + a real `terminate` consumer (D, *small*), the public `dispatch()`
admission mutation (E), and `tool_progress` events (F). **Out of scope:** pi's in-memory
`PendingMessageQueue` + outer `while(true)` (re-expressed, not ported); the one-at-a-time/all
`QueueMode` batching (deferred — no interactive multi-turn consumer in Cove today); the
`afterToolCall`-returns-`terminate` control-flow hook (Cove has no control-flow hook class,
[extensions/types.ts:34-42](../../../src/runtime/extensions/types.ts)); the
"deliver into an already-running session" half of `dispatch()` (gated on the same drain A lands).
**Supersession:** item C **supersedes group-3 G3.2 item B** (`activeTools`/`toolChoice` gating) — that
spec is folded here with the journaled-state hard constraint made explicit.

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| A (steering) | G5.1; the `RunLoopDeps` port + `appendCanonicalEntry` (exist) | the pending-input table + a `getSteeringMessages` dep + a `submitSteer` mutation |
| B (follow-up) | **A** (shares the pending-input table); the `appendFollowUp` seam (exists) | thin add-on: a `step.runQuery` at no-tool-calls instead of finalizing |
| C (gating) | the `decode.ts` `streamText` call + frozen plan (exist) | **supersedes G3.2-B**; gate must fold from journaled state |
| D (sequential) | `FrozenToolDescriptor` freeze seam + idempotent `appendToolResult` (exist) | flip `Promise.all`→in-order await; wire the dead `terminate` flag to a real read |
| E (dispatch) | the `agentRequests` admission path + `DispatchReceipt` types + `findDispatchInput` (exist) | admission mutation only; continuing-session delivery gated on A |
| F (tool_progress) | the `events` table + `DeltaBatcher` pattern (exist) | observational only, like `text_delta`; never journaled |

---

## A — Mid-run steering via a durable pending-input table

**What.** Cove's only concurrency story is **supersede** (cancel-and-restart), which discards in-flight
tool work — `submitPrompt` admits with `supersede: true`
([submit.ts:44](../../../convex/invoke/submit.ts)) and `cancelActiveRequests` cancels the workflow +
marks the request `cancelled` ([admit.ts:60-84](../../../convex/invoke/admit.ts),
[admit.ts:113](../../../convex/invoke/admit.ts)). There is **no steering path**: the only existing
inject is the result-schema re-nudge `appendFollowUp`, not a user steer
([loop.ts:110](../../../convex/engine/loop.ts), [steps.ts:220-228](../../../convex/engine/steps.ts)).
Port pi's steering as the **ONE durable pending-input table** (D17 /
[08 §5:434-440](../../design/08-conventions-and-execution-boundary.md)), drained at the **post-dispatch
boundary** of `runAgentLoop` so completed tool results in the current step are **preserved**.

**Where.** New journaled dep `getSteeringMessages(stepNumber)` added to `RunLoopDeps`
([loop.ts:51-66](../../../convex/engine/loop.ts)), wired in `runHandler` as a `step.runMutation`
alongside the existing `appendFollowUp`/`decode` deps
([runHandler.ts:36-96](../../../convex/engine/runHandler.ts) — `decode` at L36-37, `appendFollowUp` at
L42-48, the `awaitEvent`-HITL precedent at L70-94). The mutation atomically (a) reads pending steer
entries for the session, (b) appends each as a user `MessageEntry` via `appendCanonicalEntry`
([admit.ts:136](../../../convex/invoke/admit.ts) / [steps.ts:226](../../../convex/engine/steps.ts) show
the seam), and (c) marks them consumed / records the consumed ids. Prefer the **session-entry form**
([schema.ts:146](../../../convex/schema.ts) `sessionEntries`) over an `agentRequests` sidecar
([schema.ts:168](../../../convex/schema.ts)) — pi's own `durable-harness.md:40` keeps the session log as
source-of-truth (sidecars only for large blobs). Add a public `submitSteer` mutation parallel to
`submitPrompt` ([submit.ts:18-46](../../../convex/invoke/submit.ts)) that **enqueues** when an in-flight
request exists instead of superseding. Drain **after** dispatch + after any `settleResultRun` terminal
check ([loop.ts:123-129](../../../convex/engine/loop.ts)), **before** the next `decode`.

**Why native / why it fits.** The drained set is journaled **before** it counts as consumed — the
consumed-ids-before-consumed invariant (pi `durable-harness.md:161`): a `step.runMutation` returns its
cached journal result on replay, so the same messages are injected on the same step without re-reading
live state — the **identical mechanism** already used for `decode`/`dispatch`/`appendFollowUp`. The
queue lives in Convex (`sessionEntries`), the loop stays pure, no AI SDK involvement (the drain is a
mutation), no competing loop/durability engine — it reuses `@convex-dev/workflow`. It directly parallels
the existing `awaitEvent`-based HITL park path ([runHandler.ts:70-94](../../../convex/engine/runHandler.ts)).
This makes supersede an **explicit alternative**, not the only concurrency story.

**Effort** M (table + drain mutation + `submitSteer` + the loop wiring). **Risk** med — the drain point
must sit after dispatch so a steer never discards completed tool results, and consumed-ids must journal
before consumption or a replay double-injects.

**Acceptance.** A `submitSteer` against a running session enqueues a pending-input row; the next loop
iteration drains it into the history as a user turn **before** the next `decode`, with the current
step's tool results intact; a mid-loop replay re-injects **exactly** the journaled set (same step, no
duplicates, no live re-read); with no in-flight request, `submitSteer` behaves as a normal prompt admit.

---

## B — Follow-up turn injection on the shared pending-input table

**What.** A free-form run **finalizes** the moment a step returns no tool calls
([loop.ts:97-103](../../../convex/engine/loop.ts)) — there is no follow-up-message concept distinct from
the result-schema re-nudge (the `followUps` counter at [loop.ts:75](../../../convex/engine/loop.ts) /
[loop.ts:106-111](../../../convex/engine/loop.ts) is **result-only**). Add follow-up injection as a
**thin add-on** to A's table: when a free-form run hits no-tool-calls, consult the durable pending-input
table instead of finalizing; if a queued user turn exists, append it and re-decode — keeping one
continuous run, no finalize/re-setup round-trip.

**Where.** At the free-form no-tool-calls branch ([loop.ts:97-101](../../../convex/engine/loop.ts)),
before `finalize`, add a `step.runQuery` against the pending-input table (the read half of A's seam);
on a hit, append via the existing `appendFollowUp` journaled mutation
([steps.ts:220-228](../../../convex/engine/steps.ts), wired at
[runHandler.ts:42-48](../../../convex/engine/runHandler.ts)) and `continue` to the next step rather than
return. Each loop dep is a separate journaled `step.run*` with no process memory
([runHandler.ts:28-96](../../../convex/engine/runHandler.ts)); the design's "one `agentRequests` row per
submission" durable model is preserved ([schema.ts:168](../../../convex/schema.ts)).

**Why native / why it fits.** As literally described — "port pi's outer-loop drain... keeping one
continuous run" — pi's mechanism is a **process-global** in-memory `PendingMessageQueue` drained inside a
single long-lived `while(true)` (`/root/projects/harness-engine/pi/packages/agent/src/agent.ts:109-152`,
`agent-loop.ts:166-266`), which **cannot survive journal replay**. Cove's own docs prescribe the
compatible form: a pending-input table drained "at the top of each `llmStep`"
([08 §5:434-440](../../design/08-conventions-and-execution-boundary.md), D17
[07:37](../../design/07-risks-and-decisions.md)), and the refactor note pins the seam: follow-up may be
injected "only via a journaled `appendFollowUp`-style step... must enqueue through a journaled mutation"
([REFACTOR-PRAGMATIC.md:354](../../../docs/REFACTOR-PRAGMATIC.md)). The drain is a journaled query —
deterministic on replay — and adds no AI-SDK ownership above the model call. **Defer** the
one-at-a-time/all `QueueMode` batching (`agent.ts:245-291`): a TUI-UX nicety with no Cove consumer today.

**Effort** M (shares A's table; the loop add-on + query are the new surface). **Risk** med — the drain
must be a journaled query and the re-decode must advance `stepNumber` (like the re-nudge at
[loop.ts:112](../../../convex/engine/loop.ts)) so the step cap still bounds an unbounded follow-up chain.

**Acceptance.** A free-form run that would finalize, with a queued follow-up present, instead appends the
follow-up and runs another turn in the **same** run; with the queue empty it finalizes exactly as today;
the drain is replay-stable (a mid-loop replay re-takes the journaled query result, no second LLM call);
`maxSteps` still terminalizes a runaway follow-up chain.

---

## C — Per-step `activeTools` / `toolChoice` gating  *(supersedes G3.2-B)*

**What.** `decode` hands the **full** frozen tool roster to `streamText` every step — `tools:
toAiTools(input.tools)` ([decode.ts:152-157](../../../convex/engine/decode.ts),
[decode.ts:339-349](../../../convex/engine/decode.ts)) — with **no `toolChoice` and no per-step
`activeTools` subset**. `DecodeInput` has neither field today
([decode.ts:103-110](../../../convex/engine/decode.ts)); `llmStep` passes
`buildModelView(plan.tools)` un-gated ([llmStep.ts:61](../../../convex/engine/llmStep.ts),
[buildTools.ts:46-52](../../../convex/engine/buildTools.ts)). Add optional `activeTools?: string[]` and
`toolChoice?: 'auto'|'required'|{type:'tool',toolName}` to `DecodeInput`, threaded into the existing
`streamText` call.

**Where.** `DecodeInput` ([decode.ts:103-110](../../../convex/engine/decode.ts)) gains the two optional
fields; forward them into `streamText` ([decode.ts:152](../../../convex/engine/decode.ts) — `streamText`
accepts both natively). `llmStep` ([llmStep.ts:61](../../../convex/engine/llmStep.ts)) derives the gate
and passes it down. Primary use: on a result-schema run after the first re-nudge, force
`activeTools=[finish,give_up]` + `toolChoice:'required'` instead of consuming another text re-nudge —
the durable outcome already drives termination ([resultTools.ts:210-226](../../../convex/engine/resultTools.ts)
`computeResultOutcome`, [resultTools.ts:33-39](../../../convex/engine/resultTools.ts)
`buildResultFollowUpPrompt`, gate inputs at [loop.ts:97-114](../../../convex/engine/loop.ts)). Secondary:
restrict the callable set per phase (the pi plan-mode pattern,
`/root/projects/harness-engine/pi/packages/coding-agent/src/core/agent-session.ts:803`
`setActiveToolsByName`).

**Why native / why it fits.** This **supersedes group-3 G3.2 item B** — same `streamText`-boundary
gate, now with the replay constraint made a hard requirement. The AI SDK already owns **only** the
`streamText` call ([decode.ts:152](../../../convex/engine/decode.ts)); adding an `activeTools`/`toolChoice`
arg keeps it exactly at the boundary the thesis permits, adds no durable state outside Convex, no
competing loop/durability engine. **Hard constraint:** the gate value **must** be a pure function of
journaled/persisted state passed down from the loop (`stepNumber`, the `followUps` count reconstructed
at [loop.ts:75](../../../convex/engine/loop.ts)/[loop.ts:111](../../../convex/engine/loop.ts),
`hasResultSchema`, the durable result outcome over persisted rows) — **never** a live process-global or
non-journaled counter — so `reconstructDecision`'s replay path and the live path compute the **identical**
gate. Keep it optional / off by default so non-result runs are unchanged.

**Effort** M (two `DecodeInput` fields + the gate derivation in `llmStep` + the `streamText` plumbing).
**Risk** low — touches no loop control flow or durability invariant; the gate is journaled like every
other decode input *iff* it folds from journaled state (the one forbidden failure mode).

**Acceptance.** A decode that derives `activeTools:['finish','give_up']` + `toolChoice:'required'` from
the journaled result-run state exposes only those tools and forces a call; a free-form run with no gate
sees the full roster exactly as today; the gate is reconstructed **identically** on a mid-loop replay
(folds from frozen plan + persisted step inputs, no live registry read).

---

## D — Opt-in sequential tool mode + a real `terminate` consumer  *(small)*

**What.** `runDispatch` always runs a step's tool calls via `Promise.all` (parallel only) — sequential
`ToolExecutionMode` is explicitly deferred ([dispatch.ts:40](../../../convex/engine/dispatch.ts),
[08 §5:441-443](../../design/08-conventions-and-execution-boundary.md)). Add an **opt-in sequential
mode** frozen on the plan (any one sequential tool forces the whole batch sequential, per pi
`agent-loop.ts:382-384`) for ordered side-effecting tools (write-then-read) or stop-on-first-error. Also
**generalize `terminate`**: today only result tools set `terminate:true`
([resultTools.ts:123](../../../convex/engine/resultTools.ts),
[resultTools.ts:142](../../../convex/engine/resultTools.ts)) and the loop **ignores** it — termination
goes through `getOutcome`/`settleResultRun` reading `details`
([resultTools.ts:210-226](../../../convex/engine/resultTools.ts),
[loop.ts:97-159](../../../convex/engine/loop.ts)). The `terminate` field
([types.ts:53](../../../convex/engine/types.ts)) is **dead**; wire it (or a `computeResultOutcome`-style
read) into a real consumer so **any** tool's persisted result can settle the batch.

**Where.** Add a sequential `ToolExecutionMode` to `FrozenToolDescriptor`
([types.ts:23-33](../../../convex/engine/types.ts), the freeze seam;
[buildTools.ts:46-52](../../../convex/engine/buildTools.ts) rebuilds from frozen descriptors); in
`runDispatch` ([dispatch.ts:40](../../../convex/engine/dispatch.ts)) await `dispatchOne` **in order**
instead of `Promise.all` when the mode is set — leveraging the **idempotent** `appendToolResult`
([steps.ts:204-205](../../../convex/engine/steps.ts) filter-then-push replace-in-place,
[dispatchTools.ts:176-209](../../../convex/engine/dispatchTools.ts) the non-task path). Parallel stays
default. **Drop** the "afterToolCall returns terminate" hook sub-feature — Cove has no control-flow hook
class ([extensions/types.ts:34-42](../../../src/runtime/extensions/types.ts) is partitioned into pure
content-mutation classes with no `terminate` path), it is the lowest-value highest-cost piece.

**Why native / why it fits.** Sequential dispatch only changes `Promise.all`→in-order `await` inside the
already-journaled `dispatchTools` action ([dispatchTools.ts:209](../../../convex/engine/dispatchTools.ts));
`appendToolResult` is idempotent by `toolCallId`, so replay determinism holds and order is deterministic.
A generalized `terminate` is derived from persisted tool-result rows inside the existing durable loop —
the **same Convex-owned pattern** `computeResultOutcome` already uses
([resultTools.ts:210-226](../../../convex/engine/resultTools.ts)) — durable state stays in Convex, AI SDK
untouched. **Justify with a real use case before building** — demand is currently speculative
parity-with-pi.

**Effort** S. **Risk** low — additive frozen field + a branch in `runDispatch`; the `terminate`
generalization reads persisted rows (no new durable surface).

**Acceptance.** A plan with one sequential tool runs the whole batch in order (write-then-read observes
the write); a parallel plan still runs `Promise.all`; a re-dispatch after a crash re-runs idempotently
in the same order (no double-write); a non-result tool that sets `terminate` (read from its persisted
row) settles the batch — and the previously-dead `terminate` flag has a real consumer.

---

## E — First-class async `dispatch()` admission surface

**What.** Cove has `DispatchReceipt`/`dispatchId` types
([types.ts:56-61](../../../src/runtime/types.ts), request shapes at
[types.ts:38-53](../../../src/runtime/types.ts)) and a `findDispatchInput` consumer
([session-history.ts:211-216](../../../src/runtime/session-history.ts)) but **no public `dispatch()`
surface** — `submitPrompt` only supersedes ([submit.ts:18-46](../../../convex/invoke/submit.ts)), and
every admit starts a **fresh** workflow ([admit.ts:110-142](../../../convex/invoke/admit.ts)). Ship the
public `dispatch()` / `admitDispatch` **admission mutation only**: idempotent by `dispatchId`
(replay-safe), inserts a `kind`-tagged `agentRequests` row + appends the dispatch-tagged message entry
(consumed via the existing `findDispatchInput`), returns the existing `DispatchReceipt{dispatchId,
acceptedAt}`; wire it to a POST route by codegen alongside `submit*`.

**Where.** New mutation parallel to `submitPrompt`
([submit.ts:18-46](../../../convex/invoke/submit.ts)) calling a new `admitDispatch` helper alongside
`admitPrompt` ([admit.ts:110-142](../../../convex/invoke/admit.ts)); the `agentRequests.kind` union
([schema.ts:176-182](../../../convex/schema.ts)) gains a `dispatch` member (it has none today); the row
+ message entry use the existing `appendCanonicalEntry`
([admit.ts:136](../../../convex/invoke/admit.ts)); the receipt is
[types.ts:56-61](../../../src/runtime/types.ts). **Explicitly scope OUT** the "deliver into an
already-running session" half: that requires the running workflow to drain the pending-input table per
`llmStep` — which is **item A**. Until A lands, `dispatch()` either equals `submitPrompt` (supersede) or
queues input nothing consumes; so land the durable admission + receipt now and gate continuing-session
delivery on A (which this item "pairs with").

**Why native / why it fits.** The Convex-native framing (a mutation inserting an `agentRequests` row +
appending a dispatch message entry, **no in-memory queue**) keeps durable state in Convex and is
journal-replay-friendly — the design already requires `admitDispatch` to be **replay-idempotent by
`dispatchId`** ([06-phase-roadmap.md:259-267](../../design/06-phase-roadmap.md),
[group-1/phase-06-harness-invoke.md:108](../../plans/group-1/phase-06-harness-invoke.md)), never touches
the AI SDK, adds no competing loop/durability engine. The docs bless it: `dispatch` is a kept public
verb ([08:19](../../design/08-conventions-and-execution-boundary.md)) and
[02-architecture-and-mapping.md:95](../../design/02-architecture-and-mapping.md) maps `dispatch()` to an
admission mutation. (Frame it as **Convex-native admission**, not as an "improvement over flue's
in-memory `DispatchQueue`".)

**Effort** M (the mutation + helper + `kind` union member + codegen route + the M6 admission-contract
assertions). **Risk** med — the idempotency-by-`dispatchId` and payload-conflict invariants
([phase-06:108](../../plans/group-1/phase-06-harness-invoke.md)) must hold, and the continuing-session
delivery must stay scoped out until A exists.

**Acceptance.** `dispatch(...)` inserts one `kind:"dispatch"` `agentRequests` row + a dispatch-tagged
message entry and returns a `DispatchReceipt`; re-calling with the **same** `dispatchId` returns the same
receipt and inserts **no** second row (replay-idempotent); the **same** `dispatchId` with a **different**
payload raises a conflict; the entry is retrievable via `findDispatchInput`; no continuing-session
delivery is claimed until A lands.

---

## F — Per-tool incremental `tool_progress` events for long-running tools

**What.** Cove emits **one terminal** tool event per call
([dispatchTools.ts:160-173](../../../convex/engine/dispatchTools.ts)), so long-running tools (bash, MCP)
show nothing until done — `EngineTool.execute(args, signal)` has no `onUpdate` param
([types.ts:57-63](../../../convex/engine/types.ts)) and `runDispatch` writes a single terminal result
([dispatch.ts:55-77](../../../convex/engine/dispatch.ts)); `localBash` buffers stdout and resolves on
`close` ([localBash.ts:51-67](../../../convex/sandbox/localBash.ts)). Add an optional emit-only
`onUpdate(progress)` callback to `EngineTool.execute` and emit incremental **`tool_progress`** events so a
UI shows live tool output.

**Where.** Add `onUpdate?` to `EngineTool.execute` ([types.ts:63](../../../convex/engine/types.ts)) and
thread it through `runDispatch`/`dispatchOne`
([dispatch.ts:55-77](../../../convex/engine/dispatch.ts)). In the `dispatchTools` action, wire `onUpdate`
to `emitFromAction` emitting a new observational `tool_progress` `CoveEvent` (`toolCallId`, `toolName`,
partial content), reusing the `events` table + `DeltaBatcher` coalescing exactly as `text_delta` does
([decode.ts:135](../../../convex/engine/decode.ts), [decode.ts:148](../../../convex/engine/decode.ts)).
Stream `localBash` stdout chunks to `onUpdate` (it already has `child.stdout.on('data')` at
[localBash.ts:53](../../../convex/sandbox/localBash.ts)). Add the `tool_progress` variant to the
`CoveEvent` union ([types.ts:870-884](../../../src/runtime/types.ts), which today carries only
`tool_start` + the terminal `tool`) and the redact passthrough
([emit.ts:30-45](../../../convex/events/emit.ts), the decorate→redact→seq→insert log). Scope to bash + MCP
first; the box sandbox swap-in needs its own streaming channel later.

**Why native / why it fits.** Progress events are observational append-only rows in the existing `events`
table ([emit.ts:30-45](../../../convex/events/emit.ts)) — the **same** mechanism that emits
`text_delta`/`thinking_delta` from the streaming decode path
([decode.ts:135-148](../../../convex/engine/decode.ts)). Events are **not** journaled workflow inputs and
are never read back by the replay guard, so emitting them does not break journal-replay determinism,
relocates no durable state out of Convex, adds no competing loop engine, and leaves the AI SDK untouched.
**Hard constraint:** `tool_progress` is purely observational — **never** written to the journaled step
row, **never** read by decode/replay (mirrors `text_delta` semantics) — so a crash-replay re-emits but
never double-counts.

**Effort** M (the `onUpdate` thread + the new `CoveEvent` variant + the `localBash` streaming wire +
redact passthrough). **Risk** med — only if partial output leaks into the journaled step row; keeping it
emit-only (the same discipline as `text_delta`) is the whole correctness condition.

**Acceptance.** A long-running bash tool emits coalesced `tool_progress` events with partial stdout before
its terminal `tool` event; a UI subscribed to the `events` query sees live output; the partial output is
**never** persisted into the journaled step row nor fed into decode; a mid-loop replay re-emits progress
but the finalized step is byte-identical (no double-count, exactly like `text_delta`).

---

## Risks & gotchas (cross-item)

- **A / B — journal the consumed set *before* it counts as consumed.** The pending-input drain must
  record the consumed ids inside the **same** `step.runMutation`/journaled query that injects them
  ([runHandler.ts:36-96](../../../convex/engine/runHandler.ts) pattern). If consumption is recorded out
  of band, a mid-loop replay re-drains the same rows and double-injects — the consumed-ids-before-consumed
  invariant (pi `durable-harness.md:161`).
- **A — drain *after* dispatch, never before.** Inject steering after `dispatch` + after any
  `settleResultRun` ([loop.ts:123-129](../../../convex/engine/loop.ts)), so a steer arriving mid-step
  never discards the step's completed tool results — the exact failure mode supersede has today.
- **B — keep the step cap binding.** A follow-up re-decode must advance `stepNumber` like the re-nudge
  ([loop.ts:112](../../../convex/engine/loop.ts)); otherwise an unbounded follow-up chain escapes
  `maxSteps` ([loop.ts:79](../../../convex/engine/loop.ts)).
- **C — fold the gate from journaled state only.** The `activeTools`/`toolChoice` value must be
  reconstructable on replay from the frozen plan + persisted step inputs (`stepNumber`, `followUps`,
  durable result outcome) — **never** a live counter, or `reconstructDecision` and the live path diverge.
  (This is the one constraint G3.2-B left implicit and this item makes hard.)
- **D — idempotency carries the order guarantee.** Sequential dispatch is only replay-safe because
  `appendToolResult` is idempotent by `toolCallId` ([steps.ts:204-205](../../../convex/engine/steps.ts)).
  Do **not** add the `afterToolCall`-returns-`terminate` hook — Cove has no control-flow hook class
  ([extensions/types.ts:34-42](../../../src/runtime/extensions/types.ts)).
- **E — admission only; gate delivery on A.** Do not claim continuing-session delivery before the
  pending-input drain (A) exists, or `dispatch()` silently equals supersede or queues dead input. Hold the
  idempotency + payload-conflict invariants ([phase-06:108](../../plans/group-1/phase-06-harness-invoke.md)).
- **F — emit-only, never journaled.** `tool_progress` must stay out of the journaled step row and out of
  decode — same discipline as `text_delta` ([decode.ts:135-148](../../../convex/engine/decode.ts)). A
  replay re-emits observational events; it must never re-feed them as inputs.
