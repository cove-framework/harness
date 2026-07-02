# Phase G4.5 — Ingress — API Gateway REST + closed-by-default auth

> Group 4 (Convex → AWS migration). This phase replaces the Convex `httpRouter` + `httpAction` submit/poll
> surface ([`convex/http.ts`](../../../convex/http.ts)) with an **API Gateway REST API + Lambda proxy
> integration** and inverts the open-by-default auth gap into a **CLOSED-by-default REQUEST Lambda
> authorizer**. The submit path is the **only** caller of `StartExecution` on the `AgentLoop` state machine.

## Goal & scope

Stand up the public, non-native HTTP ingress for the AWS backend: the three application routes
(`POST /agents/{name}/{id}`, `GET /runs/{runId}`, `POST /workflows/{name}`), the `?wait=result` poll shim,
the `CoveHttpError` → wire-envelope mapping, request validation, throttling/CORS, and a closed-by-default
authorizer that runs the user's `authorize()` shape. Concretely this phase owns:

- **The REST API + Lambda proxy routes.** An `aws_apigateway.RestApi` (or `aws_apigatewayv2` HTTP API —
  see D-note below) with three resource trees bound to thin handler Lambdas: `admit`, `poll`,
  `submitWorkflow`. Each handler is the AWS adapter over the **portable** `src/runtime/http.ts` validation +
  error-render layer.
- **`admit` = the StartExecution call-site.** `admit` does the `TransactWriteItems` admission write
  (supersede-cancel + insert `agentRequests` + append the `u-<requestId>` user entry) then
  `StartExecution(name=submissionId)` on `AgentLoop`, replacing
  [`admit.ts:110-142`](../../../convex/invoke/admit.ts)'s `workflow.start`. The state-machine **contract**
  (`name=submissionId`, `executionArn` stamped on the Requests item) is defined in
  [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md); this phase owns the **call-site**.
- **The CLOSED-by-default authorizer.** A REQUEST-type Lambda authorizer that runs the pluggable
  `authorize()` hook and returns an IAM **Allow/Deny** policy. [`convex/auth.ts`](../../../convex/auth.ts)
  returned `undefined` (OPEN) when no provider was installed; the locked decision (D-AWS-6) **inverts this to
  DENY** when no authorizer policy is configured.
- **The `?wait=result` poll, bounded to <29 s.** The Convex 60 s synchronous poll
  ([`http.ts:30-53`](../../../convex/http.ts)) **exceeds API Gateway's hard 29 s integration timeout**; this
  phase ships the bounded poll for HTTP wire-contract parity and points reactive callers at the WS
  terminal-frame ([G4.6](phase-g4.6-reactive-websocket-streaming.md)) (D-AWS-13).
- **The CDK `ingress-stack.ts`** wiring routes → handlers → authorizer, request validation, throttling,
  CORS, and the `4xx`/`401`/`403` Gateway Responses.

**Out of scope (owned elsewhere, cross-linked):**

- The `AgentLoop` state machine, the `StartExecution`/`StopExecution` *contracts*, and
  `requestStore.cancelActiveRequests` (the supersede helper `admit` calls) →
  [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md).
- HITL `submitApproval` (the `SendTaskSuccess` resolve path) and its two-sided early-submit guard. Although
  the spine places the `submitApproval` Lambda physically under `handlers/hitl/` and it sits behind this
  REST API, its body, idempotency, and token semantics are **owned by**
  [G4.4](phase-g4.4-hitl-task-tokens.md). This phase only mounts the route + authorizer in front of it.
- `POST /channels/{name}` inbound webhooks (verify → dedup → submit → ack) and the outbound Reply Task →
  [G4.7](phase-g4.7-channels-workflows-scheduler.md). This phase only declares the route exists and that the
  authorizer enforces the **framework gate only** (the HMAC/Ed25519 verify stays inside the channels Lambda).
- The reactive WebSocket API, Connections/Subscriptions tables, and Streams fan-out →
  [G4.6](phase-g4.6-reactive-websocket-streaming.md).
- The DynamoDB tables, GSIs, S3 bucket, and the `store/` adapter seam (`requestStore`, `sessionStore`) →
  [G4.1](phase-g4.1-foundation-cdk-dynamodb.md).

## Dependencies

