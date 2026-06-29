# Phase G4.4 — HITL approval gate — Step Functions task tokens

> Group 4 (Convex → AWS migration). This phase replaces `@convex-dev/workflow`'s `step.awaitEvent` +
> `workflow.sendEvent` HITL handshake with a Step Functions **`.waitForTaskToken`** `AwaitApproval` Map
> state, a DynamoDB-backed **Approvals** table that carries the task token, and a `submitApproval` Lambda
> that resumes the parked run via `SendTaskSuccess`. The single sharpest correctness risk in the whole
> migration lives here: raw task tokens do not exist until the wait state is entered, so the
> Convex "durable/queued event, never lost before park" guarantee must be re-established with a **two-sided
> early-submit guard** (D-AWS-5).

## Goal & scope

Reproduce, on AWS, the exact behavior of the Convex HITL lifecycle:
[`convex/engine/approvals.ts`](../../../convex/engine/approvals.ts) (`park` / `applyApproval` / `listPending`
/ `submitApproval`), the pure decision core
[`convex/engine/hitl.ts`](../../../convex/engine/hitl.ts) (`partitionGatedToolCalls` /
`applyApprovalDecision`), and the `resolveApprovals` durable-suspension dep in
[`convex/engine/runHandler.ts:70-94`](../../../convex/engine/runHandler.ts) that the loop calls at the gate
([`convex/engine/loop.ts:116-122`](../../../convex/engine/loop.ts)). Specifically this phase owns:

- **The `AwaitApproval` Map body.** [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md) places the
  empty `AwaitApproval` Map (with `maxConcurrency: 1`) and routes `HitlChoice` into it; THIS phase fills the
  Map iteration with the `.waitForTaskToken` Task and its Catch, and wires the park + apply Lambdas.
- **Durable park.** A `park` Lambda that conditionally writes the pending approval row keyed on `toolCallId`
  (replacing `ctx.db.insert("approvals")`), **stamping the SFN task token** on the row, plus the
  early-submit self-completion guard.
- **Out-of-band resolve.** A `submitApproval` Lambda (behind the [G4.5](phase-g4.5-ingress-apigw-auth.md)
  API Gateway) that is idempotent + fail-loud on double-submit and resumes the run via `SendTaskSuccess`.
- **Apply-after-resume.** The rejected-call error tool-result write and the approved-call args patch
  (`applyApproval` → the portable `hitl.ts` `applyApprovalDecision`), so `Dispatch` runs only the
  approved + ungated set.
- **Park heartbeat + timeout** (`HeartbeatSeconds` / `TimeoutSeconds`) → `FinalizeApprovalTimeout`, and
  abandonment of the parked token on cancel/supersede.
- **`listPending`** as a DynamoDB Query backing the approval-card UI (the live push is
  [G4.6](phase-g4.6-reactive-websocket-streaming.md); this phase only owns the read shape + the table being
  Stream-enabled).

**Out of scope (owned elsewhere, cross-linked):** the surrounding state-machine and the `HitlChoice` /
`AwaitApproval` Map *placement* and `maxConcurrency: 1` constraint
([G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)); the `dispatchTools` Lambda that consumes the
approved set ([G4.2](phase-g4.2-compute-lambda-actions.md)); the API Gateway route + closed authorizer that
front the `submitApproval` Lambda ([G4.5](phase-g4.5-ingress-apigw-auth.md)); the WS fan-out that pushes the
approval-card delta and the Approvals Stream ([G4.6](phase-g4.6-reactive-websocket-streaming.md)); the
Approvals **table/GSI definitions** and the `store/approvalStore.ts` seam
([G4.1](phase-g4.1-foundation-cdk-dynamodb.md)); `StopExecution` on cancel/supersede that abandons the token
([G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md) authoritative, this phase verifies the parked-token
abandonment jointly).

## Dependencies

