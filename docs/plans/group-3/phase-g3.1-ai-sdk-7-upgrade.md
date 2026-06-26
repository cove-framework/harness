# Phase G3.1 — AI SDK 7 upgrade (v5 → v7)

> Move Cove's deliberately-minimal AI-SDK surface from `ai@^5` to `ai@^7` via the two-hop
> (`v5→v6→v7`) codemods plus the verified manual-fix list, without touching a single
> hardened-contract invariant. The hard gate (Node 22+ / ESM) is already cleared and Cove is
> already on `ModelMessage`, so the migration is small, mechanical, and low-risk — its cheapness is
> itself the thesis paying off. Design-of-record: [08 — Conventions & Execution Boundary](../../design/08-conventions-and-execution-boundary.md)
> (§4.1 replay determinism, §4.2 stream deadline, §4.7 usage & cost), [04 — Durable Engine](../../design/04-durable-engine.md),
> [03 — Data Model](../../design/03-data-model-sor.md). Decision: [G3-D1](README.md#decision-log).

> **Status — ✅ DONE & VERIFIED** (branch `upgrade/ai-sdk-7`, not yet committed). Deps lifted to the v7
> line (`ai ^7.0.2`, `@ai-sdk/anthropic ^4`, `@ai-sdk/google ^4`, `@ai-sdk/openai ^4`,
> `@ai-sdk/gateway ^4.0.2`, `@ai-sdk/provider ^4`, `@ai-sdk/provider-utils ^5`); 14 code/config files
> touched; **`tsc --noEmit` 0 · full vitest 412 passed / 1 skipped · `tsup` ESM+DTS build OK · zero
> v2-compat-mode warnings.** The migration was compiler-driven (no codemods needed — the surface was
> small enough to fix directly off `tsc`).
>
> **Findings that differed from this plan's predictions** (the plan was written from the pre-migration
> analysis; reality on `ai@7.0.2` / `@ai-sdk/provider@4.0.0`):
> - **`finishReason` became an OBJECT in v3** — `{ unified: 'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other', raw: string|undefined }`, not a bare string. The hand-rolled mock and every provider-level `finish` part in the tests had to build the object. (Cove's own *high-level* `finishReason: string` types are unchanged — the SDK folds the object down to a string.)
> - **One unpredicted type error:** tool-result image content `type: "media"` → `type: "image-data"` ([messages.ts:136](../../../convex/providers/messages.ts)) — the only `tsc` error the bump surfaced.
> - **`part.totalUsage` is NOT renamed** — it is the real field on `TextStreamFinishPart` in v7; the predicted `→ part.usage` was wrong. [decode.ts:200](../../../convex/engine/decode.ts) is unchanged.
> - **`system`→`instructions` and `result.fullStream`→`result.stream` are `@deprecated` aliases, not hard removals** — green was reachable without them, but both were scrubbed anyway so the next major won't break.
> - **The one real correctness fix:** [usage.ts:116](../../../convex/engine/usage.ts) cache-read mapping (`cachedInputTokens` → `inputTokenDetails.cacheReadTokens`). `tsc` could **not** catch this (the local `AiSdkUsage` interface is structural/all-optional) and the default mock has no cache tokens — it would have silently zeroed cache-read cost. Guarded by [usage.test.ts](../../../convex/engine/__tests__/usage.test.ts).
> - **`strictJsonSchema` (task 7):** reviewed, no code change. NB the suite is mock-based, so this is **not** exercised against a live OpenAI call — if a loose user schema is rejected in production, apply the per-call `strictJsonSchema:false` escape then.

## Goal & scope

Land the v5→v7 bump with `tsc --noEmit` 0, the full vitest suite green, and `tsup` building. The
work is bounded because Cove's AI-SDK surface is tiny and intentional:

- **In scope:** the two-hop codemods (`npx @ai-sdk/codemod v6` then `v7`); the `system→instructions`
  renames (3 sites); `result.fullStream→result.stream`; the usage field renames
  (`part.totalUsage→part.usage`, `cachedInputTokens→inputTokenDetails.cacheReadTokens`,
  `reasoningTokens→outputTokenDetails.reasoningTokens`); the load-bearing
  `LanguageModelV2→LanguageModelV3` spec bump (the ~27 casts + the hand-rolled mock rewrite); and a
  one-time **review** of v6 OpenAI `strictJsonSchema=true` against Cove's `jsonSchema(v.parameters)`
  tool schemas. Keep every reference-header citation accurate after edits.
- **Out of scope (Tier 3, recorded so nobody "while we're here"s them):** consuming `ToolLoopAgent`,
  `WorkflowAgent`, `HarnessAgent`, the `toolApproval` setting, v7 `timeout`/`TimeoutError`,
  `registerTelemetry`/`diagnostics_channel`, `contextSchema`/`toolsContext`. None of these are
  renames; each would surrender the durable loop ([README §Tier 3](README.md#tier-3--explicitly-do-not-adopt)).
- **Deferred riders (Tier 0 / Tier 2 follow-ons, not this phase):** wiring `reasoning` for
  unknown-family providers ([g3.2 item A](phase-g3.2-native-leverage.md)), `uploadFile` for image
  base64 re-send, an optional `@ai-sdk/otel` exporter. The bump *unlocks* them; this phase does not
  ship them.

**What is already done (the hard gates):** Node 22+ / ESM-only — [`package.json`](../../../package.json)
`engines.node ">=22.18"` + `"type":"module"`, [`tsconfig.json`](../../../tsconfig.json) `module:ESNext`,
`moduleResolution:Bundler`. The v6 `CoreMessage→ModelMessage` rename — Cove never used `CoreMessage`;
it imports `ModelMessage` ([messages.ts:11](../../../convex/providers/messages.ts)) and hand-rolls
`toModelMessages` ([messages.ts:150](../../../convex/providers/messages.ts)), so v6's async
`convertToModelMessages` (and `Tool.toModelOutput` object-wrap) **do not apply** — Cove calls neither.

## Dependencies

| Must hold | Why |
| --- | --- |
| **Deps bumped** (done) | The codemods + manual fixes are against `ai@7` / `@ai-sdk/*@4`/`@5`; the [`package.json`](../../../package.json) majors are already lifted. `npm install` must resolve the lockfile. |
| **`@ai-sdk/codemod`** available via `npx` | The two-hop runner (`npx @ai-sdk/codemod v6`, then `v7`) automates most renames. It is **not** a dependency — it is run on demand. The v7 line is `@ai-sdk/codemod@4.0.0`. |
| **P3 — Providers** (group 1) | The `LanguageModelV2→V3` spec bump touches the provider registry/gateway and the `MockLanguageModelV2` seam — both P3 deliverables. |
| **P4 — Durable engine** (group 1) | `decode.ts`/`compact.ts`/`usage.ts` are the only AI-SDK call sites; the replay guard and force-finalize path are P4 invariants this phase must not perturb. |
| The codemods do **not** cover everything | The docs explicitly warn manual changes remain; the `LanguageModelV2→V3` spec bump and the hand-rolled mock are **not** codemoddable. |

## Deliverables

| File | Change |
| --- | --- |
| [`package.json`](../../../package.json) | Majors lifted to the v7 line (**done**: `ai ^7.0.2`, `@ai-sdk/anthropic ^4`, `@ai-sdk/google ^4`, `@ai-sdk/openai ^4`, `@ai-sdk/gateway ^4.0.2`, `@ai-sdk/provider ^4`, `@ai-sdk/provider-utils ^5`). |
| [`convex/engine/decode.ts`](../../../convex/engine/decode.ts) | `system:`→`instructions:` (line 154); `result.fullStream`→`result.stream` (line 168); `part.totalUsage`→`part.usage` (line 200); `LanguageModelV2`→`V3` cast (line 153) + the `@ai-sdk/provider` import (line 17). |
| [`convex/engine/compact.ts`](../../../convex/engine/compact.ts) | `system:`→`instructions:` (lines 170, 174); `LanguageModelV2`→`V3` casts (lines 170, 173) + the import (line 9). |
| [`convex/engine/usage.ts`](../../../convex/engine/usage.ts) | `AiSdkUsage` shape: replace flat `cachedInputTokens`/`reasoningTokens` (lines 88-89) with the nested `inputTokenDetails.cacheReadTokens` / `outputTokenDetails.reasoningTokens`; update the read at line 106. |
| [`convex/providers/testModel.ts`](../../../convex/providers/testModel.ts) | Rewrite the hand-rolled mock to the **V3** interface: `specificationVersion: "v3"` (line 57); update the `LanguageModelV2`/`…V2Content`/`…V2StreamPart`/`…V2Usage` imports (lines 18-23) to V3; reshape `DEFAULT_USAGE` (line 33) to the V3 usage shape. |
| [`convex/providers/gateway.ts`](../../../convex/providers/gateway.ts) | `LanguageModelV2`→`V3` in the resolved-handle type (the `@ai-sdk/gateway` import at line 11 is unchanged at the call surface). |
| [`convex/providers/registry.ts`](../../../convex/providers/registry.ts) | `LanguageModelV2`→`V3` in the registered-model handle types. |
| `convex/**/__tests__/*` (decode, providers, boundary) | `LanguageModelV2`→`V3` in test fixtures + the boundary test that asserts `src/runtime/*` never imports the AI SDK (the rule is unchanged; only the type name moves). |
| (review) [`convex/engine/decode.ts:343-346`](../../../convex/engine/decode.ts) | **No code change unless tests fail** — verify v6 OpenAI `strictJsonSchema=true` does not reject the loose user-supplied JSON Schemas threaded via `jsonSchema(v.parameters)`. |

## Source map (the exact call sites)

Every AI-SDK touch point in the codebase, with the v7 transform. (Line numbers are the analysis's
recorded positions against the v5 source; verify each before editing — the surrounding code may have
shifted.)

| Call site | v5 form | v7 transform |
| --- | --- | --- |
| [`decode.ts:17`](../../../convex/engine/decode.ts) | `import type { JSONSchema7, LanguageModelV2 } from "@ai-sdk/provider"` | `LanguageModelV2`→`LanguageModelV3` |
| [`decode.ts:18`](../../../convex/engine/decode.ts) | `import { jsonSchema, type ModelMessage, streamText, tool } from "ai"` | unchanged (`ModelMessage` already correct) |
| [`decode.ts:152-157`](../../../convex/engine/decode.ts) | `streamText({ model, system, messages, tools })` (the **only** `streamText` call) | `system:`→`instructions:`; cast `model as LanguageModelV3` |
| [`decode.ts:154`](../../../convex/engine/decode.ts) | `system: input.systemPrompt` (separate param, **not** in `messages[]`) | →`instructions: input.systemPrompt` |
| [`decode.ts:168`](../../../convex/engine/decode.ts) | `for await (const part of result.fullStream)` | `result.fullStream`→`result.stream` |
| [`decode.ts:200`](../../../convex/engine/decode.ts) | `usageRaw = part.totalUsage as AiSdkUsage` (off the **finish** stream part, single-step) | `part.totalUsage`→`part.usage` — a **rename**, not the multi-step semantic break (Cove is single-step) |
| [`decode.ts:343-346`](../../../convex/engine/decode.ts) | `tool({ description, inputSchema: jsonSchema(...) })` — **no `execute`** | unchanged; **review** under v6 `strictJsonSchema=true` |
| [`compact.ts:9`](../../../convex/engine/compact.ts) | `import type { LanguageModelV2 } from "@ai-sdk/provider"` | →`LanguageModelV3` |
| [`compact.ts:10`](../../../convex/engine/compact.ts) | `import { generateText } from "ai"` | unchanged |
| [`compact.ts:170,174`](../../../convex/engine/compact.ts) | `generateText({ …, system: SUMMARIZATION_SYSTEM_PROMPT })` (2 calls) | `system:`→`instructions:`; cast `model as LanguageModelV3` |
| [`messages.ts:11`](../../../convex/providers/messages.ts) | `import type { ModelMessage } from "ai"` | unchanged — **already `ModelMessage`** |
| [`messages.ts:150`](../../../convex/providers/messages.ts) | `toModelMessages` (Cove's own canonical→`ModelMessage` transform) | unchanged — **not** `convertToModelMessages`, so the v6 async change does not apply |
| [`gateway.ts:11`](../../../convex/providers/gateway.ts) | `import { gateway } from "@ai-sdk/gateway"` | unchanged at the call surface; bump the handle's `LanguageModelV2`→`V3` type |
| [`testModel.ts:18-23,57`](../../../convex/providers/testModel.ts) | hand-rolled `LanguageModelV2` mock, `specificationVersion: "v2"` | **rewrite to V3** — the single biggest manual item |
| [`usage.ts:84-90,106`](../../../convex/engine/usage.ts) | `AiSdkUsage` reads `cachedInputTokens`/`reasoningTokens` | →`inputTokenDetails.cacheReadTokens` / `outputTokenDetails.reasoningTokens` |
| [`package.json`](../../../package.json) | `engines.node ">=22.18"` + `"type":"module"` | **v7 Node22+/ESM gate already satisfied** |
| [`tsconfig.json`](../../../tsconfig.json) | `module: ESNext`, `moduleResolution: Bundler` | already ESM — no change |
| [`ui-types.ts:9-28`](../../../src/react/ui-types.ts) | Cove's **own** `UIMessage`/`UIMessagePart` | unchanged — Cove does **not** consume `useChat`/SDK `UIMessage`/stream-response helpers |

## Hardened-contract obligations

The migration must preserve every engine invariant. These are non-negotiable and are the reason the
Tier-3 features are excluded:

1. **[08 §4.1 — the replay guard must survive.](../../design/08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical)**
   [decode.ts:117-119](../../../convex/engine/decode.ts) reads the persisted step row before any AI-SDK
   call and reconstructs a finalized decision **without** calling the model. The `fullStream`→`stream`
   rename and the usage renames must not move the `loadStep()`/`isFinalized` short-circuit, and
   `reconstructDecision` ([decode.ts:314-327](../../../convex/engine/decode.ts)) must keep reading the same
   persisted fields. The model is called **at most once per finalized step** — unchanged.
2. **[08 §4.2 — durable-data-on-timeout must NOT be replaced by `TimeoutError`.](../../design/08-conventions-and-execution-boundary.md)**
   On the stream deadline ([decode.ts:208-211](../../../convex/engine/decode.ts)) Cove **breaks the loop and
   force-finalizes the partial** (`synthesizeResponse` + `finalizeStep`,
   [decode.ts:228-254](../../../convex/engine/decode.ts)). Do **not** pass v7 `timeout`/`abortSignal` into the
   `streamText` call — a thrown `TimeoutError` would unwind past `batcher.flush` (line 214) and
   `finalizeStep` (line 254), destroying the partial turn the replay guard depends on. The deadline stays
   a Cove-owned wall-clock check that commits state.
3. **[08 §4.7 — usage aggregation stays Cove-owned.](../../design/08-conventions-and-execution-boundary.md#47-usage--cost)**
   Cove reads usage off the **per-call** finish stream part ([decode.ts:200](../../../convex/engine/decode.ts))
   and aggregates itself in [usage.ts](../../../convex/engine/usage.ts)/`addUsage`. The v7 multi-step
   `result.usage` consolidation (the silent cost-accounting breaker) **does not apply** — Cove never reads
   a cumulative `result.usage`. The field renames are mechanical; the aggregation logic is untouched.
4. **Tools keep no `execute`.** [decode.ts:340-349](../../../convex/engine/decode.ts) `toAiTools` builds
   `tool({ description, inputSchema })` with **no `execute`** — Cove dispatches out-of-band. This is why the
   v7 `toolApproval`/`timeout.toolMs`/`contextSchema` surfaces are inert here and excluded.
5. **The boundary stays walled.** The boundary test forbids `src/runtime/*` from importing the AI SDK; the
   `LanguageModelV2→V3` rename must not leak an `@ai-sdk/*` import into the V8-safe core.

## Implementation tasks

Ordered, buildable. Keep `tsc --noEmit` green-or-known-red between steps (the spec bump will be red
mid-migration; close it before moving on).

- [x] **1 — Bump deps (done) + install.** Confirm [`package.json`](../../../package.json) majors are on the
  v7 line; run `npm install` and confirm the lockfile resolves (`ai@7.0.2`, `@ai-sdk/anthropic@4.0.0`,
  `@ai-sdk/google@4.0.0`, `@ai-sdk/openai@4.0.0`, `@ai-sdk/gateway@4.0.2`, `@ai-sdk/provider@4.0.0`,
  `@ai-sdk/provider-utils@5.0.0`).
- [x] **2 — Run the codemods (two hops).** `npx @ai-sdk/codemod v6 .` then `npx @ai-sdk/codemod v7 .`
  (the v7 line is `@ai-sdk/codemod@4.0.0`). Review the diff — the codemods handle most renames but
  **not** the spec bump or the hand-rolled mock. Discard any codemod edit that touches a Tier-3 surface
  (none should, since Cove imports none).
- [x] **3 — `system`→`instructions`.** Three sites: [decode.ts:154](../../../convex/engine/decode.ts),
  [compact.ts:170](../../../convex/engine/compact.ts), [compact.ts:174](../../../convex/engine/compact.ts).
  (The codemod `rename-system-to-instructions` should catch these; verify.)
- [x] **4 — `fullStream`→`stream`.** [decode.ts:168](../../../convex/engine/decode.ts) `result.fullStream`→
  `result.stream`. The part `switch` (lines 169-207) is unchanged — the part shapes (`text-delta`,
  `reasoning-delta`, `tool-call`, `finish-step`, `finish`, `error`) carry through.
- [x] **5 — Usage field renames.** [decode.ts:200](../../../convex/engine/decode.ts) `part.totalUsage`→
  `part.usage`; in [usage.ts](../../../convex/engine/usage.ts) reshape `AiSdkUsage` (lines 84-90) to nest
  `inputTokenDetails.cacheReadTokens` and `outputTokenDetails.reasoningTokens`, and update the read at line
  106 (`usage.inputTokenDetails?.cacheReadTokens ?? 0`). Keep the local-interface-no-SDK-import discipline
  (usage.ts never imports `ai`).
- [x] **6 — `LanguageModelV2`→`V3` spec bump (the load-bearing item).** Rename the ~27 casts/types across
  [decode.ts](../../../convex/engine/decode.ts), [compact.ts](../../../convex/engine/compact.ts),
  [gateway.ts](../../../convex/providers/gateway.ts), [registry.ts](../../../convex/providers/registry.ts),
  [usage.ts](../../../convex/engine/usage.ts) (its doc comment references `LanguageModelV2Usage`), and the
  test fixtures (`decode.test.ts`, `providers.test.ts`, `boundary.test.ts`). Then **rewrite the hand-rolled
  mock** in [testModel.ts](../../../convex/providers/testModel.ts): `specificationVersion: "v3"` (line 57),
  the `LanguageModelV2*` imports (lines 18-23)→`V3`, and reshape `DEFAULT_USAGE` (line 33) to the V3 usage
  shape. Keep the mock dependency-free (do **not** import `MockLanguageModelV3` from `ai/test` — same
  phantom-`msw`-devDependency reason the hand-roll exists per [testModel.ts:11-16](../../../convex/providers/testModel.ts)).
- [x] **7 — `strictJsonSchema` review.** Run the provider/decode tests and a smoke decode against a tool
  with a loose user-supplied schema; if v6 OpenAI `strictJsonSchema=true` rejects it at
  [decode.ts:345](../../../convex/engine/decode.ts), set the per-call escape (`strictJsonSchema: false` on
  the OpenAI provider options) — **only if a test actually fails**. This is a review item, not a guaranteed
  edit.
- [x] **8 — Green gate.** `npx tsc --noEmit` exits 0; `npm test` (vitest) passes the full suite; `npm run
  build` (tsup) succeeds. Re-verify each touched file's reference-header citation still reads true.

## Acceptance

- [x] **`tsc --noEmit` exits 0.** No `LanguageModelV2` references remain; the V3 spec is consistent across
  decode/compact/gateway/registry/usage/tests and the mock.
- [x] **Full vitest suite green.** The existing unit + integration suite passes unchanged in **behavior** —
  decode replay-equality, usage rollup, the mock seam (`cove-test/mock`), and the boundary test (no
  `@ai-sdk/*` import from `src/runtime/*`) all still hold.
- [x] **`tsup` build OK.** `npm run build` emits the `dist/` artifacts; the V8-safe runtime barrel stays
  free of AI-SDK imports.
- [x] **No thesis surface adopted.** Grep proves the tree still imports **no** `ToolLoopAgent`,
  `WorkflowAgent`, `HarnessAgent`, `toolApproval`, `timeout`/`TimeoutError`, `registerTelemetry`,
  `contextSchema`/`toolsContext` — the migration changed types/options, not architecture.
- [x] **Replay + durable-timeout invariants intact.** A crash-after-`insertStreaming`-before-`finalizeStep`
  replay still re-decodes once; a deadline still force-finalizes the partial (no `TimeoutError` escapes);
  usage is still aggregated per-call by Cove.

## Risks & gotchas

- **The spec bump is the real cost, not the renames.** The verdict flags the weakest part of the original
  "rename ~6 sites" framing: the load-bearing work is `LanguageModelV2→V3` — the analysis estimates **~27
  casts** across decode/compact/gateway/registry/usage/tests plus the hand-rolled mock pinned to
  `specificationVersion:"v2"` ([testModel.ts:57](../../../convex/providers/testModel.ts)). It is still
  mechanical and low-risk, but budget for the breadth, not just the 6 option-renames.
- **The mock is hand-rolled for a reason — keep it that way.** [testModel.ts:11-16](../../../convex/providers/testModel.ts)
  documents that `ai/test`'s `MockLanguageModel*` statically pulls in `msw` (an unshipped devDependency of
  `@ai-sdk/provider-utils`). Rewrite the V3 mock by hand; **do not** swap to the SDK's `MockLanguageModelV3`,
  or you re-introduce the phantom dependency the consumer install does not carry.
- **`part.totalUsage`→`part.usage` is a rename here, not the dangerous semantic break.** The v7 multi-step
  consolidation makes `result.usage` cumulative — a silent cost-accounting breaker for code that read
  `result.usage` expecting final-step values. Cove is **single-step per decode** and reads usage off the
  **finish stream part** ([decode.ts:200](../../../convex/engine/decode.ts)), not `result.usage`, so the
  rename is safe. Do not "fix" usage by reading `result.usage`/`result.finalStep` — that would change the
  semantics.
- **Do not let the deadline become a `TimeoutError`.** The most tempting wrong move is to pass v7
  `timeout`/`abortSignal` into the `streamText` call "for free." It breaks durable-data-on-timeout (§4.2).
  The deadline stays Cove's wall-clock check that force-finalizes.
- **`strictJsonSchema` is a test pass, not a redesign.** Cove tools are user-supplied JSON Schema fed via
  `jsonSchema(v.parameters)`. v6 flips the OpenAI default to `true`; if a loose schema is rejected at
  runtime, the fix is a per-call `strictJsonSchema:false`, not a schema rewrite. Confirm with a test before
  editing.
- **The codemods do not cover everything.** The AI-SDK docs warn manual changes remain. The spec bump, the
  mock rewrite, and the `usage.ts` nesting are all non-codemoddable. Treat the codemod output as a starting
  diff, not a finished migration.
- **Reference headers must stay accurate.** Several headers cite `MockLanguageModelV2` / `LanguageModelV2`
  by name (e.g. [decode.ts:12](../../../convex/engine/decode.ts), [testModel.ts:3](../../../convex/providers/testModel.ts)).
  Update the prose so the [08 §2](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)
  convention does not drift from the code.
