# Cove Refactor: flue-shaped surface, pi-shaped mechanics, pi-style extensions

> **Decisions locked (2026-06-24).** §8 open-decision **#1 (durability fork) is RESOLVED: keep `@convex-dev/workflow` journal-replay** → `frozenPlan` stays (renamed `runPlan`) and hooks are partitioned by determinism class per §5. This is the recommended path; the checkpoint-resume alternative is off the table for this refactor.
>
> **Implementation status.** ✅ **Phase 0 landed** (`frozenPlan`→`runPlan` rename across schema/setup/requests/llmStep/dispatchTools; `SessionData.version` widened to `number` + forward-only `migrateSessionData` seam; new name-keyed `src/runtime/tool-registry.ts` sidecar). ✅ **Phase 1 landed** (`mcpServers` strict-schema defect fixed + `extensions` field added to `AgentProfileSchema`/`AgentRuntimeConfig`, with `assertMcpServers`/`assertExtensions` + threading through `resolveAgentProfile`/`extendAgentProfile`; the silent `initialize` `catch {}` now emits an observable `setup_initialize_failed` warn). ✅ **Phase 2 landed** (new `convex/providers/{plugin,builtins}.ts` `ProviderPlugin` abstraction collapsing the 4 hardcoded provider switches — catalog membership, `caps`, `buildProviderOptions`, `hasCredentials` — into one self-registering unit; dispatchers consult plugins first with the legacy literals kept as fallback = zero behavior change; `thinking.ts` de-`"use node"`-ed to keep plugins V8-safe; built-ins activated in both the node `gateway` and V8 `setup` paths). Verified: `tsc` 0 errors, 375 tests pass (+27 total). 🔄 **Phase 3a landed** (runtime user-tool path: `ToolDefinition.execute` widened to `string | ToolResult` with new `ToolResult` types; `dispatchTools` recovers user-tool closures by name via `getRegisteredTool`; `setup` freezes recoverable user-tool descriptors via the new pure `freezeUserToolDescriptors` helper — unregistered/inline tools skipped with an observable `setup_user_tool_unregistered` warn; built-in collision throws). Verified: `tsc` 0, 379 tests. ✅ **Phase 3b landed** (codegen installation: new `generate-tool-registry.ts` → `convex/_cove/toolResolver.ts`; new authoring file `convex/toolRegistry.ts` re-exporting the registry surface; `cove build` emits the resolver (export `tools` by convention); `cove init` scaffolds `toolRegistry.ts` + regenerates the resolver; `setup`/`dispatchTools` side-effect-import the resolver to install the registry per isolate). Simplified vs. agents: the tool registry uses a fixed `tools` export (no tsx-child loader / build-time validation — can add later). Verified: `tsc` 0, 380 tests. 🔄 **Phase 4a landed** (incremental compaction: new pure `resolvePreviousCompaction` (entry-id→index boundary translation, undefined→fresh fallback) + `combineSummaries`; `compact.ts` now selects the UPDATE prompt when a prior summary exists, summarizes the split-turn prefix, and records summed summarization usage on the `CompactionEntry` via a new `usage` arg on `appendCompactionEntry` — `data` is `v.any()` so no schema change). NOTE: the pi stale-usage guard was deliberately SKIPPED — it's a no-op in Cove's per-step-finalized-usage model (post-compaction the next step's usage reflects the smaller context, so no compaction loop; replay idempotency is handled by the journaled compact step). Verified: `tsc` 0, 385 tests. ✅ **Phase 4b landed** (overflow-then-retry: `StepDecision.overflow`; decode classifies a provider context-overflow via `isContextOverflow` and calls a new `finalizeOverflow` dep → `steps.finalizeOverflowStep` marks the step finalized WITHOUT appending a session entry (so no `stripOverflowError` needed — the retry's compacted history stays clean); the loop compacts + advances to a FRESH step within a loop-local budget (`DEFAULT_OVERFLOW_RETRY_BUDGET=1`), failing observably as `context_overflow` when exhausted; replay reconstructs `overflow:true` from the row's finishReason). Skipped the step `attempt` discriminator (redundant — the fresh stepNumber already gives each attempt its own journal entry/row). Verified: `tsc` 0, 392 tests. ✅ **Phase 5 landed** (extensions). ✅ **5a-i foundation landed** (new `src/runtime/extensions/{types,registry,runner}.ts`: the hook contract partitioned into 3 determinism classes via `eventClass()`; `ExtensionRegistrationAPI` (registration-only) + `ExtensionContext` (handler-only, with `appendEntry`); name-keyed `defineExtensionRegistry` mirroring the agent/tool registries; pure `runExtensionFactory`/`loadExtensions`/`toManifestEntry` that instantiate a factory against a recording API → collect tools/fragments/ordered handlers → serialized data-only manifest, with per-extension error isolation. `types.ts` `ExtensionFactory` now re-exports the precise contract. Barrel-exported. Verified: `tsc` 0, 398 tests). ✅ **5a-ii landed** (extension loading runs INSIDE the V8 `setup` mutation — no separate `use node` hop — since the registration-only factory contract is pure; new pure `resolveExtensionSpecs`; setup loads named (registry) + inline factories via `loadExtensions`, composes contributed system-prompt fragments into the frozen prompt, freezes the ordered manifest into `runPlan.extensions`, isolates+warns on missing/failed extensions; new codegen `generate-extension-registry.ts` → `_cove/extensionResolver.ts`, dev `convex/extensionRegistry.ts`, `cove build` emits it, `cove init` scaffolds it; barrel-exported). Verified: `tsc` 0, 400 tests. **Working capability: system-prompt-fragment extensions** (named or inline). ✅ **5b landed** (hook firing). ✅ **5b-i** (new `src/runtime/extensions/apply.ts`: `bindManifest` re-runs named factories to recover handler closures in manifest order — inline-factory hooks dropped, documented; pure async folds `runNotifyHooks`/`applyContextHooks`/`applyBeforeAgentStartHooks`/`applyToolCallHooks`/`applyToolResultHooks` — all unit-tested). ✅ **5b-ii** (content-mutation hooks FIRE: `getRunPlanContext` exposes the manifest; `llmStep` binds it and applies `before_agent_start` (system-prompt override) + `context` (message rewrite) before the model call — pure, replay-safe since the journaled step output is what a replay reconstructs). Verified: `tsc` 0, 406 tests. ✅ **5b-iii (dispatch tool hooks)** — new tested `wrapToolsWithHooks` (buildTools.ts) wraps each executable tool with `tool_call` (mutate args / block before execute) + `tool_result` (patch content/details/isError after) hooks; `dispatchTools` binds the manifest + wraps (zero overhead when no such hooks; replay-safe — dispatch action is journaled). Verified: `tsc` 0, 409 tests. ✅ **extension-contributed tools** (`bindManifest` now returns hooks + tools; setup freezes ext tool descriptors via `freezeUserToolDescriptors(...,()=>true)`; dispatch adds bound ext tools to `userTools`). ✅ **`appendEntry` substrate** (`CustomEntry` type + `sessionEntries.kind` "custom"; recorded as side-state, excluded from LLM context — session-history test). Verified: `tsc` 0, 410 tests. **Hooks firing at this checkpoint (7; final count 11 — see the PLAN COMPLETE banner below):** registerSystemPromptFragment, registerTool, context, before_agent_start, tool_call, tool_result, (+ the bind/manifest substrate). ✅ **notify firing (turn_end) + appendEntry persistence** — new `makeBufferedContext` (sync appendEntry buffers; caller drains) + idempotent `appendCustomEntries` mutation; `llmStep` fires `turn_end` after each decode and persists drained entries with deterministic ids. **All 3 determinism classes now fire** (registration / content-mutation / notify); every primitive unit-tested. Verified: `tsc` 0, 411 tests. ✅ **agent_start / agent_end notify** (setup / finalize, persisted via the shared `persistCustomEntries`) + ✅ **session_before_compact** (compact.ts — cancel = NOOP, or replace the summary skipping the model call; bound from the manifest via a defensive `getExtensionManifest` query).
>
> ## ✅ PLAN COMPLETE (Phases 0–5) — final verification: `tsc` 0 errors · **412 tests pass** (1 skipped) · `tsup` build (ESM + DTS) success.
>
> **Phase 5 hook status** (design §5.5):
> - **Firing (11):** `registerSystemPromptFragment`, `registerTool`, `on('setup')`-registration, `context`, `before_agent_start`, `tool_call`, `tool_result`, `session_before_compact`, `agent_start`, `agent_end`, `turn_end` — plus `appendEntry` (custom entry kind + idempotent persistence).
> - **Not wired (tested primitives exist; marginal/constrained in Cove):** `tool_execution_*` (per-tool notify — awkward from the pure dispatch path), `session_compact`/`turn_start`/`model_select` notify (low-value), `before_provider_request` (redundant with `context` since model params are frozen), `message_end` (mutates persisted output). The `applyToolResultHooks`/`runNotifyHooks` primitives are unit-tested, so these are thin additions if needed.
> - **Dropped per design (§5.5):** `project_trust`, `fork`/`tree`/`switch`, `message_start`/`message_update`, `user_bash`/`input`, `registerCommand`/`registerShortcut`/`registerFlag`, `exec`, `setModel`/`setThinkingLevel` mid-run — all assume an interactive/in-process TUI a durable backend doesn't have. with the design's recommended §8 defaults (widen tool result = yes; reject inline-in-`initialize` tools; cancel = noop; extensions = trusted single-tenant).

