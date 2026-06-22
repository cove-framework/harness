# Phase 8 — HTTP + auth + restored Workflow surface
> Expose cove to non-Convex callers: a minimal `httpRouter` (submit + poll, no SSE), the pluggable `authorize` hook, the `CoveHttpError` 4xx rendering sub-layer, **and** the restored first-class user-authored Workflow surface (`POST /workflows/:name`, `defineWorkflow`/`WorkflowHandler`, `runs.kind='workflow'`). Design-of-record: [06 — Roadmap](../../design/06-phase-roadmap.md) + [05 — Public API & SDK](../../design/05-public-api-and-sdk.md), [08 — Conventions](../../design/08-conventions-and-execution-boundary.md). Decisions: [D2, D3, D18](../../design/07-risks-and-decisions.md).

## Goal & scope

Phase 6 made a prompt runnable from **Convex** code. Phase 8 makes it runnable from **outside** Convex — webhooks, channels, curl, the non-reactive SDK — and restores the second run kind flue had: user-authored **workflows**.

- `convex/http.ts` — a Convex `httpRouter` with **three** route groups: agent submit/poll (`POST /agents/:name/:id`, `GET /runs/:runId`, `?wait=result`), the **restored** workflow submit (`POST /workflows/:name`, `?wait=result`), and nothing else (no streaming GET — D2, no SSE).
- The pluggable **`authorize(ctx, req)`** hook with **per-transport gating** (HTTP bearer parse vs. native `ctx.auth` identity), invoked at admission so the engine is never reached unauthenticated.
- The **`CoveHttpError` sub-layer** (M4): the 4xx vocabulary, `renderHttpError`/`toHttpResponse` emitting the canonical `CoveApiError` envelope, `configureErrorRendering({devMode})`, and `validateAgentRequest`/`validateWorkflowRequest`.
- The **restored Workflow concept** (D18): the runtime `defineWorkflow((ctx) => result) → WorkflowHandler`, the `convex/workflows/` execution path that runs a handler as a **workflow-kind** run, the `runs.kind: 'agent' | 'workflow'` discriminator, and the `POST /workflows/:name` route. (The `defineWorkflow` **registry/codegen** wiring lands in P8.5; this phase builds the runtime + HTTP execution path.)

**Out of scope (deferred):** the `defineWorkflow`/`defineAgentRegistry` build-time codegen + `cove` binary (P8.5); reactive subscription + native `createCoveClient` iterator + `@cove/react` (P9); channel adapters on top of this submit surface (P11). A concrete auth **provider** (Clerk/Convex Auth/bearer) is **not** wired — only the hook (D3).

## Dependencies

