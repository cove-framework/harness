# Group 3 — AI SDK 7 — upgrade & leverage

The **third bulk** of cove-harness build plans. Where group 1 ([`../group-1/`](../group-1/))
built the cores and group 2 ([`../group-2/`](../group-2/)) finishes the surface, **group 3
moves Cove from `ai@^5` to `ai@^7` and harvests the (small, deliberate) feature surface the
bump unlocks.** The version bump is **being executed concurrently in this session** — the
dependency majors are already lifted to the v7 line in [`package.json`](../../../package.json)
(`ai ^7.0.2`, `@ai-sdk/anthropic ^4.0.0`, `@ai-sdk/google ^4.0.0`, `@ai-sdk/openai ^4.0.0`,
`@ai-sdk/gateway ^4.0.2`, `@ai-sdk/provider ^4.0.0`, `@ai-sdk/provider-utils ^5.0.0`) — so the
migration plan ([phase-g3.1](phase-g3.1-ai-sdk-7-upgrade.md)) is the **active workstream**, not a
proposal. The leverage tiers ([g3.2](phase-g3.2-native-leverage.md), [g3.3](phase-g3.3-harness-adapter.md))
are the roadmap that bump unlocks.

> Same conventions as groups 1–2 — reference headers ([08 §2](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)),
> `tsc --noEmit` green per phase, the execution boundary ([08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)),
> tests in `__tests__/`. Where this roadmap and the [design-of-record](../../design/) disagree,
> the design wins — and the design is load-bearing here: **Convex owns the durable loop; the LLM
> decides but does not control flow; tools are dispatched out-of-band with no AI SDK `execute`;
> pi's message model stays canonical; the provider-plugin layer sits atop the AI SDK.** Every
> verdict below is measured against that thesis.

## Thesis

Cove's AI-SDK surface is deliberately minimal — **one `streamText` call**
([decode.ts:152](../../../convex/engine/decode.ts)), **two `generateText` calls**
([compact.ts:170/174](../../../convex/engine/compact.ts)), `tool()` with **no `execute`**,
`jsonSchema()`, `gateway()`, and the `LanguageModel` types — because Convex (not the SDK) owns
the durable loop, the journal, replay, HITL suspension, usage rollup, telemetry, and the sandbox.
That minimalism makes the v5→v7 bump **cheap** (every expensive, non-codemoddable v6/v7 gate lands
on SDK surfaces Cove refuses) and makes most of v7's headline features **already-native or
would-conflict** rather than gaps to fill. The opportunity is therefore lopsided: a small set of
**native leverage** wins (Tier 0), a strategic **invert-expose** play once the harness API leaves
canary (Tier 1), the **bump itself** (Tier 2, now active), and a clear **do-not-adopt** list
(Tier 3) where each item would surrender the thesis. The decision to bump (below) is justified by
**currency and optionality**, not feature-pull.

## Opportunity matrix — 12 AI SDK 7 features

Status: `already-native` (Cove built it) · `partial-gap` (Cove has most, a thin delta remains) ·
`true-gap` (genuinely missing) · `would-conflict` (adopting surrenders the thesis).
Verdict: `adopt-now` · `adopt-later` · `skip` · `invert-expose`.

