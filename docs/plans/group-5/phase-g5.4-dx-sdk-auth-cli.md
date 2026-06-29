# Phase G5.4 — DX: facade completion, SDK/react reconciliation, auth & CLI

> Finish the developer-facing surface so the whole public API is live, not half-stubbed. Wire the inert
> facade verbs (`task`/`shell`/`fs`), reconcile the two divergent reactive-client contracts, add the
> combined `useCoveAgent` hook + a reactive facade transport + `workflows.invoke`, export the missing
> `ResultUnavailableError`, fix the asymmetric CLI registry codegen + dev-watch and add `cove logs` — and
> close the **open-by-default** deployment gap with a shipped default `authorize` provider. Every item stays
> Convex-native: durable state never leaves Convex, the @convex-dev/workflow journal/replay loop is
> untouched, and the AI SDK stays at the model boundary. Design-of-record:
> [05 — Public API & SDK](../../design/05-public-api-and-sdk.md),
> [08 — Conventions & execution boundary](../../design/08-conventions-and-execution-boundary.md)
> (§3 the boundary, §4.11 shell envelope), [07 — Risks & decisions](../../design/07-risks-and-decisions.md).
> **Decision note (auth):** the default-provider item closes a real security gap — today an unconfigured
> deployment is fully open (no default `authorize`, no `ctx.auth` path, no gate on the `invoke.submit*`
> mutations); G5.4 ships closed-by-default without disturbing the durable architecture.

## Goal & scope

Each item below is a **mini-spec** (what · where · why-native · effort · risk · acceptance), anchored to the
exact call sites the analysis verified. **In scope:** completing the already-declared public contract —
filling stubs, reconciling type surfaces, wiring reactive paths, and the auth gate. **Out of scope:** the
G2.5 run-row lifecycle writer (`convex/runs.ts` still writes nothing — gates the `runId`-keyed run
inspection and the dedicated workflow hook); the deferred `m7` blueprint system (`cove add`, `cove docs`);
and **any restoration of flue's SSE / Durable-Streams machinery** — the workflow + logs surfaces fold Convex
events, never re-introduce a stream engine. The thesis boundary holds throughout: the new host-issued
`shell`/`fs` action touches the box via `env.exec` inside an **engine action**, never from an `invoke/*`
mutation ([08 §3](../../design/08-conventions-and-execution-boundary.md), [phase-06](../group-1/phase-06-harness-invoke.md)).

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| G5.1, G5.3 | prior group-5 surface | phase-level prereqs |
| A (task) | `convex/engine/task.ts` primitives (exist) | facade-entry admission only; engine path is built |
| A (shell/fs) | a **new** host-shell engine action | `execShellWithEvents` has no caller today — action-building, not pure plumbing |
| B | both `CoveReactiveClient` interfaces (exist, divergent) | targeted reconciliation of the explicit-`client` path |
| C | `useRunEvents` + `AgentStore.sendMessage` (exist) | thin re-compose; client-side only |
| D | `watchRequestToTerminal` reactive pattern (exists) | feature-detect `onUpdate`; keep poll fallback |
| E | server `submitWorkflow`/`admitWorkflow` + route (exist) | drop the dedicated hook until G2.5 run-writer |
| F | `runtime/index.ts` error barrel (exists) | one-line re-export |
| G | CLI codegen loaders + `dev` watch set | restore registry symmetry + conditional emit |
| H | reactive `events.listForStream` + event-stream iterator (exist) | read-only terminal tail; key on `streamKey` |
| I | `auth.ts` hook + `invoke.submit*` mutations (exist) | ship a default + wire `ctx.auth` + gate the mutations |

---

## A — Wire the facade `task()` / `shell()` / `fs` verbs through the transport

**What.** Roughly half the public facade is inert at runtime: `session.task()`, `session.shell()`,
`harness.shell()`, and **both** `fs` surfaces throw `CoveError('not_implemented')`, even though the full
type contract is declared. Split honestly by remaining work: (1) **`task()` is mostly wiring** — the
engine path already exists; only the facade-entry admission is missing. (2) **`shell()` + `fs()` need a NEW
server-side host-shell engine action** — `execShellWithEvents` has **no caller today**, so this is
action-building, not pure facade plumbing.

