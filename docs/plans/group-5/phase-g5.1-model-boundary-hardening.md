# Phase G5.1 — Model-boundary hardening — seams & resilience

> Close the latent gaps at Cove's single model boundary: wire the dormant thinking/reasoning seam,
> add Convex-owned durable transient-retry, real abort plumbing, inter-chunk stall detection, a
> truncation `finishReason` marker, a pre-decode token-budget compaction guard, cache-write usage
> accounting, and the OpenAI strict-JSON-schema escape — all **replay-safe**, all at the
> decode/usage/setup seam, none ceding the durable loop to the AI SDK. Design-of-record:
> [04 — Durable Engine](../../design/04-durable-engine.md),
> [08 — Conventions](../../design/08-conventions-and-execution-boundary.md) (§4.1 replay, §4.2
> deadline, §4.7 usage), [07 — Risks & Decisions](../../design/07-risks-and-decisions.md) (R6 action
> limits). **This phase SUPERSEDES the unbuilt group-3 [G3.2](../group-3/phase-g3.2-native-leverage.md)
> items A (thinking-seam) and C (stall detection)** — they are folded here, expanded, and shipped with
> company. Per [G3.2 item B / decision note], per-step `activeTools`/`toolChoice` gating is *not*
> here — it lives in [G5.2](phase-g5.2-pending-input-substrate.md) alongside steering.

## Goal & scope

Each item below is a **mini-spec** (what · where · why-native · effort · risk · acceptance), anchored
to the exact call site the analysis verified. The whole point is that Cove already holds the inputs —
the built-but-dormant `thinking.ts` seam, the written-but-unused transient-error classifier, the
existing force-finalize path, the deterministic compaction token math, the already-declared
`cacheWriteTokens` field — so every item is *wiring* a pre-built capability into the one place the AI
SDK is allowed to live.

**In scope:** all eight items A–H, at the model boundary only (`convex/engine/decode.ts`,
`usage.ts`, `setup.ts`, `requests.ts`, `llmStep.ts`, `runHandler.ts`; `convex/providers/thinking.ts`).
**Out of scope:** any in-action retry/stall *loop* that would non-determinize replay (Convex/Workpool
owns durable retry; the stall finalize routes through the existing force-finalize path); persisting
partial turns on cancel (discard-on-cancel stays); raising the overflow retry budget (a working
pre-decode guard makes `=1` sufficient); per-step tool gating and steering (G5.2). No durable state
leaves Convex; the AI SDK is never elevated above the single `streamText` call.

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| A | the dormant `buildProviderOptions` seam (built, exported, tested) | wiring only — `setup → getRunPlanContext → llmStep → decode` chain |
| B | the `llmStep` `step.runAction` in `runHandler.ts` + `@convex-dev/workflow` `RetryBehavior` | declarative retry option; no new code path |
| C | the `dispatch.ts` `signal` seam (exists) + `decode.ts` `streamText` call | needs a concurrent cancel-poll watcher (the real work) |
| D | the `decode.ts` `fullStream` loop + `src/runtime/abort.ts` `composeTimeoutSignal` | reuses the existing force-finalize resolution; supersedes G3.2-C |
| E | the `forced` branch in `decode.ts` (exists) | one marker on an already-journaled field |
| F | the pure `estimateContextTokens` math (`compaction.ts`) + the loop's journaled `compact` step | derive only from reconstructed history |
| G | `AiSdkUsage.inputTokenDetails.cacheWriteTokens` (already declared) | one field read + a stale comment delete |
| H | the `decode.ts` `streamText`/`toAiTools` call (gateway-resolved) | trigger-gated guard + regression test; do **not** wire unconditionally |

---

## A — Wire the dormant `buildProviderOptions` / thinking seam into decode

**What.** The entire `thinking.ts` machinery — `buildProviderOptions()` (per-family anthropic
`budgetTokens` / openai `reasoningEffort`+`store` / google `thinkingConfig`) plus
`adjustMaxTokensForThinking`/`clampThinkingLevel` — is fully built, exported, and unit-tested but has
**zero callers in the engine**. The single `streamText` call passes only
`model`/`instructions`/`messages`/`tools`; no `providerOptions`, no `maxTokens`, no reasoning. The
schema's `thinkingLevel` field is declared but never resolved/frozen at setup. One feature plumbed
nowhere end-to-end.