| Must land first | Why |
| --- | --- |
| **P6 — Harness/invoke** | `POST /agents/:name/:id` is a thin HTTP shell over `invoke.submitPrompt`; `?wait=result` polls the same `agentRequests` terminal status the facade awaits. The `authorize` hook gates the **same** `invoke.submit*` mutations P6 built (so native callers are gated too). |
| **P4 — Durable engine** | `POST /workflows/:name` starts a run via `workflow.start`; the `?wait=result` poll reads the terminal `runs`/`agentRequests` row `finalize` writes. A workflow handler that calls `ctx.prompt(...)` re-enters the agent loop. |
| **P5 — Session/run store** | `GET /runs/:runId` reads the `runs` table; the `runs.kind` discriminator + the run row are P5's schema (this phase **adds** the discriminator usage, the column itself is in `schema.ts`). |
| P1 (done) | `errors.ts` (`CoveError` base + `ResultUnavailableError`), the `CoveApiError`/`CoveHttpError` naming ([08 §1](../../design/08-conventions-and-execution-boundary.md#1-naming--namespace)), `CoveContext`/`CoveContextInternal` types. |

## Deliverables

| File / dir | Purpose |
| --- | --- |
| `convex/http.ts` | The `httpRouter`: `POST /agents/:name/:id` (+`?wait=result`), `GET /runs/:runId`, `POST /workflows/:name` (+`?wait=result`). Each route: `authorize` → validate → admit → (poll or 202). No streaming GET. |
| `convex/httpAuth.ts` | The `authorize(ctx, req)` invocation seam + the default **no-op-deny** wiring (ship the hook, no provider — D3). The same gate re-used from `invoke.submit*` for native callers. |
| `convex/workflows/runWorkflow.ts` | The workflow-kind execution path: resolve a `WorkflowHandler` by name, create a `runs` row with `kind:'workflow'`, run the handler (which may call `ctx.prompt`/`ctx.session`), record `{result|error}`, terminalize. |
| `convex/workflows/index.ts` | Barrel for the workflow runtime (the **registry/codegen** that populates the name→handler map is P8.5; here it reads an injected map). |
| `src/runtime/errors.ts` (extend) | Add the **HTTP sub-layer**: `CoveHttpError extends CoveError` + the 4xx subclasses + `renderHttpError`/`toHttpResponse` + `configureErrorRendering` + `validateAgentRequest`/`validateWorkflowRequest`. |
| `src/runtime/handle-agent.ts` | **Ported** `handleAgentRequest` + the `WorkflowHandler` type + `handleWorkflowRequest` — the transport-neutral request handlers `http.ts` calls. |
| `src/runtime/workflow-definition.ts` | `defineWorkflow((ctx) => result) → WorkflowHandler` — the authoring construct (Convex-app-bound, **not** the runtime barrel; mirrors `defineAgentRegistry`'s split). |
| `src/runtime/api-error.ts` | The `CoveApiError` wire envelope shape (`{ error: { code, message, details? } }`) shared by `renderHttpError` and the SDK (P9). |
| `convex/http.test.ts` | Malformed-call + auth + happy-path + workflow-run acceptance. |

> `http.ts`/`httpAuth.ts`/`workflows/*` are the Convex-server half; `errors.ts`/`handle-agent.ts`/`workflow-definition.ts`/`api-error.ts` are pure runtime. `defineWorkflow` is **Convex-app-bound** (exported from the app/CLI surface, not `@cove/runtime` — same rule as `defineAgentRegistry`, [08 §1](../../design/08-conventions-and-execution-boundary.md#1-naming--namespace)).

## Source map (flue/pi → cove)

| flue/pi file | target cove file | port / transform notes |
| --- | --- | --- |
| [`runtime/src/errors.ts`](../../../../flue/packages/runtime/src/errors.ts) (HTTP layer L210–1078) | `src/runtime/errors.ts` (extend) | Port `FlueHttpError`→`CoveHttpError`; the 4xx subclasses `MethodNotAllowedError`(405)/`UnsupportedMediaTypeError`(415)/`InvalidJsonError`(400)/`AgentNotFoundError`(404)/`WorkflowNotFoundError`(404)/`RouteNotFoundError`/`RunNotFoundError`/`InvalidRequestError`/`RunStoreUnavailableError`; `toHttpResponse`(L920)→ keep + alias `renderHttpError`; `configureErrorRendering`(L884); `validateAgentRequest`(L1066)/`validateWorkflowRequest`(L1045). **DROP** `StreamNotFoundError`(L349, SSE/D2) and `PersistedSchemaVersionError` ([08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)). |
| [`runtime/src/runtime/flue-app.ts`](../../../../flue/packages/runtime/src/runtime/flue-app.ts) | `convex/http.ts` | The **route table only**, re-expressed as `httpRouter` routes (not a Hono app). `POST /agents/:name/:id`(L262-area), `POST /workflows/:name`(L275/281). **DROP** the Hono app, `describeRoute`/`openAPIRouteHandler`/`GET /openapi.json` (m5, [08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)), and the DS stream routes. |
| [`runtime/src/runtime/handle-agent.ts`](../../../../flue/packages/runtime/src/runtime/handle-agent.ts) | `src/runtime/handle-agent.ts` | Port `handleAgentRequest`, `handleWorkflowRequest`, and `type WorkflowHandler = (ctx: CoveContextInternal) => unknown`(L30). Replace the in-process dispatch with a call into `invoke.submit*` / `workflows.runWorkflow`. |
| [`runtime/src/runtime/handle-stream-routes.ts`](../../../../flue/packages/runtime/src/runtime/handle-stream-routes.ts) | — (**dropped**) | DS/SSE long-poll streaming — dropped (D2, no SSE). Native clients use reactive queries (P9); HTTP gets `?wait=result` poll-to-terminal only. Record in [08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit). |
| [`runtime/src/routing.ts`](../../../../flue/packages/runtime/src/routing.ts) | `convex/http.ts` (inline) | The flue-router / `Fetchable` plumbing collapses into the `httpRouter` route declarations + `authorize`. No separate router abstraction. |
| [`runtime/src/internal.ts`](../../../../flue/packages/runtime/src/internal.ts) (L67/L84 `WorkflowHandler`/`handleWorkflowRequest`) | `src/runtime/workflow-definition.ts` + `convex/workflows/` | The workflow execution contract; in cove a `WorkflowHandler` runs as a **durable workflow-kind run**, not an in-process call. |
| `@flue/sdk` HTTP client | — (P9) | The consumer SDK's HTTP half is P9; this phase only builds the **server** routes it will call. `client.workflows.invoke` (the SDK verb) lands in P9 over these routes. |

## Hardened-contract obligations

- **[D2 — no SSE](../../design/07-risks-and-decisions.md).** `http.ts` exposes **submit + poll only**. `GET /runs/:runId` returns a point-in-time `RunRecord`, never a stream; `?wait=result` is poll-to-terminal (bounded, returns the terminal `PromptResponse`/workflow result). No `GET` streaming route exists.
- **[D3 — pluggable auth, none by default](../../design/07-risks-and-decisions.md).** Ship the `authorize(ctx, req)` hook; **do not** wire a provider. It runs at admission for **every** transport: HTTP parses the bearer/header off `req`; native `ConvexReactClient` callers are gated by `ctx.auth.getUserIdentity()` with `authorize` as the shared **authorization** (not authentication) seam. The engine ([04](../../design/04-durable-engine.md)) is never reached unauthenticated.
- **[08 §1 — naming](../../design/08-conventions-and-execution-boundary.md#1-naming--namespace).** `FlueHttpError`→`CoveHttpError`, `FlueApiError`→`CoveApiError`, `[flue]`→`[cove]`. The 4xx subclasses keep their non-branded names. `CoveApiError` is the **wire** envelope (`{error:{code,message,details?}}`).
- **M4 — canonical 4xx, never a raw 500.** A malformed call (bad method/content-type/JSON, unknown agent/workflow, bad path) is caught and rendered by `renderHttpError` into the `CoveApiError` envelope with the right status — never a Convex stack-trace 500. `configureErrorRendering({devMode})` controls whether `details` carries the stack.
- **[D18 — workflow restored, distinct run kind](../../design/07-risks-and-decisions.md).** A `POST /workflows/:name` run creates a `runs` row with **`kind:'workflow'`** (an agent prompt creates `kind:'agent'`). The two are not conflated; `GET /runs/:runId` and the SDK distinguish them. A `WorkflowHandler` is **Convex-app-bound** and durable (its `ctx.prompt` calls are nested agent runs).
- **[08 §3 — boundary](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy).** `httpAction`s admit + poll; they **do not** touch the box or run the loop inline. A workflow handler's body runs as a durable workflow step, not in the `httpAction`.

## Implementation tasks

- [ ] **1. Extend `src/runtime/errors.ts` with the HTTP sub-layer.** Port `CoveHttpError extends CoveError` (carries `status` + `code`) and the 4xx subclasses (drop `StreamNotFoundError`, `PersistedSchemaVersionError`). Header cites `errors.ts` HTTP layer. `tsc` green.
- [ ] **2. Add `src/runtime/api-error.ts`** — the `CoveApiError` envelope type + a `toApiError(err)` normalizer (maps any `CoveError`/`CoveHttpError`→`{code,message,details?}`, unknown→500 generic).
- [ ] **3. Port `renderHttpError`/`toHttpResponse` + `configureErrorRendering`** into `errors.ts` (or a sibling `http-render.ts`). `toHttpResponse(err)` → a `Response` with the right status + the `CoveApiError` JSON body; `devMode` toggles `details.stack`.
- [ ] **4. Port `validateAgentRequest`/`validateWorkflowRequest`** — method + content-type + non-empty path-segment + registered-name checks; each throws the matching `CoveHttpError` subclass.
- [ ] **5. Port `src/runtime/handle-agent.ts`** — `handleAgentRequest(req, deps)`: validate → `authorize` → `invoke.submitPrompt` → if `?wait=result` poll terminal then `toHttpResponse`/JSON, else 202 `{requestId}`. `handleWorkflowRequest(req, deps)`: validate → `authorize` → `workflows.runWorkflow` → same wait/202 logic. Define `WorkflowHandler`.
- [ ] **6. Add `src/runtime/workflow-definition.ts`** — `defineWorkflow((ctx)=>result): WorkflowHandler` with a brand marker (`__coveWorkflow`) for the P8.5 registry validation. Pure; Convex-app-bound (documented, not on the `@cove/runtime` barrel).
- [ ] **7. Build `convex/workflows/runWorkflow.ts`** — an action (or workflow) that: resolves the handler by name from the injected registry (P8.5 supplies it; here accept an injected map), inserts a `runs` row `kind:'workflow'` (status `running`), runs the handler with a `CoveContextInternal` whose `prompt`/`session` start **nested agent runs**, captures `{result}` or `{error}`, patches the `runs` row terminal. Replay-safe (handler side effects via nested durable runs, idempotent by `runId`).
- [ ] **8. Build `convex/http.ts`** — `httpRouter()` with `POST /agents/:name/:id`, `GET /runs/:runId`, `POST /workflows/:name`, each an `httpAction` delegating to `handleAgentRequest`/`handleWorkflowRequest` with the Convex deps (mutations/queries) injected. Wrap each in a `try/catch → toHttpResponse`.
- [ ] **9. Build `convex/httpAuth.ts`** — the `authorize` seam: a configurable hook (default returns a deny/anonymous per config), invoked by the handlers **and** re-used from `invoke.submit*` (patch P6's mutations to call the shared gate so native callers are gated too). No provider shipped.
- [ ] **10. Wire `runs.kind`** — ensure `submitPrompt` (P6) stamps `kind:'agent'` and `runWorkflow` stamps `kind:'workflow'`; `GET /runs/:runId` returns the kind in the `RunRecord`.
- [ ] **11. Tests** (`convex/http.test.ts`, `convex-test`, no live provider): malformed-call 4xx envelope; unauthorized→401; agent submit happy path (202 + poll→completed); workflow submit happy path (workflow-kind run, result returned); unknown agent→`AgentNotFoundError` 404; unknown workflow→`WorkflowNotFoundError` 404.
- [ ] **12. `tsc --noEmit` green;** export the HTTP sub-layer where flue exported it; confirm `defineWorkflow` is **not** on `src/runtime/index.ts` (app-bound), and update [08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)/PLAN if any drop wording needs a citation.

## Acceptance

Start from [06 P8's bar](../../design/06-phase-roadmap.md) plus M3/M4 additions:

1. **External submit + poll.** A `curl POST /agents/triage/inst-1` (with a valid bearer the test's `authorize` accepts) returns `{sessionId, requestId, submissionId}`; `POST …?wait=result` polls to terminal and returns a `PromptResponse` JSON. `GET /runs/:runId` returns a point-in-time `RunRecord` (never a stream).
2. **Auth gate uniform.** An unauthorized call (`authorize` throws) → **401** `CoveApiError` envelope, and the engine is never invoked; the **same** hook rejects a native `invoke.submitPrompt` lacking identity.
3. **Malformed → canonical 4xx (M4).** A bad method → 405 `MethodNotAllowedError`; bad content-type → 415; non-JSON body → 400 `InvalidJsonError`; unknown agent → 404 `AgentNotFoundError`; empty/!/`/workflows/` path → 400 `InvalidRequestError` — each a `CoveApiError` JSON body, **not** a raw Convex 500. `devMode:false` omits the stack.
4. **Restored workflow run (D18).** `POST /workflows/report-weekly?wait=result` runs the registered `WorkflowHandler`, which internally drives an agent prompt, and returns the handler's `result`; the run appears as `runs.kind='workflow'` (distinct from the agent run it spawned, which is `kind='agent'`).
5. **No SSE.** There is no streaming `GET` route; the router exposes exactly the submit/poll surface (D2).
6. **`tsc --noEmit` exits 0.**

## Risks & gotchas

- **`httpAction` cannot run the loop inline.** A `?wait=result` handler must **poll** the terminal status (a bounded loop of `runQuery` with backoff under the ~240 s action budget), not `await` the workflow. For long runs, return 202 + `requestId` and let the caller poll `GET /runs/:runId`; only short runs should use `?wait=result`.
- **Workflow handler durability.** A `WorkflowHandler` that calls `ctx.prompt` must spawn a **nested durable agent run** (like P6's `task`), not an in-process call — otherwise a crash mid-handler loses work. The handler's own orchestration should itself be a workflow step so it's replay-safe.
- **`authorize` must gate BOTH transports.** The classic leak is gating only the `httpAction` and forgetting the native `invoke.submit*` path. Route both through one shared `authorize` call so a native `ConvexReactClient` caller can't bypass it.
- **`runs.kind` conflation was the original M3 bug.** Do not key `runs` by `agentName` in a way that loses the agent-vs-workflow distinction; the discriminator must be explicit so the SDK (P9) and `GET /runs` render the right shape.
- **Drop the OpenAPI layer cleanly (m5).** flue's `flue-app.ts` wires `describeRoute`/`openAPIRouteHandler`/`GET /openapi.json`; do **not** port them. Per-route validation is the Convex `v.*` argument validators + `validateAgentRequest`/`validateWorkflowRequest`. Cite the drop in [08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit).
- **`devMode` default.** `configureErrorRendering` must default to **`devMode:false`** in deployed envs so stack traces never leak in the `CoveApiError.details`. Make it explicit at app init, not implicit.
- **CoveApiError is the contract shared with P9.** Lock the envelope shape now (`{error:{code,message,details?}}`); the native SDK + `@cove/react` (P9) parse it. Changing it later breaks the client.
