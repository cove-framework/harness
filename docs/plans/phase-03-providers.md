# Phase 3 — Provider registry — AI SDK gateway
> Stand up `convex/providers/`: the AI SDK gateway registry, the `registerProvider` facade, `ModelConfig`→gateway-id resolution to `ModelHandle`, `ThinkingLevel`→per-provider reasoning options (pi-reproduced numeric budgets + `adjustMaxTokensForThinking`), the `storeResponses` flag, `toModelMessages` non-vision downgrade + `sanitizeSurrogates`, and the `MockLanguageModelV2` test-model seam (M5). Design-of-record: [06 — Roadmap](../design/06-phase-roadmap.md) + docs cited below. Decisions: [D1–D19](../design/07-risks-and-decisions.md).

## Goal & scope

Replace pi-ai's provider stack **wholesale** with the Vercel AI SDK gateway, while
**reproducing pi's provider-option *fidelity*** (concrete thinking budgets, token
fitting, store flag, non-vision downgrade, surrogate sanitization). pi-ai's
`providers/*` are read **only for the option shapes** — none of pi-ai's transport
code ports. The phase produces a `"use node"` provider module that the durable
engine (P4) calls from `engine/llmStep`/`engine/setup`:

- `resolveModel(modelConfig)` → a `ModelHandle` that carries the AI SDK
  gateway model id, capability metadata (vision/reasoning), and a callable AI SDK
  `LanguageModelV2`.
- `registerProvider` / `registerApiProvider` facade — last-write-wins, module-scoped,
  re-resolvable on every cold action boot (no dedupe bookkeeping).
- `buildProviderOptions(handle, thinkingLevel, opts)` — maps `ThinkingLevel` →
  per-provider reasoning options with pi's **concrete numeric budgets** and the
  `adjustMaxTokensForThinking` fitting math; threads `storeResponses` →
  `providerOptions.openai.store`.
- `toModelMessages(messages, handle)` — the last outbound transform:
  `sanitizeSurrogates` over every text field + non-vision image→placeholder
  downgrade (REPLACE, de-dupe consecutive), then map the canonical `Message[]` to
  the AI SDK `ModelMessage[]`.
- The **`MockLanguageModelV2` test-model seam** — `resolveModel` honors a reserved
  test model id returning a mock-backed `ModelHandle`; the seam is the single
  deterministic injection point P3/P4 tests drive (flue's `providers/faux.ts` is
  **not** ported, superseded — [08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)).

**Out of scope** (later phases): the durable loop and `streamText` call itself
(P4 — this phase only supplies the resolved model + outbound transform + usage
mapper signature); usage *aggregation* into rollups (P4 §4.7 — this phase ports
only `fromProviderUsage`/`addUsage`/`emptyUsage` primitives if convenient, but they
land in P4); `connectMcpServer` (P10); compaction model selection (P12). No HTTP,
no sessions, no engine actions.

## Dependencies

- **P1 (required, landed).** `ModelHandle`, `ModelConfig`, `ThinkingLevel`, the
  canonical `Message`/`UserMessage`/`AssistantMessage`/`ToolResultMessage`/`Usage`
  shapes ([`src/runtime/messages.ts`](../../src/runtime/messages.ts)), and
  `ProviderRegistrationError`/`ModelNotConfiguredError`
  ([`src/runtime/errors.ts`](../../src/runtime/errors.ts)) all already exist on disk
  and are exported from [`src/runtime/index.ts`](../../src/runtime/index.ts). This
  phase **consumes** them and may *widen* `ModelHandle` (see Implementation task 2),
  but must not break the existing `AgentRuntimeConfig.resolveModel` signature in
  [`src/runtime/types.ts`](../../src/runtime/types.ts) (line 270:
  `resolveModel: (model: ModelConfig | undefined) => ModelHandle | undefined`).
- **AI SDK deps (already in `package.json`):** `ai@^5`, `@ai-sdk/gateway@^3`,
  `@ai-sdk/anthropic@^2`, `@ai-sdk/google@^3`, `@ai-sdk/openai@^2`,
  `@ai-sdk/provider-utils@^3` (carries `MockLanguageModelV2` under
  `@ai-sdk/provider-utils/test`). No new deps needed; verify the `/test` subpath
  resolves at task 7.