> **Revision note.** This is the FINAL design, revised against the principal engineer's adversarial review. The review's central feasibility errors (the "replay-safe for free" over-claim, the nonexistent `resolveProfileForRequest`, the V8-mutation extension load phase, the `prepareCompaction` shape mismatch, the same-stepNumber retry, and the over-claimed phase independence) are all fixed below, with the change marked inline as `(revised: …)`. The three highest-leverage structural changes the review demanded are now first-class: (1) an **`initialize`-free, name-keyed registry** that recovers tool/extension *closures* per isolate without re-running the agent initializer; (2) **all hook execution moved behind the `runDecode`/`loadStep` replay guard** with content-mutation hooks redefined as **pure functions of (frozen plan + persisted step inputs + event payload)**; (3) the **extension load phase moved into a dedicated pre-setup `use node` action** that mirrors the existing MCP-discovery hop and feeds a serialized manifest into `setup.run`.

## 1. Executive summary

**Thesis (one paragraph).** Cove already *is* flue-shaped at the top (`createAgent`/`defineAgentProfile`/`defineTool`, model = `"provider/model"` string) and pi-shaped at the bottom (entry-tree session, pure/impure compaction split, descriptors-not-closures). The pragmatic move is therefore **not a rewrite but a convergence-plus-extensions** pass: (a) finish wiring the flue-like authoring surface that is already declared but not consumed (the `mcpServers` schema gap, `tools`/`skills`/`subagents` threaded only to validation, framework tools that bypass `defineTool`); (b) make the four hardcoded provider switches pluggable behind one `ProviderPlugin` so adding a provider is one registration, not four edits; (c) **add a pi-modeled extension system whose hooks are partitioned by where they can legally run** under the durable journal — registration hooks resolved off the journal-critical path in a pre-setup node action, content-mutation hooks run *behind the `runDecode` replay guard* (live-path-only) as pure functions of frozen+persisted inputs, and notify-only hooks anywhere — with a hard rule that *no extension may make the journaled inputs of a replayed step non-deterministic*; and (d) **keep `frozenPlan`** — it is the determinism backbone, not dead weight — but **rename and re-scope it to a "freeze identity, rebind object" contract** that now also freezes the resolved *extension manifest* (active names + ordered subscribed events) so replay sees a stable, order-stable hook set.