- **[G4.1](phase-g4.1-foundation-cdk-dynamodb.md)** — the **Approvals** table MUST exist with base key
  `PK=REQ#<requestId>, SK=<status>#<toolCallId>`, GSI1 `by_session_and_status`
  (`PK=SESS#<sessionId>#<status>`), and **GSI2 `by_toolCall`** (`PK=TC#<toolCallId>`) — the resolve lookup
  that carries the `taskToken` attribute. The `store/approvalStore.ts` adapter (park / resolve / list) and
  the `store/requestStore.ts` (read `executionArn`, the old `convexWorkflowId`) MUST be wired. Streams
  (NEW_IMAGE) on Approvals enabled for the approval-card live push.
- **[G4.2](phase-g4.2-compute-lambda-actions.md)** — the `dispatchTools` Lambda that runs the
  approved + ungated set MUST honor "skip already-resulted calls" so a reject's pre-written error
  tool-result is respected.
- **[G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)** — the `AgentLoop` STANDARD state machine
  with the `HitlChoice` Choice and the empty `AwaitApproval` Map (`maxConcurrency: 1`) MUST be deployed;
  this phase fills its body. The Requests item must already carry `executionArn` (for `StopExecution` on
  cancel) — this phase only reads it.
- The portable **`hitl.ts`** decision core (`partitionGatedToolCalls`, `applyApprovalDecision`,
  `ApprovalDecision`, `ApprovalOutcome`) is **moved verbatim** to `backend/engine/hitl.ts` — it is already
  declared "Pure / V8-safe" and imports only from `./types.ts`.
- This phase **blocks nothing** on the critical path but is gated by G4.3; it is co-verified with
  [G4.5](phase-g4.5-ingress-apigw-auth.md) (the route in front of `submitApproval`).

## Deliverables

- `backend/sfn/agent-loop.asl.json` (CONTRIBUTION) — the `AwaitApproval` Map iteration body: a
  `.waitForTaskToken` Task (`Resource: arn:aws:states:::lambda:invoke.waitForTaskToken`) + an `ApplyApproval`
  Task + a Catch for `States.Timeout` → `FinalizeApprovalTimeout`.
- `backend/handlers/hitl/park.ts` — the park Lambda (conditional Put + token stamp + early-submit guard).
- `backend/handlers/hitl/applyApproval.ts` — the apply-after-resume Lambda (reject → error tool-result;
  approve → args patch), over the portable `applyApprovalDecision`.
- `backend/handlers/hitl/submitApproval.ts` — the out-of-band resolve Lambda (`SendTaskSuccess`, fail-loud).
- `backend/handlers/hitl/listPending.ts` — the approval-card read (Query `begins_with(SK, "pending#")`).
- `backend/store/approvalStore.ts` (CONTRIBUTION) — park / resolve / list / readToken helpers over the
  DocumentClient (the replaced Convex ADAPTER seam; the algorithmic core stays in `hitl.ts`).
- `backend/engine/hitl.ts` — the portable decision core, moved verbatim from `convex/engine/hitl.ts`.
- CDK: in `cdk/stacks/orchestrator-stack.ts` — the three HITL Lambda constructs, the
  `states:SendTaskSuccess` / `states:SendTaskFailure` IAM grant on the `submitApproval` + `park` roles, and
  the `AwaitApproval` Task `HeartbeatSeconds`/`TimeoutSeconds` props.
- Tests: ASL/Step Functions Local approval-flow tests + `aws-sdk-client-mock` unit tests for the
  early-submit race (both orderings) — the parity bars under
  [G4.8](phase-g4.8-tests-parity-cutover.md).

## Source map