**Where.** Seam (built): [thinking.ts:134](../../../convex/providers/thinking.ts) `buildProviderOptions`
→ [thinking.ts:152](../../../convex/providers/thinking.ts) `buildBuiltinProviderOptions`,
[thinking.ts:21-92](../../../convex/providers/thinking.ts) `clampReasoning`/`adjustMaxTokensForThinking`/
`clampThinkingLevel`; re-exported at [index.ts:31-37](../../../convex/providers/index.ts). The handle
already carries the inputs `buildProviderOptions` consumes —
`provider`/`maxOutputTokens`/`supportsReasoning`/`thinkingLevelMap`
([gateway.ts:77-88](../../../convex/providers/gateway.ts)). Gaps to close, in order:
- [setup.ts:81-86](../../../convex/engine/setup.ts) — `resolveAgentProfile` already yields
  `profile.thinkingLevel` (via [agent-definition.ts:106-108](../../../src/runtime/agent-definition.ts))
  but it's dropped; [setup.ts:329-344](../../../convex/engine/setup.ts) — the `runPlan` patch omits
  `thinkingLevel` (schema field at [schema.ts:49](../../../convex/schema.ts) is declared but unset).
- [requests.ts:19-40](../../../convex/engine/requests.ts) — `getRunPlanContext` omits `thinkingLevel`.
- [llmStep.ts:141](../../../convex/engine/llmStep.ts) — the `runDecode({...})` call omits any thinking field.
- [decode.ts:103-110](../../../convex/engine/decode.ts) — `DecodeInput` has no thinking field;
  [decode.ts:152-157](../../../convex/engine/decode.ts) — `streamText` omits `providerOptions`/`maxTokens`.

**Target:** (1) at setup, clamp `profile.thinkingLevel` via `clampThinkingLevel(handle-caps)` and add it
to the `runPlan` patch so it is **frozen for replay**; (2) return `runPlan.thinkingLevel` from
`getRunPlanContext`; (3) thread it into `DecodeInput` via `llmStep`; (4) in decode, call
`buildProviderOptions(handle, level, { maxTokens, storeResponses })` and pass the resulting
`providerOptions` + fitted `maxTokens` into `streamText`.

