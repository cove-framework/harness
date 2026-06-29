# Phase G5.3 — Out-of-band orchestration & durable waits

> Make Cove's registered surfaces actually **execute** without ceding the durable loop: run the
> registered `defineWorkflow` handler **out-of-band**, routing each `ctx.session().prompt()`/`skill()`/
> `compact()` back through the existing Convex admit path so every sub-prompt is its own journaled
> `agentRun`; wire `resolveSandbox` to a configured **sandbox selector** (frozen by name on the plan,
> factory recovered replay-safely) to finally unlock `@upstash/box`; convert child-`task()` delegation
> from a busy-poll inside a `"use node"` action to a durable `step.awaitEvent` wakeup (the HITL pattern);
> and spill large image bytes to Convex `_storage` instead of inlining them. Design-of-record:
> [04 — Durable Engine](../../design/04-durable-engine.md),
> [08 — Conventions](../../design/08-conventions-and-execution-boundary.md)
> (§3 execution boundary, §4.4 HITL, §4.8 image pipeline),
> [07 — Risks & Decisions](../../design/07-risks-and-decisions.md) (R5 sandbox lifecycle, D18 run kinds).
> **This phase SUPERSEDES the unbuilt group-3 [G3.2](../group-3/phase-g3.2-native-leverage.md) item D**
> (sandbox-factory wiring) — folded into **B** below, re-scoped to a serializable selector so the
> closure never crosses the journal.

## Goal & scope

Four shippable items (A–D) plus one **optional/deferred** (E). Each is a **mini-spec** below
(what · where · why-native · effort · risk · acceptance), anchored to the call sites the analysis
verified. **In scope:** A (real workflow-handler dispatch out-of-band), B (sandbox selector wiring),
C (durable child-`task()` await), D (image `_storage` spill). **Out of scope (E, optional):** a
mid-run model/thinking swap — a weak fit for Cove's unattended posture and gated on a live
mid-run change surface that does not yet exist. **The thesis boundary:** the user's workflow
orchestration and the busy child-wait are the two places Cove currently runs (or blocks) agent
control flow **outside** the Convex journal; this phase pulls both back so Convex still owns every
agent loop's durability — the handler runs out-of-band but each sub-prompt it awaits is a
journaled `agentRun`, and the child await becomes a `step.awaitEvent` inside the workflow handler.
Nothing here moves work above the model call into the AI SDK.

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| A | G5.1, G5.2 | reuses `admitPrompt`/`admitSkill`/`admitCompact` + the `CoveTransport`/`CoveContext` facade ([context.ts:116](../../../src/runtime/context.ts)); each sub-prompt is a normal journaled `agentRun` |
| B | the `SandboxFactory` seam (exists, two adapters) + a resolver-by-name pattern | supersedes G3.2-D; persist a **selector**, not the closure — mirror [toolResolver.ts](../../../convex/_cove/toolResolver.ts) |
| C | the pure HITL gate (exists) + child `finalize.run` | mirror `resolveApprovals` in [runHandler.ts:70-94](../../../convex/engine/runHandler.ts); the await **must** move action→workflow-handler |
| D | `imageChunks.storageId` column (exists, unused) + an action for `ctx.storage.store` | `persist.ts` is a non-node mutation today; the spill write/read/reclaim paths all change |
| E *(optional)* | G5.1 thinking-seam wiring + a real escalation driver | deferred; no live mid-run model-change surface exists yet |

---

## A — Real workflow-handler execution (out-of-band, sub-prompts back through admit)

**What.** `POST /workflows/:name` resolves the registered `WorkflowHandler` only as a **404 existence
check**, then `admitWorkflow` creates a `kind:"workflow"` row and **reuses the undifferentiated
`agentRun` over serialized input with a hardcoded `model:"cove-test/mock"`** — the handler's
`CoveContext` orchestration (`ctx.init().session().prompt()` …) is **never invoked**. Build a real
dispatch path that **executes the user handler out-of-band**, with each sub-prompt routed back through
the existing Convex admit path as its own durable, journaled `agentRun`.