| # | Feature | v7 API | Cove status | Verdict | Net value |
| --- | --- | --- | --- | --- | --- |
| 1 | v5→v6→v7 upgrade path | `npx @ai-sdk/codemod v6`/`v7`; `system→instructions`; `fullStream→stream`; `LanguageModelV2→V3` | partial-gap | **adopt-now** (Tier 2) | low (currency) |
| 2 | Standardized `reasoning` option | `reasoning: 'low'…'xhigh'` on `streamText`/`generateText` | partial-gap | adopt-later | low |
| 3 | `timeout` (totalMs/stepMs/chunkMs/toolMs) + `TimeoutError` | `timeout: {…}` | partial-gap | **skip the API** (adopt `chunkMs` idea) | negative (API) |
| 4 | `performance` per-step stats | `result.finalStep.performance` (TTFT, tok/s) | partial-gap | adopt-later (the **idea**, computed natively) | med |
| 5 | Telemetry redesign | `registerTelemetry(new OpenTelemetry())` + `node:diagnostics_channel` | would-conflict | **skip** | negative |
| 6 | Tool approvals | `toolApproval: { tool: 'user-approval' }` | partial-gap | **skip mechanism**; native input-aware predicate | low |
| 7 | `WorkflowAgent` / `@ai-sdk/workflow` | `new WorkflowAgent({…})`, `'use workflow'`/`'use step'` | would-conflict | **skip** | negative |
| 8 | `ToolLoopAgent` + loop control | `stopWhen`/`prepareStep`/`runtimeContext`/`activeTools` | would-conflict | **skip facade**; native per-step `activeTools`/`toolChoice` | low |
| 9 | `HarnessAgent` (Claude Code/Codex/Pi) | `new HarnessAgent({ harness, sandbox })`; `claudeCode`/`codex`/`pi` adapters | would-conflict | **invert-expose** (publish `coveHarness`) | med |
| 10 | `uploadFile` / `uploadSkill` → `providerReference` | `uploadFile({ api: anthropic.files(), … })` | partial-gap (files) / already-native (skills) | adopt-later (`uploadFile` rider); skip `uploadSkill` | low |
| 11 | `SandboxSession` abstraction | `createVercelSandbox`, `agent.createSession()` | already-native | **skip** (wire `resolveSandbox` natively) | negative (API) |
| 12 | Tool context `contextSchema` / `toolsContext` | `tool({ contextSchema })`, `toolsContext` | would-conflict | **skip** | negative |

**Headline:** of 12 v7 features, **0 are true-gaps Cove must consume** — 3 are already-native
(11) or close, 5 would-conflict with the durable-loop thesis (5, 7, 8, 9, 12), and the real value
is a handful of **native leverage** items (Tier 0) plus one **invert-expose** play (Tier 1). The
bump (Tier 2) is currency, not capability.

## The four tiers

### Tier 0 — leverage natively (ship as Cove features, land alongside the bump)

Mostly **v5-independent** — these are Cove-owned features the analysis surfaced while mapping v7,
shippable on the current code with no SDK consumption. Detailed in
[phase-g3.2-native-leverage.md](phase-g3.2-native-leverage.md). Six items, A–F:

| | Item | Where | Why native |
| --- | --- | --- | --- |
| **A** | Wire the **dormant** `buildProviderOptions`/reasoning seam into decode | [thinking.ts:134](../../../convex/providers/thinking.ts) → [decode.ts:152](../../../convex/engine/decode.ts) | `streamText` passes **no** `providerOptions` today; Cove's `ThinkingLevel` (6-value + budget-carving + per-model native tokens) is richer than v7's flat `reasoning` string |
| **B** | Per-step `activeTools`/`toolChoice` gating | [decode.ts:156](../../../convex/engine/decode.ts) | `streamText` already accepts both; Cove freezes the full tool set once at setup ([setup.ts:110](../../../convex/engine/setup.ts)) with no per-step gating |
| **C** | `chunkMs` stall detection (~5-line fix) | [decode.ts:208](../../../convex/engine/decode.ts) | the deadline loop measures elapsed-since-start, not gap-since-last-chunk — a stalled stream is caught only at 240 s |
| **D** | Wire `resolveSandbox` to the configured `AgentRuntimeConfig.sandbox` factory | [dispatchTools.ts:41-46](../../../convex/engine/dispatchTools.ts) | hardcodes `localBash`; the swap seam ([types.ts:367/751](../../../src/runtime/types.ts)) is plumbed and unit-tested but **unwired in prod** |
| **E** | Native TTFT/throughput perf stats on the step row | [decode.ts:123/168/200/244](../../../convex/engine/decode.ts) | computed from Cove's injectable clock in the `fullStream` loop → replay-stable on the persisted row (unlike v7's in-memory `finalStep.performance`) |
| **F** *(opt.)* | Input-aware per-tool approval predicate | [decode.ts:183](../../../convex/engine/decode.ts) + [hitl.ts:35](../../../convex/engine/hitl.ts) | extends the flat `approvalTools` `string[]` allowlist ([schema.ts:192](../../../convex/schema.ts)) with an args-aware decision in the existing pure gate |