**Why native / why it fits.** **Supersedes G3.2 item A** and folds in the full end-to-end wiring G3.2
only sketched. `thinking.ts` is V8-safe and imports nothing from the AI SDK
([thinking.ts:8-9](../../../convex/providers/thinking.ts)) — it emits only AI-SDK `providerOptions`
*key names*, so the SDK stays thin and the options enter only at the one `streamText` call (the
sanctioned boundary). Freezing the *resolved* level at setup removes any live registry/profile lookup
mid-run, exactly mirroring how model/compaction are already frozen ("freeze the resolution so replay
never drifts", [setup.ts:40-44](../../../convex/engine/setup.ts)); `buildProviderOptions` re-clamps
defensively so it stays correct if the model is re-resolved. Default `'off'`/undefined ⇒ existing runs
are byte-identical.

**Effort** M (a four-file pass through an existing chain) · **Risk** low — additive; the pure helpers
are already tested, the only new surface is the boundary plumb.

**Acceptance.** A decode for an anthropic/openai/google model passes the matching `providerOptions` +
fitted `maxTokens` (asserted against `buildBuiltinProviderOptions` output); `thinkingLevel` unset ⇒
no `providerOptions`/`maxTokens` and a byte-identical request; the frozen level reconstructs identically
on replay (resolved from the frozen plan + handle, never re-derived from a live profile). A new
`decode.test.ts` case asserts `providerOptions`/`maxTokens` flow through to the `streamText` args.

---

## B — Classify + retry transient model errors at the durable workflow layer

**What.** `retry.ts` ports flue's transient-error classifiers
(`isRetryableThrown`/`isRetryableModelError`/`isRetryableErrorMessage` — overloaded/429/5xx/network/
timeout), but only `isContextOverflow` is wired; on a transient provider failure decode throws straight
out of the `llmStep` action. The `llmStep` `step.runAction` carries **no retry option**, and
`WorkflowManager` is constructed with **no `workpoolOptions`**, even though the library exposes per-step
`RetryBehavior`. Today Cove relies solely on the AI SDK's in-process HTTP retries — the very thing the
thesis wants Convex, not the SDK, to own.

**Where.** Classifiers (written, unused beyond overflow):
[retry.ts:18-39](../../../convex/engine/retry.ts) (regex + `isRetryableThrown`/`isRetryableModelError`).
Throw site: [decode.ts:224](../../../convex/engine/decode.ts) (`throw toError(streamError)` — only the
overflow branch at [decode.ts:220](../../../convex/engine/decode.ts) is handled). No retry option on any
`step.runAction`: [runHandler.ts:36-39](../../../convex/engine/runHandler.ts) (`decode`/`dispatch`),
also [runHandler.ts:23,61,106](../../../convex/engine/runHandler.ts). Manager with no options:
[workflow.ts:8](../../../convex/workflow.ts). Existing overflow retry-as-fresh-step template (NOT
transient): [loop.ts:86-92](../../../convex/engine/loop.ts). Library: `@convex-dev/workflow` v0.3.12
exposes `RetryBehavior` on `runAction` and `workpoolOptions` on the ctor.
**Target:** set a bounded, **declarative** `RetryBehavior` on the `llmStep` `step.runAction`
(e.g. `{ retry: { maxAttempts: 3, initialBackoffMs, base: 2 } }`), letting Convex/Workpool own durable
retry+backoff across independent transactions — **NOT** an in-action loop.

**Why native / why it fits.** Reinforces the thesis: a declarative `RetryBehavior` makes Workpool own
durable retry+backoff in journal-safe, replay-deterministic transactions; an in-action retry loop
(explicitly forbidden) would non-determinize replay. Center scope on this declarative path (in-thesis,
low-risk). Treat the "classify with `isRetryableThrown` and retry-as-fresh-step" variant as **secondary**
— its only real value is to *not* retry hard errors (auth/bad-request) when blanket retry is undesirable;
otherwise it is partly redundant with Workpool's transient handling and adds complexity. Keep
`dispatchTools` retry **out** of scope (tool effects need idempotency analysis first). Either delete the
now-dead `isRetryableThrown`/`isRetryableModelError` or actually consume one in the chosen path so the
classifier stops being unused code.

**Effort** M (one declarative option + a decision on the dead classifier) · **Risk** low — no new
control flow; bounded attempts in separate transactions.

**Acceptance.** A transient `streamText` failure (overloaded/429/5xx) on `llmStep` is retried up to
`maxAttempts` with backoff by Workpool, then surfaces as a failed step if still failing; a hard error
(auth/bad-request) is **not** retried; the retried step is a fresh transaction (no in-action loop), so
a mid-retry replay re-takes the journaled outcome deterministically; `retry.ts` has no
unused-export lint after the cleanup.

---

## C — Plumb a real `AbortSignal` to tools and the model stream on cancel

**What.** Cancellation is poll-only. `dispatchTools` re-queries status before/after each tool but
constructs **no `AbortController`**, so `DispatchDeps.signal` is always `undefined` and `tool.execute`
never receives a live abort; `decode` passes **no `abortSignal`** to `streamText`, so a cancelled
request runs the decode to completion and just discards the result. Cancellation is best-effort-discard,
not true interruption.

**Where.** Signal seam (present but unfed): [dispatch.ts:20-29](../../../convex/engine/dispatch.ts)
`DispatchDeps.signal`, forwarded into `tool.execute` at
[dispatch.ts:58](../../../convex/engine/dispatch.ts); the cancel checks at
[dispatch.ts:49,69](../../../convex/engine/dispatch.ts). The `runDispatch` call passes no signal:
[dispatchTools.ts:209](../../../convex/engine/dispatchTools.ts); the cancel poll:
[dispatchTools.ts:149-150](../../../convex/engine/dispatchTools.ts) reading
[steps.ts:245-251](../../../convex/engine/steps.ts) `requestStatus`. No `abortSignal` on the model
stream: [decode.ts:152-157](../../../convex/engine/decode.ts). Framework/bash tools already honor a
signal: [frameworkTools.ts:84-85](../../../convex/engine/frameworkTools.ts) `throwIfAborted`,
[frameworkTools.ts:232,240](../../../convex/engine/frameworkTools.ts) `composeTimeoutSignal` →
`env.exec({ signal })`. `DecodeDeps` wiring (no signal):
[llmStep.ts:91-141](../../../convex/engine/llmStep.ts).
**Target:** a per-action `AbortController` fired on cancel, its signal passed into `runDispatch`
(→ `tool.execute`) and into `streamText`'s `abortSignal`.

**Why native / why it fits.** The `AbortController` is **per-action ephemeral** state that dies with the
action and is reconstructed on replay (Convex re-runs `llmStep`/`dispatchTools` from the journal) — it
adds no durable state and survives replay by being rebuilt, not persisted. Discard-on-cancel /
no-persist-partial is **preserved exactly** for replay determinism. The signal only enters the existing
model-boundary `streamText` call and the already-signal-aware dispatch; Convex still owns the loop and
cancel status still lives in the `agentRequests` row read via `requestStatus`.

**Critical implementation note** (the description understates): within one Convex action JS is
single-threaded and `isCancelled()` is a DB poll — nothing *pushes* the cancel flip, so "fired when
`isCancelled` flips" actually requires a **concurrent poll loop** (e.g. racing `requestStatus` on an
interval) that calls `controller.abort()` mid-stream. That watcher is the real work, not the one-line
signal pass-through; it is what justifies the M effort. (The same signal may also feed the
task-delegation / `activate_skill` loops, though those already short-circuit via `isCancelled` between
calls.)