**Where.** Inert stubs: [context.ts:228-229](../../../src/runtime/context.ts) `task()` → `deferredCall`,
[context.ts:231-233](../../../src/runtime/context.ts) `session.shell()`,
[context.ts:166-169](../../../src/runtime/context.ts) `harness.shell()`,
[context.ts:234,296-310](../../../src/runtime/context.ts) `fs` → `deferredFs`. Transport interface to extend:
[context.ts:93-103](../../../src/runtime/context.ts) (`CoveTransport`); transport impl + refs:
[index.ts:22-32](../../../src/sdk/index.ts) `CoveApiRefs`, [index.ts:42-117](../../../src/sdk/index.ts)
`createCoveTransport`. **task() reuses (built):** [task.ts:36-108](../../../convex/engine/task.ts)
`createChildRequest` (idempotent `submissionId = task:<parentRequestId>:<toolCallId>` at
[task.ts:47](../../../convex/engine/task.ts)), [task.ts:111-118](../../../convex/engine/task.ts)
`getChildResult`, [task.ts:127-145](../../../convex/engine/task.ts) `formatTaskResult`; the `task` kind is
already in the discriminator ([schema.ts:176-181](../../../convex/schema.ts)). **shell/fs (not pre-built):**
the redact+event envelope [shell.ts:15-90](../../../src/runtime/shell.ts) (`execShellWithEvents` /
`redactEnvValues`, caller only in `__tests__`); the new action resolves the session sandbox by reusing the
`resolveSandbox` shape at [dispatchTools.ts:41-46](../../../convex/engine/dispatchTools.ts), runs
`execShellWithEvents` / `SessionEnv` fs, then persists the redacted `sessionEntries` triple. Add the
`submitTask` / `shell` admission entrypoints alongside [submit.ts:18-46](../../../convex/invoke/submit.ts).

**Why native / why it fits.** The boundary is already settled and stays Convex-native. `invoke/*` mutations
**never touch the box** (admission/scheduling/cancel only,
[08 §3](../../design/08-conventions-and-execution-boundary.md),
[phase-06:60](../../plans/group-1/phase-06-harness-invoke.md)); the host-issued shell touches the box via
`env.exec` inside an **engine action**, distinct from model-issued `dispatchTools`. Durable state stays in
`agentRequests`; `task` already replays deterministically off its `submissionId`
([task.ts:47](../../../convex/engine/task.ts)). Env redaction is mandatory and already specified
([08 §4.11](../../design/08-conventions-and-execution-boundary.md): keys-only `<redacted>` in every event
and the persisted triple; only `env.exec` sees real values). No competing loop, AI SDK untouched.

**Effort** L — task is light, but the host-shell action (sandbox resolution, event emit, transcript triple,
fs surface) is real build. **Risk** med — a new box-touching path; keep it strictly inside the engine action.

**Acceptance.** `session.task("…")` resolves a child run's final answer (idempotent on replay via the
deterministic `submissionId`; re-admission of the same `toolCallId` returns the existing child, not a
second one). `session.shell("echo hi")` returns `{stdout,stderr,exitCode}`, emits the `tool_start`+`tool`
pair (shared `toolCallId`, `toolName:'bash'`, `durationMs`), and persists a transcript triple in which any
`env` **value** appears only as `<redacted>` (keys preserved) — verified in both event and row.
`harness.shell()` runs the same envelope with **no** transcript hook. `fs.*` round-trips through the
session `SessionEnv` confined to the workspace. None of the four paths is reachable from an `invoke/*`
mutation.

---

## C — `useCoveAgent` combined send+stream React hook

**What.** flue's `useFlueAgent` was split into `useAgentPrompt` (submit) and `useRunEvents` (events) and
never rejoined, forcing chat-UI consumers to correlate `streamKey` (= `instanceId`, **not** `requestId` — a
documented footgun) themselves. Add `useCoveAgent(instanceId, options?)` returning
`{ messages, status, error, send }` — the hook most chat UIs actually want.

