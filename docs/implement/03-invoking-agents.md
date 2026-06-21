# Invoking Agents

Once you have [defined an agent](02-defining-agents.md), you invoke it to run prompts. Cove gives you two consumer-facing transports over the same durable engine:

1. **The native Convex SDK** — `createCoveClient` over a Convex client, driving the `ctx.init(agent).session(name).prompt(text)` chain. Best when your code lives in (or talks directly to) the Convex deployment.
2. **The HTTP API** — `POST /agents/:name/:id` to submit, `GET /runs/:runId` to read state, with an optional `?wait=result` long-poll. Best for clients that can only speak HTTP.

Both land on the same `submitPrompt` mutation and the same `requests.get` snapshot. Neither streams — there is **no SSE anywhere**. Live updates come from a reactive Convex query (`useQuery(api.requests.get, ...)`) or from polling.

This page is the deep dive on both transports, the `CallHandle` return value, typed result schemas, querying run state, and the `authorize` hook. For the end-to-end "first run" walkthrough, see [Getting Started](01-getting-started.md).

---

## The native SDK

### Wiring the client

`createCoveClient(client, refs, opts?)` wraps any object satisfying `ConvexLike` into a `CoveClient`:

```ts
export interface ConvexLike {
  mutation(reference: any, args: Record<string, unknown>): Promise<any>;
  query(reference: any, args: Record<string, unknown>): Promise<any>;
}
```

Both `ConvexHttpClient` (from `convex/browser`) and `ConvexReactClient` satisfy this — it only needs `mutation` and `query`. The package is intentionally **decoupled from `convex/_generated`**, so you must supply the five deployed function references yourself via `CoveApiRefs`:

```ts
// src/sdk/index.ts
export interface CoveApiRefs {
  submitPrompt: unknown;   // admit a prompt
  stopActive: unknown;     // abort in-flight work on a session
  getRequest: unknown;     // read a request snapshot
  sessionExists: unknown;  // session existence check
  deleteSession: unknown;  // delete a session (cascades to task children)
}
```

All five fields are required. Pass them from your app's generated `api`:

```ts
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { createCoveClient } from "../src/sdk/index.ts";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

const cove = createCoveClient(client, {
  submitPrompt: api.invoke.submit.submitPrompt,
  stopActive: api.invoke.submit.stopActive,
  getRequest: api.requests.get,
  sessionExists: api.sessions.store.exists,
  deleteSession: api.sessions.store.remove,
});
```

The returned `CoveClient` has two members:

- **`.context(init)`** — builds a `CoveContext` for one invocation (the authoring entry point).
- **`.transport`** — the raw `CoveTransport` seam, if you want to drive `submitPrompt` / `awaitTerminal` / `stopActive` / `sessionExists` / `deleteSession` directly.

If you only need the transport (no context facade), call `createCoveTransport(client, refs, opts)` directly; `createCoveClient` is just `{ transport, context: (init) => createCoveContext(transport, init) }`.

### The authoring chain

The full chain is `client.context(init)` → `ctx.init(agent)` → `harness.session(name)` → `session.prompt(text)`:

```ts
import { helloAgent } from "../convex/agents.ts";

// Only `id` is required. payload defaults to undefined, env to {}, log to a no-op.
const ctx = cove.context({ id: "instance-42" });

// Calls agent.initialize({ id, env, payload }), resolves the profile, and derives
// the harness defaultModel from profile.model. options?.name sets the harness name.
const harness = await ctx.init(helloAgent);            // or: ctx.init(helloAgent, { name: "primary" })

// Validates the session name; defaults to "default". Does NOT verify existence.
const session = await harness.session();               // or: harness.session("chat")

const { text, usage, model } = await session.prompt("Say hello.");
```

`CoveContextInit` is `{ id, payload?, env?, req?, log? }`. The `id` becomes the agent instance id (it is also what the initializer receives as `context.id`), `env` is passed to the initializer as platform bindings, and `payload` is available to it too. If `log` is omitted, a no-op logger (`info`/`warn`/`error` all no-ops) is used.

`ctx.init(agent, options?)` runs the agent's `initialize` callback **every time** (it is not a one-time constructor), resolves the profile, and sets the harness `defaultModel` to `profile.model` when that is a string. `options?.name` sets the harness name (default `"default"`).

### Sessions: continuity and existence