**Effort** M (the concurrent cancel-watcher, not the pass-through) · **Risk** med — a concurrent timer
racing the stream; must clear cleanly on normal finish.

**Acceptance.** Cancelling a run mid-stream aborts the in-flight `streamText` (the decode returns/throws
promptly, not after the full turn) and fires the signal into running tools (bash honors it); the partial
turn is **not persisted** (discard-on-cancel); the watcher is cleared on normal completion (no leaked
timer); a replay rebuilds the controller and re-takes the journaled outcome — no persisted partial to
diverge on.

---

## D — Inter-chunk stall / no-progress detection on the model stream

**What.** Decode enforces only a single wall-clock `STREAM_DEADLINE_MS` (240 s), checked after each
stream part. A provider that opens the stream then **stalls** (no deltas) burns the full deadline. Add
an **inter-chunk idle deadline** that resets on each stream part, distinct from the total deadline; on
stall, force-finalize the partial via the existing path.

**Where.** [decode.ts:34](../../../convex/engine/decode.ts) `STREAM_DEADLINE_MS = 240_000`;
[decode.ts:125](../../../convex/engine/decode.ts) `deadlineMs`; the `fullStream` for-await loop with the
total-deadline check at [decode.ts:208-211](../../../convex/engine/decode.ts) (no `abortSignal` on the
`streamText` call at [decode.ts:152-157](../../../convex/engine/decode.ts)); force-finalize resolution at
[decode.ts:228-242](../../../convex/engine/decode.ts) (`forced` → `synthesizeResponse`), replayed via
[decode.ts:314-327](../../../convex/engine/decode.ts) `reconstructDecision`. The idle-timer primitives
already exist but are **unused by decode**: [abort.ts:36-44](../../../src/runtime/abort.ts)
`composeTimeoutSignal` / `AbortSignal.timeout`. (`deltaBatcher.lastFlush` is flush-cadence only.)
Design anchors: [08 §4.2:183-189](../../design/08-conventions-and-execution-boundary.md) (single 240 s
deadline), [04 §Stream deadline:303-310](../../design/04-durable-engine.md),
[07 R6:116-124](../../design/07-risks-and-decisions.md).
**Target:** an inter-chunk idle deadline (reset per part) that triggers the same `forced = true`
force-finalize branch.