**Where.** The existence-check-only route:
[http.ts:128-159](../../../convex/http.ts) (`getRegisteredWorkflow(name)` at
[http.ts:140](../../../convex/http.ts) gates only the 404; the body just `submitWorkflow`s). The
mock-model reuse: [admit.ts:225-252](../../../convex/invoke/admit.ts) (`admitWorkflow` inserts
`model:"cove-test/mock"` at [admit.ts:240](../../../convex/invoke/admit.ts) and starts the plain
`agentRun` at [admit.ts:248](../../../convex/invoke/admit.ts)); the G2.5-deferral comment lives at
[admit.ts:219-223](../../../convex/invoke/admit.ts). The handler type +
resolver: [workflowRegistry.ts:13-65](../../../convex/workflowRegistry.ts) (`WorkflowHandler`,
`getRegisteredWorkflow`); the side-effect install
[workflowResolver.ts:1-16](../../../convex/_cove/workflowResolver.ts); the route→`submitWorkflow`
wiring [submit.ts:48-64](../../../convex/invoke/submit.ts). The facade the handler drives:
`createCoveContext` → `makeSession.runPrompt` whose `session.prompt()` **submits then
`awaitTerminal`-blocks** ([context.ts:178-204](../../../src/runtime/context.ts), the blocking
`submitPrompt`/`awaitTerminal` pair at [context.ts:194-202](../../../src/runtime/context.ts)). The
journaled step graph that must stay deterministic:
[runHandler.ts:14-108](../../../convex/engine/runHandler.ts) (`step.run*` checkpoints only). The
out-of-band precedent: flue runs the handler in a background admission task
([flue/.../handle-agent.ts:329](../../../../flue/packages/runtime/src/runtime/handle-agent.ts) →
`handler(lifecycle.ctx)`, continued past the response at
[handle-agent.ts:351-370](../../../../flue/packages/runtime/src/runtime/handle-agent.ts)). The kind
discriminator: [schema.ts:176-182](../../../convex/schema.ts).

**Target.** Re-scope **away from** "inside the journaled step graph". Run the registered handler
**out-of-band** — a `"use node"` action (or `@upstash/box` context) started from `admitWorkflow`
instead of `agentRun`-over-serialized-input — constructing a `CoveContext` whose `CoveTransport`
routes `init()`/`session()`/`prompt()`/`skill()`/`compact()` back through the **existing** Convex
admit mutations, so each sub-prompt is its own durable, journaled `agentRun` the handler `await`s.
The `kind:"workflow"` `agentRequests` row tracks the **orchestration's** lifecycle/terminal status;
**drop** the `model:"cove-test/mock"` reuse.

**Why native / why it fits.** A `WorkflowHandler` is arbitrary async JS whose `session.prompt()`
blocks on a *separate* durable run ([context.ts:194-202](../../../src/runtime/context.ts)) — running
it **inside** `workflow.define` would break journal-replay determinism (the handler is V8 but
non-deterministic; `runHandler` only issues `step.run*` checkpoints) and risk a competing loop. The
fix keeps Convex the owner of every agent loop: the orchestration runs out-of-band exactly as flue
does ([handle-agent.ts:329-370](../../../../flue/packages/runtime/src/runtime/handle-agent.ts)), but
**each** `prompt()` it awaits is admitted through the normal path and runs as a journaled `agentRun`.
No user orchestration code runs inside `workflow.define`; durable state stays in Convex.

**Effort** L (out-of-band runner + a `CoveTransport` bound to the in-Convex admit mutations +
orchestration lifecycle/terminal tracking on the `kind:"workflow"` row). **Risk** med — the new
runner is the largest functional surface in group-5; the durability invariant is upheld only if every
sub-prompt goes through `admit*` (no shortcut that runs a sub-loop in-process).

**Acceptance.** `POST /workflows/echo` (and a multi-`prompt` demo handler) actually executes the
registered handler: each `ctx.session().prompt()` creates a distinct journaled `kind:"prompt"`
`agentRun` (observable as separate requests), and the `kind:"workflow"` row terminalizes
completed/failed with the handler's result; **no** request carries `model:"cove-test/mock"` from the
workflow path; a crash mid-orchestration replays each already-finalized sub-prompt from its journal
(the out-of-band runner re-observes terminal sub-runs, never re-issues a completed one).

---

## B — Wire `resolveSandbox` to a configured sandbox **selector** (unlock `@upstash/box`)