| Convex (replaced) | AWS (created) |
| --- | --- |
| [`convex/engine/approvals.ts:21-48`](../../../convex/engine/approvals.ts) — `park` (`internalMutation`, idempotent insert by `toolCallId`) | `backend/handlers/hitl/park.ts` + `store/approvalStore.ts#park` — conditional Put `PK=REQ#<id>, SK=pending#<toolCallId>`, stamps `taskToken` |
| [`convex/engine/approvals.ts:56-93`](../../../convex/engine/approvals.ts) — `applyApproval` (reject → error tool-result patch; approve → `toolCalls` args patch) | `backend/handlers/hitl/applyApproval.ts` — `store/journalStore.ts#appendToolResult` (reject) / patch step `toolCalls` (approve) |
| [`convex/engine/approvals.ts:95-105`](../../../convex/engine/approvals.ts) — `listPending` (`query`, `by_request_and_status`) | `backend/handlers/hitl/listPending.ts` — Query `PK=REQ#<id>` `begins_with(SK, "pending#")` |
| [`convex/engine/approvals.ts:113-153`](../../../convex/engine/approvals.ts) — `submitApproval` (`mutation`, fail-loud, `workflow.sendEvent`) | `backend/handlers/hitl/submitApproval.ts` — conditional UpdateItem `status=pending→…` + `SendTaskSuccess(taskToken)` |
| [`convex/engine/approvals.ts:16-18`](../../../convex/engine/approvals.ts) — `approvalEventName` (event key) | replaced by the **task token** as the resume handle; `(requestId, toolCallId)` is now the Approvals SK + `by_toolCall` key |
| [`convex/engine/hitl.ts`](../../../convex/engine/hitl.ts) — `partitionGatedToolCalls`, `applyApprovalDecision` (pure) | `backend/engine/hitl.ts` — **moved verbatim** (portable core) |
| [`convex/engine/runHandler.ts:70-94`](../../../convex/engine/runHandler.ts) — `resolveApprovals` dep (`park` + `awaitEvent` loop + `applyApproval`) | the `AwaitApproval` Map body in `backend/sfn/agent-loop.asl.json` (park Task + `.waitForTaskToken` + apply Task) |
| [`convex/engine/loop.ts:116-122`](../../../convex/engine/loop.ts) — `gated.length > 0 && deps.resolveApprovals` gate | `HitlChoice` (Choice `gatedCount > 0`) — placed by [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md), routed here |
| [`convex/schema.ts:363-381`](../../../convex/schema.ts) — `approvals` table + `by_request_and_status`/`by_session_and_status`/`by_toolCall` | **Approvals** DynamoDB table + GSI1/GSI2 (defined in [G4.1](phase-g4.1-foundation-cdk-dynamodb.md)) |
| [`convex/engine/approvals.ts:143-150`](../../../convex/engine/approvals.ts) — `request.convexWorkflowId` → `workflow.sendEvent` | the `taskToken` attribute on the Approvals item (read by `submitApproval` instead of `convexWorkflowId`) |

## Hardened-contract obligations

The design-of-record HITL contract ([design 08 §4.4](../../design/08-conventions-and-execution-boundary.md))
and the THESIS impose the following, each of which this phase must keep:

1. **Globally-unique gate identity.** Convex used `` `approval:${requestId}:${toolCallId}` `` as the event
   name ([`approvals.ts:16-18`](../../../convex/engine/approvals.ts)). On AWS the identity is the composite
   `(requestId, toolCallId)` — the Approvals SK (`pending#<toolCallId>` under `PK=REQ#<requestId>`) and the
   GSI2 `by_toolCall` (`PK=TC#<toolCallId>`). The resume handle is the **task token** stamped on that row,
   not a string event name.
2. **Fail-loud, idempotent resolve.** `submitApproval` MUST reject a non-`pending` approval — a double
   submit cannot flip an already-resolved decision
   ([`approvals.ts:129-131`](../../../convex/engine/approvals.ts), design 08 §4.4). Realized as a
   conditional UpdateItem `ConditionExpression: status = :pending`; a `ConditionalCheckFailedException`
   surfaces as a 409 (mirroring the thrown `"approval has already been resolved"`).