- **[G4.1](phase-g4.1-foundation-cdk-dynamodb.md)** — the `Requests` table (+ GSI2 `by_session_and_status`
  for supersede, GSI3 `by_submission`), the `Sessions` table (session open + `u-<requestId>` user-entry
  append), and the `store/` adapter seam (`requestStore.ts`, `sessionStore.ts`) MUST exist; `admit` writes
  through them. The `cdk` app + stub `ingress-stack.ts` (G4.1 deliverable 3) is the shell this phase fills.
- **[G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)** — the `AgentLoop` state-machine **ARN**
  (exported as a CFN output + SSM parameter by G4.3) MUST be resolvable; `admit` calls
  `StartExecution(name=submissionId)` against it. The `StopExecution`/`cancelActiveRequests` helper that the
  supersede path invokes is also owned there.
- **[G4.4](phase-g4.4-hitl-task-tokens.md)** — the `submitApproval` handler this phase mounts a route for.
- This phase **branches off** G4.1/G4.3 in parallel with [G4.6](phase-g4.6-reactive-websocket-streaming.md);
  it does not block G4.4/G4.7.

## Deliverables

In `backend/`:

- `backend/cdk/stacks/ingress-stack.ts` — the `aws_apigateway.RestApi` (REST, regional endpoint), its three
  resource trees + methods (Lambda proxy integration), the REQUEST authorizer attachment, a `RequestValidator`,
  per-stage throttling (`throttlingRateLimit`/`throttlingBurstLimit`), CORS, and the `401`/`403`/`4xx`/`5xx`
  `GatewayResponse` mappings. Grants the `admit` Lambda `states:StartExecution` on the `AgentLoop` ARN.
- `backend/handlers/ingress/admit.ts` — the `POST /agents/{name}/{id}` (+`?wait=result`) handler.
- `backend/handlers/ingress/poll.ts` — the `GET /runs/{runId}` handler + the bounded `?wait=result` poll loop
  (also imported by `admit`).
- `backend/handlers/ingress/submitWorkflow.ts` — the `POST /workflows/{name}` handler.
- `backend/handlers/ingress/authorizer.ts` — the REQUEST Lambda authorizer (closed-by-default policy builder).
- `backend/handlers/ingress/apiError.ts` — a tiny shim that turns `renderHttpError`'s `{status, body}` into the
  API Gateway Lambda-proxy result shape `{statusCode, headers, body}` (the only new adapter glue; the error
  hierarchy + validation stay portable in `src/runtime/http.ts`).
- (consumed, owned by G4.3) `requestStore.setExecutionArn`, `requestStore.cancelActiveRequests` — `admit` calls
  these; the supersede/StartExecution wiring is exercised by this phase's acceptance tests.

> **D-note (REST vs HTTP API).** The spine names "API Gateway REST + Lambda authorizer" (ingress-stack.ts
> comment) and D-AWS-6 specifies a **REQUEST** Lambda authorizer with a configurable identity-source and
> caching TTL. REST API is the default here because (a) it supports `RequestValidator` for body/required-param
> validation at the edge, (b) per-method throttling and per-method authorizer attachment, and (c) per-status
> `GatewayResponse` mapping for the `401`/`403` envelopes. Both REST and HTTP APIs share the **29 s hard
> integration timeout** that bounds `?wait=result`. If the HTTP API is chosen later, the authorizer becomes a
> v2 `HttpLambdaAuthorizer` with `responseTypes: [SIMPLE]`; the handler bodies are unchanged.

## Source map