**What.** `resolveSandbox()` **hardcodes** `localBash({ cwd: workspace })` despite a header claiming a
`SandboxFactory` seam. The full `@upstash/box` adapter (lazy provisioning, by-name resolve, base64
`bash -l` exec with timeout, box-gone re-resolve) is shipped/exported but **never reachable** at
runtime. Add a **serializable selector** resolved deterministically at setup and frozen on `runPlan`,
so `resolveSandbox` picks `localBash` vs `upstashBox` replay-safely. **Supersedes G3.2 item D.**

**Where.** The hardcode: [dispatchTools.ts:41-46](../../../convex/engine/dispatchTools.ts)
(`resolveSandbox` builds `localBash(...)` unconditionally at
[dispatchTools.ts:44](../../../convex/engine/dispatchTools.ts)). The built-but-unreached factory:
[upstashBox.ts:364](../../../convex/sandbox/upstashBox.ts) (`export function upstashBox`), exported at
[index.ts:10](../../../convex/sandbox/index.ts). The seam:
`AgentRuntimeConfig.sandbox?: SandboxFactory` ([types.ts:367](../../../src/runtime/types.ts)),
`SandboxFactory.createSessionEnv({ id })`
([types.ts:751-761](../../../src/runtime/types.ts)); the key is already in the profile allowlist at
[agent-definition.ts:50](../../../src/runtime/agent-definition.ts). The setup that reads the profile
but **never** reads/freezes a sandbox: [setup.ts:78-86](../../../convex/engine/setup.ts) (profile
read) and the `runPlan` freeze [setup.ts:329-344](../../../convex/engine/setup.ts) (no `sandbox`
written). The `runPlan` validator that lacks a `sandbox` field:
[schema.ts:45-77](../../../convex/schema.ts). The resolver-by-name pattern to mirror:
[toolResolver.ts:1-14](../../../convex/_cove/toolResolver.ts). The anti-pattern Cove must **not**
copy: flue invokes the factory closure straight from live in-memory config
([flue/.../client.ts:311](../../../../flue/packages/runtime/src/client.ts)). Unit coverage that proves
the adapter works (via `FakeBoxClient`):
[upstashBox.test.ts:317-328](../../../convex/sandbox/__tests__/upstashBox.test.ts).
`@upstash/box ^0.4.4` is installed: [package.json:81](../../../package.json).

**Target.** (1) Add a serializable sandbox **selector** to `runPlanValidator`
([schema.ts:45-77](../../../convex/schema.ts)), e.g. `sandbox?: { kind: "local" | "upstashBox";
name?: string; size?: string }` — **not** the `SandboxFactory` closure. (2) In setup, read
`profile.sandbox` ([setup.ts:78-86](../../../convex/engine/setup.ts)) and freeze **only the selector**
deterministically alongside the rest of the plan ([setup.ts:329-344](../../../convex/engine/setup.ts)).
(3) Recover the concrete `SandboxFactory` **by name** in
`dispatchTools.resolveSandbox` via a sandbox registry/resolver mirroring
[toolResolver.ts](../../../convex/_cove/toolResolver.ts) — fall back to `localBash` when no selector
is set; **never persist the closure**.

**Why native / why it fits.** This is the thesis's named out-of-band sandbox, currently never used at
runtime. A raw `SandboxFactory` is a closure and **cannot** cross the `@convex-dev/workflow` journal —
flue gets away with calling `sandbox.createSessionEnv` directly
([client.ts:311](../../../../flue/packages/runtime/src/client.ts)) only because it holds live config in
memory. Persisting a serializable selector and recovering the factory by name (the existing
tool/agent/extension-resolver pattern) keeps durable state in Convex, preserves journal replay, adds
no competing loop, and the handle stays ephemeral/per-dispatch-action per **R5**
([07 §R5](../../design/07-risks-and-decisions.md)) — re-resolved by id, never cached across the
journal.

**Effort** M (one frozen-plan field + selector freeze in setup + a by-name sandbox resolver in the
dispatch action). **Risk** low — internal wiring; no loop/durability change; the seam is unit-tested
against both adapters.