**Where.** Export site (no `useCoveAgent` today): [index.ts:1-48](../../../src/react/index.ts). Implement as
a thin wrapper over [use-run-events.ts:43-62](../../../src/react/use-run-events.ts) — return its
`{messages,status,error}` and delegate `send` to the returned
[use-run-events.ts:34,61](../../../src/react/use-run-events.ts) `store`, whose
[agent-store.ts:65-91](../../../src/react/agent-store.ts) `sendMessage` already does optimistic
send + `local_send_admitted`/`local_send_failed` reconcile. The footgun it resolves:
[use-run-events.ts:8-12](../../../src/react/use-run-events.ts) (`streamKey` = `instanceId`/`runId`, not the
`agentRequests` id) and [schema.ts:345](../../../convex/schema.ts) (`streamKey = runId | instanceId |
${instanceId}:${session}`). Guard `send` when `store` is `undefined`, mirroring flue's
[use-agent.ts:25-49](../../../../flue/packages/react/src/use-agent.ts) throw. Keep
`useAgentPrompt`/`useRunEvents` as-is for advanced consumers.

**Why native / why it fits.** Purely client-side React DX confined to `src/react/`. It re-composes two
existing client hooks; `sendMessage` still routes through `client.agents.send → api.invoke.submitPrompt`
([agent-store.ts:74-81](../../../src/react/agent-store.ts)), so Convex remains the durable owner. No process-
global state, no journal/replay touch, no AI-SDK boundary. Minor overlap with `useCoveRun` (read-only fold,
no `send`) — `useCoveAgent` does **not** subsume it.

**Effort** S. **Risk** low — additive re-compose; no new durable surface.

**Acceptance.** `useCoveAgent(instanceId)` renders `messages` from the reactive stream, reflects
`status`/`error`, and `send(text)` optimistically appends then reconciles via the store. Calling `send`
with an absent stream key throws the documented "cannot send without an instance id" error. A happy-dom
test parallels `use-run-events.test.tsx`. `useAgentPrompt`/`useRunEvents` are unchanged.

---

## G — Fix asymmetric tool/extension registry codegen + dev-watch

**What.** Two concrete CLI bugs. (1) `build.ts` loads + validates the **agent** and **workflow** registries
but **unconditionally** emits the tool + extension resolver sidecars (importing `../toolRegistry.ts` /
`../extensionRegistry.ts`) with **no** `loadToolRegistry`/`loadExtensionRegistry` — so those registries are
never validated, the `exportName` is hardcoded `"tools"`/`"extensions"`, and the emitted sidecar fails
`tsc --noEmit` when the registry files are absent (breaking the `cli-smoke` fixture and pre-tool-registry
projects on upgrade). (2) `dev.ts` watches only the agent + workflow registry paths, so editing
`toolRegistry.ts`/`extensionRegistry.ts` during `cove dev` does **not** re-codegen.

**Where.** Asymmetric load + hardcoded export: [build.ts:55-56](../../../src/cli/commands/build.ts)
(loads agent+workflow only), [build.ts:88,94](../../../src/cli/commands/build.ts) (hardcodes
`exportName:"tools"`/`"extensions"`, always-emit). Missing loaders:
[registry-loader.ts:44,49,59,67](../../../src/cli/codegen/registry-loader.ts) export only
`agentRegistryPath`/`workflowRegistryPath` + their loaders (grep for tool/ext loaders = none). Missing
validators: [validate-registry.ts:40,80](../../../src/cli/validation/validate-registry.ts)
(`validateAgentRegistry`/`validateWorkflowRegistry` only). Emitter export-name slots:
[generate-tool-registry.ts:19,23](../../../src/cli/codegen/generate-tool-registry.ts),
[generate-extension-registry.ts:17,21](../../../src/cli/codegen/generate-extension-registry.ts). Dev watch
set: [dev.ts:78-86](../../../src/cli/commands/dev.ts) (omits the two registry paths). **Scoping correction:**
fresh `cove init` projects are **not** broken — [init.ts:171-172](../../../src/cli/commands/init.ts) scaffolds
`toolRegistry.ts`/`extensionRegistry.ts` with `defineToolRegistry({})`/`defineExtensionRegistry({})`
(asserted by [init.test.ts:70-71](../../../src/cli/__tests__/init.test.ts)); breakage is limited to the
`examples/cli-smoke` fixture and to upgrading pre-tool-registry projects.