**Why native / why it fits.** **Supersedes G3.2 item C** and corrects its mechanism. A timestamp check at
the *bottom* of the for-await loop (mirroring [decode.ts:208](../../../convex/engine/decode.ts)) **cannot
fire during a true stall**, because that loop body only runs when a part arrives. Implement instead via a
`Promise.race` between the iterator's `next()` and an idle timer, **or** wire an `AbortSignal` into
`streamText`'s `abortSignal` using the existing `composeTimeoutSignal`/`AbortSignal.timeout` primitives,
resetting the idle window on each part. Treat the stall finalize **exactly** like the existing forced
path (commit the partial; do **not** adopt the AI-SDK v7 abort-and-throw `TimeoutError`, which would
destroy the partial turn the replay guard depends on, §4.2) so replay reconstruction is unchanged. Scope
as a **latency/cleanliness improvement, not a correctness fix** — the worst case today is already
crash-safe (a killed action leaves a non-finalized streaming row the journal re-decodes,
[decode.ts:4-9](../../../convex/engine/decode.ts)).

**Effort** S · **Risk** low — same force-finalize outcome, additive idle window.

**Acceptance.** A stream that emits one chunk then goes silent is force-finalized at the idle deadline
(not at 240 s); a steadily-streaming turn is unaffected; the forced partial still finalizes through
`synthesizeResponse` (no `TimeoutError` escapes the loop); replay re-takes the recorded finalized step
identically.

---

## E — Mark deadline/stall force-finalized turns with a distinct `finishReason`

**What.** On hitting the deadline (or a D-stall) the loop force-finalizes a partial via
`synthesizeResponse` but stamps `finishReason` **`"stop"`**, so a truncated decode is indistinguishable
downstream from a naturally-finished turn — no truncation marker, no diagnosability. Stamp a distinct
`finishReason` (e.g. `"deadline"`/`"truncated"`) on forced finalize.

**Where.** [decode.ts:31](../../../convex/engine/decode.ts) `CONTEXT_OVERFLOW_FINISH_REASON` (the
precedent); [decode.ts:162](../../../convex/engine/decode.ts) `finishReason` default `"stop"`;
[decode.ts:198-201](../../../convex/engine/decode.ts) the `finish` part;
[decode.ts:208-211](../../../convex/engine/decode.ts) the deadline break sets `forced`;
[decode.ts:228-229](../../../convex/engine/decode.ts) the `if (forced)` branch (where the marker is set);
[decode.ts:244-254](../../../convex/engine/decode.ts) `finalized` carries `finishReason`;
[decode.ts:317](../../../convex/engine/decode.ts) `reconstructDecision` replays the overflow marker (the
same mechanism). Persisted by [steps.ts:99,120,133](../../../convex/engine/steps.ts) `finalizeStep`
(context_overflow marker precedent at [steps.ts:173](../../../convex/engine/steps.ts)). Loop never
branches on `finishReason` ([loop.ts:79-138](../../../convex/engine/loop.ts) — overflow/toolCalls/
shouldCompact only); `turn_end` hook reads `decision.finishReason`
([llmStep.ts:148](../../../convex/engine/llmStep.ts)).
**Target:** when `forced === true`, set `finalized.finishReason` to the truncation marker instead of the
default `"stop"`, at/after [decode.ts:228](../../../convex/engine/decode.ts).

**Why native / why it fits.** Aligned — and it is *exactly* the pattern Cove already runs for overflow:
`CONTEXT_OVERFLOW_FINISH_REASON` is written on finalize and reconstructed deterministically on replay
([decode.ts:317](../../../convex/engine/decode.ts)), proving a distinct `finishReason` marker is
replay-safe and fully Convex-owned. The marker is part of the persisted row a replay reads back, so no
durable state leaves Convex and determinism holds. **Do NOT add a new loop branch in this item** — leave
loop behavior unchanged so it stays low-risk; pair the actual loop reaction with item D. Optionally
surface the truncation flag on the emitted `turn` event for observers
([decode.ts:266-275](../../../convex/engine/decode.ts)).