**Acceptance.** A run whose profile sets `sandbox: upstashBox(...)` dispatches tools into the upstash
box (not local bash); an unconfigured run still gets `localBash`; the frozen value on `runPlan` is a
plain selector object (no closure), and `resolveSandbox` re-derives the identical factory on replay
from the frozen selector + the by-name registry (no live config read); existing sandbox tests pass
against both adapters; the box handle is re-resolved per dispatch action and never held across the
journal.

---

## C — Replace child `task()` busy-poll with a durable `awaitEvent` wakeup

**What.** `runTaskDelegation` **polls** `getChildResult` every 500 ms up to a 200 s deadline **inside a
long-lived `"use node"` action**, busy-waiting on a child workflow; a child that outlives 200 s yields
a *not-completed* result even if it later finishes. Have the child workflow `sendEvent` on terminal
and let the parent `step.awaitEvent` it (exactly as HITL already does), freeing the action and
removing the 200 s ceiling.

**Where.** The busy-poll + ceiling:
[dispatchTools.ts:37-39](../../../convex/engine/dispatchTools.ts) (`CHILD_POLL_INTERVAL_MS = 500`,
`CHILD_POLL_DEADLINE_MS = 200_000`), the `while` loop at
[dispatchTools.ts:54-104](../../../convex/engine/dispatchTools.ts) (the poll at
[dispatchTools.ts:89-100](../../../convex/engine/dispatchTools.ts)), invoked from the `taskCalls`
loop [dispatchTools.ts:212-216](../../../convex/engine/dispatchTools.ts). The child lifecycle +
poll target + not-completed formatting: [task.ts:43-108](../../../convex/engine/task.ts)
(`createChildRequest` is idempotent by `submissionId` and starts the child workflow at
[task.ts:101-104](../../../convex/engine/task.ts)), `getChildResult`
[task.ts:111-118](../../../convex/engine/task.ts), `formatTaskResult`
[task.ts:127-145](../../../convex/engine/task.ts). The HITL gate to mirror:
[runHandler.ts:70-94](../../../convex/engine/runHandler.ts) (`resolveApprovals` parks then
`step.awaitEvent` at [runHandler.ts:82-84](../../../convex/engine/runHandler.ts)); the `sendEvent`
precedent [approvals.ts:113-153](../../../convex/engine/approvals.ts) (`workflow.sendEvent` at
[approvals.ts:145-149](../../../convex/engine/approvals.ts); the "event is durable/queued, arrives
before the loop parks → not lost" guarantee at
[approvals.ts:141-142](../../../convex/engine/approvals.ts)); the durable-suspension model header
[hitl.ts:1-4](../../../convex/engine/hitl.ts). The child's terminal emission point: the child's
`finalize.run` ([finalize.ts:17-39](../../../convex/engine/finalize.ts), an `internalMutation`, so
`workflow.sendEvent` is valid there). The constraint that forces the relocation: `awaitEvent` is
**workflow-context-only**
([workflowContext.d.ts:77](../../../node_modules/@convex-dev/workflow/dist/client/workflowContext.d.ts)),
with `onComplete`
([index.d.ts:31](../../../node_modules/@convex-dev/workflow/dist/client/index.d.ts)) and
`defineEvent`/`sendEvent`
([index.d.ts:448](../../../node_modules/@convex-dev/workflow/dist/client/index.d.ts)) available. The
group-2 canon: journaled `step.*` is sanctioned over fire-and-forget `scheduler.runAfter`
([g2.3:135](../group-2/phase-g2.3-channels-outbound.md)).

**Target.** (1) **Move the await out of** the `dispatchTools` `"use node"` action **into** the
`runHandler.ts` workflow handler — a new `resolveTaskDelegations` dep alongside `resolveApprovals`,
since `step.awaitEvent` is unavailable inside actions. (2) Emit the wakeup from the child's terminal:
add a `taskEvent(parentRequestId, toolCallId)` `sendEvent` in the child's
[finalize.run](../../../convex/engine/finalize.ts), or — more native — use `workflow.start`'s built-in
`onComplete` ([index.d.ts:31](../../../node_modules/@convex-dev/workflow/dist/client/index.d.ts)): a
child `onComplete` mutation that `sendEvent`s the parent, giving exactly-once terminal delivery that
covers child failure/cancel uniformly. (3) Idempotency is already covered:
`createChildRequest` starts the child idempotently by `submissionId`
([task.ts:47-104](../../../convex/engine/task.ts)) and the event queue is durable, so a `sendEvent`
arriving before the parent parks is not lost (the same guarantee HITL relies on,
[approvals.ts:141-142](../../../convex/engine/approvals.ts)). (4) `dispatchTools` then just writes the
formatted result (reuse [formatTaskResult](../../../convex/engine/task.ts)) **after** the await fires.