- **No dependency on P2, P4, P5.** P3 is a leaf off P1 on the critical path
  (`P1 → P3 → P4`). It must land before P4 because P4's `llmStep` imports
  `resolveModel` + `toModelMessages` + the mock seam.

## Deliverables

Create `convex/providers/` (a `"use node"` module — it imports the AI SDK):

| File | Purpose |
| --- | --- |
| `convex/providers/index.ts` | Barrel: re-exports `resolveModel`, `registerProvider`, `registerApiProvider`, `toModelMessages`, `buildProviderOptions`, the mock-seam constant, and the provider types. The single import surface for `convex/engine/*`. |
| `convex/providers/registry.ts` | The module-scoped `registerProvider`/`registerApiProvider` facade + `resolveRegisteredModel` + `getRegisteredStoreResponses`/`getRegisteredApiKey`; ports flue's `runtime/providers.ts` minus all Cloudflare-binding code. Holds the `ProviderRegistration` / `HttpProviderRegistration` types. |
| `convex/providers/gateway.ts` | `resolveModel(ModelConfig) → ModelHandle`: splits `provider/model`, layers registration over the built-in capability catalog, constructs the AI SDK gateway `LanguageModelV2`, and assembles the `ModelHandle`. Honors the reserved test model id. |
| `convex/providers/capabilities.ts` | The **V8-safe default constants**: the trimmed provider→capability table (vision, reasoning, contextWindow, maxOutputTokens, per-level `thinkingLevelMap`, cost rates) for the built-in providers (anthropic, openai, google, bedrock), distilled from pi-ai's `models.generated.ts` to a hand-maintained subset — **no 450 KB generated blob ports**. Plain object literals only. |
| `convex/providers/thinking.ts` | `ThinkingLevel` → per-provider reasoning options. Ports `adjustMaxTokensForThinking` + `clampReasoning` from pi's `simple-options.ts` verbatim (the numeric budgets `{minimal:1024, low:2048, medium:8192, high:16384}`, `minOutputTokens:1024`), plus `buildProviderOptions(handle, level, {maxTokens, storeResponses})` that emits the AI SDK `providerOptions` per provider family. |
| `convex/providers/messages.ts` | `toModelMessages(messages, handle) → ModelMessage[]`: ports `downgradeUnsupportedImages`/`replaceImagesWithPlaceholder` from pi's `transform-messages.ts` and applies `sanitizeSurrogates` (ported from pi's `utils/sanitize-unicode.ts`) to every outbound text field, then maps canonical `Message[]`→AI SDK `ModelMessage[]`. |
| `convex/providers/sanitize.ts` | `sanitizeSurrogates(text)` — the lone-unpaired-surrogate stripper, ported 1:1 from pi's `utils/sanitize-unicode.ts` (the single regex). Standalone so P4/P5 can reuse it. |
| `convex/providers/testModel.ts` | The `MockLanguageModelV2` seam: `RESERVED_TEST_MODEL_ID` constant, `isTestModelId(id)`, and `makeTestModelHandle(mock?) → ModelHandle` wrapping a `MockLanguageModelV2` from `@ai-sdk/provider-utils/test`. The deterministic injection point for P3/P4 smoke + replay tests. |
| `convex/providers/usage.ts` *(optional, if it keeps P4 unblocked)* | `fromProviderUsage`/`addUsage`/`emptyUsage` primitives ported from flue's [`usage.ts`](../../../flue/packages/runtime/src/usage.ts). Pure functions; no AI SDK import needed. Bridges AI SDK `inputTokens`/`outputTokens` ↔ rollup. *Defer to P4 if it complicates the V8-safe boundary.* |

## Source map (flue/pi → cove)