**Effort** S · **Risk** low — a single value on an already-journaled field. *(optional but cheap.)*

**Acceptance.** A forced-finalize step yields `finishReason === "deadline"`/`"truncated"` on the
persisted row (asserted by a new `decode.test.ts` case — there is no forced/deadline case today); a
replay reconstructs that same marker via `reconstructDecision` for free; a naturally-finished turn still
reports `"stop"`; loop behavior is unchanged.

---

## F — Pre-decode token-budget guard (compact before an oversized request)

**What.** Compaction triggers **reactively**: the threshold uses the *previous* step's persisted usage
(lags one step), or post-failure overflow recovery (compact+retry once, `overflowRetryBudget = 1` so a
second overflow fails hard). So the first oversized turn always incurs a wasted provider rejection. Add a
**pre-decode** token estimate so a turn known to exceed `contextWindow − reserve` compacts **before** the
call, not after a rejection.

**Where.** Reactive paths: [decode.ts:305-311](../../../convex/engine/decode.ts) `compactionDecision`
(post-step), [decode.ts:215-225](../../../convex/engine/decode.ts) (post-rejection overflow);
[loop.ts:76-95,131-135](../../../convex/engine/loop.ts) (`overflowRetryBudget` default 1, reactive
compact ordering after dispatch). Context is rebuilt pre-decode and frozen compaction settings are
available: [llmStep.ts:42-60](../../../convex/engine/llmStep.ts) (history rebuilt),
[llmStep.ts:79-89](../../../convex/engine/llmStep.ts) (frozen compaction). Frozen settings on the plan:
[requests.ts:27-31](../../../convex/engine/requests.ts). Budget hardcoded:
[runHandler.ts:33](../../../convex/engine/runHandler.ts) (`DEFAULT_OVERFLOW_RETRY_BUDGET`). The
**deterministic** math to reuse verbatim:
[compaction.ts:78-131](../../../src/runtime/compaction.ts) `estimateTokens` /
`estimateContextTokens` / `shouldCompact` (chars/4, conservative).
**Target:** a journaled pre-decode `shouldCompact` check in the loop before `deps.decode(stepNumber)`:
estimate context tokens via `estimateContextTokens` over the replay-reconstructed history and compare to
`contextWindow − reserveTokens`; if over, run the already-journaled `compact` step first, then decode the
compacted history.

**Why native / why it fits.** The estimate reuses the existing **pure** chars/4 math over the
replay-reconstructed entry-tree context, so it is deterministic for journal replay. It lives in the loop
(which already owns the journaled decode→compact→fresh-step control flow) or the already-journaled
`llmStep` action — no durable state leaves Convex, no competing loop, and the AI SDK stays at the model
boundary (the estimate runs *before/outside* `streamText`). The compaction settings + `contextWindow`
are already frozen on the run plan, so the reserve math is replay-stable. The **only** way it could break
determinism is if the estimate read live mutable state instead of the persisted context — so the estimate
**MUST** derive solely from the reconstructed history. **DROP the "raise the overflow retry budget"
sub-item:** a working pre-decode guard makes `overflowRetryBudget = 1` sufficient (post-rejection becomes
a rare backstop for estimate-undershoot); raising it just adds more wasted rejections. At most make it
operator-configurable rather than hardcoded at [runHandler.ts:33](../../../convex/engine/runHandler.ts).

**Effort** M (a journaled pre-decode branch + estimate reuse) · **Risk** low — additive, reuses frozen
state and pure math; net value bounded (overflow recovery already prevents hard failure today — this is a
latency/cost optimization on the first oversized turn, not a correctness fix), hence **medium not high**.