3. **The wake is never lost before park (the critical race).** Convex's `workflow.sendEvent` was
   durable/queued, so a submit arriving *before* the loop parked was not lost
   ([`approvals.ts:141-142`](../../../convex/engine/approvals.ts), design 08 §4.4). Raw task tokens lack
   this — a token does not exist until the `.waitForTaskToken` Task is entered. **D-AWS-5 two-sided guard:**
   (a) `submitApproval` always persists the decision to the Approvals row *before* attempting
   `SendTaskSuccess`; (b) the `park` Lambda, before suspending, GetItem-checks whether a decision already
   exists and, if so, immediately `SendTaskSuccess(taskToken, decision)` (self-completes). Either ordering
   resolves the run; neither deadlocks.
4. **Reject → error tool-result, never a crash.** A rejection writes an `isError: true` tool-result so the
   model self-corrects and `Dispatch` skips the call
   ([`hitl.ts:35-41`](../../../convex/engine/hitl.ts),
   [`approvals.ts:81-85`](../../../convex/engine/approvals.ts)). Approver-edited args patch the call so
   `Dispatch` runs the edited version; edited args are re-validated by the tool's normal execute-time
   validation, and a `ToolInputValidationError` returns as an error tool-result (design 08 §4.4) — not a
   thrown error that aborts the run.
5. **Sequential gate semantics.** Convex resolved gated calls in order
   (`for (const call of gatedCalls)`, [`runHandler.ts:80`](../../../convex/engine/runHandler.ts)). The
   `AwaitApproval` Map MUST keep `maxConcurrency: 1` (placed by
   [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)).
