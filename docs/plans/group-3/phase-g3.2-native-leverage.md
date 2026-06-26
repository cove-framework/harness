# Phase G3.2 — Native leverage (Tier 0, items A–F)

> Six Cove-owned features the AI-SDK-7 mapping surfaced — each shipped **natively** (computed/wired
> inside Cove's durable loop), not by consuming an SDK surface. Most are **v5-independent**: they
> land on the current code regardless of the [g3.1 bump](phase-g3.1-ai-sdk-7-upgrade.md), and they
> close real gaps (a dormant seam, a hardcoded sandbox, a stall blind-spot, missing throughput
> stats) while strengthening the durable-loop thesis rather than ceding it. Design-of-record:
> [04 — Durable Engine](../../design/04-durable-engine.md), [08 — Conventions](../../design/08-conventions-and-execution-boundary.md)
> (§4.1 replay, §4.2 deadline, §4.7 usage). Tier framing: [README §Tier 0](README.md#tier-0--leverage-natively-ship-as-cove-features-land-alongside-the-bump).

## Goal & scope

Ship the Tier-0 wins as Cove features. Each is a **mini-spec** below (what · where · why-native ·
effort · risk · acceptance), anchored to the exact call sites the analysis verified. **In scope:**
items A–E (F optional). **Out of scope:** consuming any v7 SDK option to deliver these — the whole
point is that Cove already holds the inputs (`ThinkingLevel`, the injectable clock, the
`SandboxFactory` seam, the frozen plan, the pure HITL gate). **Sequencing:** A, C, D are
v5-independent and land in any order; E and the `reasoning`-fallback half of A benefit from the
g3.1 bump but the native scaffolding does not require it.

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| A | the dormant `thinking.ts` seam (exists) | wiring only; the `reasoning`-string fallback half wants g3.1 |
| B | `decode.ts` `streamText` call + frozen plan | `streamText` already accepts `activeTools`/`toolChoice` on v5 — no bump needed |
| C | the `decode.ts` deadline loop (exists) | ~5-line local fix; v5-independent |
| D | the `SandboxFactory` swap seam (exists, two adapters) | ~5-line wiring; v5-independent |
| E | the `decode.ts` `fullStream` loop + injectable clock | additive fields on `FinalizedStep` + replay-read shape |
| F | the pure HITL gate (exists) | optional refinement of the `approvalTools` allowlist |

---

## A — Wire the dormant `buildProviderOptions` / reasoning seam into decode

**What.** Thread Cove's per-provider `providerOptions` + `maxTokens` (reasoning budgets, store flags,
Google thinking config) into the single `streamText` call. Today the whole `thinking.ts` machinery is
**dormant** — `streamText` passes only `model`/`system`/`messages`/`tools` and **no `providerOptions`,
no `maxTokens`, no reasoning** ([decode.ts:152-157](../../../convex/engine/decode.ts)).

**Where.** Seam: [thinking.ts:134](../../../convex/providers/thinking.ts) `buildProviderOptions` →
[thinking.ts:152](../../../convex/providers/thinking.ts) `buildBuiltinProviderOptions` →
[thinking.ts:213](../../../convex/providers/thinking.ts) unknown-family fallback. Consumers:
[plugin.ts:28-33](../../../convex/providers/plugin.ts) `ProviderPlugin.buildProviderOptions`,
[builtins.ts:28](../../../convex/providers/builtins.ts). Source-of-truth abstractions:
`ThinkingLevel` ([messages.ts:19](../../../src/runtime/messages.ts), `'off'|'minimal'|'low'|'medium'|'high'|'xhigh'`),
`clampThinkingLevel`/`adjustMaxTokensForThinking` ([thinking.ts:21-92](../../../convex/providers/thinking.ts)),
the per-model `thinkingLevelMap` ([capabilities.ts:34-46,151](../../../convex/providers/capabilities.ts)).
**Target:** add a `thinking`/`reasoning` field to `DecodeInput` ([decode.ts:103-110](../../../convex/engine/decode.ts),
which today has none), resolve `buildProviderOptions(handle, level)` at the decode boundary, and pass
`providerOptions`/`maxTokens` into [decode.ts:152](../../../convex/engine/decode.ts).

**Why native (not v7 `reasoning`).** Cove's `ThinkingLevel` is a **near-superset** of v7's flat
7-value `reasoning` string, plus capability-aware clamping, per-model native-token mapping
([capabilities.ts:151](../../../convex/providers/capabilities.ts) gemini LOW/HIGH), and Anthropic
`budgetTokens` carving ([thinking.ts:164-176](../../../convex/providers/thinking.ts)) — none of which the
flat string expresses. v7 also **silently ignores** the top-level `reasoning` whenever `providerOptions`
sets any reasoning key, so a naive swap is a net capability **loss**. Keep `buildProviderOptions` as the
source of truth for anthropic/openai/google; **post-g3.1**, use v7 `reasoning` only at the unknown-family
fallback ([thinking.ts:213](../../../convex/providers/thinking.ts), e.g. xAI/Groq/DeepSeek) where Cove emits
no special shape.

**Effort** M (wire the seam into decode + a thin reasoning-vs-`providerOptions` arbitration on the
upgrade). **Risk** med — purely because the `reasoning`-string half rides the major bump and the
precedence/usage-field changes; the **wiring** half (the genuine gap) is low-risk and v5-shippable.

**Acceptance.** A decode for an anthropic/openai/google model passes the matching `providerOptions` +
fitted `maxTokens` (verified against `buildBuiltinProviderOptions` output); `ThinkingLevel:'off'` passes
no thinking; an unknown-family provider falls through to the v7 `reasoning` string post-g3.1; the value is
replay-stable (resolved from the frozen plan + handle, re-derived identically on replay).

---

## B — Per-step `activeTools` / `toolChoice` gating

**What.** Allow a step to expose a **subset** of the frozen tool set (and/or force/forbid a tool) instead
of always passing the full set. Today Cove freezes tools once and passes **all** of them every decode.

**Where.** The `streamText` call's `tools: toAiTools(input.tools)` ([decode.ts:156](../../../convex/engine/decode.ts));
tools frozen at setup ([setup.ts:110](../../../convex/engine/setup.ts) `maxSteps`/plan freeze, the tool set
frozen alongside). The per-step content-mutation hook seam is Cove's `prepareStep`-equivalent
([llmStep.ts:54-58](../../../convex/engine/llmStep.ts) `applyBeforeAgentStartHooks`/`applyContextHooks`,
[apply.ts:125-150](../../../src/runtime/extensions/apply.ts)). **Target:** add optional `activeTools?:
string[]` / `toolChoice?` to the content-mutation step-prep output and pass them into
[decode.ts:152](../../../convex/engine/decode.ts) (`streamText` accepts both — **on v5 already**).

**Why native.** This is the one real loop-control gap the `ToolLoopAgent` mapping found, and it is
reachable **right now in v5** — `streamText` already takes `activeTools`/`toolChoice`, and Cove folds the
gate into its existing replay-guarded content-mutation step prep. It folds from **frozen + persisted**
inputs, so it is replay-safe (no in-memory mutable state). Do **not** consume `ToolLoopAgent` for this
([README §Tier 3](README.md#tier-3--explicitly-do-not-adopt)).

**Effort** M (one frozen-plan field + the step-prep override + the `streamText` plumbing). **Risk** low —
touches no loop control flow or durability invariant; the gate is journaled like every other decode input.

**Acceptance.** A step prep that returns `activeTools:['read_file']` causes that decode's `streamText` to
expose only `read_file`; `toolChoice:'required'`/a forced tool name is honored; the gating is reconstructed
identically on replay (folds from the frozen plan + persisted step inputs, no live registry read).

---

## C — `chunkMs` stall detection (~5-line fix)

**What.** Catch a stream that goes **silent** (no chunk for N seconds) rather than only catching total
elapsed. Today the deadline loop checks `now() - start >= deadlineMs` — total elapsed **since start**, not
the **gap since the last chunk** — so a silently-stalled stream is caught only at the 240 s wall.

**Where.** [decode.ts:34](../../../convex/engine/decode.ts) `STREAM_DEADLINE_MS = 240_000`;
[decode.ts:125](../../../convex/engine/decode.ts) `deadlineMs`; the check at
[decode.ts:208-211](../../../convex/engine/decode.ts) inside the `fullStream` for-await. **Target:** stamp a
`lastChunkAt = now()` on each iteration and add a second predicate `now() - lastChunkAt >= chunkDeadlineMs`
that triggers the same `forced = true` force-finalize branch.

**Why native.** This is the only true gap among v7's four timeout dimensions for Cove — `toolMs` and
`stepMs` are already native ([dispatch.ts:18/57-65](../../../convex/engine/dispatch.ts),
[decode.ts:34](../../../convex/engine/decode.ts)) and `totalMs` is deliberately Convex's
([loop.ts:79/141](../../../convex/engine/loop.ts)). The fix reuses Cove's existing deadline machinery and
the **force-finalize** resolution (commit the partial, [decode.ts:228-254](../../../convex/engine/decode.ts)) —
**not** v7's abort-and-throw `TimeoutError`, which would destroy the partial turn the replay guard depends
on (§4.2). A ~5-line local tweak, not an SDK adoption.

**Effort** S. **Risk** low — additive predicate in the existing loop; same force-finalize outcome.

**Acceptance.** A stream that emits one chunk then stalls is force-finalized at `chunkDeadlineMs` (not at
240 s); a steadily-streaming turn is unaffected; the forced partial still finalizes (no `TimeoutError`
escapes the loop); replay re-takes the recorded finalized step.

---

## D — Wire `resolveSandbox` to the configured `AgentRuntimeConfig.sandbox` factory

**What.** Make the live dispatch path use the **configured** sandbox provider instead of always
`localBash`. The provider-swap seam is plumbed and unit-tested with **two** adapters, but the production
dispatch loop **hardcodes** `localBash` and never reads the configured factory.

**Where.** [dispatchTools.ts:41-46](../../../convex/engine/dispatchTools.ts) `resolveSandbox` builds
`localBash({ cwd: workspace })` unconditionally. The seam it should read:
`AgentRuntimeConfig.sandbox?: SandboxFactory` ([types.ts:367](../../../src/runtime/types.ts)),
`SandboxFactory.createSessionEnv({id})` ([types.ts:751-761](../../../src/runtime/types.ts)), realized by
[upstashBox.ts:364-376](../../../convex/sandbox/upstashBox.ts) and [localBash.ts:115-126](../../../convex/sandbox/localBash.ts),
both funneling through `createSandboxSessionEnv` ([sessionEnv.ts:241-336](../../../convex/sandbox/sessionEnv.ts),
which adds workspace-escape confinement). **Target:** thread the configured factory (frozen onto the plan
at setup) into `resolveSandbox`, falling back to `localBash` only when none is configured.

**Why native.** This is the residual the `SandboxSession` mapping flagged: provider-swap is **already
native** (the `SandboxSession` portable-execution half is Cove's `SessionEnv` + `SandboxFactory`, more
mature than the SDK's — it adds confinement the SDK doesn't advertise), but the live `resolveSandbox` is
unwired. The fix is ~5 lines of internal wiring; it does **not** adopt the SDK's stateful-session ownership
([README §Tier 3](README.md#tier-3--explicitly-do-not-adopt)) — cwd/history/approvals stay in the Convex
journal, the sandbox handle stays ephemeral and re-resolved per dispatch action
([upstashBox.ts:8-9,120](../../../convex/sandbox/upstashBox.ts)).

**Effort** S. **Risk** low — internal wiring; the handle stays ephemeral/per-action per R5.

**Acceptance.** A run configured with `sandbox: upstashBox(...)` dispatches tools into the upstash box (not
local bash); an unconfigured run still gets `localBash`; the handle is re-resolved per dispatch action and
not held across the journal; existing sandbox tests pass against both adapters.

---

## E — Native TTFT / throughput perf stats on the step row

**What.** Persist per-step **time-to-first-output** and **throughput** (output tokens/sec, inter-chunk
timing) alongside the `durationMs` Cove already records — computed in the `fullStream` loop from Cove's own
clock, then folded into the `turn` event and OTel attributes.

**Where.** Inputs Cove already holds: [decode.ts:123](../../../convex/engine/decode.ts) `start = now()`
(injectable clock); the `text-delta`/`reasoning-delta` parts ([decode.ts:170-176](../../../convex/engine/decode.ts));
the token counts at `finish` ([decode.ts:200](../../../convex/engine/decode.ts)). Sinks:
`FinalizedStep.durationMs` ([decode.ts:52,244-253](../../../convex/engine/decode.ts)), the `turn` event
([decode.ts:266-275](../../../convex/engine/decode.ts), the `turn` `CoveEventVariant` at
[types.ts:885-898](../../../src/runtime/types.ts) carries `durationMs`/`model`/`usage` but **no** throughput
fields), the OTel turn span ([otel.ts:268-285](../../../convex/observability/otel.ts) → `cove.duration_ms`)
and `usageAttributes` ([otel.ts:549-571](../../../convex/observability/otel.ts), GenAI semconv). **Target:**
timestamp the first delta (TTFT), diff successive delta timestamps (inter-chunk), divide tokens-at-finish by
elapsed (tok/s); add the fields to `FinalizedStep`, the `ExistingStep` round-trip shape
([decode.ts:56-63](../../../convex/engine/decode.ts) — must change too, see Risks), the `turn` variant, and new
OTel/GenAI attributes.

**Why native (G3-D2).** The v7 `result.finalStep.performance` object is **in-memory** — it evaporates on a
workflow replay (which rebuilds from the persisted row via `reconstructDecision`,
[decode.ts:314-327](../../../convex/engine/decode.ts), never re-calling the model) and is **absent** on the
force-finalize/synthesize paths ([decode.ts:228-242](../../../convex/engine/decode.ts)). Computing the stats
from Cove's injectable clock and persisting them on the step row keeps them **durable and replay-stable** —
strictly stronger than the SDK's library-owned measurement. Cove already owns the coarse half (`durationMs`);
this adds the fine breakdown without ceding the signal.

**Effort** M (touch the decode loop, `FinalizedStep` **and** `ExistingStep`, the `turn` variant in
`types.ts`, `otel.ts` attributes, the replay-reconstruct path, tests). **Risk** low — additive, reuses the
injectable clock, no flow/durability change.

**Acceptance.** A streamed step records `timeToFirstOutputMs` + `outputTokensPerSecond` on the persisted row
and emits them on the `turn` event and as GenAI-semconv OTel attributes; a force-finalized step records the
coarse `durationMs` and degrades the throughput fields gracefully (no crash on the synthesize path); the
fields **survive a mid-loop replay** (reconstructed from the row, identical to the live write).

---

## F — Input-aware per-tool approval predicate (optional)

**What.** Let a tool's HITL gate decide on the **tool's input args**, not just its name — e.g. auto-approve
a `write_file` to `/tmp/...` but escalate everything else. Today the gate is a flat **name** allowlist.

**Where.** [decode.ts:183](../../../convex/engine/decode.ts) marks `isHitl` from `hitlToolNames` (name-keyed);
the allowlist `approvalTools: string[]` frozen on the plan ([schema.ts:192](../../../convex/schema.ts),
[setup.ts:339](../../../convex/engine/setup.ts)); the pure gate seam
[hitl.ts:17](../../../convex/engine/hitl.ts) `partitionGatedToolCalls`,
[hitl.ts:35](../../../convex/engine/hitl.ts) `applyApprovalDecision` (which already inspects/edits args).
**Target:** add an optional per-tool predicate `(args) => boolean` evaluated inside the existing pure gate —
the args are already present at park time.

**Why native.** This is the only genuine delta from v7's `toolApproval` — its per-tool input-aware function.
The **mechanism** (v7's `toolApproval` setting) is inert here (Cove's tools have no `execute`,
[decode.ts:340-349](../../../convex/engine/decode.ts), so `streamText` never reaches the gate), and adopting
it would surrender the Convex-owned durable `step.awaitEvent` suspension
([runHandler.ts:70-94](../../../convex/engine/runHandler.ts)) that already survives crash/redeploy and even
supports approve-with-edited-args (richer than v7 approve/deny). Lift only the **idea** into Cove's pure gate.
HMAC-signed approvals are **skip** — `submitApproval` is a trusted, authed Convex mutation, not a forgeable
client round-trip, so v7's forged-approval threat model does not apply.

**Effort** S (a predicate slots into one pure function with existing args access). **Risk** low — purely
additive, replay-safe (the decision is frozen into the journaled step like every other decode output).

**Acceptance.** A tool with a predicate auto-approves args matching the rule and escalates the rest via the
existing park/`awaitEvent` path; the flat `string[]` allowlist still works unchanged; the predicate decision
is replay-stable (folds from frozen plan + the journaled tool-call args).

---

## Risks & gotchas (cross-item)

- **A — keep `buildProviderOptions` the source of truth.** Do not flatten Cove's richer `ThinkingLevel` down
  to v7's `reasoning` string for anthropic/openai/google — you lose budget-carving + per-model native tokens,
  and v7 silently ignores `reasoning` when `providerOptions` sets any reasoning key. Use the v7 string only at
  the unknown-family fallback.
- **C / E — preserve §4.2 force-finalize.** Both touch the deadline loop; the resolution stays **force-finalize
  the partial**, never throw. A `TimeoutError`-style unwind would skip `batcher.flush`/`finalizeStep` and break
  the replay guard.
- **E — the read shape must change too.** The verdict's correction: `FinalizedStep`
  ([decode.ts:44-53](../../../convex/engine/decode.ts)) would carry the new fields on **write**, but
  `ExistingStep` ([decode.ts:56-63](../../../convex/engine/decode.ts)) does not round-trip timing today — both the
  write shape **and** the replay-read shape must change for the numbers to survive replay (nudging E toward the
  high end of M).
- **D — handle stays ephemeral.** Wire the **factory**, not a long-lived session. The sandbox handle is
  deliberately per-action and re-resolved by id (R5); do not cache a handle across the journal.
- **B / F — fold from frozen + persisted only.** Any per-step gating/predicate must be reconstructable on replay
  from the frozen plan + persisted step inputs; never from live registry/in-memory state, or replay diverges.