**Acceptance.** A turn whose reconstructed history exceeds `contextWindow − reserve` compacts **before**
the decode (no wasted provider rejection on the first oversized turn) and decodes the compacted history;
a normal-sized turn skips the guard with no extra compact; the estimate is computed only from the
reconstructed/persisted context, so a mid-loop replay recomputes the identical decision and re-takes the
journaled `compact`; `overflowRetryBudget` stays `1` (post-rejection path remains a backstop).

---

## G — Read cacheWrite tokens into the usage bridge (accounting fix)

**What.** `usageFromAiSdk` hardcodes `cacheWrite = 0` even though AI SDK v7 surfaces
`inputTokenDetails.cacheWriteTokens`; cache-write cost is always under-reported for providers that bill
it (Anthropic `cacheWrite` rates exist in the catalog but are never multiplied by real tokens). Pure
accounting fix.

**Where.** [usage.ts:117](../../../convex/engine/usage.ts) `const cacheWrite = 0;`;
[usage.ts:90-94](../../../convex/engine/usage.ts) `AiSdkUsage.inputTokenDetails.cacheWriteTokens`
(declared but unread); the stale "double-count" comment at
[usage.ts:105-107](../../../convex/engine/usage.ts) claiming a non-existent provider-side refinement;
`usageFromAiSdk` is the live path ([decode.ts:250](../../../convex/engine/decode.ts) + the compact path).
Anthropic `cacheWrite` rates that are currently dead code:
[capabilities.ts:60,67,74,81,88](../../../convex/providers/capabilities.ts) (3.75 / 3.75 / 1.25 / 6.25 /
18.75) and the bedrock mirror [capabilities.ts:168,175,182](../../../convex/providers/capabilities.ts).
`cacheWrite` is already a first-class persisted/public field:
[schema.ts:85](../../../convex/schema.ts), [types.ts:539](../../../src/runtime/types.ts). The test to
update: [usage.test.ts:94](../../../convex/engine/__tests__/usage.test.ts) (asserts
`cacheWrite === 0`).
**Target:** replace `const cacheWrite = 0;` with
`const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;` and rewrite the stale comment.

**Why native / why it fits.** `usage.ts` is a pure, V8-safe, type-only-import module (no AI SDK runtime
import); it computes derived accounting from a structurally-typed usage object. Reading one more
already-declared field changes no durable-state location and no replay determinism (the input is the same
model-call result already journaled). `usageFromAiSdk` is the sanctioned model-boundary bridge. Verify
the v7 Anthropic mapping: `inputTokens` **excludes** cache-creation tokens (they live in
`inputTokenDetails`), so this does **not** double-count against `input`.

**Effort** S · **Risk** low — one field read + comment delete + a test assertion flip.

**Acceptance.** `usageFromAiSdk` maps `inputTokenDetails.cacheWriteTokens` into `cacheWrite`;
[usage.test.ts:94](../../../convex/engine/__tests__/usage.test.ts) is updated and a new case proves
`cacheWrite` tokens flow into `cost.cacheWrite` at the catalog rate; `input` is unchanged (no
double-count); the stale comment is gone.

---

## H — Wire per-call `strictJsonSchema:false` escape for live OpenAI (optional)

**What.** AI SDK v6+ OpenAI defaults `strictJsonSchema:true`, which could reject loose user JSON Schemas
fed via `jsonSchema(v.parameters)` at the decode boundary. The group-3 plan resolved it as **review-only**
because the suite is mock-based, so the per-call escape is not wired. Latent risk, not a feature.

**Where.** [decode.ts:18](../../../convex/engine/decode.ts) (`jsonSchema`/`streamText`/`tool` import);
[decode.ts:152-157](../../../convex/engine/decode.ts) (`streamText` call has no `strictJsonSchema`);
[decode.ts:339-349](../../../convex/engine/decode.ts) `toAiTools` (no `providerOptions` on the per-tool
`tool({...})` — line 345 builds `inputSchema: jsonSchema(...)`). Models are resolved via the Vercel AI
**gateway**, not `@ai-sdk/openai` directly: [gateway.ts:11,109](../../../convex/providers/gateway.ts).
The suite is 100% mock-based ([testModel.ts](../../../convex/providers/testModel.ts)), so live OpenAI
strict-mode rejection is unreached. Group-3 disposition: task 7 review-only, escape not wired
([phase-g3.1:168-172,212-215](../group-3/phase-g3.1-ai-sdk-7-upgrade.md)).
**Target (re-scoped to a tracked, trigger-gated guard):** add a regression test (a loose/non-strict user
JSON Schema through `jsonSchema(v.parameters)`) plus a short TODO marker at
[decode.ts:345](../../../convex/engine/decode.ts) documenting the per-call
`providerOptions.openai.strictJsonSchema = false` escape. Do **NOT** wire the escape unconditionally now.