6. **Idempotency under at-least-once Tasks (D-AWS-7).** SFN re-invokes the same Lambda on retry. `park`'s
   Put is conditional (`attribute_not_exists` on the pending SK — replacing
   [`approvals.ts:30-35`](../../../convex/engine/approvals.ts)'s find-existing-then-insert); `applyApproval`'s
   tool-result write is idempotent replace-in-place by `toolCallId`
   (`SK=STEP#<n>#TR#<toolCallId>`, the journal child item). A re-driven park/apply is a no-op.
7. **Replay-reconstructable, never re-derived (THESIS).** Everything the park/apply consume — the gated
   calls, the step's `toolCalls`/`toolResults` — comes from the frozen runPlan + the journaled Steps item,
   not from live mutable state. The loop counters stay in SFN state
   ([G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)); HITL adds no re-derivation.
8. **The LLM decides but does not control flow; the orchestrator owns the durable pause.** The park is a
   real SFN suspension (not an in-Lambda `await`), so the loop is durable across redeploy and parks for
   hours within `TimeoutSeconds`. No AI SDK is touched here.

## Implementation tasks

A builder can execute these in order without re-deriving the design.

1. **Move the portable decision core.** Copy `convex/engine/hitl.ts` → `backend/engine/hitl.ts` unchanged
   (drop only the relative import path adjustment). It already imports only `./types.ts`; do not modify
   `partitionGatedToolCalls` or `applyApprovalDecision`.

2. **`store/approvalStore.ts`** (the replaced ADAPTER seam — pure algos stay in `hitl.ts`):
   - `park({requestId, sessionId, toolCallId, toolName, args, taskToken})` → conditional `PutItem` on
     `PK=REQ#<requestId>, SK=pending#<toolCallId>` with `ConditionExpression: attribute_not_exists(SK)`,
     writing `status:"pending"`, `createdAt`/`updatedAt`, the GSI2 attribute `gsi2pk=TC#<toolCallId>`, the
     GSI1 attribute `gsi1pk=SESS#<sessionId>#pending`, and `taskToken`. On
     `ConditionalCheckFailedException` (already parked — a Task retry), `UpdateItem` to refresh `taskToken`
     only (the new wait-state token), then return the existing row (see task 4's race note).
   - `readDecision(requestId, toolCallId)` → strongly-consistent `GetItem` on the pending SK (and a fallback
     `Query by_toolCall` if the status flipped, since the SK encodes status). Returns `{status, decision}`.
   - `resolve({requestId, toolCallId, decision, decidedBy})` → conditional `UpdateItem` with
     `ConditionExpression: status = :pending`, `SET status = :s, decision = :d, decidedBy = :by,
     updatedAt = :now` (where `:s` is `approved|rejected`). Because `status` is part of the SK, the resolve
     is modeled as a **delete-pending + put-resolved transaction** (`TransactWriteItems`: conditional
     `Delete` of `SK=pending#<toolCallId>` + `Put` of `SK=<approved|rejected>#<toolCallId>` carrying the
     decision and the `taskToken`) so the SK status prefix stays truthful and the Query for `pending#` no
     longer returns it. The transaction's condition (`Delete` requires the pending item exist) is the
     fail-loud gate.
   - `readToken(requestId, toolCallId)` → `GetItem`/`Query by_toolCall`, return `taskToken` (or null).
   - `listPending(requestId)` → Query `PK=REQ#<requestId>` `begins_with(SK, "pending#")`, project
     `{toolCallId, toolName, args}` (parity with [`approvals.ts:99-104`](../../../convex/engine/approvals.ts)).

3. **`park` Lambda** (`backend/handlers/hitl/park.ts`) — the `.waitForTaskToken` Task target. Input from the
   Map iteration: `{requestId, sessionId, stepNumber, toolCallId, toolName, args, taskToken}` (the
   `taskToken` is injected by SFN via the Task `Parameters` `"taskToken.$": "$$.Task.Token"`). Body:
   1. `approvalStore.park(...)` (idempotent conditional Put, stamping `taskToken`).
   2. **Early-submit guard:** `approvalStore.readDecision(requestId, toolCallId)`; if `status !== "pending"`
      (a submit already landed), immediately `SendTaskSuccess({taskToken, output: JSON.stringify(decision)})`
      and return — self-completing so the early submit is not lost
      ([restores `approvals.ts:141-142`](../../../convex/engine/approvals.ts)).
   3. Otherwise return nothing (no `SendTaskSuccess`/`SendTaskFailure`) — SFN keeps the iteration suspended
      on the token until `submitApproval` resumes it.
   - Note: this Lambda returns *to nothing* in the suspend path; its only job is to record the token and
     handle the early race. It MUST be invoked with `invoke.waitForTaskToken` (not plain `invoke`).

4. **Race correctness between `park`'s conditional Put and `submitApproval`'s resolve.** The pending row may
   already exist (early submit raced ahead and `park` is re-driven, OR a prior wait-state entered before a
   continue-as-new). Resolution rules:
   - If the row is `pending` with a *stale* token, `park` overwrites `taskToken` with the current token
     (task 2) so a later resume targets the live wait state.
   - If the row is already resolved, `park`'s `Put` condition fails; `readDecision` returns the decision and
     `park` self-completes via `SendTaskSuccess` (the early-submit guard). This is the load-bearing path for
     D-AWS-5 — write the unit test for it (task 9).

5. **`submitApproval` Lambda** (`backend/handlers/hitl/submitApproval.ts`) — invoked by the
   [G4.5](phase-g4.5-ingress-apigw-auth.md) API Gateway route `POST /approvals` (closed authorizer in
   front). Input: `{requestId, toolCallId, approved, editedArgs?, reason?, decidedBy?}`. Body, mirroring
   [`approvals.ts:122-152`](../../../convex/engine/approvals.ts):
   1. Build `decision = {approved, editedArgs, reason}` (the `applyApprovalDecision` input shape).
   2. `approvalStore.resolve(...)` — the transactional fail-loud resolve. On
      `TransactionCanceledException` whose cancellation reason is `ConditionalCheckFailed`, return **409**
      (mirrors `"approval has already been resolved"` / `"approval not found"`). The decision is now durably
      persisted **before** any token call (D-AWS-5 side (a)).
   3. `approvalStore.readToken(...)`. If a token is present → `SendTaskSuccess({taskToken,
      output: JSON.stringify(decision)})`. If absent (submit raced ahead of park) → return 200; the
      decision is persisted and `park`'s early-submit guard will self-complete when the wait state enters
      (D-AWS-5 side (b)).
   4. `SendTaskSuccess` may throw `TaskDoesNotExist` / `TaskTimedOut` (the wait state already resumed or
      timed out) — swallow these as already-resolved (idempotent), mirroring the no-op replay semantics of
      a re-delivered Convex event.
   - **Never** call `SendTaskFailure` here. A reject is NOT a task failure — it is a successful decision
     whose *content* is `approved: false`; the `applyApproval` Task downstream turns it into an error
     tool-result. `SendTaskFailure` is reserved for `applyApproval` itself failing irrecoverably.

6. **`applyApproval` Task / Lambda** (`backend/handlers/hitl/applyApproval.ts`) — the Map iteration's
   continuation after the `.waitForTaskToken` Task resumes. Input: the resumed Task output
   `{requestId, stepNumber, toolCallId, toolName, args, decision}`. Body, mirroring
   [`approvals.ts:69-92`](../../../convex/engine/approvals.ts):
   1. `loadStep(requestId, stepNumber)` from `store/journalStore.ts`; if absent, return (replay tolerance,
      [`approvals.ts:74`](../../../convex/engine/approvals.ts)).
   2. `const outcome = applyApprovalDecision({toolCallId, toolName, args, isHitl: true}, decision)` (the
      portable core).
   3. **reject** → `journalStore.appendToolResult` an `isError: true` child item
      `SK=STEP#<n>#TR#<toolCallId>` (idempotent replace-in-place) and set `hadToolError: true` on the step
      ([`approvals.ts:81-85`](../../../convex/engine/approvals.ts)). `Dispatch` will skip this call (it has
      a result).
   4. **approve** (with optional `editedArgs`) → `UpdateItem` the step's `toolCalls` so the call's `args`
      become `outcome.call.args` ([`approvals.ts:87-91`](../../../convex/engine/approvals.ts)).
   - This Lambda is the only place that may `SendTaskFailure` (if the journal write fails irrecoverably) so
     SFN surfaces a real error rather than silently dropping the decision.

7. **`AwaitApproval` Map iteration body** in `backend/sfn/agent-loop.asl.json` (the TS builder
   [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md) owns; this phase contributes the body):
   - `ParkAndWait` (Task) — `Resource: arn:aws:states:::lambda:invoke.waitForTaskToken`,
     `Parameters: {FunctionName: park, Payload: {requestId.$, sessionId.$, stepNumber.$, toolCallId.$,
     toolName.$, args.$, "taskToken.$": "$$.Task.Token"}}`, `HeartbeatSeconds: <heartbeat>`,
     `TimeoutSeconds: <approvalTimeout>` (default 86400, overridable from `durability.timeoutMs`),
     `Catch: [{ErrorEquals: ["States.Timeout"], Next: "FinalizeApprovalTimeout"}]`. The resumed output is
     the `decision` from `SendTaskSuccess`.
   - `ApplyApproval` (Task → `applyApproval` Lambda) → end of iteration. `ResultPath` discards output (the
     loop carries no per-iteration state).
   - Pass the gated-calls array into the Map's `ItemsPath` (the small `{toolCallId, toolName, args}`
     projection — bodies stay under the 256 KB SFN-state limit; large args spill to S3 per D-AWS-10 if
     needed, following the `imageChunks` `s3Key` pattern).
   - After the Map → `Dispatch` (Task), exactly as `HitlChoice`'s no-gate branch
     ([G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)).

8. **`FinalizeApprovalTimeout` state.** A Pass/Task that routes a parked-too-long approval to the existing
   `Finalize` family with `status: failed, reason: approval_timeout`, then → `Reply`. This realizes design
   08 §4.4's "timeout while parked → terminalize" (Convex used `durability.timeoutMs` → `cancelled`; here the
   `TimeoutSeconds` throws `States.Timeout`, caught into a terminal finalize). The Requests item carries the
   `executionArn` (G4.3) so cancel/supersede `StopExecution` also abandons the parked token — verify jointly
   with [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md).