**Why native / why it fits.** This **replaces** a process-bound, non-durable busy wait inside a
`"use node"` action with durable suspension inside the Convex workflow — exactly the
`@convex-dev/workflow` primitive. The HITL gate already proves the pattern end-to-end:
`runHandler.ts:70-94` parks on `step.awaitEvent` and `approvals.ts:113-153` emits
`workflow.sendEvent` on resolve. The await **must** move action→workflow-handler because `awaitEvent`
is workflow-context-only ([workflowContext.d.ts:77](../../../node_modules/@convex-dev/workflow/dist/client/workflowContext.d.ts))
— that is the correct direction: durable state stays in Convex and journal-replay reconstructs the
await. No relocation of state, no competing loop, no AI-SDK ownership; the 200 s ceiling disappears.

**Effort** M–L (the action→handler relocation is not a drop-in: the parent loop needs a new
park/await dep and the dispatch action loses the poll). **Risk** med — the relocation touches the loop
dep surface; mitigated by mirroring the proven `resolveApprovals` shape exactly.

**Acceptance.** A `task()` whose child runs longer than 200 s still returns the child's real terminal
result (no false *not-completed*); the parent run parks via `step.awaitEvent` and consumes **zero**
action wall-clock while waiting; the child's terminal (completed/failed/cancelled) wakes the parent
exactly once; a `sendEvent` that fires before the parent parks is still consumed (durable queue); on
replay the parent re-takes the recorded await/result, never re-dispatching a completed child.

---

## D — Spill large image bytes to Convex `_storage`

**What.** Session image persistence upserts content-addressed `imageChunks` **inline** in the row's
`data` field with `refCount` dedup, but **only the inline path exists** — the documented spill to
Convex `_storage` is unimplemented. Branch on the threshold so large blobs go to `_storage` (the
native durable blob store, so durable state stays Convex-native). **Sharper than the candidate
framing:** Convex enforces a **~1 MB per-document** limit, so `MAX_IMAGE_DATA_LENGTH = 5 MB` inline
can already **hard-fail** the `imageChunks` insert today for a single large image — the spill must
cover the **read** and **reclaim** paths, not just the write branch.