`harness.session(name = "default")` validates the name and returns a session, but does **not** check whether it already exists. Multi-turn continuity is implicit: reuse the same `(instanceId, harnessName, sessionName)` tuple and a later prompt reattaches to the same conversation tree. A different `sessionName` starts a fresh tree. (See [Sessions & Compaction](05-sessions-and-compaction.md) for the full model.)

If you need explicit existence semantics, use the `harness.sessions` sub-API instead:

```ts
const s1 = await harness.sessions.get("chat");    // throws SessionNotFoundError if missing
const s2 = await harness.sessions.create("chat"); // throws SessionAlreadyExistsError if present
await harness.sessions.delete("chat");            // calls transport.deleteSession (no-op if absent)
```

You can also delete from a session handle directly: `await session.delete()`.

> Session names beginning with `task:` are reserved for delegated subagent tasks — `assertPublicSessionName` rejects them. Pick another name.

### `session.prompt`

`prompt` is the core (and, in this cut, the **only fully wired**) call:

```ts
prompt<S extends v.GenericSchema>(
  text: string,
  options?: PromptOptions<S> & { result?: S },
): CallHandle<PromptResponse | PromptResultResponse<v.InferOutput<S>>>
```

**Model resolution** is `options?.model ?? harness defaultModel`. If neither is set, the call throws `ModelNotConfiguredError`. The harness `defaultModel` is only populated when the agent's `profile.model` is a string — if your agent sets `model: false`, every prompt must pass `options.model`.

A plain prompt (no `result` schema) resolves to a `PromptResponse`:

```ts
type PromptResponse = {
  text: string;        // snapshot.finalText ?? ""
  usage: PromptUsage;  // tokens + cost (ZERO_USAGE if the run reported none)
  model: PromptModel;  // parsed from the model string, see below
};
```

`PromptModel` is parsed by splitting the model string on the **first** `/`:

- `"anthropic/claude-x"` → `{ provider: "anthropic", id: "claude-x" }`
- a string with no `/` → `{ provider: "", id: model }`

`PromptUsage` is `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`. When the snapshot carries no usage, the facade returns `ZERO_USAGE` (all zeros).

### Typed results with `options.result`

Pass a valibot schema as `options.result` to get back validated, typed data instead of raw text:

```ts
import * as v from "valibot";

const { data, usage, model } = await session.prompt("Extract the user's name and age.", {
  model: "anthropic/claude-haiku-4-5",
  result: v.object({ name: v.string(), age: v.number() }),
});
// data: { name: string; age: number }
```

This resolves to a `PromptResultResponse<T>`:

```ts
type PromptResultResponse<T> = {
  data: T;             // the re-validated typed output
  usage: PromptUsage;
  model: PromptModel;
};
```

**The re-validation contract is the key thing to understand.** A valibot schema cannot cross the workflow journal, so under the hood the facade:

1. Converts your schema to JSON Schema via `stripJsonSchemaMeta(toJsonSchema(schema, { errorMode: "ignore" }))` and sends it as `resultSchema` to the server (which captures a structurally-valid value).
2. After the run completes, **re-validates** the captured value locally with `v.safeParse(schema, snapshot.result)` before resolving.

So you either receive validated `data`, or a thrown error — **never unvalidated data**. A re-validation mismatch throws `ResultUnavailableError` with reason `result failed schema re-validation: <issue messages>`.

> The reserved `cove-test/mock` model returns fixed canned text, so a strict result schema will fail re-validation against it. Use a real model (via `AI_GATEWAY_API_KEY` or a provider key) when exercising result schemas.

### Failure mapping

`prompt()` rejects (rather than resolving) on non-completion. The mapping is specific:

- **Cancelled, your signal aborted** → throws an `AbortError` (`DOMException` carrying your `signal.reason` as `cause`).
- **Cancelled otherwise** → throws `OperationFailedError("[cove] run cancelled (<cancelReason>).")`.
- **Failed with `result_followups_exhausted`** (in `error` or `cancelReason`) → throws `ResultUnavailableError({ reason: "result_followups_exhausted" })`.
- **Failed, with a result schema** → throws `ResultUnavailableError({ reason: snapshot.error ?? "gave_up", assistantText: snapshot.finalText })`.
- **Failed, no result schema** → throws `OperationFailedError("[cove] run failed: <error>")`.

---

## `CallHandle`: awaiting and cancelling