9. **`listPending` Lambda** — Query `begins_with(SK, "pending#")` (task 2). It is the read backing the
   approval-card UI; the live push is the Approvals Stream → WS fan-out
   ([G4.6](phase-g4.6-reactive-websocket-streaming.md)). This phase only enables the Stream and ships the
   read.

10. **CDK + IAM** (`cdk/stacks/orchestrator-stack.ts`): three `NodejsFunction` constructs (park,
    applyApproval, submitApproval) esbuild-bundled (D-AWS-11); least-privilege grants —
    `park`/`submitApproval`: `states:SendTaskSuccess` (+ `park` reads Approvals + `submitApproval`
    read/write Approvals); `applyApproval`: read/write Steps; the state machine role gets
    `lambda:InvokeFunction` on park/applyApproval. Wire `submitApproval` behind the API Gateway route in
    [G4.5](phase-g4.5-ingress-apigw-auth.md). Enable the **Approvals** DynamoDB Stream
    ([G4.1](phase-g4.1-foundation-cdk-dynamodb.md)) feeding the [G4.6](phase-g4.6-reactive-websocket-streaming.md)
    fan-out.

11. **Tests** (parity bars; full suite owned by [G4.8](phase-g4.8-tests-parity-cutover.md)):
    - Step Functions Local: a run with one gated call → park suspends → `SendTaskSuccess(approve)` → Dispatch
      runs the call → run completes.
    - `aws-sdk-client-mock` early-submit race, BOTH orderings: (a) submit-before-park → `park` self-completes;
      (b) submit-after-park → `submitApproval` `SendTaskSuccess` resumes. Neither deadlocks.
    - Double-submit → second call 409s (fail-loud), token only sent once.
    - Reject → error tool-result written, Dispatch skips the call, model gets the error.
    - Approve with `editedArgs` → step `toolCalls` args patched, Dispatch runs the edited version.
    - Timeout → `States.Timeout` → `FinalizeApprovalTimeout` → `failed/approval_timeout` → Reply.