**What changes.** Provider layer gains a `ProviderPlugin` abstraction (catalog membership + caps + option-shaping + credential detection in one unit) layered over the existing `ModelHandle`. The authoring surface closes the `mcpServers` strict-schema defect and gets `extensions?` as a first-class field. **A new name-keyed `defineToolRegistry`/`defineExtensionRegistry` sidecar (emitted by `cove build`, mirroring `agentRegistry.ts`) lets `dispatchTools` recover user-tool *closures* and lets the extension binder recover *handler closures* per isolate — without ever re-running the agent `initialize()`** (revised: the draft's `resolveProfileForRequest` call did not exist and would have re-run `initialize`; see §3.2/§5.3). A new `convex/extensions/*` subsystem (registry, runner, frozen manifest, pre-setup load action) ports pi's `(api) => void` factory, the `on()` hook contract, and the two-phase load/bind — but **load happens once in a pre-setup `use node` action** and **bind happens behind the `runDecode` guard inside the journaled actions** (revised: not in the V8 setup mutation, and not by re-instantiating side-effecting factories per action). Compaction finishes the unlanded pi work (incremental `UPDATE` prompt + split-turn prefix, overflow-then-retry) and exposes a `session_before_compact` hook. `frozenPlan` is renamed `runPlan` and grows a frozen `extensions` field plus a per-step overflow-retry mechanism (revised: retry is loop-local + a step `attempt` discriminator, not a plan boolean; see §4.3).

**What stays.** The entry-tree `SessionData` v6 model, the `SessionHistory` pure engine, the `buildContextEntries` read model, O(new) diff-sync persistence, the `ModelHandle` `model: unknown` V8/node boundary, the descriptors-not-closures split, the `decode`/`loadStep` replay guard, and the whole `runHandler → runAgentLoop` three-layer durable loop. None of these are touched except to thread new fields through and to **add a hook seam strictly *after* the `loadStep` guard** inside `runDecode`/`dispatchTools` (revised).

---

## 2. Gap analysis

| Axis | Cove today | flue / pi target | Proposed |
|---|---|---|---|
| **Providers** | `resolveModel` over `ModelHandle`; **four** hardcoded switches (`CATALOG_PROVIDERS`, `CAPABILITIES`, `buildProviderOptions` family branches, `hasCredentialsFor`) that must be edited in lockstep; `ModelHandle.model: unknown` keeps AI SDK at the `use node` boundary | flue: thin `registerProvider(id, reg)` over a catalog; pi: two-axis split (data catalog keyed by `provider/model` vs behaviour registry keyed by `api` slug) | **Keep** `ModelHandle` + dual registry + last-write-wins-per-isolate. **Add** one `ProviderPlugin` that unifies the four switches; built-ins register themselves; `registerProvider` for a catalog id stays a one-liner (flue ergonomic). Do **not** collapse the provider-id vs api-slug registries. |
| **Tools** | `defineTool` (valibot/JSON-Schema, `execute → string`) + `EngineTool` (`execute → EngineToolResult`); `userToolToEngineTool` bridges; framework tools hand-roll JSON Schema; `kind:"user"` descriptors degrade to `errorTool` (re-resolution seam unwired, `userTools: new Map()` in dispatch) | flue `defineTool` exactly (already adopted); pi `AgentTool` richer (images/details/terminate/onUpdate) | **Keep** `defineTool` as the public contract. **Wire** the user-tool re-resolution seam in `buildExecutableTools` via a new **name-keyed `defineToolRegistry` sidecar** (revised: NOT via the nonexistent `resolveProfileForRequest`, NOT by re-running `initialize`). **Widen** `ToolDefinition.execute` return to allow `string \| ToolResult` (opt-in rich result). Migrate framework tools onto `defineTool` opportunistically (low priority). |
| **Agent authoring** | `createAgent`/`defineAgentProfile`/`AgentRuntimeConfig`; valibot `strictObject`; `AGENT_RUNTIME_FIELDS` derived from schema keys; **`mcpServers` typed but absent from schema → runtime throw**; `tools`/`skills`/`subagents`/`mcpServers` validated but not consumed by `setup.ts` | flue two-tier authoring (already mirrored) | **Fix** the `mcpServers` strict-schema defect (add to schema → auto-allowlisted). **Add** `extensions?` field. **Thread** the *consumer-ready* fields (`instructions`/`compaction`) in Phase 1; thread `tools`/`skills`/`subagents`/`mcpServers` only **when their setup-side consumers exist** (revised: Phase 1 must not freeze `tools` descriptors that would then degrade to `errorTool` — see §7). Keep the derived-allowlist invariant (never hand-edit the Set). |
| **Session** | Entry-tree `SessionData` v6 (`MessageEntry`/`CompactionEntry`, `id`/`parentId`/`leafId`), `SessionHistory` pure engine, `buildContextEntries`, O(new) diff-sync rows, content-addressed `imageChunks` | pi append-only JSONL tree, leaf cursor, `buildSessionContext`, lazy/atomic flush, versioned migration | **Keep wholesale.** Only gaps: no branch/fork entries, no `custom`/`custom_message`/`label`/`session_info` taxonomy, no in-place migration (`fromData` hard-throws on `version !== 6`). **Add** a forward-only migration shim now and a `custom`/`custom_message` entry kind to back extension `appendEntry`. |
| **Compaction** | Pure `compaction.ts` (`shouldCompact`/`prepareCompaction`/prompts) + node `compact.ts`; threshold + explicit modes work; replay-stable decision from persisted usage | pi two-phase pure/impure, threshold + overflow + manual, incremental `UPDATE` summary, split-turn prefix, `session_before_compact` hook | **Keep** the split. **Land** the unlanded pi work, passing `previousCompaction` as `{summary, firstKeptIndex, details}` — **translating `CompactionEntry.firstKeptEntryId` (string) → numeric `firstKeptIndex` against the rebuilt message array** (revised: the draft passed the `CompactionEntry` directly, a type/semantics mismatch — see §4.2). Summarize `turnPrefixMessages`, record **summed** summarization `usage` across both calls (revised: split-turn dropped the prefix call's usage). **Wire** overflow-then-retry as a fresh step with an `attempt` discriminator (revised: not same-stepNumber). **Add** `session_before_compact` (replace/cancel-as-noop). |
| **Extensions** | None | pi: `(api) => void` factory, `on()` hook set, two-phase load/bind, per-extension error isolation, `registerTool`/`registerCommand`/etc., `ExtensionContext` lazy guarded getters | **New** `convex/extensions/*`: a **pre-setup `use node` load action** (mirrors `internal.mcp.discover.run`) that runs factories *once*, off the journal-critical path, and emits a **serialized manifest** into `setup.run`; a **binder** that runs **behind the `runDecode` guard** and recovers handler closures from a name-keyed registry in **frozen manifest order**. Port pi's contract; partition hooks by determinism class (§5). Defer the ~40-method UI context behind a no-op. |
| **frozenPlan / durability** | `frozenPlan` snapshotted at `setup.ts` step 0, read every step; freezes model string / systemPrompt / tool descriptors / loop ceilings / compaction / resultSchema / approvalTools; model re-resolved live per `llmStep` | pi assumes in-process loop, no journal — no analogue | **Keep, rename to `runPlan`.** Determinism backbone (verified: `agentRun` re-executes from the top; `setup.run` is a journaled `step.runMutation`; `decode` reconstructs from the finalized row). **Re-scope** to freeze the *ordered extension manifest* too. Do **not** drop while on `@convex-dev/workflow`. |

---

## 3. Proposed PUBLIC API (flue-like)

### 3.1 Providers — unify four switches behind one `ProviderPlugin`

The flue ergonomic to preserve: *registering a known provider is a one-liner; an unknown provider requires `api`+`baseUrl`.* The Cove problem to fix: catalog membership, capability lookup, option-shaping, and credential detection are four hardcoded `provider-name` switches. Collapse them into one registrable unit, keeping `registerProvider`/`resolveModel`/`ModelHandle` intact.

```ts
// convex/providers/plugin.ts  (V8-safe — NO AI SDK, NO "use node")
export interface ProviderPlugin {
  readonly id: string;                                  // catalog membership = "a plugin exists"
  caps(modelId: string): ModelCaps | undefined;         // replaces CAPABILITIES[id][modelId]
  buildProviderOptions?(handle: ModelHandle, level: ThinkingLevel, opts?: BuildOptionsInput): BuiltProviderOptions;
  /** Advisory only (resolveModel never gates on it). `env` is supplied by the single caller (setup diagnostics),
   *  which passes process.env. Credential gating does NOT happen during resolution. (revised: #11 — env source
   *  + advisory-only contract made explicit.) */
  hasCredentials?(env: Record<string, string | undefined>): boolean;
}

export function registerProviderPlugin(plugin: ProviderPlugin): void;  // module-scoped Map, last-write-wins, empty on cold boot
export function getProviderPlugin(id: string): ProviderPlugin | undefined;
```

Built-ins (`anthropic`, `openai`, `google`, `bedrock`) ship as four `ProviderPlugin` objects that **self-register on import** of `convex/providers/builtins.ts`, exactly as pi's `registerBuiltInApiProviders()` runs at import. The existing `lookupCaps`, `buildProviderOptions`, `hasCredentialsFor` become thin dispatchers that consult the plugin map first, then fall back to the legacy literals during migration, then `zeroMetadata`.

**Before** (adding a provider = 4 edits across 3 files): `registry.ts` (CATALOG_PROVIDERS), `capabilities.ts` (CAPABILITIES), `thinking.ts` (family branch), `gateway.ts` (hasCredentialsFor arm).

**After** (one registration; transport overrides still one-liner via existing `registerProvider`):

```ts
registerProviderPlugin({
  id: "groq",
  caps: (modelId) => GROQ_CAPS[modelId],
  buildProviderOptions: (h, level) => openaiCompletionsOptions(h, level),
  hasCredentials: (env) => Boolean(env.GROQ_API_KEY),   // advisory; setup passes process.env
});
registerProvider("groq", { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" });
```

`registerProvider`'s catalog-membership gate now reads "a `ProviderPlugin` is registered OR a transport registration exists" instead of a hardcoded set. The `ModelHandle.model: unknown` boundary and the `gateway()` import staying in `gateway.ts` are **unchanged** — `ProviderPlugin` is V8-safe and never touches the AI SDK. `hasCredentials` remains advisory: `resolveModel` does not gate on it; the gateway surfaces credential errors at request time.

### 3.2 createTools — fix the unwired user-tool seam via a name-keyed registry (revised: BLOCKER #1)

flue exposes `defineTool` (authoring) + `createTools` (internal built-in factory). Cove's analogue is `defineTool` + `createFrameworkTools(env)` + `buildExecutableTools`. Keep this. The concrete change is **wiring the `kind:"user"` re-resolution** that currently degrades to `errorTool` because `dispatchTools` passes `userTools: new Map()`.

**The draft was wrong.** It proposed `const profile = await resolveProfileForRequest(ctx, requestId)`. That function **does not exist anywhere in the repo**, and the only way to a profile is `getRegisteredAgent(target).initialize(...)` — arbitrary user code that runs *only* in `setup.run` and whose per-step/per-replay execution would violate the journal's at-most-once-effect contract (the draft's own §6 argues this). User-tool `execute` *closures* live on the `ToolDefinition` objects returned by `initialize`; the frozen `runPlan.tools` holds only the serializable *descriptor*. There is no persisted artifact from which to recover the closure, and the agent registry holds a `CreatedAgent` *factory*, not resolved tools.

**Fix (revised):** route user tools through a **name-keyed `defineToolRegistry` sidecar** — the same `initialize`-free, re-instantiable-per-isolate pattern the extension system uses (§5.3) and that `agentRegistry.ts` already establishes. `cove build` emits a `defineToolRegistry({...})` sidecar that self-installs on every isolate that touches `llmStep`/`dispatchTools`. `dispatchTools` then recovers closures by name, never by `initialize`:

```ts
// src/runtime/tool-registry.ts (V8-safe) — mirrors agentRegistry.ts; empty on cold boot, re-registered per isolate
export function defineToolRegistry(map: Record<string, ToolDefinition>): ToolRegistry;
export function registerToolRegistry(reg: ToolRegistry): void;
export function getRegisteredTool(name: string): ToolDefinition | undefined;

// convex/engine/dispatchTools.ts — recover closures from the registry by name (NO initialize)
const userTools = new Map<string, ToolDefinition>();
for (const d of plan.tools) {
  if (d.kind !== "user") continue;
  const def = getRegisteredTool(d.name);          // closure recovered per isolate, deterministic, initialize-free
  if (def) userTools.set(d.name, def);            // missing → stays errorTool (load-bearing safety, kept)
}
buildExecutableTools(plan.tools, { env, userTools, resultBundle, mcpResolve });
```

The **descriptor** stays frozen in `runPlan.tools` (schema only) so the model view is replay-stable; only the `execute` closure is recovered here, and because `dispatchTools` is itself a journaled action whose result is cached on replay, the closure runs at most once per finalized step. This is the same "freeze descriptor, rebind execute" contract that already holds for framework tools — but now grounded in a real, `initialize`-free recovery path. The `errorTool` degrade for any unresolved name is retained.

> Authoring impact: a user tool passed in `AgentProfile.tools` must also be addressable by name in the emitted tool registry. `cove build` collects tool definitions from the registered agents' static `tools` arrays into the `defineToolRegistry` sidecar. Inline anonymous tools that only exist inside a dynamic `initialize()` return cannot be recovered post-journal and are therefore **rejected at validation** with a clear message ("user tools must be registered by name; define them at module scope, not inside initialize()"). This is the honest constraint the journal imposes.

### 3.3 Agent authoring — close the `mcpServers` defect, add `extensions`

```ts
// src/runtime/agent-definition.ts
const AgentProfileSchema = v.strictObject({
  name:          v.optional(v.string()),
  description:   v.optional(v.string()),
  model:         v.optional(v.union([v.string(), v.literal(false)])),
  instructions:  v.optional(v.string()),
  skills:        v.optional(v.array(v.unknown())),
  tools:         v.optional(v.array(v.unknown())),
  subagents:     v.optional(v.array(v.unknown())),
  mcpServers:    v.optional(v.array(v.unknown())),   // ← FIX: was typed but missing → runtime throw
  extensions:    v.optional(v.array(v.unknown())),   // ← NEW: extension specs (names or factories)
  thinkingLevel: v.optional(v.string()),
  compaction:    v.optional(v.union([v.literal(false), v.looseObject({})])),
  durability:    v.optional(v.looseObject({})),
}, /* unknown-field message unchanged */);
// AGENT_RUNTIME_FIELDS is DERIVED from these keys — adding here auto-allowlists. Never hand-edit the Set.
```

Add `assertMcpServers` (name+url required, transport in `{streamable-http,sse}`) and `assertExtensions` (each entry is a registered name string OR an inline factory) into `assertAgentProfile`, plus `assertUniqueNames` over server names and extension names. Extend `resolveAgentProfile`/`extendAgentProfile` to `mergeArrays` the two new fields.

```ts
// src/runtime/types.ts
export type ExtensionSpec = string | ExtensionFactory;   // registry name OR inline factory
export interface AgentProfile { /* ...existing... */ mcpServers?: McpServerOptions[]; extensions?: ExtensionSpec[]; }
```

**Before / after** — an agent that today silently throws at runtime:

```ts
// BEFORE: typechecks, throws at defineAgentProfile → "received unknown agent profile field mcpServers"
createAgent(() => ({ model: "anthropic/claude-sonnet-4-6", mcpServers: [{ name: "fs", url, transport: "streamable-http" }] }));

// AFTER: validates and threads through into the frozen runPlan
createAgent(() => ({
  model: "anthropic/claude-sonnet-4-6",
  mcpServers: [{ name: "fs", url, transport: "streamable-http" }],
  extensions: ["audit-log", customCompaction],   // by-name (registry) or inline factory
}));
```

`createAgent` stays non-eager; validation stays deferred to `resolveAgentProfile`/`assertAgentRuntimeConfig`. The SDK boundary stays definition-agnostic.

> **`initialize()` determinism is a user contract (revised: #9).** `setup.run` runs `initialize({id, env, payload})` exactly once inside a journaled mutation, so the *first* execution's output is frozen and replay returns the cached plan. We therefore (a) **document that `initialize` must be deterministic** (flue-style: no clocks/random/live-IO feeding the returned config; do not stash mutable state) and (b) **stop silently swallowing `initialize` errors that change the plan** — replace the bare `catch {}` (setup.ts:67) with a recorded, observable skip (emit a `setup_initialize_failed` diagnostic + fall back to request/session model) so a transient init failure that would yield a *different* frozen plan is visible rather than silent. We do **not** expand `initialize`'s inputs beyond the already-planned `{id, env, payload}` without re-affirming the single-execution guarantee; `env`/`payload` are read-only and must not be used non-deterministically.

---

## 4. Proposed SESSION + COMPACTION layer (pi-like)

Cove's session layer is **already pi's model**, translated from JSONL to Convex rows. The work is finishing compaction parity and naming the runtime locations precisely.

### 4.1 Where each piece runs

| Piece | Cove file | Runtime location | Why |
|---|---|---|---|
| `SessionHistory`, `buildContextEntries`, entry tree | `src/runtime/session-history.ts` | **V8-safe core** | Pure tree resolution; importable by queries/mutations. pi's `buildSessionContext`. |
| `shouldCompact`, `prepareCompaction`, cut-point, prompts, `serializeConversation` | `src/runtime/compaction.ts` | **V8-safe core** | pi's pure planner half. Unit-testable without LLM/disk. |
| Diff-sync persistence, `loadSessionData`, `appendCompactionEntry` | `convex/sessions/{store,persist,diff}.ts` | **Convex (no "use node")** | DB I/O only. pi's `SessionManager`. |
| `generateText` summarization + entry append | `convex/engine/compact.ts` | **Convex `use node`** | pi's impure `compact()`. The only place the model is called for summarization. |
| Compaction *decision* (`compactionDecision`) | `convex/engine/decode.ts` | **inside `runDecode`, on both live + replay paths from persisted usage** | Recomputed from *persisted step usage* → replay-stable. **Do not unify with `estimateContextTokens(messages)`** — only the persisted-usage path is deterministic. (Note: `compact.ts` still uses the estimator for `tokensBefore` telemetry only — never route the *trigger* through it.) |
| Compaction *trigger* (`deps.compact(stepNumber)`) | `convex/engine/loop.ts` → `runHandler.ts` | **journaled `step.runAction`** | Runs before the next decode; replay re-yields the journaled summary, no second model call (verified). |

### 4.2 Concrete shapes to land (revised: BLOCKER-adjacent MAJOR #3 + MINOR #12)

The pure layer already computes `prep.previousSummary` and `prep.turnPrefixMessages`; `compact.ts` ignores them and never uses `UPDATE_SUMMARIZATION_PROMPT`/`TURN_PREFIX_SUMMARIZATION_PROMPT`. Land them — **with the correct `previousCompaction` shape**.

The draft's code `prepareCompaction(messages, settings, history.getLatestCompaction())` is a **type mismatch**: `getLatestCompaction()` returns a `CompactionEntry` whose boundary is `firstKeptEntryId: string` (session-history.ts:32), but `prepareCompaction`'s `previousCompaction` requires `{ summary, firstKeptIndex: number, details? }` (compaction.ts:350-354) — a **numeric index into the rebuilt message array**. Passing the entry directly leaves `firstKeptIndex === undefined → boundaryStart === undefined → broken slice`. The index must be computed against the **same `messages`/`contextEntries` array** passed to `prepareCompaction` (the `path.findIndex(e => e.id === firstKeptEntryId)` pattern at session-history.ts:118).

```ts
// convex/engine/compact.ts (use node) — incremental + split-turn, correct previousCompaction shape, summed usage
const history = SessionHistory.fromData(data);
const contextEntries = history.buildContextEntries();
const messages = toMessages(contextEntries);                 // the SAME array prepareCompaction will slice

// (revised #3) translate the prior compaction's entry-id boundary → numeric index in THIS message array
const prevEntry = history.getLatestCompaction();
const previous = prevEntry
  ? (() => {
      const idx = contextEntries.findIndex((c) => c.entry?.id === prevEntry.firstKeptEntryId);
      return idx >= 0
        ? { summary: prevEntry.summary, firstKeptIndex: idx, details: prevEntry.details }
        : undefined;                                          // boundary not on this path → treat as fresh
    })()
  : undefined;

const prep = prepareCompaction(messages, settings, previous);
if (!prep) return;                                            // noop ("already compacted" / "nothing to compact")

const historyPrompt = prep.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
const [historySummary, prefixSummary] = await Promise.all([
  generateText({ system: SUMMARIZATION_SYSTEM_PROMPT, prompt: historyPrompt + serializeConversation(prep.messagesToSummarize), model }),
  prep.isSplitTurn
    ? generateText({ system: SUMMARIZATION_SYSTEM_PROMPT, prompt: TURN_PREFIX_SUMMARIZATION_PROMPT + serializeConversation(prep.turnPrefixMessages), model })
    : Promise.resolve(null),
]);

const summary = prefixSummary
  ? `${historySummary.text}\n\n---\n**Turn Context (split turn):**\n${prefixSummary.text}`
  : historySummary.text;

// (revised #12) sum BOTH summarization calls' usage so split-turn cost is fully attributed
const summarizationUsage = addUsage(historySummary.usage, prefixSummary?.usage);

await appendCompactionEntry(ctx, sessionId, {
  summary: summary + formatFileOperations(...computeFileLists(prep.fileOps)),
  firstKeptEntryId: contextEntries[prep.firstKeptIndex].entry.id,   // index → entry-id for persistence
  tokensBefore: prep.tokensBefore,
  usage: summarizationUsage,                                        // ← field exists; previously never written
});
```

### 4.3 Overflow mode (G2.6) — compact-then-retry on a FRESH step (revised: MAJOR #4)

pi has two triggers: threshold (no retry) and overflow (strip error msg, compact, retry once). Cove has the `isContextOverflow` classifier but no retry hook. The draft proposed "re-decode the **same** `stepNumber`," which is **incompatible with the journal**: the loop is a flat `while (stepNumber < maxSteps)` that always `stepNumber++` (loop.ts:68,111), and re-yielding `decode(stepNumber)` for an already-finalized step hits the `loadStep` guard (decode.ts:108) and returns the **cached overflow decision** — replaying the failure, not retrying. A boolean on the *plan* is also the wrong place for a *per-step* retry budget (the plan is shared session state re-frozen per request).

**Fix (revised):** model overflow-retry as **detect → compact → advance to a fresh `stepNumber`** whose decode reads the compacted history, with the retry budget tracked as a **loop-local counter** (reconstructed deterministically like `followUps`), and a new **`attempt` discriminator on the step row** so each attempt is a distinct journal entry (and cost is attributable per attempt).

- `loop.ts` gains an `overflow` branch (parallel to the existing `decision.shouldCompact` branch at line 109):

```ts
// loop.ts — overflow recovery: compact, then advance to a fresh step that re-decodes the compacted history
let overflowRetries = 0;                       // loop-local, deterministic on replay (like followUps)
// ... inside the while loop, after decode:
if (decision.overflow && deps.compact && overflowRetries < OVERFLOW_RETRY_BUDGET) {
  await deps.stripOverflowError(stepNumber);   // remove the trailing context-overflow error turn (journaled mutation)
  await deps.compact(stepNumber);              // journaled compaction
  overflowRetries++;
  stepNumber++;                                // FRESH step number → new journal entry, reads compacted history
  continue;                                    // (revised: NOT a same-step re-decode)
}
```

- `StepDecision` gains `overflow: boolean`, set by `runDecode` from the `isContextOverflow(...)` classifier (live path) and reconstructed deterministically from the finalized row's `finishReason`/error on replay (same pattern as `shouldCompact`). `OVERFLOW_RETRY_BUDGET` is a frozen `runPlan` scalar (a *budget*, not a per-step flag), and the *consumed count* is loop-local.
- **Stale-usage guard (kept from pi):** add the guard that an assistant message whose timestamp `<=` the latest `CompactionEntry` timestamp must **not** re-trigger compaction (compute against the latest `CompactionEntry` timestamp in `compactionDecision`). Without it Cove compacts in a loop immediately after compacting.

Replay-stability holds because every branch is a journaled re-decode/re-mutation whose finalized rows determine the path; the fresh `stepNumber` gives each attempt its own journal identity.

> **As built (diverged from this draft).** No `stripOverflowError` step exists: `decode` marks the overflow step finalized *without appending a session entry* (`steps.finalizeOverflowStep`), so the compacted history is already clean and nothing needs stripping. The retry budget is a **loop-local default** (`DEFAULT_OVERFLOW_RETRY_BUDGET = 1` in `loop.ts`), **not** a frozen `runPlan` scalar. The step `attempt` discriminator and the pi stale-usage guard were both **dropped as redundant** — a fresh `stepNumber` already gives each attempt its own journal row, and Cove's per-step-finalized usage means a post-compaction step reads the smaller context and can't loop. The live `loop.ts` branch is: `if (decision.overflow) { if (deps.compact && overflowRetries < budget) { compact; overflowRetries++; stepNumber++; continue } else finalize failed/context_overflow }`.

---

## 5. EXTENSIONS mechanism

The honest framing: **pi's extension runner assumes an in-process Node loop where any hook can fire any time and mutate live state. Cove's loop replays from a journal. So Cove's extension system must split pi's single `on()` surface into three determinism classes by *where the hook physically runs* — and, critically, every content-mutation hook must run *behind the `runDecode` replay guard* and be a pure function of frozen + persisted inputs.**

### 5.1 The three determinism classes (revised: BLOCKER #2, MAJOR #5/#6)

1. **REGISTRATION (load phase) — run ONCE in a pre-setup `use node` action, OFF the journal-critical path.** (revised: NOT inside the V8 `setup.run` mutation.) A dedicated `internal.extensions.load.run` action — mirroring the existing `internal.mcp.discover.run` hop (runHandler.ts:20-25) — instantiates each resolved extension factory **once** in a Node isolate, collects its `registerTool`/`registerSystemPromptFragment`/`on('setup')` output, and returns a **serialized manifest** that `runHandler` feeds into `setup.run` as an argument (exactly like `discoveredMcp`). This resolves two review blockers at once: factory bodies never run in the V8 setup mutation (so they cannot pull a `use node` dependency or Node API into it, #5), and factories run **once**, not per-action (#6). Output is **data only** (tool descriptors, prompt fragments, active names, ordered event subscriptions) — never closures.

2. **CONTENT-MUTATION (runtime) — run BEHIND the `runDecode`/`loadStep` guard, live-path-only, as PURE functions of (frozen plan + persisted step inputs + event payload).** (revised: this is the core feasibility fix.) The draft claimed these are "replay-safe for free." **They are not.** In `llmStep.ts:27-30`, `messages = toModelMessages(history.buildContext())` and `tools = buildModelView(plan.tools)` are computed **unconditionally at the top of the action**, *before* `runDecode` (line 103) calls `loadStep()` (decode.ts:107). A `context` or `before_provider_request` hook placed "inside llmStep" runs in that **pre-guard region on every replay**; since the model is not re-called on replay, any divergent hook output is silently dropped for the model call yet diverges for anything persisted/branched off it. The fix has two halves:

   - **Location:** hooks execute **inside `runDecode`, strictly after the `existing?.isFinalized` early-return** (decode.ts:108) — i.e. only on the live path. On a finalized replay, `reconstructDecision` returns without ever invoking a hook. Concretely, `context`/`before_provider_request` move from the action top into `runDecode` after the guard; `message_end` runs after the stream completes and **before** `finalizeStep` (revised: MINOR #10 — exact seam specified); `tool_call`/`tool_result` run inside `dispatchTools` behind that action's own already-resulted-call skip (which is its replay guard).
   - **Contract:** content-mutation hooks are **pure functions of (frozen `runPlan` + the persisted step inputs + the event payload)** — **no clocks, no `Math.random`, no live DB reads, no mutable module state**. This is enforced, not merely documented (§8). A hook that needs to react to live state must instead write a deterministic-keyed `appendEntry` custom row that becomes part of the persisted, journaled inputs. Because the hook is pure and runs only on the live path, and its effect is captured in the finalized step row, replay reconstructs the same decision from that row.

3. **NOTIFY-ONLY — fire-and-forget, any boundary, skippable on replay.** `agent_start`, `turn_end`, `message_end`(observe-variant), `tool_execution_*`, `model_select`, `session_compact`. They observe; they must **not** feed anything back into journaled inputs. They may be dropped entirely on replay. pi's `appendEntry` (persisted `custom` entry, idempotent by deterministic entryId) maps here.

### 5.2 The hook contract (Cove's `on()` surface)

```ts
// src/runtime/extensions/types.ts (V8-safe — pure types + factory shape)
export type ExtensionFactory = (cove: ExtensionRegistrationAPI) => void | Promise<void>;  // revised: registration-only at instantiation
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

// (revised #6) The factory receives a REGISTRATION-ONLY api. Action-capable methods are NOT on it —
// they exist only on the ExtensionContext passed INTO handlers (porting pi's two-phase throwing-stub guarantee).
export interface ExtensionRegistrationAPI {
  // ── REGISTRATION (load phase — pure, idempotent, side-effect-free; runs once in the pre-setup node action) ──
  registerTool(tool: ToolDefinition): void;                       // → frozen descriptor in runPlan.tools; closure recovered via tool registry (§3.2)
  registerSystemPromptFragment(fragment: string): void;          // → composed into runPlan.systemPrompt
  on(event: "setup", h: ExtensionHandler<SetupEvent, SetupResult>): void;

  // ── CONTENT-MUTATION (runtime — run behind the runDecode guard; PURE fn of frozen+persisted+event) ──
  on(event: "context", h: ExtensionHandler<ContextEvent, { messages?: AgentMessage[] }>): void;
  on(event: "before_provider_request", h: ExtensionHandler<BeforeProviderRequestEvent, unknown>): void;
  on(event: "tool_call", h: ExtensionHandler<ToolCallEvent, { block?: boolean; reason?: string }>): void; // mutate event.input in place
  on(event: "tool_result", h: ExtensionHandler<ToolResultEvent, { content?; details?; isError? }>): void;
  on(event: "before_agent_start", h: ExtensionHandler<BeforeAgentStartEvent, { systemPrompt?: string }>): void;
  on(event: "message_end", h: ExtensionHandler<MessageEndEvent, { message?: AgentMessage }>): void; // replacement must keep role; runs pre-finalize
  on(event: "session_before_compact", h: ExtensionHandler<SessionBeforeCompactEvent, { cancel?: boolean; compaction?: CompactionResult }>): void;

  // ── NOTIFY-ONLY (best-effort; may be skipped on replay) ──
  on(event: "agent_start" | "agent_end" | "turn_end"
       | "tool_execution_start" | "tool_execution_end" | "session_compact",
     h: ExtensionHandler<NotifyEvent>): void;
}

// Action-capable surface — ONLY available on ctx inside a handler, never in the factory body (revised #6)
export interface ExtensionContext {
  appendEntry<T>(customType: string, data?: T): void;   // persisted custom entry (NOT sent to LLM), idempotent by deterministic entryId
  getContextUsage(): ContextUsage | undefined;
  // setModel/setThinkingLevel/sendMessage are CONSTRAINED — see §5.5
}
```

The mutation contracts are encoded **as result types**, exactly as pi (mutate-by-return for `context`/`tool_result`/`message_end`, mutate-in-place for `tool_call.input`, short-circuit for `tool_call.block`/`session_before_compact.cancel`). Per-extension error isolation (try/catch → `emitError` → continue) is non-negotiable and ported verbatim. **There is no shared `EventBus` in v1** (revised #6): pi's cross-extension `events` pub/sub has no replay-safe semantics and, with once-per-load factory instantiation, would either leak subscriptions or be empty; it is dropped. Cross-extension coordination, if ever needed, goes through deterministic `appendEntry` rows.

### 5.3 Registration / loading model (revised: name-keyed, `initialize`-free, order-stable)

```ts
// src/runtime/extensions/registry.ts (V8-safe) — mirrors agentRegistry.ts and the tool registry (§3.2)
export function defineExtensionRegistry(map: Record<string, ExtensionFactory>): ExtensionRegistry;
export function registerExtensionRegistry(reg: ExtensionRegistry): void;  // module-scoped, empty on cold boot → re-registered per isolate
export function getRegisteredExtension(name: string): ExtensionFactory | undefined;
```

Cove has **no filesystem module addressing**, so drop pi's `.pi/extensions` discovery + jiti loader entirely. Extensions are registered by name in a `defineExtensionRegistry({...})` sidecar (emitted by `cove build`, like `agentRegistry.ts`) **or** supplied inline as factories in `AgentProfile.extensions`. The same sidecar must self-install on **every isolate** that runs the load action, `llmStep`, or `dispatchTools` (same cross-isolate constraint as `providersById`).

### 5.4 The two-phase load/bind, adapted to the journal (revised: BLOCKER #2 + MAJOR #6/#7)

pi runs the factory **once** at process start (load), then `bindCore()` injects action impls (runtime). Cove cannot do "once at process start," and **must not** re-instantiate side-effecting factories per action. Instead:

- **Load phase** runs **once** in the pre-setup `internal.extensions.load.run` (`use node`) action (§5.1). It instantiates each resolved factory with the **registration-only API**, collects registrations, and returns the **serialized, ordered manifest**: for each active extension, its name, its contributed tool descriptors, its prompt fragments, and **its subscribed event names in registration order**. `runHandler` feeds this manifest into `setup.run`, which freezes it into `runPlan.extensions`. Because the load action's *output* is what crosses into the journal (data, never closures), and it is a journaled `step.runAction`, the manifest is replay-stable.

- **Bind phase** runs **behind the `runDecode` guard** (live path only) at the point a hook must fire inside `llmStep`/`dispatchTools`/`compact`. The binder reads `runPlan.extensions` (the frozen, ordered manifest), re-instantiates each named factory **from the registry to recover its handler closures**, and binds the action-appropriate `ExtensionContext`. Crucially:
  - **Factory bodies must be pure registration** — idempotent, side-effect-free, safe to re-run (revised #6). Side effects belong only inside handlers (which run live-path-only). The registration-only factory API makes this structurally enforceable (action methods are simply absent from it, porting pi's throwing-stub guarantee as a *type-level* guarantee).
  - **Iteration is in frozen-manifest order, ignoring live registry order entirely** (revised #7). The model/tool "freeze identity, rebind object" analogy is leaky for extensions because the rebind source is arbitrary user code whose *order* depends on registry iteration ("empty on cold boot, re-registered per isolate"); two isolates registering in different orders would otherwise produce different sequential `context` rewrites. Freezing the **ordered (name, events) list** and binding strictly in that order makes the hook chain deterministic regardless of live registration order. A test asserts two different registration orders yield identical hook execution given the same frozen manifest.

This is still "freeze the serializable identity (ordered manifest), rebind the live object (handler closures) per action" — but corrected so the freeze captures *order*, the rebind never runs side effects, and everything happens only on the live path.

### 5.5 pi hook → Cove mapping (one-by-one)

| pi hook | Class | Cove equivalent | Notes |
|---|---|---|---|
| `project_trust` | drop | Not feasible | No interactive trust prompt in a durable backend. |
| `resources_discover` | registration | **`on('setup')` → `{ skillPaths?, ... }`** | Runs in the pre-setup load action; contributed paths frozen into `runPlan.skills`. |
| `session_start` / `session_shutdown` | notify | **`agent_start` / `agent_end`** | Per-run start/end, best-effort, skippable on replay. |
| `session_before_switch` / `fork` / `tree` | drop (mostly) | Not feasible now | No interactive `/tree`/`/fork` UX yet; entry-tree substrate is ready, defer. |
| `session_before_compact` | content-mutation | **`session_before_compact` → `{ cancel?, compaction? }`** | Runs in `compact.ts` behind that step's idempotency. **`cancel:true` makes the compact action a NOOP, not a throw** (a throw fails a journaled step). Deliberate divergence from pi. |
| `session_compact` | notify | **`session_compact`** | After `appendCompactionEntry`; observe only. |
| `context` | content-mutation | **`context` → `{ messages? }`** | Runs **inside `runDecode` after the loadStep guard** (revised), before the model call. `structuredClone` + sequential thread, last-writer-wins. Pure fn of frozen+persisted+payload. |
| `before_provider_request` | content-mutation | **`before_provider_request`** | Runs **inside `runDecode` after the guard**, immediately before `streamText`; return replaces payload. Pure. |
| `after_provider_response` | notify | fold into `turn`/notify | Response status/headers on a notify event. |
| `before_agent_start` | content-mutation | **`before_agent_start` → `{ systemPrompt? }`** | Per-turn system-prompt override, chained, inside `runDecode` post-guard. Base prompt stays frozen in `runPlan.systemPrompt`; the override is captured in the live decode. |
| `agent_start` / `agent_end` / `turn_start` / `turn_end` | notify | same | Best-effort. |
| `message_start` / `message_update` | drop | Not feasible cleanly | Token-stream hooks; no re-stream on replay. Default drop. |
| `message_end` → `{ message? }` | content-mutation | **`message_end`**, constrained | Replacement must keep role (port pi's rejection) and is applied **inside `runDecode` after the stream completes and before `finalizeStep`, guarded so it never runs on the `isFinalized` replay branch** (revised #10). |
| `tool_execution_*` | notify | **`tool_execution_start/end`** | Best-effort, inside `dispatchTools`. |
| `model_select` / `thinking_level_select` | notify | same | Observe. Mutating the model mid-run is rejected. |
| `tool_call` → mutate `event.input` + `{ block? }` | content-mutation | **`tool_call`** | Inside `dispatchTools` before execute (behind the already-resulted-call skip). In-place mutation, no re-validation (port pi's gotcha). Block writes an error tool-result. Pure fn of persisted call + payload. |
| `tool_result` → `{ content?, details?, isError? }` | content-mutation | **`tool_result`** | Inside `dispatchTools` after execute, before `appendToolResult`. |
| `user_bash` / `input` | drop | Not feasible | TUI/interactive input. |
| `registerTool` | registration | **`registerTool`** | Descriptor frozen into `runPlan.tools`; **closure recovered via the §3.2 tool registry by name** (revised — same `initialize`-free path). First-registration-wins. |
| `registerCommand` / `registerShortcut` / `registerFlag` / `registerMessageRenderer` | drop | Not feasible | CLI/TUI surface. (`registerFlag` could return later as config injection; not core.) |
| `registerProvider` / `unregisterProvider` | registration | **maps to §3.1 `registerProviderPlugin`** | At registry-setup, not per-extension-load mid-run. |
| `sendMessage` / `sendUserMessage` | constrained | **only via a journaled `appendFollowUp`-style step** | A hook cannot inject into a replaying loop arbitrarily; must enqueue through a journaled mutation. Not exposed in v1. |
| `appendEntry` | action | **`appendEntry`** (new `custom` entry kind) | Writes a `custom` row (state, not LLM context), idempotent by deterministic entryId. The one safe write-action. |
| `setModel` / `setThinkingLevel` | drop / constrained | **Reject mid-run** | Model string frozen in `runPlan`; allowed only as a registration-phase contribution before freeze. |
| `setSessionName` / `setLabel` | action (deferred) | defer | Needs `session_info`/`label` entry kinds; low priority. |
| `exec` | drop | Not feasible | Breaks determinism/sandbox; tools cover sandboxed exec. |

**Net:** ~13 hooks port cleanly (the behaviour-defining ones), ~5 are constrained/deferred, ~8 drop as TUI/interactive-only. The drops are honest — they assume a live process or interactive UI a durable backend does not have. (This drop-list was assessed SOUND in review.)

---

## 6. frozenPlan decision: **KEEP** (rename `runPlan`, re-scope to include the ordered extension manifest)

**Decision: KEEP. Do not drop.** (Assessed SOUND in review.)

**Rationale, tied to the determinism constraint (verified against the code).** `agentRun` is a `workflow.define` handler that **re-executes from the top on every resume**, and `setup.run` is itself a journaled `step.runMutation` that returns its cached result on replay. The frozen plan makes everything downstream of setup deterministic. Dropping it = resolving the plan live inside `llmStep`/`dispatchTools`, breaking determinism in four code-sourced ways:

1. **Skills-catalog enum.** `setup.run` builds the `activate_skill` enum from a *live* `ctx.db.query("skills").withIndex("by_isActive")` (setup.ts:122-123). A live per-step rebuild would present a different tool surface than the decode the model already answered.
2. **`initialize()` is arbitrary user code** (setup.ts:60). Calling it per step/replay violates the at-most-once-effect contract. (This is also why §3.2 recovers user-tool *closures from a name-keyed registry*, never by re-running `initialize`.)
3. **Model fallback reads mutated state.** `registry > request > session > default` reads `session.model`, which `setup` itself mutates.
4. **Compaction thresholds.** `shouldCompact` must use a constant frozen `contextWindow`/`reserveTokens` so the compact branch re-takes identically.

**Why it pulls its weight.** Only the model *string* is frozen; the live AI-SDK handle is rebuilt per `llmStep` via `resolveModel(plan.model)` (llmStep.ts:24). That is "freeze serializable identity, rebind live object" — the same pattern tools use. frozenPlan freezes exactly the serializable inputs to replay, no more.

**What changes (re-scope, not remove).**
- **Rename** `frozenPlanValidator` → `runPlanValidator`, `sessions.plan` → `sessions.runPlan`, `getPlanContext` → `getRunPlanContext` (naming only; signals "resolved run snapshot").
- **Add** `extensions: v.optional(v.array(v.any()))`: the frozen, **ordered** manifest (active names, contributed tool descriptors, prompt fragments, and **subscribed event names in registration order**). This is what makes the hook set replay-stable AND order-stable (§5.4).
- ~~**Add** `overflowRetryBudget: v.optional(v.number())` + a step `attempt` discriminator.~~ **As built: neither was added.** The overflow-retry budget is a **loop-local default** (`DEFAULT_OVERFLOW_RETRY_BUDGET = 1`), not a frozen `runPlan` field; a fresh `stepNumber` already gives each overflow attempt its own journal row, so no `attempt` discriminator is needed. (See §4.3 *As built*.)

**Why the extension manifest CAN'T be frozen exactly like the model/tool analogy (revised #7).** For model/tools the rebind source is order-independent (`resolveModel(string)`, `createFrameworkTool(name, env)`). For extensions the rebind re-runs user factories whose *order* drives a sequential `context` rewrite chain; load-order depends on registry iteration, which is per-isolate. So we freeze the **ordered (name, events) list** and bind strictly in that order — restoring determinism the leaky analogy alone would not give.

**The only condition under which frozenPlan could be dropped:** if Cove abandons `@convex-dev/workflow` journal-replay for a *checkpoint-resume* model that persists loop state directly and never re-executes the handler from the top. That is a far larger change and is **not recommended**. See §8 open decision 1.

---

## 7. Phased migration plan

Each phase is independently shippable and keeps tests green. The draft's "Phase 1 is independent" claim was **over-stated** (revised #8): freezing user-`tools` descriptors before the dispatch consumer exists would turn a silently-ignored field into a live `errorTool` path (a tool the model now sees and calls that always errors). Field-threading is therefore **sequenced by consumer-readiness**, and the tool registry (the precondition for #1/#7/#8) is built first.

**Phase 0 — Rename + insurance + tool registry foundation (risk: low).**
Files: `convex/schema.ts`, `convex/engine/{setup,requests,llmStep,dispatchTools,runHandler}.ts`, `src/runtime/session-history.ts`, new `src/runtime/tool-registry.ts`.
`frozenPlan`→`runPlan` rename (mechanical). Add `SessionHistory` forward-only migration shim (`fromData` no longer hard-throws on `version !== 6`). **Land the name-keyed `defineToolRegistry`/`registerToolRegistry`/`getRegisteredTool` sidecar (empty, unused yet)** — the `initialize`-free closure-recovery substrate that Phases 3 and 5 depend on. Tests: rename-only + a registry round-trip test; green by construction.

**Phase 1 — Fix the `mcpServers` defect + thread CONSUMER-READY fields only (risk: low).**
Files: `src/runtime/agent-definition.ts`, `src/runtime/types.ts`, `convex/engine/setup.ts`.
Add `mcpServers` + `extensions` to `AgentProfileSchema` (auto-allowlisted), add `assertMcpServers`/`assertExtensions`, extend `resolveAgentProfile`/`extendAgentProfile`. **Thread only `instructions`/`compaction`** into the `setup.run` freeze (revised: these already have consumers). **Do NOT freeze `tools`/`skills`/`subagents`/`mcpServers` into `runPlan.tools` yet** — they remain validated-but-unconsumed until their dispatch/setup consumers land (Phases 2-5), so no `errorTool` regression. Also replace the bare `catch {}` around `initialize` with an observable `setup_initialize_failed` diagnostic (revised #9). Tests: agent-authoring cases with `mcpServers`/`extensions`; assert `tools` is NOT yet surfaced in `buildModelView`.

**Phase 2 — ProviderPlugin (risk: low-medium).**
Files: new `convex/providers/{plugin,builtins}.ts`; refactor `convex/providers/{capabilities,thinking,gateway,registry}.ts` to dispatch through the plugin map with legacy-literal fallback.
Built-in plugins self-register on import; `lookupCaps`/`buildProviderOptions`/`hasCredentialsFor` consult plugins first, literals as fallback (zero behavior change), then delete literals in a follow-up once parity is proven. Tests: existing provider tests pass unchanged; add a `registerProviderPlugin` test for a synthetic provider.

**Phase 3 — Wire user-tool re-resolution (registry-backed) + thread `tools`/`skills`/`subagents` + widen tool result (risk: medium).**
Files: `convex/engine/dispatchTools.ts`, `convex/engine/buildTools.ts`, `convex/engine/setup.ts`, `src/runtime/tool-types.ts`, `src/runtime/tool.ts`, `cove build` codegen for the tool sidecar.
Populate `userTools` in `dispatchTools` from `getRegisteredTool(name)` (revised: registry-backed, `initialize`-free). **Now** freeze `tools`/`skills`/`subagents` descriptors into `runPlan.tools` (their dispatch consumer exists this phase — closing the #8 coupling). `cove build` emits the `defineToolRegistry` sidecar from the agents' static `tools`; reject inline-in-`initialize` user tools at validation. Widen `ToolDefinition.execute` return to `string | ToolResult` (opt-in). Keep `errorTool` for any unresolved kind. Tests: a custom user-tool dispatch test (currently degrades to `errorTool`); a "user tool defined inside initialize is rejected" test; verify framework/result/mcp paths unchanged.

**Phase 4 — Compaction parity (risk: medium).**
Files: `convex/engine/compact.ts`, `convex/engine/{loop,decode,steps,retry}.ts`, `convex/schema.ts` (step `attempt`).
Land incremental `UPDATE` summary + split-turn prefix **with the correct `previousCompaction` index translation** (revised #3), record **summed** summarization `usage` (revised #12), add the stale-usage guard, wire overflow-then-retry **as a fresh step + `attempt` discriminator + loop-local budget** (revised #4). Tests: incremental-compaction + split-turn (assert prefix usage is attributed) + overflow-retry; assert the compaction decision and the overflow branch are identical across a simulated replay (re-decode of finalized rows).

> **As built:** no `convex/schema.ts` change for compaction — the `attempt` discriminator and the stale-usage guard were both **dropped as redundant** (see §4.3 *As built*), and the overflow budget is loop-local. Summed `usage` round-trips via a new optional `usage` arg on `appendCompactionEntry` (the entry `data` stays `v.any()`, so no schema change). `retry.ts` was not touched.

**Phase 5 — Extensions subsystem (risk: high).**
Files: new `src/runtime/extensions/{types,registry,runner}.ts`, new `convex/extensions/{load,manifest,bind}.ts`; touch `convex/engine/{runHandler,setup,decode,dispatchTools,compact}.ts` to add the pre-setup load hop, freeze the manifest, and fire hooks **behind the `runDecode` guard**.
**5a** — pre-setup `use node` load action (mirrors MCP discovery) + frozen ordered manifest into `runPlan.extensions` + registration hooks + notify-only hooks + `appendEntry` custom entry kind. These cannot corrupt the journal; land first.
**5b** — content-mutation hooks (`context`, `before_provider_request`, `before_agent_start`, `message_end`, `tool_call`, `tool_result`, `session_before_compact`) placed **inside `runDecode` after the `loadStep` guard** (and the analogous post-guard seams in `dispatchTools`/`compact`), each a **pure function of frozen+persisted+payload**. Risk: any hook leaking non-determinism into a journaled input. Mitigation: live-path-only placement + the purity contract + a **replay-equality test per content-mutation hook** (run the hook twice, assert identical output) + a **registration-order-independence test** (two orders → identical chain). Tests: port pi's runner tests (ordering, error isolation, role-check on `message_end`, `session_before_compact` replace/cancel-as-noop); add the determinism tests above.

---

## 8. Risks + open decisions for the USER

Crisp either/or questions. The first three block design; the rest are scoping.

1. **Durability model — the foundational fork.** *Keep `@convex-dev/workflow` journal-replay (→ `runPlan` stays mandatory; hooks partitioned by determinism class as in §5), OR move to checkpoint-resume durable state (→ `frozenPlan` droppable, but the loop and every replay-guard must be rewritten)?* **Recommendation: keep journal-replay.** Everything here assumes this.

2. **`session_before_compact` cancel semantics — diverge from pi.** *Should `{cancel:true}` make the compact step a **noop** (Cove-safe, my recommendation) OR reject the run as pi does (which would fail a journaled step)?* **Recommendation: noop.**

3. **Content-mutation hook trust boundary.** *Are extensions **trusted code** (app-owner authored, may mutate provider payloads and tool args) OR **untrusted/multi-tenant** (need sandboxing, allow-lists, no raw `before_provider_request`)?* **Recommendation: trusted, single-tenant per deploy** for v1. If multi-tenant is required, `before_provider_request` and `tool_call` in-place mutation must be gated. (Note: the purity contract in §5.1 is enforced *regardless* of trust — it is a determinism requirement, not a security one.)

4. **Tool result widening.** *Widen public `ToolDefinition.execute` to `string | ToolResult` now (images/terminate reachable from user tools), OR keep `→ string`?* **Recommendation: widen (opt-in).**

5. **Framework tools onto `defineTool`.** *Migrate hand-rolled framework tools now, OR leave them?* **Recommendation: leave them** for this refactor; revisit if a single authoring story becomes a goal.

6. **Branch/fork/tree feature.** *Near-term product goal (and thus the `session_before_tree`/`fork`/`switch` hooks + `branch_summary` entries), OR deferred?* **Recommendation: defer.** Entry-tree substrate already supports it mechanically.

7. **Provider catalog source.** *Keep the hand-maintained `CAPABILITIES` subset behind `ProviderPlugin`, OR adopt a generated catalog (pi's `models.generated.ts`) as the plugin data source?* **Recommendation: keep hand-maintained behind the plugin**; swapping to a generated source later is non-breaking.

8. **Inline-in-`initialize` user tools (NEW, revised #1).** *Accept the constraint that user tools must be defined at module scope (registry-recoverable by name) and reject tools defined inside a dynamic `initialize()` return, OR invest in a heavier mechanism to persist/recover dynamic tool closures across the journal?* **Recommendation: accept the constraint.** The journal cannot serialize closures; module-scope-by-name is the honest, deterministic model, and matches how `agentRegistry`/`providersById` already work.

**Top residual risks.** (a) **Phase 5b purity enforcement** is where journal corruption could hide — any content-mutation hook that reads live, non-frozen state reintroduces exactly the non-determinism `runPlan` exists to prevent. Enforce "hooks read only frozen plan + the event payload + their own deterministic-keyed `appendEntry` rows," and ship the per-hook replay-equality + order-independence tests as gating. (b) The **`ProviderPlugin` fallback-to-legacy-literal window** (Phase 2) must be deleted deliberately, or the four switches silently persist. (c) **Cross-isolate re-registration:** the extension registry, the tool registry, and the provider plugin map are all empty on every cold boot and **must be re-registered per isolate** (same constraint as `providersById`); the generated sidecars must run on every isolate that touches the load action / `llmStep` / `dispatchTools`, not just `setup`. (d) **The pre-setup extension load action** adds a Node cold-start hop; gate it (like the MCP hop) behind a cheap check so runs with no extensions skip it.

---

Relevant files for implementation:
- Authoring + schema fix: `/root/projects/harness-engine/cove-harness/src/runtime/agent-definition.ts`, `/root/projects/harness-engine/cove-harness/src/runtime/types.ts`
- Tool registry (new): `/root/projects/harness-engine/cove-harness/src/runtime/tool-registry.ts`; tool seam: `/root/projects/harness-engine/cove-harness/convex/engine/{dispatchTools,buildTools}.ts`, `/root/projects/harness-engine/cove-harness/src/runtime/{tool,tool-types}.ts`
- Provider plugin: `/root/projects/harness-engine/cove-harness/convex/providers/{capabilities,thinking,gateway,registry}.ts` (+ new `plugin.ts`, `builtins.ts`)
- Compaction parity: `/root/projects/harness-engine/cove-harness/convex/engine/{compact,loop,decode,retry,steps}.ts`, `/root/projects/harness-engine/cove-harness/src/runtime/compaction.ts`, `/root/projects/harness-engine/cove-harness/src/runtime/session-history.ts`
- runPlan / durability: `/root/projects/harness-engine/cove-harness/convex/schema.ts`, `/root/projects/harness-engine/cove-harness/convex/engine/{setup,requests,runHandler,llmStep}.ts`
- Extensions (new): `/root/projects/harness-engine/cove-harness/src/runtime/extensions/*`, `/root/projects/harness-engine/cove-harness/convex/extensions/*` (note the pre-setup load action mirrors `/root/projects/harness-engine/cove-harness/convex/mcp/discover.ts` + `runHandler.ts:20-25`); model on `/root/projects/harness-engine/pi/packages/coding-agent/src/core/extensions/{types,runner,loader}.ts`