### Tier 1 — strategic invert-expose (deferred, gated on the harness API leaving canary)

Publish **Cove AS an AI-SDK harness adapter** — `coveHarness`, a peer to `claudeCode`/`codex`/`pi`
(note: `HarnessAgent` already ships a **`pi`** adapter — Cove's ancestor). Cove is **~80% there**:
[ui-types.ts:2/19](../../../src/react/ui-types.ts) mirrors the AI SDK `UIMessage` verbatim, and decode already
emits `text-delta` on `fullStream` ([decode.ts:168-170](../../../convex/engine/decode.ts)). The gap is a thin
compatibility shim, not a rebuild. **Never CONSUME `HarnessAgent`/`WorkflowAgent`** — that
surrenders the durable loop. Detailed in [phase-g3.3-harness-adapter.md](phase-g3.3-harness-adapter.md).
Deferred because the harness packages are canary-only and explicitly flagged "expect breaking
changes between releases" — pinning a published adapter to a moving surface is the real cost.

### Tier 2 — the v5→v7 bump itself (now ACTIVE)

The two-hop (`v5→v6→v7`) migration: codemods + manual fixes. The hard gate — Node 22+ / ESM —
is **already cleared** ([package.json](../../../package.json) `engines.node ">=22.18"` + `"type":"module"`;
[tsconfig.json](../../../tsconfig.json) `module:ESNext`), and Cove is **already on `ModelMessage`**
([messages.ts:11](../../../convex/providers/messages.ts)), so the v6 `CoreMessage` rename is done.

Mechanical cost (the real work): `system→instructions` (3 sites), `fullStream→stream`, usage field
renames (`cachedInputTokens→inputTokenDetails.cacheReadTokens`,
`reasoningTokens→outputTokenDetails.reasoningTokens`, `part.totalUsage→part.usage`), and the
load-bearing `LanguageModelV2→V3` spec bump (~27 casts across decode/compact/gateway/registry/usage/tests
+ rewrite the hand-rolled mock in [testModel.ts](../../../convex/providers/testModel.ts)). One **review**
item (not a rename): v6 OpenAI `strictJsonSchema` defaults `true` — could reject loose tool schemas
fed through `jsonSchema(v.parameters)` ([decode.ts:345](../../../convex/engine/decode.ts)). Post-upgrade
riders unlocked: `uploadFile` (image base64 re-send), v7 `reasoning` for unknown-family providers, an
optional `@ai-sdk/otel` exporter. Detailed in [phase-g3.1-ai-sdk-7-upgrade.md](phase-g3.1-ai-sdk-7-upgrade.md).

### Tier 3 — explicitly DO NOT adopt

Each surrenders the Convex-owns-the-loop thesis. Recorded so future readers are not tempted:

| Feature | Why skip |
| --- | --- |
| `WorkflowAgent` / `@ai-sdk/workflow` | a **competing** durability engine — relocates journal/replay/approval-suspend out of Convex ([runHandler.ts](../../../convex/engine/runHandler.ts) IS this, natively) |
| `ToolLoopAgent` consume / facade | `runtimeContext` (in-memory mutable across steps) is a replay hazard across the journaled `llmStep`; the loop is already native ([loop.ts:73](../../../convex/engine/loop.ts)) |
| v7 `timeout` / `TimeoutError` | abort-and-throw breaks **durable-data-on-timeout** — Cove force-finalizes the partial step ([decode.ts:228-254](../../../convex/engine/decode.ts)) instead of throwing |
| `registerTelemetry` / `diagnostics_channel` | process-global, AsyncLocalStorage-backed — cannot survive a journal replay or redeploy; Cove already emits GenAI-semconv spans from a durable events table ([otel.ts](../../../convex/observability/otel.ts)) |
| `toolApproval` setting | **inert** — Cove's AI-SDK tools have no `execute` ([decode.ts:340-349](../../../convex/engine/decode.ts)), so the SDK never reaches the gate; HITL is native via `step.awaitEvent` |
| `SandboxSession` stateful-session ownership + `contextSchema`/`toolsContext` | relocates durable state (cwd/history/approvals/context) **out of Convex** into an SDK-held object; Cove binds per-tool context via `SessionEnv` + the closure registry |
| `uploadSkill` | anthropic-container-only; Cove's slug+activate-on-demand catalog ([skills.ts](../../../convex/skills.ts)) is more portable |

## Decision log

**G3-D1 — Bump v5→v7 now, despite low feature-pull.** The analysis is unambiguous that there is
**zero feature-pull**: v7 graduates `experimental_` APIs Cove never imported and adds
agent/telemetry/UI machinery Cove deliberately replaced; the matrix shows **0 true-gaps**. The
earlier recommendation was therefore **adopt-later** (fold into the next provider-major bump). The
user has **decided to proceed now**. This is still reasonable on three grounds:

1. **Currency.** The dependency majors are lifting in lockstep for other reasons (provider feature
   tracking); doing the bump deliberately, with both codemods + the verified ~6-site fix list, is
   cheaper than an emergency bump under a future provider-feature deadline.
2. **Unlocks Tier-1 inversion.** The `coveHarness` invert-expose play (Tier 1) can only be authored
   against the real (v7-line) harness interface; staying on v5 forecloses it.
3. **De-risks future provider features.** Anthropic/Google/OpenAI provider majors (`@ai-sdk/*@4`)
   land the v7 `reasoning` plumbing, `uploadFile`, and the `LanguageModelV3` spec — being current
   means the next provider capability is a rider, not a re-migration.

The cheapness of the bump (no thesis surfaces touched) is **itself evidence the thesis is paying
off** — every expensive gate fell on a surface Cove refuses to own.

**G3-D2 — Compute perf stats natively, never consume `finalStep.performance`.** (Tier 0-E.) The
in-memory v7 object evaporates on replay and is absent on the force-finalize path; Cove already
holds the inputs (first-delta timestamp, inter-delta diffs, usage at `finish`) and the injectable
clock.

**G3-D3 — Invert, never consume, the agent classes.** (Tier 1 / Tier 3.) `HarnessAgent`,
`WorkflowAgent`, and `ToolLoopAgent` are competing loop owners; the only thesis-aligned move is to
expose Cove's durable loop *as* an AI-SDK-shaped surface, keeping Convex in control.

## GA / beta nuance

v7's **core** is GA-track and de-experimentalizes many APIs: `streamText`/`generateText`, the
standardized `reasoning` option, `timeout`, the telemetry redesign, and `uploadFile`/`uploadSkill`
ship **unflagged** (the `experimental_` prefix is dropped, not added). The **agent-harness**
packages are a different channel: `HarnessAgent`, `SandboxSession`, and parts of `@ai-sdk/workflow`
are **canary/experimental** — the docs say "expect breaking changes between releases." This is why
Tier 2 (core bump) is **adopt-now** while Tier 1 (`coveHarness` adapter against the harness API) is
**deferred until that surface settles**.

## Phases

| Phase | Title | Plan | Tier | Status |
| --- | --- | --- | --- | --- |
| **G3.1** | AI SDK 7 upgrade (v5→v7) | [phase-g3.1-ai-sdk-7-upgrade.md](phase-g3.1-ai-sdk-7-upgrade.md) | 2 | 🔄 **In progress** (deps bumped; fixes landing) |
| **G3.2** | Native leverage (Tier 0 A–F) | [phase-g3.2-native-leverage.md](phase-g3.2-native-leverage.md) | 0 | ◻ Proposed |
| **G3.3** | Cove-as-harness adapter (`coveHarness`) | [phase-g3.3-harness-adapter.md](phase-g3.3-harness-adapter.md) | 1 | ◻ Proposed — deferred (gated on canary) |

## Build order

```
G3.1 (bump, ACTIVE) ─▶ G3.2 (native leverage; A/C/D shippable independently)
                        └─▶ G3.3 (invert-expose; gated on harness API leaving canary)
```

**G3.1 goes first and is already underway** — the deps are bumped, so the green gate
(`tsc --noEmit` 0, vitest green, `tsup` build OK) is the immediate bar. **G3.2** lands the Cove-owned
wins; items **A** (reasoning wiring), **C** (chunkMs), and **D** (sandbox factory) are v5-independent
and can land in any order. **G3.3** is the strategic capstone, deferred until the v7 harness API is no
longer canary.