## Acceptance

The phase is done when, observably mirroring the Convex behavior it replaces:

- **Durable park.** A run with a gated tool call suspends at `AwaitApproval` (visible in the SFN execution
  as a `TaskScheduled` with no `TaskSucceeded` until resume); the execution survives a state-machine
  redeploy while parked (the token-backed wait is durable, equivalent to the Convex `awaitEvent`
  suspension).
- **Resume.** `submitApproval(approved: true)` resumes the run and `Dispatch` runs the approved call;
  `approved: false` resumes and `Dispatch` skips the call (an `isError: true` tool-result is present on the
  step), matching [`approvals.ts:81-91`](../../../convex/engine/approvals.ts) and
  [`hitl.ts:35-44`](../../../convex/engine/hitl.ts).
- **Edited args.** `editedArgs` patch the call so the dispatched args differ from the model's original,
  re-validated at dispatch — parity with
  [`approvals.ts:87-91`](../../../convex/engine/approvals.ts).
- **Early-submit race.** A `submitApproval` issued **before** the loop reaches the park resumes the run
  exactly once (the park Lambda self-completes); no deadlock, no lost wake — the property design 08 §4.4
  and [`approvals.ts:141-142`](../../../convex/engine/approvals.ts) require, and the single sharpest risk
  this phase exists to close.
- **Fail-loud double-submit.** A second `submitApproval` for the same `(requestId, toolCallId)` after the
  first resolves returns 409 and does NOT send a second `SendTaskSuccess` — matching
  [`approvals.ts:129-131`](../../../convex/engine/approvals.ts).
- **Idempotent re-drive.** An at-least-once SFN re-invoke of `park`/`applyApproval` is a no-op (conditional
  Put / idempotent tool-result replace-in-place) — no duplicate pending row, no double tool-result.