**Why native / why it fits.** A per-call `strictJsonSchema:false` provider option lives entirely at the
sanctioned model boundary (`decode.ts`, where the AI SDK is already imported). It is a passive option flag
on the `streamText`/`tool` call — it relocates no durable state, does not affect the persisted step/usage
path, adds no competing loop, and does not let the AI SDK own anything above the model call. But because
Cove resolves models via the gateway (not `@ai-sdk/openai`) and the suite is mock-based, live strict-mode
rejection is unreached today — so **gate the actual edit on the first live-OpenAI failure**, exactly as
group-3 task 7 / risks prescribe.

**Effort** S · **Risk** low — a test + a documented TODO; no behavior change until triggered.

**Acceptance.** A regression test feeds a non-strict user JSON Schema through `toAiTools` and documents
the expected failure surface; the TODO at [decode.ts:345](../../../convex/engine/decode.ts) names the
exact per-call escape; the escape is **not** wired (no `strictJsonSchema` source hit) until a live-OpenAI
rejection is observed.

---

## Risks & gotchas (cross-item)

- **A — keep `buildProviderOptions` the source of truth; freeze the level at setup.** Resolve and
  `clampThinkingLevel` once at setup and freeze `thinkingLevel` onto the run plan; never look up the
  profile/registry mid-run, or replay diverges. The options enter **only** the one `streamText` call;
  do not let any thinking shape leak into the V8-safe modules.
- **B / C — Convex owns durability; the action stays in-thesis.** B's retry must be the **declarative**
  `RetryBehavior` (separate transactions), never an in-action loop. C's `AbortController` must be
  **per-action ephemeral** (rebuilt on replay), never persisted; the concurrent cancel-watcher must be
  cleared on normal finish so it cannot leak or fire post-completion.
- **C / D — preserve discard-on-cancel and §4.2 force-finalize.** A cancelled decode discards the
  partial (no persist). A stalled decode **force-finalizes** the partial through `synthesizeResponse` —
  it must **never** throw a v7 `TimeoutError`, which would skip `batcher.flush`/`finalizeStep` and break
  the replay guard. D's idle check cannot be a bottom-of-loop timestamp (it can't fire during a true
  stall) — use `Promise.race` / a reset-per-part `AbortSignal`.
- **D / E — the marker rides the already-journaled `finishReason`.** E stamps a distinct value on the
  persisted `finishReason` field (replayed for free by `reconstructDecision`); do **not** add a loop
  branch on it in E — pair the loop reaction with D. The two are designed to compose: D forces the
  finalize, E labels it.
- **F — derive the estimate from reconstructed history only.** The single determinism trap: the
  pre-decode estimate must read solely the replay-reconstructed/persisted context (chars/4 over the
  entry tree), never live mutable state, or a replay recomputes a different compact decision. Reuse
  `compaction.ts` math verbatim; do not invent new token math. Do **not** raise `overflowRetryBudget`.
- **G — verify the v7 cache-token partition.** `inputTokens` excludes cache-creation tokens in v7
  (they live in `inputTokenDetails`), so reading `cacheWriteTokens` into `cacheWrite` does not
  double-count against `input`. Confirm against the live Anthropic mapping before trusting the cost line.
- **H — do not wire the escape blind.** Gateway-resolution + mock-only suite mean strict-mode is
  unreached; an unconditional `strictJsonSchema:false` would silently loosen schema validation for every
  provider. Ship only the test + TODO; gate the real edit on a live failure.