`prompt()` (and the other session/harness call surfaces) returns a `CallHandle<T>` rather than a bare `Promise`. A `CallHandle` is a **thenable** — you `await` it (or chain `.then` / `.catch` / `.finally`) like a promise — that *also* carries:

- **`.signal`** — an `AbortSignal` you can pass elsewhere.
- **`.abort(reason?)`** — cancel the in-flight call.

```ts
const handle = session.prompt("Do something long-running…", {
  model: "anthropic/claude-haiku-4-5",
});

// Cancel after 5 seconds.
const timer = setTimeout(() => handle.abort("took too long"), 5000);

try {
  const { text } = await handle;     // resolves on terminal status
  clearTimeout(timer);
  console.log(text);
} catch (err) {
  // On abort during the run, the facade fires transport.stopActive(ref) to
  // cancel the server-side work, then rethrows the AbortError here.
}
```

Two behaviors worth knowing:

- **Self-swallowing rejections.** A `CallHandle` pre-attaches an internal `promise.catch(() => {})`, so a fire-and-forget (un-awaited) handle will **not** crash the process as an unhandled rejection. The flip side: you must `await` or `.catch()` it to actually observe an error.
- **It is not a real `Promise`.** Its `Symbol.toStringTag` is `"Promise"` for interop, but it is a thenable. This is fine for `await` and `Promise.all([...])`.

> `createCallHandle` and the related abort helpers (`abortErrorFor`, `composeTimeoutSignal`) live in `src/runtime/abort.ts` and are internal — you consume `CallHandle` via `prompt()`, you do not construct it.

### What's wired vs. deferred (SDK)

Only `prompt()` is implemented in this cut. The following reject with a `CoveError` whose code is `'not_implemented'`:

- `session.skill(...)` (P10), `session.task(...)` (P6), `session.shell(...)` (P6), `session.fs` (P6), `session.compact()` (P12)
- `harness.shell(...)` (P6), `harness.fs` (P6)

These are documented gaps, not working features — see [Subagents & Workflows](06-subagents-and-workflows.md), [Tools, Skills & HITL](04-tools-skills-hitl.md), and [Sessions & Compaction](05-sessions-and-compaction.md) for where each lands.

### Polling, not streaming

The native transport (`createCoveTransport`) submits via the `submitPrompt` mutation, then **busy-polls** `client.query(refs.getRequest, { requestId })` until the status is terminal (`completed` / `failed` / `cancelled`). Tuning lives in `CreateCoveTransportOptions`, the third arg to `createCoveClient` / `createCoveTransport`:

```ts
const cove = createCoveClient(client, refs, {
  pollIntervalMs: 400,      // default 400ms
  pollDeadlineMs: 600_000,  // default 600,000ms (10 min)
});
```

Hitting the deadline does **not** throw — `awaitTerminal` returns the last snapshot it saw, or `{ status: "failed", error: "poll deadline exceeded" }` if it never got one. (For a reactive UI, prefer subscribing to `useQuery(api.requests.get, { requestId })` with a `ConvexReactClient` instead of long-polling.)

> The transport's `submitPrompt` forwards only `prompt`, `model`, `instanceId`, `harnessName`, `sessionName`, and `resultSchema` to the mutation — other `PromptSubmission` fields are dropped. It also ignores the `AbortSignal` argument declared by the `CoveTransport` interface (cancellation is handled in `awaitTerminal` and via `stopActive`).

---

## The HTTP API

The HTTP surface is a Convex `httpRouter` (`convex/http.ts`) served from your deployment's `CONVEX_SITE_URL` (e.g. `https://<deployment>.convex.site`). There is **no streaming** — `GET /runs/:runId` is a point-in-time snapshot, and `?wait=result` is a server-side long-poll.

Set a base URL for the examples below:

```bash
export COVE="https://<your-deployment>.convex.site"
```

### Submit a prompt — `POST /agents/:name/:id`

The `:id` path segment becomes the `instanceId`. The body must be JSON (`Content-Type: application/json`, else `415`), and accepts either `message` or `prompt` for the text:

```bash
curl -s -X POST "$COVE/agents/hello/instance-42" \
  -H "Content-Type: application/json" \
  -d '{"message":"Say hello.","model":"anthropic/claude-haiku-4-5","sessionName":"chat"}'
```

Body fields (validated by `validateAgentRequest`):