- **Sequential gating.** Multiple gated calls in one step are resolved in order (Map `maxConcurrency: 1`).
- **Timeout.** A parked approval exceeding `TimeoutSeconds` terminalizes `failed/approval_timeout` → Reply,
  and a cancel/supersede `StopExecution` abandons the parked token (no orphaned wait).
- **`listPending` parity.** The Query returns the same `{toolCallId, toolName, args}` projection as
  [`approvals.ts:99-104`](../../../convex/engine/approvals.ts), and the Approvals Stream pushes the card to
  subscribed WS clients ([G4.6](phase-g4.6-reactive-websocket-streaming.md)).

## Risks & gotchas

- **The early-submit deadlock (D-AWS-5, top risk).** If the two-sided guard is incomplete — e.g.
  `submitApproval` calls `SendTaskSuccess` only when a token is present but does NOT persist the decision
  first, or `park` suspends without re-reading the decision — an approval that lands in the window between
  the Map entering and the token being stamped is silently lost and the run parks forever (a regression of
  the Convex durable-queued event). Both sides are mandatory; both orderings must be unit-tested.
- **Status-in-SK modeling.** Because the Approvals SK encodes status (`<status>#<toolCallId>`), a resolve is
  not a simple `UpdateItem` — it is a `TransactWriteItems` (delete `pending#`, put `<resolved>#`) so the
  `begins_with("pending#")` Query stays truthful. Modeling the resolve as a plain attribute `UpdateItem` on
  the pending SK would leave a stale `pending#` item that `listPending` keeps returning. (If G4.1 chooses a
  fixed SK with status as a non-key attribute instead, the resolve simplifies to a conditional `UpdateItem`
  — confirm the table shape with [G4.1](phase-g4.1-foundation-cdk-dynamodb.md) before coding the store.)
- **Stale token after continue-as-new.** [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)'s
  continue-as-new starts a fresh execution; if a run parks, continues-as-new, and re-enters the Map, the
  pending row may carry the *old* execution's token. `park` MUST overwrite `taskToken` on re-park (task 2)
  so `submitApproval` targets the live wait state; otherwise `SendTaskSuccess` throws `TaskDoesNotExist`
  against a dead execution and the wake is lost.
- **`SendTaskSuccess` vs `SendTaskFailure` confusion.** A rejected approval is a *successful* task with
  `approved: false` content — it MUST go through `SendTaskSuccess` so the `applyApproval` Task runs and
  writes the error tool-result. Using `SendTaskFailure` for a reject would skip `applyApproval`, leave the
  call un-resulted, and let `Dispatch` re-run it.
- **Approver-edited args validation.** Edited args are re-validated at dispatch
  ([`hitl.ts:11`](../../../convex/engine/hitl.ts) comment); a `ToolInputValidationError` must surface as an
  error tool-result, not a thrown error that fails the Map iteration (design 08 §4.4). Keep the validation
  inside `dispatchTools` ([G4.2](phase-g4.2-compute-lambda-actions.md)), not in `applyApproval`.
- **Token leakage / TTL.** Parked tokens are valid up to `TimeoutSeconds` (default 24 h). A cancel that does
  not also `StopExecution` (G4.3) leaves the token live but the run dead; ensure cancel abandons the parked
  token. Do NOT log the raw `taskToken` (it is a resume credential).
- **At-least-once `submitApproval` retries.** If the API Gateway / client retries `submitApproval`, the
  conditional resolve 409s on the second attempt and the `SendTaskSuccess` swallow of
  `TaskDoesNotExist`/`TaskTimedOut` keeps it idempotent — but make sure the 409 is not surfaced as a
  user-visible failure on a legitimate retry of an already-applied decision.
- **Stream amplification.** The Approvals Stream pushes pending + resolved transitions; the WS reducer must
  treat the resolved row as the terminal of the card. With the status-in-SK transactional resolve, the
  Stream emits a `REMOVE` of `pending#` + an `INSERT` of `<resolved>#` — the fan-out
  ([G4.6](phase-g4.6-reactive-websocket-streaming.md)) must map both to the same card, not two cards.