**Where.** The write (inline-only) upsert:
[persist.ts:156-174](../../../convex/sessions/persist.ts) (the "P4: inline only … documented
follow-up doc 08 §4.8" comment at [persist.ts:157](../../../convex/sessions/persist.ts)), inside
`appendCanonicalEntry` ([persist.ts:113](../../../convex/sessions/persist.ts)). The read that reads
**only** `chunk.data`: `loadSessionData` [persist.ts:42-48](../../../convex/sessions/persist.ts).
The reclaim with **no** storage delete: `releaseImageRefs`
[persist.ts:235-247](../../../convex/sessions/persist.ts). The thresholds (defined, never branched
on): [images.ts:17](../../../convex/sessions/images.ts) (`MAX_IMAGE_DATA_LENGTH = 5MB`),
[images.ts:19](../../../convex/sessions/images.ts) (`INLINE_IMAGE_THRESHOLD = 100KB`); the
content-hash markers that keep hoisting deterministic: `defaultImageHash`
[images.ts:62-73](../../../convex/sessions/images.ts), `extractEntryImages`
[images.ts:80](../../../convex/sessions/images.ts) (hoists, no size branch). The schema column,
present but **unused**: [schema.ts:410-417](../../../convex/schema.ts)
(`imageChunks.storageId: v.optional(v.id("_storage"))`). The design that mandates the spill:
[08 §4.8 / line 257](../../../docs/design/08-conventions-and-execution-boundary.md) ("Inline
threshold: ~100 KB in `imageChunks.data`; larger → Convex `_storage`").

**Target.** (1) In `appendCanonicalEntry` ([persist.ts:113](../../../convex/sessions/persist.ts), the
upsert at [persist.ts:156-174](../../../convex/sessions/persist.ts)): when an attachment's base64
length exceeds `INLINE_IMAGE_THRESHOLD`, write the bytes to `_storage` and store the resulting `Id`
in `imageChunks.storageId` (leaving `data` undefined) instead of inline. (2)
`loadSessionData` ([persist.ts:42-48](../../../convex/sessions/persist.ts)): fetch via
`ctx.storage.get` when `storageId` is set, rather than only reading `chunk.data`. (3)
`releaseImageRefs` ([persist.ts:235-247](../../../convex/sessions/persist.ts)): `ctx.storage.delete`
the blob when a spilled chunk's `refCount` hits zero. **Call out in the plan:** `_storage` writes
require an **action** (`ctx.storage.store`), but `persist.ts` is a pure non-node mutation helper today
(["V8-safe: no `use node` (no box/AI SDK)"](../../../convex/sessions/persist.ts), persist.ts:7) — so
the spill likely routes large blobs through an action/scheduled mutation rather than the pure mutation
path.

**Why native / why it fits.** Convex `_storage` **is** the Convex-native durable blob store, so
spilling to it keeps durable state inside Convex (no relocation out of Convex). Image hoisting uses
deterministic content-hash markers (`defaultImageHash`,
[images.ts:62-73](../../../convex/sessions/images.ts)) and idempotent upserts, preserving
journal-replay determinism; no process-global state; the AI SDK owns nothing here.

**Effort** M (write branch + read fetch + reclaim delete + the mutation→action routing for
`ctx.storage.store`, plus tests across the spilled/inline boundary). **Risk** med — the
mutation→action relocation for the write path is the subtle bit; the dedup/refCount invariant must
hold across spilled and inline chunks alike.

**Acceptance.** An attachment over `INLINE_IMAGE_THRESHOLD` is stored as a `_storage` blob with
`imageChunks.storageId` set and `data` undefined; a sub-1 MB-but-over-threshold image that **fails**
the inline insert today now succeeds via the spill; `loadSessionData` reconstructs the bytes
identically whether inline or spilled; when a spilled chunk's `refCount` reaches zero the `_storage`
blob is deleted (no orphan); the content hash (and therefore dedup) is identical for the same bytes
regardless of inline vs spilled.

---

## E — Replay-safe mid-run model/thinking swap *(optional / deferred)*

**What.** `setup` freezes model/tools/compaction onto `runPlan` **once**; the loop never re-reads
model/thinking per step, so an agent cannot escalate to a stronger model after a tool batch. A durable
analog of pi's `prepareNextTurn` would persist model/thinking changes as session entries and have a
journaled dep re-read them per step. **Deferred:** Cove's primary posture is **unattended autonomous
runs** ([setup.ts:50-51](../../../convex/engine/setup.ts) `SYSTEM_PREAMBLE`: "operating unattended …
Do not ask the user questions"), so pi's interactive toggle is a weak fit, and **two** things make it
premature — there is no live surface to change model mid-run, and reasoning level is not threaded into
the decode at all.

**Where.** Model frozen once: [setup.ts:109](../../../convex/engine/setup.ts), no `thinkingLevel`
written at [setup.ts:329-344](../../../convex/engine/setup.ts). The per-step read that returns only
the frozen model: `getRunPlanContext` [requests.ts:11-42](../../../convex/engine/requests.ts).
`llmStep` reads `plan.model` per step with **no** `thinkingLevel`/`buildProviderOptions`:
[llmStep.ts:35-61](../../../convex/engine/llmStep.ts) (verified: `llmStep` references neither). The
loop never re-snapshots config: `runAgentLoop` [loop.ts:73-142](../../../convex/engine/loop.ts). The
unused slot + missing entry kinds: [schema.ts:49](../../../convex/schema.ts) (`runPlan.thinkingLevel`)
and [schema.ts:153](../../../convex/schema.ts) (`kind: message|compaction|custom` only — no
config-change kind). The seam that exists but is **not called from decode**:
`buildProviderOptions` [thinking.ts:134](../../../convex/providers/thinking.ts).

**Target (sequenced, minimal).** FIRST wire the **frozen** `thinkingLevel` from `runPlan` into the
decode's provider options via [thinking.ts:134 `buildProviderOptions`](../../../convex/providers/thinking.ts)
so reasoning level is honored at all — **note this overlaps G5.1's thinking-seam wiring**; treat it as
that item's dependency, not a duplicate. THEN, **only if** a real driver lands (an extension hook or
steering input that wants escalation), add a `model_change`/`thinking_level_change` entry kind to
`sessionEntries` ([schema.ts:153](../../../convex/schema.ts)) and have
`getRunPlanContext`/`llmStep` re-read the latest such entry **per step before** `resolveModel` — a
journaled, replay-deterministic re-read with **no** in-flight mutation. **Drop** the generic
`prepareNextTurn` callback; keep it data-driven via entry kinds.

**Why native / why it fits.** The durable form persists changes as session entries and re-reads them
via a **journaled** dep before the next provider request, never mutating the in-flight request: durable
state stays in Convex, replay re-yields the same model from journaled entries (deterministic), no
competing loop, and the AI SDK stays at the model boundary (the dep only chooses which model string
`llmStep` resolves). pi's mechanism is **in-memory** (`agent-loop.ts` re-reads a mutable turn state)
and would conflict — the proposed durable rewrite does not. Deferred until a concrete escalation
driver exists.

**Effort** M. **Risk** med — only if mis-built as a live in-memory mutation (forbidden); the durable
entry-kind form is low-risk but currently **driverless**.

**Acceptance** *(when undeferred)*. With no config-change entry, every step resolves the frozen plan
model (unchanged behavior); appending a `model_change` entry causes the **next** step's decode to
resolve the new model while the in-flight request is untouched; a replay re-yields the identical
model from the journaled entry; frozen `thinkingLevel` reaches `buildProviderOptions` for an
anthropic/openai/google decode.

---

## Risks & gotchas (cross-item)

- **A — out-of-band, but never in-process sub-loops.** The handler runs outside the journal; the
  invariant holds **only** if every `prompt()`/`skill()`/`compact()` it awaits is admitted through the
  Convex `admit*` mutations and runs as a journaled `agentRun`. A "fast path" that runs a sub-loop
  inside the workflow runner re-introduces exactly the non-deterministic loop this re-scope avoids, and
  loses crash recovery for the sub-run.
- **A / C — the runner re-observes, never re-issues.** On replay/crash both the workflow runner (A)
  and the parked parent (C) must reconstruct from terminal state, not re-launch completed work.
  `createChildRequest`'s `submissionId` idempotency ([task.ts:47-104](../../../convex/engine/task.ts))
  and the durable event queue are the guardrails; preserve them.
- **C — `awaitEvent` is workflow-context-only.** It does **not** exist on the action ctx
  ([workflowContext.d.ts:77](../../../node_modules/@convex-dev/workflow/dist/client/workflowContext.d.ts)),
  so the await **must** move from the `dispatchTools` action up to `runHandler.ts`. Emit the wakeup
  from the child's `finalize`/`onComplete` (a mutation), never `scheduler.runAfter` — fire-and-forget
  is not journaled and can be lost or doubled on replay ([g2.3:135](../group-2/phase-g2.3-channels-outbound.md)).
- **B — freeze the selector, never the closure.** A `SandboxFactory` is a closure and cannot cross the
  `@convex-dev/workflow` journal. Persist a serializable selector and recover the factory **by name**
  (the tool/agent/extension-resolver pattern); the handle stays per-action and re-resolved by id (R5),
  never cached across the journal. Do **not** copy flue's direct in-memory `createSessionEnv` call
  ([client.ts:311](../../../../flue/packages/runtime/src/client.ts)).
- **D — the write path needs an action; dedup must span both stores.** `ctx.storage.store` is
  action-only while `persist.ts` is a pure mutation; route large blobs through an action/scheduled
  mutation. The `refCount` dedup + reclaim invariant must hold uniformly for inline **and** spilled
  chunks — a spilled chunk hitting `refCount 0` must `ctx.storage.delete` (no orphan blobs), and the
  content hash must be identical regardless of where the bytes live.
- **B / D / E — fold from frozen + persisted only.** Any per-step or per-run resolution (the sandbox
  selector, the spilled-vs-inline read, an undeferred model re-read) must be reconstructable on replay
  from the frozen plan + persisted/journaled state — never from live in-memory or process-global
  state, or replay diverges.