| Field | Aliases | Notes |
| --- | --- | --- |
| `message` | `prompt` | Required, non-empty string. |
| `model` | — | Optional `'provider-id/model-id'`. **Omitting it defaults to `cove-test/mock`**, not a real provider. |
| `sessionName` | — | Optional; defaults to `"default"`. |
| `result` | `resultSchema` | Optional JSON Schema for a result-shaped run. |

A submit returns the admit envelope (note: the `workflowId` from the underlying `AdmitResult` is intentionally omitted over HTTP):

```json
{
  "sessionId": "...",
  "requestId": "...",
  "submissionId": "..."
}
```

Use the returned `requestId` to read the run's state.

> `submitPrompt` **always supersedes** any in-flight request on the same `(instanceId, harnessName, sessionName)` session (cancelling it with `cancelReason: "superseded"`). The HTTP route does not let you set `harnessName`, so it always targets the default harness. For a non-superseding dev driver, use `dev:startPrompt` (below).

### Wait for the result — `?wait=result`

Add `?wait=result` to block until the run reaches a terminal state. The response merges the admit envelope **and** the request snapshot:

```bash
curl -s -X POST "$COVE/agents/hello/instance-42?wait=result" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Say hello."}'
```

```json
{
  "sessionId": "...",
  "requestId": "...",
  "submissionId": "...",
  "status": "completed",
  "finalText": "cove mock response",
  "result": null,
  "usage": { "...": "..." },
  "totalTokens": 9,
  "totalSteps": 1,
  "totalToolCalls": 0,
  "durationMs": 12
}
```