The convex/* files this phase replaces → the new AWS files it creates.

| Convex surface (replaced) | New AWS artifact (this phase) |
| --- | --- |
| [`convex/http.ts:33,55-102`](../../../convex/http.ts) — `httpRouter` + `POST /agents/` `httpAction` | `RestApi` resource `POST /agents/{name}/{id}` → `backend/handlers/ingress/admit.ts` (Lambda proxy) |
| [`http.ts:30-53,83-90`](../../../convex/http.ts) — `pollTerminal` 60 s synchronous poll (`POLL_DEADLINE_MS = 60_000`) | bounded **<29 s** poll loop in `poll.ts`/`admit.ts` (`POLL_DEADLINE_MS = 27_000`); reactive callers → WS terminal frame ([G4.6](phase-g4.6-reactive-websocket-streaming.md)) |
| [`http.ts:104-126`](../../../convex/http.ts) — `GET /runs/` `httpAction` → `api.requests.get` | `GET /runs/{runId}` → `backend/handlers/ingress/poll.ts` → `requestStore` GetItem on `Requests` (`PK=REQ#<runId>, SK=META`) |
| [`http.ts:132-159`](../../../convex/http.ts) — `POST /workflows/` `httpAction` (`getRegisteredWorkflow` 404 + `submitWorkflow`) | `POST /workflows/{name}` → `backend/handlers/ingress/submitWorkflow.ts` (bundled `workflowRegistry`) |
| [`http.ts:73,112,139`](../../../convex/http.ts) + [`convex/auth.ts`](../../../convex/auth.ts) — `runAuthorize` open-by-default hook | `backend/handlers/ingress/authorizer.ts` REQUEST Lambda authorizer, **CLOSED by default** (no policy ⇒ Deny) |
| [`convex/invoke/submit.ts:18-46`](../../../convex/invoke/submit.ts) `submitPrompt` + [`admit.ts:110-142`](../../../convex/invoke/admit.ts) `admitPrompt` | `admit.ts`: `TransactWriteItems` (supersede + insert `agentRequests` + `u-<requestId>` entry) then `StartExecution` |
| [`admit.ts:60-84`](../../../convex/invoke/admit.ts) `cancelActiveRequests` (`workflow.cancel` + status patch) | `requestStore.cancelActiveRequests` (owned [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)); `admit` calls it in the supersede branch |
| [`admit.ts:138-139`](../../../convex/invoke/admit.ts) `workflow.start` → `convexWorkflowId` patch | `StartExecution(name=submissionId)` → `requestStore.setExecutionArn(requestId, executionArn)` |
| [`convex/invoke/submit.ts:49-64`](../../../convex/invoke/submit.ts) `submitWorkflow` + [`admit.ts:225-252`](../../../convex/invoke/admit.ts) `admitWorkflow` | `submitWorkflow.ts`: resolve name in bundled registry (404 on unknown) → admit `kind:"workflow"` → `StartExecution {kind:'workflow', target:name}` |
| [`convex/requests.ts:8-27`](../../../convex/requests.ts) `requests.get` reactive query | `requestStore` GetItem returning the same projection (`status, finalText, result, error, cancelReason, usage, totalTokens, totalSteps, totalToolCalls, durationMs`) |
| [`src/runtime/http.ts`](../../../src/runtime/http.ts) — `CoveHttpError`/`renderHttpError`/`validateAgentRequest` | **moved verbatim** to `backend/engine` (portable); run **inside** the handler Lambda + `apiError.ts` proxy-shim |
| [`convex/workflowRegistry.ts:63`](../../../convex/workflowRegistry.ts) `getRegisteredWorkflow` | bundled into `submitWorkflow.ts` (no `_cove/workflowResolver` side-effect import; registry resolves in-process) |

`POST /channels/{name}` ([`http.ts:165-179`](../../../convex/http.ts)) is **declared** by this stack but its
handler + verify pipeline are owned by [G4.7](phase-g4.7-channels-workflows-scheduler.md). `submitApproval`
behind the REST API is owned by [G4.4](phase-g4.4-hitl-task-tokens.md).

## Hardened-contract obligations

Every contract below comes from the THESIS, the spine (`ingressAuthDesign`, D-AWS-6/13/14), and design docs
[05 §Auth](../../design/05-public-api-and-sdk.md) / [08](../../design/08-conventions-and-execution-boundary.md).
The ingress MUST preserve each.

1. **The orchestrator owns the loop; `admit` only kicks it (THESIS).** `admit` does the admission write +
   exactly one `StartExecution`; it **never** runs a loop step, never touches the sandbox, never calls the AI SDK.
   The handler Lambdas are V8-safe pure adapters — they only do DynamoDB I/O + the SFN start (mirroring
   [`http.ts:8`](../../../convex/http.ts) "No use node": `httpActions` only call mutations/queries).
2. **Replay-reconstructable invariant (THESIS).** Everything `admit` writes is the *frozen input* the loop
   replays from — the `agentRequests` row (model, target/agent, `resultSchema`, `approvalTools`, `mcpServers`,
   `replyContext`) and the deterministic `u-<requestId>` user entry
   ([`admit.ts:135-136`](../../../convex/invoke/admit.ts)). Nothing the loop later consumes is re-derived from
   live mutable state; `admit` writes it once. The `setup` Lambda freezes the runPlan from these
   ([G4.2](phase-g4.2-compute-lambda-actions.md)).
3. **Closed-by-default auth (D-AWS-6, the deliberate security improvement).**
   [`auth.ts:19-22`](../../../convex/auth.ts) returns `undefined` (open) when no hook is installed; the
   authorizer **inverts** this — **no configured policy ⇒ Deny**. A user-supplied `authorize()` returns an
   identity (→ Allow + context) or throws → Deny. The `UnauthorizedError(401)`
   ([`src/runtime/http.ts:38-42`](../../../src/runtime/http.ts)) maps to an authorizer Deny / explicit `401`
   Gateway Response. **This is a cutover behavior change** (every previously-open caller `403`s until a policy
   is configured) and MUST be on the cutover checklist ([G4.8](phase-g4.8-tests-parity-cutover.md)).
4. **`CoveHttpError` → `CoveApiError` envelope parity.** `renderHttpError`
   ([`src/runtime/http.ts:71-77`](../../../src/runtime/http.ts)) stays portable and runs **inside** each
   handler; `apiError.ts` only re-shapes `{status, body}` → `{statusCode, headers, body}`. The wire codes
   (`unsupported_media_type` 415, `invalid_json` 400, `invalid_request` 400, `unauthorized` 401,
   `workflow_not_found` 404, `run_not_found` 404, `internal_error` 500) and the `{error:{code,message,status}}`
   shape ([`http.ts:60-62`](../../../src/runtime/http.ts)) are unchanged. `configureErrorRendering({devMode})`
   ([`http.ts:64-68`](../../../src/runtime/http.ts)) still redacts 500 detail by default.
5. **Body validation parity.** `validateAgentRequest`
   ([`src/runtime/http.ts:87-100`](../../../src/runtime/http.ts)) runs inside `admit` — accepts `message`
   **or** `prompt`, requires a non-empty string, and normalizes `model`/`sessionName`/`result|resultSchema`.
   The edge `RequestValidator` is a coarse guard (Content-Type, body present); the *authoritative* validation
   stays the portable function so error codes match exactly.
6. **Supersede-cancel is atomic-by-DynamoDB, StartExecution is best-effort (D-AWS-14).** The supersede in
   `admit` ([`admit.ts:113`](../../../convex/invoke/admit.ts) → `cancelActiveRequests`) makes the **DynamoDB
   conditional `status=cancelled` UpdateItem authoritative** (`ConditionExpression status IN (pending,running)`)
   and the `StopExecution` of the prior execution best-effort (swallow `ExecutionDoesNotExist`/already-terminal,
   mirroring [`admit.ts:73-77`](../../../convex/invoke/admit.ts)'s try/catch). The new admission write +
   `StartExecution` are likewise two services: the `TransactWriteItems` is authoritative; `name=submissionId`
   makes a re-`StartExecution` an idempotent no-op (D-AWS-7, contract owned by G4.3).
7. **`name=submissionId` execution identity.** `admit` generates `submissionId` (was
   [`admit.ts:116`](../../../convex/invoke/admit.ts) `crypto.randomUUID()`) and passes it as the
   `StartExecution` `name`, so a retried `admit` (at-least-once API GW → Lambda) yields **one** execution; the
   returned `executionArn` is stamped on the Requests item via `requestStore.setExecutionArn` (was
   `convexWorkflowId`, [`admit.ts:139`](../../../convex/invoke/admit.ts)).
8. **`?wait=result` is bounded to <29 s, never 60 s (D-AWS-13).** API Gateway's hard 29 s integration timeout
   makes [`http.ts:31`](../../../convex/http.ts)'s `POLL_DEADLINE_MS = 60_000` un-portable. Bound the poll to
   ~27 s; if the run hasn't terminalized, return the latest non-terminal snapshot (HTTP-contract parity — the
   caller re-polls `GET /runs/{runId}`), and steer reactive SDK callers to the WS terminal frame
   ([G4.6](phase-g4.6-reactive-websocket-streaming.md)).
9. **Channel webhooks bypass the authorizer's body, not the framework gate.** A Lambda authorizer **cannot
   see the raw body** but every channel adapter HMAC/Ed25519-verifies the exact raw bytes
   ([`channels/inbound.ts:21-31`](../../../convex/channels/inbound.ts)). So for `/channels/*` the authorizer
   enforces **only** the framework gate (or is attached with `resultsCacheTtl=0`), and `adapter.verify` stays
   **inside** the inboundChannel Lambda over `event.body` (base64-decoded if `isBase64Encoded`). Lambda proxy
   integration with **no body transformation** preserves byte fidelity (owned by G4.7; this phase guarantees
   the integration introduces no re-serialization).

## Implementation tasks

Execute in order. Each item is independently checkable.

1. **Move `src/runtime/http.ts` into the portable core** (`backend/engine/http.ts` or re-export). It is already
   marked "Pure / V8-safe: no Convex" ([`src/runtime/http.ts:5`](../../../src/runtime/http.ts)); the move drops
   nothing. Keep `CoveHttpError` subclasses, `renderHttpError`, `validateAgentRequest`, `configureErrorRendering`.

2. **`apiError.ts` proxy-shim.** A 10-line `toProxyResult(err): APIGatewayProxyResultV2` that calls
   `renderHttpError(err)` and returns `{ statusCode: status, headers: { 'content-type': 'application/json',
   ...cors }, body: JSON.stringify(body) }`. Every handler's outer try/catch funnels through it (mirroring the
   `try { ... } catch (err) { const { status, body } = renderHttpError(err); return Response.json(body, {status}) }`
   pattern at [`http.ts:97-100`](../../../convex/http.ts)).

3. **`admit.ts` handler** (`POST /agents/{name}/{id}` + `?wait=result`). Body:
   1. Parse path params from `event.pathParameters` (`name`, `id`); throw `InvalidRequestError("expected
      /agents/:name/:id")` if missing (parity with [`http.ts:62-63`](../../../convex/http.ts)).
   2. Content-Type guard → `UnsupportedMediaTypeError` ([`http.ts:64-66`](../../../convex/http.ts)); JSON
      parse → `InvalidJsonError` ([`http.ts:67-72`](../../../convex/http.ts)). Honor `isBase64Encoded`.
   3. `validateAgentRequest(raw)` → `{ message, model, sessionName, resultSchema }`.
   4. **Admission write** — factored into the shared, **G4.5-owned/exported** helper `ingress/admitWrite.ts` (`admitPrompt(deps, input)`), consumed by BOTH this handler and the channels-inbound Lambda ([G4.7](phase-g4.7-channels-workflows-scheduler.md) task 7). It replaces `submitPrompt`→`admitPrompt` ([`admit.ts:110-137`](../../../convex/invoke/admit.ts)):
      - `getOrCreateSessionId` via `sessionStore` (GSI1 `by_instance_harness_session` GetItem; conditional Put
        the HEADER item if absent).
      - **Supersede:** `requestStore.cancelActiveRequests(sessionId, "superseded")` (owned by G4.3;
        DynamoDB-authoritative + best-effort `StopExecution`).
      - Generate `submissionId` (ULID/UUID); build the `agentRequests` item (`kind:"prompt"`, `status:"pending"`,
        `model ?? "cove-test/mock"`, `target=name`, `expectsResult`, `resultSchema`, `approvalTools`,
        `mcpServers`, `replyContext`, `createdAt`/`updatedAt`).
      - Append the `u-<requestId>` user entry (`{ role:"user", content:message, timestamp:now }` —
        [`admit.ts:135-136`](../../../convex/invoke/admit.ts)) via `sessionStore` conditional Put keyed on the
        deterministic `entryId` (idempotent — [G4.1](phase-g4.1-foundation-cdk-dynamodb.md) key conventions).
      - Do the insert + entry append (and, where the supersede status flip can be co-located) as a
        **`TransactWriteItems`** so the request and its user turn commit together.
   5. **`StartExecution(name=submissionId)`** on the `AgentLoop` ARN (read from the `STATE_MACHINE_ARN` env, set
      by CDK from the G4.3 SSM/CFN output), input `{ requestId, sessionId }`. Then
      `requestStore.setExecutionArn(requestId, executionArn)`. Swallow `ExecutionAlreadyExists` (idempotent
      re-admit — treat as success and read the existing arn).
   6. If `event.queryStringParameters?.wait === "result"` → `pollTerminal(requestId)` (bounded, task 5) and
      merge the snapshot into the response (`{ sessionId, requestId, submissionId, ...snap }` —
      [`http.ts:84-90`](../../../convex/http.ts)); else return `{ sessionId, requestId, submissionId }`
      ([`http.ts:92-96`](../../../convex/http.ts)). Status `200`.
   7. Outer try/catch → `apiError.ts`.

3a. **`StartExecution` IAM.** Grant the `admit` (and `submitWorkflow`) Lambda role **only**
   `states:StartExecution` on the single `AgentLoop` state-machine ARN (least privilege). No `StopExecution`
   here — the supersede `StopExecution` lives in `requestStore.cancelActiveRequests`, whose helper Lambda/role
   is granted in G4.3.

4. **`submitWorkflow.ts` handler** (`POST /workflows/{name}`). Mirror
   [`http.ts:132-159`](../../../convex/http.ts):
   - Path param `name`; `InvalidRequestError` if missing.
   - Resolve `getRegisteredWorkflow(name)` from the **bundled** `workflowRegistry`
     ([`convex/workflowRegistry.ts:63`](../../../convex/workflowRegistry.ts)); unknown → `WorkflowNotFoundError`
     (404) ([`http.ts:140`](../../../convex/http.ts)). No `_cove/workflowResolver` side-effect import — the
     registry is resolved in-process at bundle time.
   - Parse body (absent/empty body allowed → `input = undefined`, [`http.ts:141-146`](../../../convex/http.ts)).
   - Admit a **distinct `kind:"workflow"`** request (replaces `admitWorkflow`,
     [`admit.ts:225-252`](../../../convex/invoke/admit.ts)): `instanceId = "workflow:<name>"`, serialized
     input, `target=name`, append the `u-<requestId>` entry, then `StartExecution` with input
     `{ requestId, sessionId, kind:"workflow", target:name }` (the named-execution mapping owned by
     [G4.7](phase-g4.7-channels-workflows-scheduler.md)). Response includes `runId = requestId`
     ([`http.ts:148-153`](../../../convex/http.ts)).

5. **`poll.ts` — `pollTerminal` bounded + `GET /runs/{runId}`.**
   - `pollTerminal(requestId)`: loop `requestStore.get(requestId)` every `POLL_INTERVAL_MS` (400 ms, parity
     with [`http.ts:30`](../../../convex/http.ts)) until `status ∈ {completed, failed, cancelled}` or
     `Date.now() > deadline` with **`POLL_DEADLINE_MS = 27_000`** (D-AWS-13 — stays under the 29 s integration
     timeout). On deadline return the latest non-terminal snapshot (do not throw).
   - `GET /runs/{runId}`: `runId` from path; `requestStore.get` (GetItem `PK=REQ#<runId>, SK=META`); `null` →
     `RunNotFoundError(runId)` (404, [`http.ts:111,119`](../../../convex/http.ts)); else return the snapshot
     projection (`status, finalText, result, error, cancelReason, usage, totalTokens, totalSteps,
     totalToolCalls, durationMs` — identical to [`requests.ts:13-25`](../../../convex/requests.ts)). Set
     `Lambda timeout` for `admit`/`poll` to ~30 s (the 27 s poll + headroom), still under API GW's 29 s — the
     **API Gateway integration timeout, not the Lambda timeout, is the binding constraint**.

6. **`authorizer.ts` — REQUEST Lambda authorizer, CLOSED by default.**
   - Type `REQUEST` (sees headers/query/context, **not** the body), `identitySource` e.g.
     `method.request.header.Authorization` (configurable); `resultsCacheTtl` configurable (default `300` for
     app routes; **`0`** for `/channels/*`).
   - Run the user's `authorize({ headers, requestContext })` shape (the AWS analogue of
     [`auth.ts:9`](../../../convex/auth.ts)'s `AuthorizeHook`). If it returns an identity → build an
     **Allow** policy for the matched `methodArn` with `context = { principalId, ...identity }`. If it throws
     `UnauthorizedError` (or anything) → **Deny**.
   - **CLOSED-by-default:** if **no** `authorize` hook is configured, return **Deny** (the inversion of
     [`auth.ts:20`](../../../convex/auth.ts)'s `if (!authorizeHook) return undefined`). Document the single
     escape hatch (an explicit `COVE_ALLOW_OPEN=1` dev flag) so "no policy ⇒ 403" is never a silent surprise
     in local dev.
   - Attach the authorizer to `/agents/*`, `/runs/*`, `/workflows/*` (and HITL `submitApproval`); attach to
     `/channels/*` with `resultsCacheTtl=0` and framework-gate-only semantics.

7. **`ingress-stack.ts` — the CDK wiring.**
   - `new apigateway.RestApi(this, "CoveApi", { endpointTypes:[REGIONAL], deployOptions:{ throttlingRateLimit,
     throttlingBurstLimit }, defaultCorsPreflightOptions: { allowOrigins, allowMethods:["POST","GET"],
     allowHeaders:["Authorization","Content-Type"] } })`.
   - `new apigateway.RequestAuthorizer(this, "CoveAuthorizer", { handler: authorizerFn, identitySources:[...],
     resultsCacheTtl })`.
   - Resources: `agents/{name}/{id}` (POST), `runs/{runId}` (GET), `workflows/{name}` (POST), `channels/{name}`
     (POST, handler from G4.7). Each `addMethod` with `LambdaIntegration(fn)` (proxy) + the authorizer
     (`authorizationType: CUSTOM`).
   - `RequestValidator` (`validateRequestBody:true, validateRequestParameters:true`) on POST methods (coarse —
     authoritative validation is the portable `validateAgentRequest`).
   - **`GatewayResponse`** for `UNAUTHORIZED` (401) and `ACCESS_DENIED` (403) emitting the `CoveApiError`
     envelope so an authorizer Deny renders `{error:{code:"unauthorized",...}}` not the default API GW XML;
     `DEFAULT_4XX`/`DEFAULT_5XX` likewise, and **CORS headers on error responses**.
   - Grant `admit`/`submitWorkflow` `states:StartExecution` on the `AgentLoop` ARN; grant
     `admit`/`poll`/`submitWorkflow` the `requestStore`/`sessionStore` DynamoDB actions (GetItem/PutItem/
     UpdateItem/Query/TransactWriteItems) on `Requests`/`Sessions` + their GSIs (least privilege, per table).

8. **Bundle posture.** esbuild-bundle each handler (Node 20, no VPC — D-AWS-11). `admit`/`poll`/`submitWorkflow`
   import only `store/` + the portable `http.ts` + the AWS SDK SFN/DynamoDB clients (no AI SDK, no sandbox adapter
   — these are admission-path Lambdas, **nothing below the port imports the AI SDK**). `submitWorkflow` bundles
   the `workflowRegistry`.

9. **Wire-contract conformance test fixtures.** Capture the exact request/response pairs the Convex routes
   produced (the `{sessionId, requestId, submissionId}` shape; the `?wait=result` merged snapshot; the
   `CoveApiError` bodies for 400/401/404/415) so [G4.8](phase-g4.8-tests-parity-cutover.md) can assert byte-level
   parity against the Convex `convex-test` HTTP cases.

## Acceptance

Objective bars — each mirrors the Convex behavior in [`convex/http.ts`](../../../convex/http.ts) /
[`auth.ts`](../../../convex/auth.ts) it replaces.

- **Submit parity.** `POST /agents/{name}/{id}` with `{message}` (or `{prompt}`) under a configured authorizer
  returns `200 {sessionId, requestId, submissionId}`, writes a `pending` `agentRequests` item with
  `target=name` + the `u-<requestId>` user entry, and there is exactly **one** `AgentLoop` execution named
  `submissionId` with `executionArn` stamped on the Requests item — parity with
  [`admit.ts:110-142`](../../../convex/invoke/admit.ts).
- **Supersede.** A second submit on the same `(instanceId, harnessName, sessionName)` while the first is
  `pending`/`running` flips the first to `status=cancelled, cancelReason=superseded` (DynamoDB authoritative,
  even if the prior `StopExecution` 404s) before admitting the second — parity with
  [`admit.ts:113,60-84`](../../../convex/invoke/admit.ts).
- **Idempotent re-admit.** Two `admit` invocations producing the same `submissionId` (or a retried API GW
  delivery) yield **one** execution (`name=submissionId`), not two — `ExecutionAlreadyExists` is swallowed.
- **`?wait=result` bounded.** `?wait=result` blocks until terminal and merges the snapshot
  ([`http.ts:84-90`](../../../convex/http.ts)); a run that does not terminalize within ~27 s returns the latest
  non-terminal snapshot **before** API Gateway's 29 s timeout fires (never a 504), and the caller can re-poll
  `GET /runs/{runId}` — D-AWS-13.
- **Run snapshot.** `GET /runs/{runId}` returns the exact projection of
  [`requests.ts:13-25`](../../../convex/requests.ts); an unknown id → `404 {error:{code:"run_not_found"}}`.
- **Workflow route.** `POST /workflows/{known}` admits a `kind:"workflow"` run + returns
  `{sessionId, requestId, submissionId, runId}`; `POST /workflows/{unknown}` → `404
  {error:{code:"workflow_not_found"}}` — parity with [`http.ts:132-159`](../../../convex/http.ts).
- **Closed-by-default auth (the security inversion).** With **no** authorizer policy configured, every app
  route returns **403** (the inversion of [`auth.ts:20`](../../../convex/auth.ts)'s open default). With a hook
  that returns an identity, the request is admitted and the identity is available in the handler `context`. A
  hook that throws → 403/401 with the `CoveApiError` envelope (not API GW's default XML).
- **Error envelope parity.** Bad Content-Type → `415 unsupported_media_type`; non-JSON body → `400
  invalid_json`; missing `message` → `400 invalid_request`; unknown route → 404 — all rendered as
  `{error:{code,message,status}}` ([`src/runtime/http.ts`](../../../src/runtime/http.ts)). A 500 leaks no
  internal detail unless `configureErrorRendering({devMode:true})`.
- **No loop in ingress (THESIS).** A static/bundle check: no ingress handler imports the AI SDK, the sandbox adapter,
  or the engine `loop`/`dispatch` modules; `admit` does exactly one `StartExecution` and zero loop steps.
- **Raw-byte fidelity declared.** The `/channels/*` route uses Lambda proxy integration with no body transform
  (verified jointly with [G4.7](phase-g4.7-channels-workflows-scheduler.md)); the authorizer never reads the
  body.

## Risks & gotchas

- **The open→closed inversion looks like an outage.** Every previously-open native/test/HTTP caller starts
  `403`ing the moment the authorizer is attached with no policy. This is **intended** (D-AWS-6) but must be a
  loud line item on the [G4.8](phase-g4.8-tests-parity-cutover.md) cutover checklist with a dev-mode escape
  hatch (`COVE_ALLOW_OPEN`), or the cutover looks broken.
- **29 s vs 60 s `?wait=result`.** The synchronous-wait contract cannot be ported as-is
  ([`http.ts:31`](../../../convex/http.ts) is 60 s; API GW caps at 29 s). The bounded poll + client re-poll (or
  WS terminal frame) is a **behavior change** for non-reactive HTTP/SDK callers — document it in the SDK shim
  ([G4.6](phase-g4.6-reactive-websocket-streaming.md)). Set the Lambda timeout above the poll deadline but the
  **integration timeout** is the binding limit; a Lambda that runs past 29 s still returns a 504 to the client.
- **Authorizer cannot see the body — never put signature verify in it.** A Lambda authorizer only sees
  headers/query/context. Channel HMAC/Ed25519 verify **must** stay inside the channels Lambda over the raw
  bytes ([`channels/inbound.ts:21-31`](../../../convex/channels/inbound.ts)); any attempt to verify in the
  authorizer breaks all 8 adapters (D-AWS-6, risks list).
- **Body transformation breaks raw-byte fidelity.** API Gateway request templates / non-proxy integration /
  mishandled `binaryMediaTypes` re-serialize the body. Use **Lambda proxy** with no mapping template; this
  stack must not introduce a transform on `/channels/*` (owned by G4.7 but constrained here).
- **Cross-service non-atomicity in supersede + start.** `StopExecution` (prior) + status write + new insert +
  `StartExecution` span DynamoDB and SFN; a crash mid-sequence can leave a `cancelled` row with a still-running
  prior execution, or a `pending` row with no execution. Mitigated by **DynamoDB-authoritative + state
  self-abort at Task entry** (D-AWS-14, owned by G4.3) and `name=submissionId` idempotency, but it is a latent
  window to call out.
- **Authorizer caching vs identity drift.** `resultsCacheTtl > 0` caches the Allow/Deny per identity-source
  value; a revoked token stays Allowed until the TTL lapses. Keep the app-route TTL modest (≤300 s) and **0**
  for `/channels/*` (where the "identity" is the framework gate, not a per-user token).
- **`RequestValidator` is coarse, not authoritative.** The edge validator only checks Content-Type/required
  params; it does **not** reproduce `validateAgentRequest`'s `message`-or-`prompt` aliasing or non-empty check
  ([`src/runtime/http.ts:87-100`](../../../src/runtime/http.ts)). Keep the portable function as the source of
  truth or error codes drift from the Convex contract.
- **CORS on error responses.** API Gateway does **not** automatically add CORS headers to `GatewayResponse`
  (401/403/4xx); without explicit headers on those responses, a browser SDK caller sees an opaque CORS error
  instead of the `CoveApiError` body. Add the headers on every `GatewayResponse`.