| flue/pi source (verified exists) | Target cove file | Port / transform notes |
| --- | --- | --- |
| [`flue · runtime/src/internal.ts`](../../../flue/packages/runtime/src/internal.ts) `resolveModel` (lines 111–149) | `convex/providers/gateway.ts` `resolveModel` | Keep the `provider/model` split + error messages; **rebrand `[flue]`→`[cove]`**. Return a **`ModelHandle`** (AI SDK gateway) instead of pi-ai `Model<Api>`. Registered providers still win over the catalog. |
| [`flue · runtime/src/runtime/providers.ts`](../../../flue/packages/runtime/src/runtime/providers.ts) (`registerProvider`, `registerApiProvider`, `ProviderRegistration`, `HttpProviderRegistration`, `resolveRegisteredModel`, `getRegisteredStoreResponses`, `getRegisteredApiKey`, `buildModelFromRegistration`, `zeroMetadataModel`) | `convex/providers/registry.ts` | Port the HTTP-provider path; **drop all Cloudflare-binding code** (`CloudflareAIBindingRegistration`, `isCloudflareBindingRegistration`, `attachModelBinding`, `getModelBinding`, `getModelGateway`, the `cloudflare-model.ts` import) per [08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit). `ProviderRegistration` collapses to just `HttpProviderRegistration`. Keep `storeResponses?: boolean` on the registration. Throw the existing **`ProviderRegistrationError`** from [`src/runtime/errors.ts`](../../src/runtime/errors.ts). |
| [`pi · ai/src/providers/simple-options.ts`](../../../pi/packages/ai/src/providers/simple-options.ts) (`adjustMaxTokensForThinking`, `clampReasoning`) | `convex/providers/thinking.ts` | Port **verbatim** — the budgets `{minimal:1024, low:2048, medium:8192, high:16384}`, `minOutputTokens:1024`, and the fit math `Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens)` + the `maxTokens <= thinkingBudget` clamp. This is the load-bearing fidelity contract. |
| [`pi · ai/src/providers/anthropic.ts`](../../../pi/packages/ai/src/providers/anthropic.ts) (thinking block, lines ~760–790: `adjustMaxTokensForThinking` call → `thinkingBudgetTokens`) | `convex/providers/thinking.ts` (anthropic/bedrock branch) | Read for the **shape only**: anthropic/bedrock map to an explicit **reasoning token budget** carved out of `maxTokens`. Emit `providerOptions.anthropic.thinking = { type:'enabled', budgetTokens }` (AI SDK shape) instead of the raw Anthropic SDK `thinkingBudgetTokens`. |
| [`pi · ai/src/providers/openai-responses.ts`](../../../pi/packages/ai/src/providers/openai-responses.ts) (`reasoningEffort` mapping ~176–276; `store: false` line 243) | `convex/providers/thinking.ts` (openai branch) | openai maps `ThinkingLevel`→`providerOptions.openai.reasoningEffort` (`off`→omit). `storeResponses` threads to `providerOptions.openai.store` (pi hard-codes `store:false`; cove makes it the registration/request flag). |
| [`pi · ai/src/providers/google.ts`](../../../pi/packages/ai/src/providers/google.ts) (`thinkingConfig`/`thinkingBudget` ~291–428) | `convex/providers/thinking.ts` (google branch) | google maps to `providerOptions.google.thinkingConfig = { thinkingBudget, includeThoughts:true }`; `off` → `{ thinkingBudget: 0 }`. |
| [`pi · ai/src/providers/transform-messages.ts`](../../../pi/packages/ai/src/providers/transform-messages.ts) (`downgradeUnsupportedImages`, `replaceImagesWithPlaceholder`, the two placeholder constants) | `convex/providers/messages.ts` | Port the downgrade pass: when `!handle.supportsVision`, REPLACE image blocks in `user`/`toolResult` with a text placeholder, **de-dupe consecutive placeholders**. Skip pi's tool-call-id normalization + synthetic-tool-result passes (those belong to P4's context rebuild, not the outbound transform). |
| [`pi · ai/src/utils/sanitize-unicode.ts`](../../../pi/packages/ai/src/providers/../utils/sanitize-unicode.ts) (`sanitizeSurrogates`) | `convex/providers/sanitize.ts` | Port the single regex 1:1. Apply across all outbound text/reasoning/tool-result text in `toModelMessages`. |
| [`pi · ai/src/models.ts`](../../../pi/packages/ai/src/models.ts) (`getSupportedThinkingLevels`, `clampThinkingLevel`, `EXTENDED_THINKING_LEVELS`) | `convex/providers/thinking.ts` (clamp helper) | Port `clampThinkingLevel` so a requested level that the model doesn't support snaps to the nearest supported one before budget mapping. `EXTENDED_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh"]`. |
| [`pi · ai/src/api-registry.ts`](../../../pi/packages/ai/src/api-registry.ts) (`registerApiProvider` module-scoped map, last-write-wins) | `convex/providers/registry.ts` `registerApiProvider` | Port the **last-write-wins, module-scoped** semantics (re-register on every isolate boot, no dedupe). In cove this registers a custom AI SDK provider factory for an `api` slug the gateway doesn't ship. |
| [`flue · runtime/src/usage.ts`](../../../flue/packages/runtime/src/usage.ts) (`fromProviderUsage`, `addUsage`, `emptyUsage`) | `convex/providers/usage.ts` *(optional)* | Pure helpers; bridge AI SDK `inputTokens`/`outputTokens` ↔ the `Usage` rollup (see [08 §4.7](../design/08-conventions-and-execution-boundary.md#47-usage--cost) — provider side uses `inputTokens`/`outputTokens`, caller side `input`/`output`). Defer to P4 if it muddies the V8 boundary. |
| `pi · ai/src/providers/faux.ts` | **(not ported)** | Superseded by `MockLanguageModelV2` (M5, [08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)). Do **not** port. |
| `pi · ai/src/models.generated.ts` (453 KB) | **(not ported)** | Distill a hand-maintained subset into `convex/providers/capabilities.ts`. Do **not** copy the generated blob. |

## Hardened-contract obligations

This phase **does not own** any of the durable-loop §4 contracts (those land in P4),
but it must **supply the primitives** several of them depend on, and it must honor the
execution-boundary rules:

- **[08 §3 — execution boundary](../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy).**
  `convex/providers/*` is a **`"use node"` module** (it imports the AI SDK). It is
  reached **only from `"use node"` engine actions** (`llmStep`, `setup`) — never from
  queries/mutations. It **touches no box** (no `SessionEnv`). The module exposes pure
  resolution + transform functions; it does not orchestrate or persist.
- **[08 §4.1 — replay determinism](../design/08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical).**
  `resolveModel` must be **deterministic for a given `(ModelConfig, registry state)`**
  — same input → same `ModelHandle` capabilities — so a replayed `llmStep` that *does*
  re-resolve (before hitting the finalized-row guard) produces an identical handle. The
  **mock seam** is what makes the P4 replay test exact: the reserved test model id
  resolves to a `MockLanguageModelV2` whose canned response is byte-stable.
- **[08 §4.2 — action budgets](../design/08-conventions-and-execution-boundary.md#42-action-budgets--timeouts).**
  `buildProviderOptions` must not silently strip a caller `maxTokens`; the
  `adjustMaxTokensForThinking` fit guarantees `thinkingBudget ≤ maxTokens` so the
  240 s stream deadline (P4) operates on a model request that *can* terminate. Surface
  the resolved `maxOutputTokens` on the `ModelHandle` for P4's deadline math.
- **[08 §4.7 — usage & cost](../design/08-conventions-and-execution-boundary.md#47-usage--cost).**
  If `usage.ts` ports here, honor the **two field-name conventions** (provider/rollup
  side `inputTokens`/`outputTokens`; caller side `input`/`output`) and keep the cache
  fields (`cacheRead`/`cacheWrite`/`cacheWrite1h`) + per-model `cost{}` — never a
  token-only subset.
- **[08 §4.8 — image pipeline (downgrade leg)](../design/08-conventions-and-execution-boundary.md#48-image-pipeline).**
  The non-vision downgrade in `toModelMessages` is the **last leg** of the image
  pipeline: REPLACE (not drop) image parts with a placeholder, de-dupe consecutive
  placeholders. This is mandatory — a non-vision model **400s on raw image parts**
  ([04 — Durable Engine, `toModelMessages`](../design/04-durable-engine.md)).
- **[08 §2 — reference-header convention](../design/08-conventions-and-execution-boundary.md#2-reference-header-convention).**
  Every file opens with the origin header. pi-derived files cite pi; the gateway/registry
  files cite flue; `testModel.ts`/`capabilities.ts` are "New (Convex backend)" but cite
  the pattern source.
- **[05 — Provider credential detection](../design/05-public-api-and-sdk.md#environment--configuration).**
  Provider detection resolves **keyless ambient credentials** — Google ADC via
  `GOOGLE_APPLICATION_CREDENTIALS`, AWS Bedrock via the AWS chain
  (`AWS_PROFILE`/IAM/ECS/IRSA) — **not only literal API keys** read from Convex env.
  Detection is **plain Convex env reads** (no Worker/Node `env`-object plumbing). The
  gcloud-config filesystem ADC probe is **NOT** included here (real-machine-bash-adapter
  only, [D7](../design/07-risks-and-decisions.md)).

## Implementation tasks

Ordered, buildable. `tsc --noEmit` stays green after every task.

1. **[ ] Scaffold `convex/providers/` with reference headers + `"use node"`.**
   Create the eight files (skip `usage.ts` unless task 11 needs it). Each opens with
   the [§2](../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)
   header. Put `"use node";` at the top of every file that imports the AI SDK
   (`gateway.ts`, `thinking.ts`, `messages.ts`, `testModel.ts`, `index.ts`); `sanitize.ts`,
   `capabilities.ts`, and `registry.ts`'s pure types may stay node-free but the barrel
   pulls them into the node module anyway.

2. **[ ] Widen `ModelHandle` for the AI SDK (`src/runtime/messages.ts`).**
   The current `ModelHandle` (lines 150–171) has `id`/`provider`/`modelString`/
   `contextWindow`/`maxOutputTokens`/`supportsVision`/`supportsReasoning`/`cost`. Add an
   **opaque** `model: unknown` field (the AI SDK `LanguageModelV2`) plus
   `thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>` so the gateway can
   carry the resolved AI SDK model + per-level clamp data **without** importing the AI SDK
   into the V8-safe `src/runtime` core. *Keep the field typed `unknown`* — only
   `convex/providers/*` and `convex/engine/*` cast it back to `LanguageModelV2`. This
   preserves the V8-safe boundary (the core never imports `ai`). Update the doc-comment.

3. **[ ] Port `sanitizeSurrogates` → `convex/providers/sanitize.ts`.**
   1:1 from pi's `utils/sanitize-unicode.ts` (the single regex + JSDoc). No deps.

4. **[ ] Build `convex/providers/capabilities.ts` — the V8-safe default constants.**
   A hand-maintained `Record<string /*provider*/, Record<string /*modelId*/, ModelCaps>>`
   for anthropic, openai, google, bedrock, where `ModelCaps = { contextWindow,
   maxOutputTokens, supportsVision, supportsReasoning, thinkingLevelMap?, cost }`.
   Distill from pi's `models.generated.ts` (do **not** copy it). Include a per-provider
   **fallback** entry (`zeroMetadata`-style) for ids the table doesn't know, so an
   unknown gateway model still resolves with `contextWindow:0` (treated as "unknown" by
   compaction). Also export `EXTENDED_THINKING_LEVELS` here for the clamp.

5. **[ ] Port the registry → `convex/providers/registry.ts`.**
   From flue's `runtime/providers.ts`: `HttpProviderRegistration` (keep `api`, `baseUrl`,
   `apiKey`, `headers`, `contextWindow`, `maxTokens`, `models`, **`storeResponses`**),
   the module-scoped `providersById` map, `registerProvider` (last-write-wins; throw
   `ProviderRegistrationError` when a non-catalog id omits `api`/`baseUrl`),
   `hasRegisteredProvider`, `getRegisteredApiKey`, `getRegisteredStoreResponses`,
   `resetProvidersForTests`, and `resolveRegisteredModel`/`buildModelFromRegistration`/
   `zeroMetadataModel` (returning **`ModelHandle` capability data**, hydrated from
   `capabilities.ts` instead of pi's `getModel`/`getModels`). **Drop every
   Cloudflare-binding symbol.** `registerApiProvider` ports the module-scoped
   last-write-wins map from pi's `api-registry.ts`. **Tricky bit:** the module is
   re-imported on every cold action, so the registry is empty on boot — registrations are
   re-applied by the generated app entry (P8.5) per isolate. P3's tests register
   explicitly in setup; do not assume persistence across actions.

6. **[ ] Port `adjustMaxTokensForThinking` + `clampThinkingLevel` → `convex/providers/thinking.ts`.**
   Copy `adjustMaxTokensForThinking` + `clampReasoning` from pi's `simple-options.ts`
   **verbatim** (the budgets object, `minOutputTokens`, the fit + clamp math). Port
   `clampThinkingLevel`/`getSupportedThinkingLevels` from pi's `models.ts` (operating on
   the `thinkingLevelMap` from `capabilities.ts`). These are pure; unit-testable without
   the AI SDK.

7. **[ ] Build `buildProviderOptions(handle, level, opts)` in `thinking.ts`.**
   Branch on `handle.provider` family:
   - **anthropic / bedrock** → call `adjustMaxTokensForThinking(opts.maxTokens,
     handle.maxOutputTokens, level, customBudgets)`; emit
     `{ anthropic: { thinking: { type:'enabled', budgetTokens } } }` and return the fitted
     `maxTokens` alongside (the caller/P4 sets it on the request). `level==='off'` →
     no thinking, pass `maxTokens` through.
   - **openai** → `{ openai: { reasoningEffort: clamp(level), store: !!opts.storeResponses } }`;
     `level==='off'` → omit `reasoningEffort`, still thread `store`.
   - **google** → `{ google: { thinkingConfig: { thinkingBudget, includeThoughts:true } } }`;
     `off` → `{ thinkingBudget: 0 }`.
   Always run `clampThinkingLevel` first. Return
   `{ providerOptions, maxTokens }`. **Tricky bit:** `storeResponses` must thread even when
   `level==='off'` — the store flag is independent of reasoning.

8. **[ ] Port `toModelMessages` → `convex/providers/messages.ts`.**
   Port `downgradeUnsupportedImages` + `replaceImagesWithPlaceholder` (with the two
   placeholder constants — keep the wording the design cites, e.g.
   `[image omitted: model has no vision]`). Gate the downgrade on
   `handle.supportsVision === false`. Then map canonical `Message[]` → AI SDK
   `ModelMessage[]` (user/assistant/toolResult → AI SDK roles + content parts) and apply
   `sanitizeSurrogates` to **every** outbound text/reasoning/tool-result-text field.
   **Skip** pi's tool-call-id normalization + synthetic-tool-result passes — those are P4
   context-rebuild concerns, not the outbound transform. **Tricky bit:** de-dupe
   consecutive placeholders (pi's `previousWasPlaceholder` flag), and REPLACE rather than
   drop, so positional context survives.

9. **[ ] Build the `MockLanguageModelV2` seam → `convex/providers/testModel.ts`.**
   Export `RESERVED_TEST_MODEL_ID` (e.g. `"cove-test/mock"`), `isTestModelId(modelString)`,
   and `makeTestModelHandle(mock?: MockLanguageModelV2) → ModelHandle` that imports
   `MockLanguageModelV2` from `@ai-sdk/provider-utils/test`, defaults a canned
   non-streaming response, and assembles a `ModelHandle` with
   `supportsVision/supportsReasoning` toggleable for tests. **Verify the `/test` subpath
   resolves** under `moduleResolution:"Bundler"` (it does in `@ai-sdk/provider-utils@^3`);
   if not, fall back to the top-level export. This is the single seam P3 smoke + P4
   replay/throughput tests drive.

10. **[ ] Wire `resolveModel` → `convex/providers/gateway.ts`.**
    Port flue's `internal.ts` `resolveModel`: split `provider/model` (error on missing
    `/`, rebranded `[cove]`); **first** check `isTestModelId` → return
    `makeTestModelHandle()`; **then** `resolveRegisteredModel(providerId, modelId)` (registry
    wins); **then** the built-in capability catalog (`capabilities.ts`) + an AI SDK gateway
    `LanguageModelV2` constructed via `@ai-sdk/gateway` (`gateway(modelString)` or the
    per-provider `@ai-sdk/{anthropic,openai,google}` factory). Assemble the `ModelHandle`:
    `id`/`provider`/`modelString`/`contextWindow`/`maxOutputTokens`/`supportsVision`/
    `supportsReasoning`/`cost`/`thinkingLevelMap`/`model` (the AI SDK handle, typed
    `unknown` in the core). Throw the `[cove] Unknown model specifier …` error for ids no
    catalog/registry knows. **Tricky bit:** credential detection — resolve keyless ambient
    creds (Google ADC env var, AWS chain) as well as literal `*_API_KEY` env vars, all via
    plain `process.env` reads inside this `"use node"` module.

11. **[ ] (Optional) Port usage primitives → `convex/providers/usage.ts`.**
    Only if it unblocks P4 cleanly: `fromProviderUsage`/`addUsage`/`emptyUsage` from flue's
    `usage.ts`, honoring the dual field-name convention + cache/cost fields ([§4.7](../design/08-conventions-and-execution-boundary.md#47-usage--cost)).
    Otherwise note "deferred to P4" and skip.

12. **[ ] Barrel `convex/providers/index.ts`.**
    Re-export `resolveModel`, `registerProvider`, `registerApiProvider`,
    `getRegisteredStoreResponses`, `toModelMessages`, `buildProviderOptions`,
    `RESERVED_TEST_MODEL_ID`/`isTestModelId`/`makeTestModelHandle`, and the
    `HttpProviderRegistration`/`ProviderRegistration` types. This is the only import path
    `convex/engine/*` (P4) uses.

13. **[ ] Add the P3 test file(s).**
    A Convex-node test (or a plain `vitest` node test importing the module) covering the
    Acceptance bar below, all driven through the `MockLanguageModelV2` seam — **no live
    provider**.

14. **[ ] `tsc --noEmit` must exit 0.** Run `npx tsc --noEmit` from `cove-harness/`;
    fix any type leakage (especially: the AI SDK `LanguageModelV2` type must **not** appear
    in `src/runtime/*` — keep it `unknown` there).

## Acceptance

Start from [06 P3's acceptance](../design/06-phase-roadmap.md#-phase-3--provider-registry)
and the coverage additions. Each is a concrete pass/fail test driven through the mock seam:

1. **Capability resolution.** `resolveModel("anthropic/claude-sonnet-4-6")` returns a
   `ModelHandle` with the right capabilities (`supportsVision`/`supportsReasoning` true,
   non-zero `contextWindow`/`maxOutputTokens`, a populated `cost`, and a non-null
   `model`). An unknown id throws `[cove] Unknown model specifier …`; a `/`-less specifier
   throws the format error.
2. **Mock smoke (no live provider).** `resolveModel(RESERVED_TEST_MODEL_ID)` returns a
   handle wrapping `MockLanguageModelV2`; a **non-streaming `generateText`** call against
   `handle.model` returns the canned text. (P4 will exercise the streaming/`streamText`
   path; P3 proves the seam wires up.)
3. **Thinking-budget fit.** For an anthropic handle with `maxOutputTokens = N`,
   `buildProviderOptions(handle, "high", { maxTokens: undefined })` returns
   `providerOptions.anthropic.thinking.budgetTokens` and a fitted `maxTokens` where
   `budgetTokens ≤ maxTokens ≤ N` (per `adjustMaxTokensForThinking`). A small explicit
   `maxTokens` (e.g. 1500 with a high budget) clamps `thinkingBudget` to
   `maxTokens - 1024`.
4. **`storeResponses` flag.** `buildProviderOptions(openaiHandle, level, { storeResponses:
   true })` sets `providerOptions.openai.store === true`; with `storeResponses:false`/unset
   it is `false`/absent. The flag threads even when `level === "off"`.
5. **Non-vision downgrade.** `toModelMessages([... a user message with an image part ...],
   handleWithSupportsVisionFalse)` REPLACES the image with a single text placeholder
   (two consecutive images → **one** placeholder); a vision-capable handle passes the
   image through untouched.
6. **Surrogate sanitization.** A message text containing a lone high surrogate
   (`String.fromCharCode(0xD83D)`) comes out of `toModelMessages` with the surrogate
   stripped; a valid paired emoji (`🙈`) is preserved.
7. **Registry override + store flag.** `registerProvider("anthropic", { baseUrl, apiKey,
   storeResponses:true })` then `resolveModel("anthropic/…")` resolves through the
   registration (registration wins over catalog), and `getRegisteredStoreResponses
   ("anthropic")` is `true`. A non-catalog provider id registered **without** `api`/`baseUrl`
   throws `ProviderRegistrationError`. Re-`registerProvider` on the same id **replaces**
   (does not accumulate).
8. **Keyless ambient credentials (coverage-audit add).** With only
   `GOOGLE_APPLICATION_CREDENTIALS` set (no `GOOGLE_API_KEY`), `resolveModel("google/…")`
   resolves a usable handle (ADC path); with the AWS chain present (e.g. `AWS_PROFILE`),
   `resolveModel("bedrock/…")` resolves — **not only** literal `*_API_KEY` env vars.
9. **`tsc --noEmit` exits 0** and `src/runtime/*` carries **no** `import … from "ai"` /
   `@ai-sdk/*` (the AI SDK stays behind the `convex/providers` node boundary; the core's
   `ModelHandle.model` is `unknown`).

## Risks & gotchas

- **`"use node"` boundary (the big one).** `convex/providers/*` imports the AI SDK, so it
  **must** carry `"use node";` and can be called **only from `"use node"` actions** (P4's
  `llmStep`/`setup`) — never from queries/mutations or the V8-safe `src/runtime` core.
  Leaking an `@ai-sdk/*` type into `src/runtime` breaks the boundary; that is why
  `ModelHandle.model` is typed `unknown` there and re-cast only inside `convex/providers`.
- **Stateless registry across cold actions.** The `providersById` map is module-scoped, so
  it is **empty on every cold action boot**. Do **not** rely on a registration surviving
  across actions — the generated app entry re-applies registrations per isolate (P8.5),
  and P3 tests must register in their own setup. This mirrors the box "stateless handle"
  rule: resolve/register fresh each cold action.
- **Replay determinism depends on a stable resolve.** P4's replay guard short-circuits
  before re-calling the model, but `resolveModel` may still re-run; it **must** be
  deterministic for `(ModelConfig, registry state)`. The `MockLanguageModelV2` canned
  response must be **byte-stable** so P4's `responseMessages` round-trip + replay-equality
  tests are exact. Avoid `Date.now()`/`Math.random()` in the mock's default response.
- **`adjustMaxTokensForThinking` must be ported *verbatim*.** The exact budgets and the
  `maxTokens <= thinkingBudget` clamp are a fidelity contract — paraphrasing the math
  silently changes thinking budgets vs pi and can blow the `maxTokens` envelope (and the
  240 s deadline). Copy, don't reinterpret.
- **Don't copy `models.generated.ts`.** The 453 KB blob would bloat the action bundle and
  drag pi-ai's full provider enum into the V8 boundary indirectly. Distill a hand-maintained
  capability subset; default unknown ids to zero-metadata.
- **AI SDK `providerOptions` shape drift.** The thinking/store option keys
  (`anthropic.thinking.budgetTokens`, `openai.reasoningEffort`/`store`,
  `google.thinkingConfig.thinkingBudget`) are **AI SDK** shapes, *not* the raw
  Anthropic/OpenAI/Google SDK shapes pi used. Read pi only for the *intent* (which level →
  which budget); emit the AI SDK key names. Pin against `@ai-sdk/*@^2/3` docs.
- **`@ai-sdk/provider-utils/test` subpath.** `MockLanguageModelV2` lives under the `/test`
  export; confirm it resolves under `moduleResolution:"Bundler"` before relying on it
  (task 9). If the subpath fails, import from the package root.
- **Surrogate regex + `verbatimModuleSyntax`.** The lookbehind/lookahead regex is fine on
  ESNext; just keep it 1:1. With `verbatimModuleSyntax:true` (tsconfig), use
  `import type` for the AI SDK type imports that are types-only (`LanguageModelV2`,
  `ModelMessage`) to avoid emitting runtime imports where unintended.
- **Credential detection is env-only inside Convex.** No filesystem gcloud-config probe
  here ([D7](../design/07-risks-and-decisions.md) — that's real-machine-bash-adapter only).
  Read `GOOGLE_APPLICATION_CREDENTIALS` / the AWS chain from `process.env`; do not shell out
  or touch the FS.