The long-poll uses a **400ms interval and a 60s deadline** (note: shorter than the SDK's 10-minute default). If the run is not terminal by then, it returns the latest **non-terminal** snapshot rather than erroring — so always check `status`.

### Read run state — `GET /runs/:runId`

`GET /runs/:runId` returns a point-in-time snapshot (the same fields as the `requests.get` query). Use the `requestId` you got back from the submit:

```bash
curl -s "$COVE/runs/<requestId>"
```

```json
{
  "submissionId": "...",
  "status": "running",
  "finalText": null,
  "result": null,
  "error": null,
  "cancelReason": null,
  "usage": { "...": "..." },
  "totalTokens": 0,
  "totalSteps": 0,
  "totalToolCalls": 0,
  "durationMs": null
}
```

Terminal statuses are `"completed"`, `"failed"`, and `"cancelled"`; non-terminal are `"pending"` and `"running"`. A missing or malformed run id returns `404` with code `run_not_found`. There is no streaming endpoint — to follow a long run over HTTP, either re-`GET /runs/:runId` on an interval or submit with `?wait=result`.

### Error envelope

Every HTTP error is rendered through `renderHttpError` onto the `CoveApiError` envelope:

```json
{ "error": { "code": "invalid_request", "message": "...", "status": 400 } }
```

The wire codes/statuses a client may see:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed body / missing `:id` / empty `message`. |
| 400 | `invalid_json` | Body is not valid JSON. |
| 401 | `unauthorized` | The `authorize` hook threw. |
| 404 | `run_not_found` | Unknown / invalid run id. |
| 404 | `workflow_not_found` | `POST /workflows/:name` — see below. |
| 415 | `unsupported_media_type` | Missing `application/json` content type. |
| 500 | `internal_error` | Anything else (message redacted by default). |

`500` details are redacted by default (message is just `"[cove] internal server error."`); only `CoveHttpError` subclasses surface their real code/message/status. Call `configureErrorRendering({ devMode: true })` to expose `500` details in development.

Two `CoveHttpError` subclasses exist but are **not yet wired** into the live HTTP surface, so a client cannot receive them from these routes in this cut:

| Status | Code | State |
| --- | --- | --- |
| 404 | `agent_not_found` | Reserved. The `:name` segment in `POST /agents/:name/:id` is only checked for non-emptiness (`if (!segs[1] || !id)`); it is not validated against any registry, so `AgentNotFoundError` is never thrown. |
| 405 | `method_not_allowed` | Reserved. Routes are registered per-method via `http.route({ method })`; a wrong method is handled by the Convex `httpRouter`'s own default response and does **not** flow through `renderHttpError` or produce the `CoveApiError` envelope. `MethodNotAllowedError` is never thrown. |

To control status/code from your own code (e.g. inside an `authorize` hook), throw a `CoveHttpError` subclass such as `UnauthorizedError`.

### `POST /workflows/:name` is a stub

The workflow route exists and returns the proper envelope, but **always returns `404 workflow_not_found`** until the `defineWorkflow` registry + codegen land (P8.5). Do not rely on it yet. See [Subagents & Workflows](06-subagents-and-workflows.md).

---

## Querying run state from native callers

If you are inside Convex (or using a Convex client directly rather than the SDK facade), the public query is `api.requests.get`:

```ts
// Reactive — re-renders as the run progresses (ConvexReactClient).
const snap = useQuery(api.requests.get, { requestId });
// snap?.status, snap?.finalText, snap?.result, snap?.usage, ...
```

`requests.get` returns `null` if the request is not found; otherwise the snapshot: `{ submissionId, status, finalText, result, error, cancelReason, usage, totalTokens, totalSteps, totalToolCalls, durationMs }`. This reactive query is the recommended "live updates" path (there is no SSE).

To abort in-flight work on a session natively, call the `stopActive` mutation (`api.invoke.submit.stopActive`) with the session tuple; each id defaults to `"default"`, and it returns `{ cancelled: <n> }` (0 if the session is not found).

### The dev driver — `dev:startPrompt`

For local exercising via the CLI there is `api.dev.startPrompt` (`convex/dev.ts`). Unlike `submitPrompt`, it runs with `supersede: false` (it does **not** cancel in-flight work), defaults `instanceId` to `"dev"` and `harnessName` to `"default"`, and is the easiest way to drive a free, deterministic run with the reserved mock model:

```bash
# Submit (model defaults to cove-test/mock — free, no credentials).
node node_modules/convex/bin/main.js run dev:startPrompt '{"prompt":"hello"}'

# Read state (richer than requests.get — includes per-step detail).
node node_modules/convex/bin/main.js run dev:getRequest '{"requestId":"<requestId>"}'
```

`dev:getRequest` returns `{ status, finalText, result, error, cancelReason, totalTokens, totalSteps, steps: [...] }` — handy when debugging step-by-step behavior. See [Deployment & Operations](08-deployment-and-operations.md) for the full CLI / deploy story.

---

## The `authorize` hook

The HTTP surface ships **no default auth provider**. With no hook installed, `/agents` and `/runs` are **open** (unauthenticated). To gate them, install an `authorize` hook at module scope via `configureAuthorize`:

```ts
// convex/<your-app-entry>.ts
import { configureAuthorize } from "./auth.ts";
import { UnauthorizedError } from "../src/runtime/http.ts";

configureAuthorize(async (ctx, req) => {
  const token = req.headers.get("authorization");
  if (!token || !(await isValid(ctx, token))) {
    throw new UnauthorizedError(); // -> 401 { error: { code: "unauthorized", ... } }
  }
  return { userId: extractUserId(token) }; // return any identity value
});
```

The hook type is:

```ts
type AuthorizeHook = (ctx: ActionCtx, req: Request) => unknown | Promise<unknown>;
```

It runs (via `runAuthorize`) at admission on **every** `/agents` and `/runs` route, **before** the body is validated. Return any value to allow (it becomes the identity), or **throw to deny** — throwing `UnauthorizedError` yields a `401`. Any other thrown error is rendered through `renderHttpError` (a non-`CoveHttpError` becomes a redacted `500`).

Two operational caveats:

- **Module-scoped, last-write-wins.** The hook is stored in module state, so it is **not persisted across cold boots**. Your generated app entry must re-call `configureAuthorize` on each boot.
- **The Slack channel route does not run `authorize`.** `POST /channels/slack` has its own signature-based verification (`SLACK_SIGNING_SECRET`); see [Channels](07-channels.md). Channel **outbound** (posting results back) is not yet implemented.

---

## Where to go next

- [Defining Agents](02-defining-agents.md) — the agents you invoke here.
- [Tools, Skills & Human-in-the-Loop](04-tools-skills-hitl.md) — gating runs with approvals.
- [Sessions & Compaction](05-sessions-and-compaction.md) — the `(instanceId, harnessName, sessionName)` key and multi-turn continuity.
- [Subagents & Workflows](06-subagents-and-workflows.md) — delegation and the `/workflows` route (deferred).
- [Channels (Slack & beyond)](07-channels.md) — the inbound webhook transport.
- [Deployment & Operations](08-deployment-and-operations.md) — env layout, CLI, and the mock model.