**Why native / why it fits.** Pure build-time codegen + `fs.watch` changes. No durable state relocates, no
journal/replay touch, no AI-SDK boundary. The seam it validates (`getRegisteredTool`/`getRegisteredExtension`,
consumed in [dispatchTools.ts:16,19-22](../../../convex/engine/dispatchTools.ts) and `setup.ts`/`finalize.ts`/
`llmStep.ts`) is exactly Cove's own out-of-band closure-recovery mechanism, which the thesis endorses.

**Effort** M. **Risk** low — codegen/watch only; prefer **conditional emit** (emit the resolver only when the
registry file is present) so the `tsc` gate stays green on pre-registry projects, rather than only patching
the fixture.

**Acceptance.** `build.ts` loads + validates all four declared registries and reads `exportName` from each
file (no hardcoded `"tools"`/`"extensions"`). Editing `toolRegistry.ts` or `extensionRegistry.ts` during
`cove dev` triggers a re-codegen. `cove build` on a project **without** the two registry files type-checks
clean (conditional emit) instead of failing `tsc`. `examples/cli-smoke` builds green. Existing
`init.test.ts`/`codegen.test.ts` still pass.

---

## I — Ship a default `authorize` provider (close open-by-default)

**What.** `convex/auth.ts` ships a pluggable `authorize(ctx, req)` hook run at every admission point but
ships **no default provider**, so an unconfigured deployment is fully open. Worse, the `ctx.auth`
native-caller path that [05:260](../../design/05-public-api-and-sdk.md) promises has **zero call sites**, and
the `invoke.submit*` mutations have **no** `runAuthorize` call — so the mutation surface is ungated even if
HTTP were closed. Ship a **closed-by-default** gate, scoped wider than "just a provider".

**Where.** No-op gate, no default: [auth.ts:11-22](../../../convex/auth.ts) (`runAuthorize` returns
`undefined` when no hook is installed; module-scoped `let`, re-applied per cold boot per
[auth.ts:1-5](../../../convex/auth.ts)). HTTP gate sites (only gate, no signature/identity check):
[http.ts:73,112,139](../../../convex/http.ts) (`/agents`, `/runs`, `/workflows`). Channel backstop (gate is
no-op, `adapter.verify` is the real check): [inbound.ts:25,28](../../../convex/channels/inbound.ts).
**Ungated mutation surface:** [submit.ts:18-46](../../../convex/invoke/submit.ts) — `submitPrompt`
(and `submitWorkflow`/`submitSkill`/`submitCompact`) has **no** auth call. Design promises that are
unimplemented: [05:259-260](../../design/05-public-api-and-sdk.md) ("the same hook also runs from the public
`invoke.submit*` mutations so the engine is never reached unauthenticated"; native callers gated by
`ctx.auth.getUserIdentity()`); [08 deployment](../../implement/08-deployment-and-operations.md) ("with no
hook installed, those routes are open"). Grep `ctx.auth`/`getUserIdentity` across `convex/` = **0 hits**.

**Why native / why it fits.** A default `authorize` gate runs at the admission/HTTP boundary (`httpAction`)
and inside the public `invoke.submit*` mutations. It does not relocate durable state, does not touch the
@convex-dev/workflow journal-replay loop, adds no competing engine, and keeps the AI SDK at the model
boundary. The hook is module-scoped but **re-applied per cold boot by codegen** — i.e.
cold-boot-rederivable, the thesis's allowed category, not the forbidden process-global-that-cannot-survive-
replay. Neutral-to-aligned: closes a security gap without disturbing durability.

**Effort** M. **Risk** med — security-sensitive default; a too-strict default could lock out existing
deployments, so gate behind the absence of an explicit hook and document the opt-out.

**Acceptance.** (1) An **unconfigured** deployment rejects an unauthenticated submit with 401 (default
requires identity via `ctx.auth.getUserIdentity()`), instead of admitting it. (2) The `ctx.auth` native-
caller path is actually wired and reads the verified identity. (3) `submitPrompt`/`submitWorkflow` run the
gate, so the mutation surface is closed even when reached directly (not only via HTTP). (4) Channel webhook
routes keep `adapter.verify` signature checks as the `/channels` backstop. (5) Installing a custom
`authorize` hook overrides the default (last-write-wins, re-applied per cold boot). No durable state or
workflow-loop change.

---

## B — Reconcile the two divergent `CoveReactiveClient` interfaces (sdk vs react)

**What.** `src/sdk/types.ts` defines `CoveReactiveClient` with a **3-arg** `agents.send(name,id,opts)` +
`runs.events`; `src/react/client-types.ts` defines a **different** one with a **1-arg**
`agents.send(opts)` + `subscribeEvents`. The react layer claims the sdk client is "structurally assignable"
but the `send` signatures differ — and the broken pairing is **documented**: the CLI scaffold README shows
users `CoveProvider` (react) + `createCoveReactiveClient` (sdk) together, so passing that sdk client as the
explicit `client` prop throws `TypeError: client.subscribeEvents is not a function` at `AgentStore.start()`
and mis-binds the options object to the 3-arg send's `name` param.

**Where.** sdk interface (3-arg send + `runs.events`, no `subscribeEvents`):
[types.ts:172-191](../../../src/sdk/types.ts); sdk impl: [client.ts:77](../../../src/sdk/client.ts)
`send(name,id,opts)`, [client.ts:114-122](../../../src/sdk/client.ts) `runs.events`. react interface
(1-arg send + `subscribeEvents`, no `runs`): [client-types.ts:49-65](../../../src/react/client-types.ts);
false "structurally assignable" claim: [client-types.ts:5-6,46-47](../../../src/react/client-types.ts).
Mismatch sites: [agent-store.ts:48](../../../src/react/agent-store.ts) calls `client.subscribeEvents`,
[agent-store.ts:74](../../../src/react/agent-store.ts) calls 1-arg `client.agents.send`. The explicit-client
plumbing: [provider.tsx:14-21](../../../src/react/provider.tsx) (`client` prop typed as the **react**
`CoveReactiveClient`), `useResolvedCoveClient` prefers the explicit override. The documented incompatible
pairing: [init.ts:325-328](../../../src/cli/commands/init.ts) (scaffold README imports `CoveProvider` +
`createCoveReactiveClient`). The separate-contract fakes:
[agent-store.test.ts](../../../src/react/__tests__/agent-store.test.ts) /
[use-run-events.test.tsx](../../../src/react/__tests__/use-run-events.test.tsx) implement `subscribeEvents`.

**Why native / why it fits.** Pure consumer-side type-contract/DX reconciliation. Both clients are thin
Convex-reactive consumer surfaces (mutation/query/`onUpdate`/`watchQuery`). It relocates no durable state
(still all in Convex events/requests/runs), does not touch journal replay or the @convex-dev/workflow loop,
adds no competing engine, and keeps the AI SDK at the model boundary.

**Effort** M. **Risk** low — type-surface plumbing; the default ambient-Convex path
(`createReactiveClientFromConvex`) already works.

**Acceptance.** Passing the `@cove/sdk` `createCoveReactiveClient` result as the explicit react `client` prop
works end-to-end (no `subscribeEvents is not a function`, no mis-bound options) — via a documented adapter
(`runs.events` async-iterator → `subscribeEvents` callback; 3-arg send → 1-arg), OR the react
hooks/`AgentStore` consuming the sdk surface directly, OR a single shared minimal contract. The false
"structurally assignable" comment is corrected. The `init.ts` scaffold README pairing actually runs. Default
ambient path unchanged.

---

## D — Reactive (`onUpdate`) `CoveTransport` for the runtime facade

**What.** `createCoveClient`'s `CoveContext` facade (`ctx.init().session().prompt()`) binds to a **polling**
transport (`awaitTerminal` polls `getRequest` every ~400ms, 600s deadline) — strictly worse in latency +
load than the reactive consumer client, which already uses Convex `onUpdate`. Offer a reactive
`CoveTransport` (`onUpdate`-backed `awaitTerminal`) so the facade and consumer client share one low-latency
await path; keep polling as the `ConvexHttpClient`-only fallback.

**Where.** Polling transport: [index.ts:15-19](../../../src/sdk/index.ts) (`ConvexLike` declares only
`mutation`/`query`), [index.ts:42-117](../../../src/sdk/index.ts) `createCoveTransport`,
[index.ts:81-92](../../../src/sdk/index.ts) (poll `awaitTerminal`, 400ms / 600_000ms),
[index.ts:128-138](../../../src/sdk/index.ts) `createCoveClient`. Facade consumers:
[context.ts:93-103](../../../src/runtime/context.ts) (`CoveTransport`),
[context.ts:194-202](../../../src/runtime/context.ts) (drives `submitPrompt`+`awaitTerminal`). The reactive
pattern to reuse (don't duplicate): [client.ts:138-178](../../../src/sdk/client.ts)
`watchRequestToTerminal`. The wider client shape to feature-detect:
[types.ts:33-42](../../../src/sdk/types.ts) `CoveConvexClient` (carries `onUpdate`). No server-side consumer
of the facade transport and no existing facade-transport tests.

**Why native / why it fits.** Pure client-side latency optimization. Durable state stays in Convex — it
still reads `getRequest` (Convex-owned). Nothing touches the journal/replay or adds a competing loop;
`convex.onUpdate` is the canonical Convex-reactive primitive, **more** on-thesis than the poll loop. AI SDK
untouched.

**Effort** M. **Risk** low — additive path; the poll loop remains the fallback.

**Acceptance.** When the facade is built over an `onUpdate`-capable client, `awaitTerminal` resolves via the
reactive subscription (no 400ms poll). When built over a `ConvexHttpClient`-only client (no `onUpdate`), it
falls back to the existing 400ms/600s poll loop. `ConvexLike` is widened to optionally carry `onUpdate`.
First facade-transport tests cover both paths.

---

## E — Implement the SDK workflow consumer surface (`workflows.invoke`)

**What.** The reactive client's `workflows.invoke` throws `not_implemented` even though the server route +
admit are wired by codegen. Wire `workflows.invoke` to `POST submitWorkflow` and watch the request to
terminal like `agents.prompt`. **Explicitly drop/defer** the dedicated `useCoveWorkflow`/`WorkflowRun`
hook — `useCoveRun` already folds run events generically and there is no distinct workflow behavior to
observe until the G2.5 run-writer exists.

**Where.** Throwing slot: [client.ts:124-130](../../../src/sdk/client.ts) (`workflows.invoke` →
`CoveApiError("workflows: not available until G2.4")`). Refs + options:
[types.ts:45-53](../../../src/sdk/types.ts) `CoveReactiveApiRefs` (add a `submitWorkflow` ref),
[types.ts:161-191](../../../src/sdk/types.ts) (`WorkflowInvokeOptions` + the `workflows.invoke` slot). The
shape to mirror: [client.ts:80-107](../../../src/sdk/client.ts) `agents.prompt` (submit → watch). The
existing generic fold (use this for any run kind, incl. workflow):
[use-cove-run.ts:49-116](../../../src/react/use-cove-run.ts). Server (built):
[submit.ts:49-64](../../../convex/invoke/submit.ts) `submitWorkflow`,
[admit.ts:225-252](../../../convex/invoke/admit.ts) `admitWorkflow` (the run reuses `agentRun` over the
serialized input; `workflow.start` at [admit.ts:248](../../../convex/invoke/admit.ts)),
[http.ts:147](../../../convex/http.ts) (route bound), [dev.ts:34-49](../../../convex/dev.ts) `startWorkflow`
(exercises the path without HTTP). The run-writer gap: [runs.ts:1-6](../../../convex/runs.ts) (nothing writes
the `runs` table yet — `listRuns()` returns `[]`, `get()` only has the `agentRequests` fallback).

**Why native / why it fits.** As scoped over Convex reactivity it is on-thesis: Convex still owns the run
([admit.ts:248](../../../convex/invoke/admit.ts) `workflow.start`); `workflows.invoke` just POSTs
`submitWorkflow` then watches `getRequest` to terminal exactly like `agents.prompt`. **CAVEAT (thesis trap):**
flue's reference `WorkflowRun` ([workflow-run.ts](../../../../flue/packages/react/src/workflow-run.ts)) is
built on the dropped SSE / Durable-Streams `runs.stream` engine — porting it verbatim would re-introduce the
SSE path Cove deliberately removed ([client.ts:7](../../../src/sdk/client.ts)). The implementation **must**
fold Convex events, not restore flue's stream machinery.

**Effort** M (trends toward S given the dropped hook). **Risk** low — mirrors a built path; the only hazard
is porting the SSE machinery, which is forbidden.

**Acceptance.** `client.workflows.invoke("name", { wait:"result" })` POSTs `submitWorkflow` and resolves the
run's terminal snapshot via the reactive watch (no throw). A `submitWorkflow` ref is added to
`CoveReactiveApiRefs`. No dedicated workflow hook is added; `useCoveRun(streamKey)` observes a workflow run.
No SSE/`runs.stream` code is reintroduced. No durable state leaves Convex.

---

## F — Export `ResultUnavailableError` from the runtime barrel

**What.** `src/runtime/errors.ts` defines `ResultUnavailableError` (the rejection for
`prompt({ result })` on give-up / exhausted / re-validation failure) and `context.ts` + the engine loop
throw it, but `src/runtime/index.ts` does **not** re-export it — so result-schema consumers cannot
`instanceof`-branch the rejection without string/code matching. One-line barrel addition; without it the
headline result-schema feature has no catchable typed error in the public surface.

**Where.** Class def: [errors.ts:138](../../../src/runtime/errors.ts) (code `"result_unavailable"` at
[errors.ts:144](../../../src/runtime/errors.ts)). Throw sites:
[context.ts:260,276,279](../../../src/runtime/context.ts), [loop.ts:108,157](../../../convex/engine/loop.ts).
The error re-export block that omits it: [index.ts:51-71](../../../src/runtime/index.ts). The published
barrel entrypoint: [package.json:31](../../../package.json) (`"./runtime"`). Contract:
`PromptResultResponse`. Tests currently deep-import via `../errors.ts`
([context.test.ts](../../../src/runtime/__tests__/context.test.ts),
[loop.test.ts](../../../convex/engine/__tests__/loop.test.ts)), confirming no public path.

**Why native / why it fits.** A one-line re-export of a pure error class from the V8-safe runtime barrel
touches no durable state, no journal/replay, no competing loop, no AI-SDK boundary. The barrel is explicitly
the pure/V8-safe subset and the published `"./runtime"` entrypoint. Fully aligned.

**Effort** S. **Risk** low — additive re-export, no behavior change.

**Acceptance.** `import { ResultUnavailableError } from ".../runtime"` resolves, and a result-schema
consumer can `instanceof`-branch the `prompt(..., { result })` rejection from the public entrypoint instead
of deep-importing `./errors.ts` or matching `.code === "result_unavailable"`. No behavior change to the
throw paths.

---

## H — `cove logs`: live run-event tailing from the terminal

**What.** Cove's CLI has only `build`/`dev`/`init`/`deploy` (+ a no-op `add` stub); flue ships
`flue logs <runId>` (tail/replay a run with `--types`/`--format`/`--follow`). Add `cove logs` as a **thin
terminal tail/replay over the existing reactive event stream** — no separate streaming server. Key it on
what is actually populated today.

**Where.** CLI surface (no `logs`/`docs` — dropped at [cove.ts:3](../../../bin/cove.ts); usage
[cove.ts:38-63](../../../bin/cove.ts); `add` is a deferred-`m7` stub at
[cove.ts:185-186,220-221](../../../bin/cove.ts)). The reactive read path to tail:
[read.ts:17-32](../../../convex/events/read.ts) `listForStream` (seq cursor). The SDK iterator to reuse:
[client.ts:109-122](../../../src/sdk/client.ts) `runs.events(streamKey)` →
[event-stream.ts:49,110,203](../../../src/sdk/event-stream.ts) (`createCoveEventStream`, `onUpdate`,
`AsyncIterator`). **Keying correction:** key on `streamKey` / `instanceId` / `submissionId` (the keys
`listForStream` and `runs.events` already accept), with `--types` / `--format(pretty|ndjson)` / `--follow` /
`--since <seq>`. Treat flue-style `cove logs <runId>` as **following G2.5**: `runs.ts` documents that nothing
writes the `runs` table yet ([runs.ts:1-6](../../../convex/runs.ts) — `listRuns()` returns `[]`, `get()` only
has the `agentRequests` `requestId` fallback), so `runId`-keyed inspection has no data source until the
run-row lifecycle writer lands. **Drop** the bundled "optionally add `cove docs` and blueprint-backed
`cove add`" — those are independent items (`docs` needs a corpus + index; `add` needs the deferred `m7`
blueprint system, [cove.ts:221](../../../bin/cove.ts)). Reference impl:
[flue.ts:247,570,1531](../../../../flue/packages/cli/bin/flue.ts) (`LogsArgs`/`parseLogsArgs`/`logsCommand`)
and [flue logs.md](../../../../flue/apps/docs/src/content/docs/cli/logs.md).

**Why native / why it fits.** A read-only terminal consumer of the existing reactive Convex query
(`listForStream` via the SDK event-stream iterator). It relocates no durable state, adds no competing
loop/engine, does not touch the AI SDK or the model boundary, and introduces no replay-affecting global
state. Mirrors `flue logs`' "read-only, does not invoke work" contract.

**Effort** M. **Risk** low — read-only CLI atop a shipped reactive query.

**Acceptance.** `cove logs <streamKey> --follow` tails the live ordered event sequence from the terminal;
`--since <seq>` resumes from a cursor; `--types` filters by event type; `--format ndjson` emits one JSON
object per line (default `pretty`). It only **reads** (`listForStream`) — it never admits work. `runId`-keyed
inspection is deferred to the G2.5 run-writer (documented, not silently broken). `cove docs`/`cove add` are
not in this item.

---

## Risks & gotchas (cross-item)

- **A — the box is touched only inside an engine action.** `invoke/*` mutations must never call `env.exec`
  ([08 §3](../../design/08-conventions-and-execution-boundary.md),
  [phase-06:60](../../plans/group-1/phase-06-harness-invoke.md)); the host-issued `shell`/`fs` path resolves
  the sandbox lazily inside the engine action only. The `task` admission stays idempotent on the
  deterministic `submissionId` ([task.ts:47](../../../convex/engine/task.ts)) so a replayed/re-admitted
  `toolCallId` reuses the existing child rather than spawning a second.
- **A — env redaction is mandatory and load-bearing.** `ShellOptions.env` **values** must be `<redacted>`
  (keys-only) in **every** event and in the persisted `sessionEntries` triple — only `env.exec` sees real
  values ([08 §4.11](../../design/08-conventions-and-execution-boundary.md)). A leaked value in a row is a
  durable secret leak.
- **E / H — do NOT restore the SSE / Durable-Streams engine.** Cove deliberately dropped flue's
  `runs.stream` SSE path ([client.ts:7](../../../src/sdk/client.ts)). The workflow surface (E) and `cove logs`
  (H) must fold **Convex events** (`listForStream` / `onUpdate`), never port flue's `WorkflowRun` /
  `FlueEventStream` machinery.
- **E / H — gate on the G2.5 run-writer.** `convex/runs.ts` writes nothing yet ([runs.ts:1-6](../../../convex/runs.ts)).
  `runId`-keyed run inspection and a dedicated `useCoveWorkflow` hook have no data source until that writer
  lands — key everything off `streamKey`/`instanceId`/`submissionId` for now.
- **I — a too-strict default can lock out live deployments.** The default `authorize` must engage only when
  no explicit hook is installed, must be overridable (last-write-wins, re-applied per cold boot per
  [auth.ts:1-5](../../../convex/auth.ts)), and must close **both** the HTTP routes **and** the
  `invoke.submit*` mutations — closing only HTTP leaves the mutation surface open
  ([submit.ts:18-46](../../../convex/invoke/submit.ts)).
- **B / C / D — these are consumer-side only.** No item here may relocate durable state out of Convex, add a
  process-global that cannot survive a cold boot, or move ownership to the AI-SDK boundary. The reactive
  transport (D) and combined hook (C) re-compose existing Convex-reactive surfaces; the module-scoped auth
  hook (I) is cold-boot-rederivable, not a forbidden non-journaled global.
