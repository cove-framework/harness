# Phase G4.3 — Durable orchestrator — Step Functions Standard state machine

> Group 4 (Convex → AWS migration). This phase is the spine: it replaces `@convex-dev/workflow` with an
> AWS Step Functions **STANDARD** state machine that drives the thin G4.2 Lambdas. **The thesis lives or
> dies here** — the orchestrator owns the durable loop; the LLM decides but does not control flow.

## Goal & scope

Translate the pure control flow of [`convex/engine/loop.ts`](../../../convex/engine/loop.ts) — the
`while (stepNumber < maxSteps)` orchestrator over a `RunLoopDeps` port — into an ASL **STANDARD** state
machine (`AgentLoop`) of Choice and Map states driving the single-purpose Lambdas defined in
[G4.2](phase-g4.2-compute-lambda-actions.md). Specifically this phase owns:

- **Control-flow transcription.** Every branch of `loop.ts` (overflow → compact-retry; zero-tool freeform
  finish vs result re-nudge; HITL gate; result `finished`/`gave_up`/`pending`; step-cap fail; threshold
  compaction) becomes an ASL `Choice`/`Map`/`Task` transition. `loop.ts` stays in the repo as the
  executable **spec** the ASL is transcribed from and parity-tested against (D-AWS-9).
- **The durable journal + per-step idempotency.** Reproduce the two `@convex-dev/workflow` guarantees —
  (a) journaled checkpoints, (b) at-most-once side effects — on top of DynamoDB + SFN execution history.
  SFN gives (a) natively but delivers Tasks **at-least-once**, so (b) becomes a per-Lambda idempotency
  obligation keyed on `(requestId, stepNumber, op)`.
- **Loop counters in SFN state.** `stepNumber`/`followUps`/`overflowRetries` are carried in the SFN
  execution state object (the deterministic reconstruction `loop.ts` does in `let` locals), never
  re-derived from live mutable state.
- **Execution identity.** `workflow.start → convexWorkflowId` becomes `StartExecution(name=submissionId)`
  → `executionArn` stamped on the **Requests** item.
- **Stop / supersede / cancel.** `workflow.cancel` becomes `StopExecution(executionArn)` with the DynamoDB
  `status=cancelled` conditional write authoritative (D-AWS-14).
- **Continue-as-new** to bound the SFN 25k-event history (D-AWS-12).

**Out of scope (owned elsewhere, cross-linked):** the Lambda bodies themselves
([G4.2](phase-g4.2-compute-lambda-actions.md)); the HITL `.waitForTaskToken` park/submit details
([G4.4](phase-g4.4-hitl-task-tokens.md)); `admit`/`poll`/authorizer and the actual `StartExecution`
call-site ([G4.5](phase-g4.5-ingress-apigw-auth.md)); the WS fan-out that consumes finalized-step writes
([G4.6](phase-g4.6-reactive-websocket-streaming.md)); the terminal Reply Task wiring, `workflow.invoke`,
and the `runAfter(0, compact)` async-invoke ([G4.7](phase-g4.7-channels-workflows-scheduler.md)); the CDK
data layer, tables, GSIs and the `store/` seam ([G4.1](phase-g4.1-foundation-cdk-dynamodb.md)).

## Dependencies

- **[G4.1](phase-g4.1-foundation-cdk-dynamodb.md)** — the DynamoDB tables (`Sessions`, `Requests`,
  `Steps`, `Approvals`, `Events`, `Meta`), the `store/` adapter seam (`journalStore.ts`,
  `requestStore.ts`, `sessionStore.ts`), and the S3 spill pattern (D-AWS-10) MUST exist; the journal
  idempotency this phase relies on is realized by conditional writes in those stores.
- **[G4.2](phase-g4.2-compute-lambda-actions.md)** — the `setup`, `llmStep`, `dispatchTools`, `compact`,
  `finalize`, `mcpDiscover` Lambdas MUST be deployed and individually invokable; this phase only wires
  them as Task states and never reaches into their bodies.
- This phase **blocks** [G4.4](phase-g4.4-hitl-task-tokens.md) (adds the `AwaitApproval` Map),
  [G4.7](phase-g4.7-channels-workflows-scheduler.md) (adds the `Reply` Task), and is consumed by
  [G4.5](phase-g4.5-ingress-apigw-auth.md) (needs the state-machine ARN for `StartExecution`).

## Deliverables

In `backend/`:

- `backend/cdk/stacks/orchestrator-stack.ts` — a CDK `aws_stepfunctions.StateMachine`
  (`stateMachineType: StateMachineType.STANDARD`) named `AgentLoop`, its IAM role, the X-Ray/CloudWatch
  logging config, and `lambda.grantInvoke` for each G4.2 Lambda.
- `backend/sfn/agent-loop.asl.json` — the ASL definition, **generated from a TypeScript builder**
  (`backend/cdk/sfn/agentLoop.ts` using `aws_stepfunctions` + `aws_stepfunctions_tasks` constructs) and
  **checked in** so Step Functions Local tests in [G4.8](phase-g4.8-tests-parity-cutover.md) run the exact
  deployed graph.
- A **preflight** helper Task/state (`McpDiscoverChoice`) reading `getMcpServers` from the Requests item.
- The **continue-as-new** `RestartChoice` + `StartExecution` self-restart wiring.
- The `StopExecution`-on-cancel path: a `requestStore.cancelActiveRequests` helper (DynamoDB-authoritative)
  invoked by [G4.5](phase-g4.5-ingress-apigw-auth.md)'s `admit`, plus a `status=cancelled` self-abort
  check at each Task-Lambda entry (defense in depth).
- A `sfn/state.ts` TypeScript type for the SFN state object passed between states
  (`{ requestId, sessionId, stepNumber, followUps, overflowRetries, maxSteps, maxFollowUps,
  hasResultSchema, overflowRetryBudget, compactEnabled, decision }`).

## Source map

| Convex surface (replaced) | New AWS artifact (this phase) |
| --- | --- |
| [`convex/engine/runHandler.ts`](../../../convex/engine/runHandler.ts) — `workflow.define` handler running `runAgentLoop` over `step.run*` ports | `AgentLoop` ASL STANDARD state machine; each `RunLoopDeps` op → a Task state |
| [`convex/engine/loop.ts`](../../../convex/engine/loop.ts) — pure `while`-loop + branch order | ASL `Choice`/`Map` states; `loop.ts` retained as the parity spec (D-AWS-9) |
| `runHandler.ts:20-25` — `getMcpServers` query → `mcp.discover` action → `setup` mutation | `McpDiscoverChoice` (Choice) → `McpDiscover` (Task) → `Setup` (Task) |
| `runHandler.ts:36-37` — `decode: step.runAction(llmStep)` | `DecideStep` (Task → `llmStep` Lambda) |
| `runHandler.ts:38-40` — `dispatch: step.runAction(dispatchTools)` | `Dispatch` (Task → `dispatchTools` Lambda) |
| `runHandler.ts:41` — `getOutcome: step.runQuery(steps.getOutcome)` | `SettleResult`/`SettleResultZero` (Task → `getOutcome`); see [`steps.ts:231`](../../../convex/engine/steps.ts) |
| `runHandler.ts:42-48` — `appendFollowUp: step.runMutation(steps.appendFollowUp)` | `AppendFollowUp` (Task); see [`steps.ts:220`](../../../convex/engine/steps.ts) |
| `runHandler.ts:49-58` — `finalize: step.runMutation(finalize.run)` | `Finalize*` states (Task → `finalize` Lambda); see [`finalize.ts:17`](../../../convex/engine/finalize.ts) |
| `runHandler.ts:59-69` — `compact: step.runAction(compact.compact)` | `Compact` / `CompactRetry` (Task → `compact` Lambda) |
| `runHandler.ts:70-94` — `resolveApprovals` (park + `awaitEvent` loop) | `HitlChoice` → `AwaitApproval` **Map** (owned by [G4.4](phase-g4.4-hitl-task-tokens.md)) |
| `runHandler.ts:106` — `step.runAction(channels.reply.dispatch)` | `Reply` terminal Task (wired by [G4.7](phase-g4.7-channels-workflows-scheduler.md)) |
| [`convex/invoke/admit.ts:138-139,175-176,248-249`](../../../convex/invoke/admit.ts) — `workflow.start` → `convexWorkflowId` patch | `StartExecution(name=submissionId)` → `executionArn` on Requests (call-site in [G4.5](phase-g4.5-ingress-apigw-auth.md)) |
| [`admit.ts:60-84`](../../../convex/invoke/admit.ts) — `cancelActiveRequests` (`workflow.cancel` + status patch) | `requestStore.cancelActiveRequests`: conditional `status=cancelled` UpdateItem (authoritative) + best-effort `StopExecution` |
| [`convex/engine/decode.ts:1-13,55-80`](../../../convex/engine/decode.ts) — replay guard `loadStep → reconstructDecision` | the load-bearing idempotency contract for the `DecideStep` Task (re-invoke is model-free) |
| [`convex/engine/types.ts:90-104`](../../../convex/engine/types.ts) — `StepDecision` | the small `decision` summary `{overflow,toolCallCount,gatedCount,shouldCompact}` carried in SFN state; full `StepDecision` stays in DynamoDB |
| [`convex/engine/dispatchTools.ts:37-39,87-102`](../../../convex/engine/dispatchTools.ts) — `CHILD_POLL` `setTimeout` loop for `task()` | nested `StartExecution.sync` of `AgentLoop` (D-AWS-8; poll loop deleted) |
| `@convex-dev/workflow` journaled `step.run*` | SFN execution history (checkpoints) + DynamoDB journal (side-effect idempotency) |

`src/runtime/errors.ts` (`ResultUnavailableError`) stays portable; in SFN its "swallow-but-still-reply"
semantics ([`runHandler.ts:97-101`](../../../convex/engine/runHandler.ts)) become an explicit terminal
state that still transitions to `Reply` (see `FinalizeGaveUp`/`FinalizeFollowupsExhausted` below).

## Hardened-contract obligations

Every contract below comes from `loop.ts` and design doc
[`08 §4`](../../design/08-conventions-and-execution-boundary.md); the ASL transcription MUST preserve each.

1. **Orchestrator owns the loop (THESIS).** No single Lambda runs the `while`-loop. The control flow is
   the state machine's; each Lambda is a pure single-purpose Task. The one-orchestrator-Lambda design is
   explicitly rejected (D-AWS-9, locked decision #1) — it would reintroduce a 15-min-bound durable loop.
2. **The LLM decides but does not control flow (THESIS).** `DecideStep` (`llmStep`) returns a *decision
   summary* only (`{overflow, toolCallCount, gatedCount, shouldCompact}`); the SFN `Choice` states — not
   the model — pick the next state. `streamText`/`tool()` stay thin (no SDK agent loop / durability /
   HITL), preserved in [G4.2](phase-g4.2-compute-lambda-actions.md).
3. **Step cap → observable fail** ([`loop.ts:79,140-141`](../../../convex/engine/loop.ts); doc 08 §4.9).
   `StepCapChoice` (`stepNumber < maxSteps`) gates `DecideStep`; the false branch → `FinalizeStepCap`
   (`failed`, reason `step_limit_exceeded`) — a distinct terminal, never a silent stop.
4. **Overflow compact-retry** ([`loop.ts:86-95`](../../../convex/engine/loop.ts); Phase 4b).
   `OverflowChoice` → `OverflowBudgetChoice` (`overflowRetries < overflowRetryBudget && compactEnabled`)
   → `CompactRetry` then `overflowRetries++, stepNumber++` → `StepCapChoice`; else → `FinalizeOverflow`
   (`failed/context_overflow`). The overflow step appends **no** session entry
   ([`steps.ts:157-184` `finalizeOverflowStep`](../../../convex/engine/steps.ts)), so the retry re-decodes
   compacted history cleanly.
5. **Result re-nudge & termination** ([`loop.ts:97-113,125-129,149-160`](../../../convex/engine/loop.ts);
   doc 08 §4.10). `getOutcome` (`finished`/`gave_up`/`pending`) drives `ResultChoice`. `finished` →
   `FinalizeResult` (`completed`, validated `result`); `gave_up` → `FinalizeGaveUp`
   (`failed/gave_up`) → still routes to `Reply` (mirrors `ResultUnavailableError` being swallowed but the
   reply still posting); `pending` from the zero-tool path → `FollowUpBudgetChoice`
   (`followUps >= maxFollowUps` → `FinalizeFollowupsExhausted` else `AppendFollowUp`,
   `followUps++, stepNumber++`). Never resolve an unvalidated result.
6. **Threshold compaction is replay-deterministic** ([`loop.ts:131-137`](../../../convex/engine/loop.ts)).
   `CompactThresholdChoice` (`decision.shouldCompact && compactEnabled`) → `Compact` then `stepNumber++`.
   The `compact` Lambda guards on the existing `CompactionEntry` so a Task retry does **not** double-charge
   `generateText` (loop.ts:134 explicitly relies on this).
7. **At-most-once side effects under at-least-once delivery (journal idempotency).** SFN re-invokes the
   same Lambda with the same input on retry, so the existing replay guards are load-bearing, not
   belt-and-suspenders: `llmStep`'s `loadStep → reconstructDecision`
   ([`decode.ts:1-13`](../../../convex/engine/decode.ts)) makes a re-invoke model-free;
   `dispatchTools`'s `appendToolResult` is idempotent by `toolCallId`
   ([`steps.ts:187-217`](../../../convex/engine/steps.ts)) and it already skips already-resulted calls
   ([`dispatchTools.ts:135-143`](../../../convex/engine/dispatchTools.ts)); `finalize` is a terminal
   UpdateItem with a non-terminal condition. The idempotency key is **`(requestId, stepNumber, op)`**.
8. **Replay-reconstructable invariant (THESIS).** Every Task re-reads the **frozen runPlan** (Sessions
   HEADER, written once by `setup` — [`setup.ts:329-344`](../../../convex/engine/setup.ts)) + the
   journaled Steps; **nothing** is re-derived from live mutable state. Counters live in SFN state, mirroring
   `loop.ts`'s `let stepNumber/followUps/overflowRetries`.
9. **HITL gate ordering** ([`loop.ts:119-122`](../../../convex/engine/loop.ts);
   [`runHandler.ts:80-93`](../../../convex/engine/runHandler.ts)). `HitlChoice` (`gatedCount > 0`) →
   `AwaitApproval` Map with `maxConcurrency: 1` to preserve the sequential `for (const call of gatedCalls)`
   semantics, then → `Dispatch` which runs only the approved + ungated set. Park/submit internals are
   [G4.4](phase-g4.4-hitl-task-tokens.md); this phase only places the Map and its sequential constraint.
10. **Cross-service non-atomicity** (D-AWS-14). `StopExecution` + status write span two services. The
    DynamoDB conditional `status=cancelled` UpdateItem (`ConditionExpression status IN (pending,running)`)
    is **authoritative**; `StopExecution` is best-effort and swallows
    `ExecutionDoesNotExist`/already-terminal (mirrors [`admit.ts:73-77`](../../../convex/invoke/admit.ts)).

## Implementation tasks

Execute in order. Each item is independently checkable.

1. **Define the SFN state shape** (`backend/sfn/state.ts`). Type the JSON state object the machine threads:
   `{ requestId, sessionId, stepNumber, followUps, overflowRetries, maxSteps, maxFollowUps,
   hasResultSchema, overflowRetryBudget, compactEnabled, decision? }`. **Never** put `StepDecision`,
   `responseMessages`, `runPlan`, or tool rosters in state (256 KB SFN-state / 400 KB DynamoDB-item limits
   — D-AWS-10); Tasks read those from DynamoDB/S3 by id.

2. **Build the TS state-machine builder** (`backend/cdk/sfn/agentLoop.ts`) using
   `aws_stepfunctions_tasks.LambdaInvoke` (with `payloadResponseOnly: true`) and `aws_stepfunctions.Choice`/
   `Map`/`Pass`/`Succeed`. Emit the JSON to `backend/sfn/agent-loop.asl.json` for tests. Wire these states:
   - **`McpDiscoverChoice`** (Choice) — a tiny preflight reads `requestStore.getMcpServers(requestId)`;
     `mcpServers.length > 0` → `McpDiscover` else → `Setup`. Mirrors
     [`runHandler.ts:20-24`](../../../convex/engine/runHandler.ts).
   - **`McpDiscover`** (Task → `mcpDiscover` Lambda) → `Setup`. Result (`McpToolDescriptor[]`, may exceed
     256 KB) is written to DynamoDB by the Lambda, **not** returned in state.
   - **`Setup`** (Task → `setup` Lambda) — freezes runPlan to Sessions HEADER, flips status→running,
     returns the small scalars `{maxSteps, maxFollowUps, hasResultSchema, overflowRetryBudget,
     compactEnabled, sessionId}` ([`setup.ts:358`](../../../convex/engine/setup.ts) returns exactly this
     shape minus the SFN-specific scalars). Initialize `stepNumber=0, followUps=0, overflowRetries=0` via a
     `Pass`/`ResultPath`. → `StepCapChoice`.
   - **`StepCapChoice`** (Choice) — `stepNumber < maxSteps` → `DecideStep` else → `FinalizeStepCap`.
   - **`DecideStep`** (Task → `llmStep`) — returns `decision = {overflow, toolCallCount, gatedCount,
     shouldCompact}`. → `OverflowChoice`.
   - **`OverflowChoice`** (Choice) — `decision.overflow == true` → `OverflowBudgetChoice` else →
     `ZeroToolChoice`.
   - **`OverflowBudgetChoice`** (Choice) — `overflowRetries < overflowRetryBudget` AND `compactEnabled`
     → `CompactRetry` (Task → `compact`) → `Pass`(`overflowRetries++, stepNumber++`) → `StepCapChoice`;
     else → `FinalizeOverflow`.
   - **`ZeroToolChoice`** (Choice) — `decision.toolCallCount == 0`:
     `&& !hasResultSchema` → `FinalizeFreeform` (`completed`, `finalText`);
     `&& hasResultSchema` → `SettleResultZero` (Task → `getOutcome`) → `ResultChoice`;
     else → `HitlChoice`.
   - **`HitlChoice`** (Choice) — `decision.gatedCount > 0` → `AwaitApproval` (Map placeholder; body added by
     [G4.4](phase-g4.4-hitl-task-tokens.md), `maxConcurrency: 1`) → `Dispatch`; else → `Dispatch`.
   - **`Dispatch`** (Task → `dispatchTools`) → `ResultGateChoice`.
   - **`ResultGateChoice`** (Choice) — `hasResultSchema` → `SettleResult` (Task → `getOutcome`) →
     `ResultChoice`; else → `CompactThresholdChoice`.
   - **`ResultChoice`** (Choice on `getOutcome.type`) — `finished` → `FinalizeResult`; `gave_up` →
     `FinalizeGaveUp`; `pending` (zero-tool entry) → `FollowUpBudgetChoice`; `pending` (dispatch entry) →
     `CompactThresholdChoice`. (Disambiguate the two `pending` entries via a `resultPath` flag set on entry,
     since loop.ts reaches `settleResultRun` from two call sites with different continuations.)
   - **`FollowUpBudgetChoice`** (Choice) — `followUps >= maxFollowUps` → `FinalizeFollowupsExhausted`;
     else → `AppendFollowUp` (Task) → `Pass`(`followUps++, stepNumber++`) → `StepCapChoice`.
   - **`CompactThresholdChoice`** (Choice) — `decision.shouldCompact && compactEnabled` → `Compact` (Task)
     → `Pass`(`stepNumber++`) → `RestartChoice`; else → `Pass`(`stepNumber++`) → `RestartChoice`.
   - **`Finalize*`** (FinalizeFreeform/Result/GaveUp/StepCap/Overflow/FollowupsExhausted) — each a Task →
     `finalize` Lambda with the matching `{status, reason, finalText, result, error}` → `Reply`.
   - **`Reply`** (Task → `reply` Lambda; wired by [G4.7](phase-g4.7-channels-workflows-scheduler.md)) →
     `Succeed`.

3. **Wire loop counters via `Pass` states with `ResultPath`/`Parameters`** (SFN cannot increment inline).
   Each `stepNumber++`/`followUps++`/`overflowRetries++` is a `Pass` that recomputes the counter with
   intrinsic `States.MathAdd($.stepNumber, 1)` and writes it back. This is the SFN realization of
   `loop.ts`'s `let` mutations and is **the** deterministic-counter mechanism (do not store counters in
   DynamoDB — D-AWS-7).

4. **Continue-as-new (`RestartChoice`)** (D-AWS-12). After each `stepNumber++` (the back-edge of the
   loop), insert `RestartChoice`: if `stepNumber % RESTART_THRESHOLD == 0` (e.g. 40) →
   `RestartExecution` (a Task → `aws_stepfunctions_tasks.StepFunctionsStartExecution` against the **same**
   `AgentLoop` ARN, passing `{requestId, sessionId, stepNumber, followUps, overflowRetries}` plus a fresh
   re-read of the Setup scalars) → `Succeed` (this execution ends; the child carries the loop forward); else
   → `StepCapChoice`. The DynamoDB journal makes the restart boundary stateless — the child re-reads the
   frozen runPlan + Steps exactly as the parent would have. Use a non-`.sync` `StartExecution` here (the new
   execution replaces, not blocks).

5. **Per-Task retry & catch policy.** On each `LambdaInvoke` Task add `Retry` for the transient set
   (`Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`, `States.Timeout`,
   `Lambda.TooManyRequestsException`) with backoff. Because Tasks are at-least-once and the Lambdas are
   idempotent by `(requestId, stepNumber, op)`, retries are safe. Add a top-level `Catch` on `States.ALL`
   from the loop body → `FinalizeUnhandled` (`failed`, `error` = `$.Cause`) → `Reply`, so an unexpected
   throw still terminalizes + replies (mirrors `runHandler.ts`'s try/finally reply guarantee).

6. **`setup` Lambda contract additions** (consumed here, implemented in
   [G4.2](phase-g4.2-compute-lambda-actions.md)). `setup` must return `overflowRetryBudget`
   (default `DEFAULT_OVERFLOW_RETRY_BUDGET = 1` — [`loop.ts:23`](../../../convex/engine/loop.ts)) and
   `compactEnabled` (derived from the frozen `compaction !== false` —
   [`setup.ts:116-134`](../../../convex/engine/setup.ts)). `runHandler.ts:33` hard-codes the budget; here
   it is part of the returned scalars so the loop counters and the budget are co-located in SFN state.

7. **CDK orchestrator stack** (`orchestrator-stack.ts`). Create the `StateMachine`
   (`StateMachineType.STANDARD`), attach `logs` (ALL level) + X-Ray, and grant the execution role:
   `lambda:InvokeFunction` on each G4.2 Lambda ARN; `states:StartExecution` / `states:StopExecution` /
   `states:DescribeExecution` on its own ARN (for nested `.sync` child task runs and continue-as-new);
   nothing else (least privilege). Export the state-machine ARN as a CFN output + SSM parameter for
   [G4.5](phase-g4.5-ingress-apigw-auth.md)'s `admit` Lambda.

8. **Execution identity.** The `StartExecution` call-site lives in `admit`
   ([G4.5](phase-g4.5-ingress-apigw-auth.md)); this phase owns the **contract**: `name = submissionId`
   (deterministic — a duplicate `StartExecution` with the same name is an idempotent no-op, replacing the
   `crypto.randomUUID()` submissionId at [`admit.ts:116`](../../../convex/invoke/admit.ts) as the
   execution key), and the returned `executionArn` is stamped onto the Requests item field `executionArn`
   (was `convexWorkflowId` — [`admit.ts:138-139`](../../../convex/invoke/admit.ts)). Define the
   `requestStore.setExecutionArn(requestId, arn)` helper here.

9. **Cancel / supersede / stop** — implement `requestStore.cancelActiveRequests(sessionId, reason)`
   replacing [`admit.ts:60-84`](../../../convex/invoke/admit.ts): Query Requests GSI2
   (`by_session_and_status`, `status ∈ {pending, running}`); for each, conditional UpdateItem
   `SET status=cancelled, cancelReason=:r` `ConditionExpression status IN (pending,running)`
   (**authoritative**); then best-effort `StopExecution(executionArn)` swallowing
   `ExecutionDoesNotExist`/already-terminal. Add a `status=cancelled` strongly-consistent GetItem self-abort
   check at the entry of each Task Lambda (defense in depth — `dispatchTools` already does this between
   tools, [`dispatchTools.ts:147-148`](../../../convex/engine/dispatchTools.ts)).

10. **Child `task()` → nested `StartExecution.sync`** (D-AWS-8). Delete the `CHILD_POLL`
    `setTimeout`/`CHILD_POLL_DEADLINE_MS` loop ([`dispatchTools.ts:37-39,87-102`](../../../convex/engine/dispatchTools.ts)).
    A `task()` tool-call becomes `dispatchTools` returning a "needs-child" marker that the state machine
    services via `StepFunctionsStartExecution` with `integrationPattern: RUN_JOB` (`.sync`) against
    `AgentLoop` — the parent blocks on the child's terminal state natively (no poll, no 200 s deadline).
    The child's final answer is read back from DynamoDB and written as the parent's `task` tool-result.
    *(The exact partition/fan-out of multiple `task()` calls into a `Map` of `.sync` executions is detailed
    in [G4.2](phase-g4.2-compute-lambda-actions.md)/[G4.7](phase-g4.7-channels-workflows-scheduler.md); this
    phase owns that SFN — not a Lambda — owns subagent fan-out.)*

11. **S3 spill plumbing** (D-AWS-10). Confirm `DecideStep`/`Dispatch` never pass `responseMessages` or a
    large `runPlan` through SFN state; the Lambdas follow the `Blobs.s3Key` pointer pattern from
    [G4.1](phase-g4.1-foundation-cdk-dynamodb.md). The state machine only ever carries ids + scalars.

12. **Checked-in ASL + a `cdk synth` diff guard.** Add a CI step that regenerates `agent-loop.asl.json`
    from the builder and fails if it drifts from the checked-in copy (so the SFN-Local parity tests in
    [G4.8](phase-g4.8-tests-parity-cutover.md) always run the deployed graph).

## Acceptance

Objective bars — each mirrors a `loop.ts` behavior or a `@convex-dev/workflow` guarantee.

- **Branch parity.** A property/transcription test asserts the ASL graph reproduces `loop.ts`'s decision
  tree edge-for-edge: overflow→compact-retry vs overflow→fail; zero-tool freeform finish vs result
  re-nudge; HITL gate before dispatch; result `finished`/`gave_up`/`pending`; step-cap fail; threshold
  compaction. (Run `loop.ts` against a mock `RunLoopDeps` and the ASL against Step Functions Local with the
  same mocked Lambdas; the visited-state sequences must match — [G4.8](phase-g4.8-tests-parity-cutover.md).)
- **Step cap.** A run that never terminates reaches `FinalizeStepCap` at `stepNumber == maxSteps` and the
  Requests item ends `status=failed, error=step_limit_exceeded` (not a silent stop) — parity with
  [`loop.ts:140-141`](../../../convex/engine/loop.ts).
- **Result termination.** A result-schema run that fires `finish` ends `completed` with the validated
  `result`; one that fires `give_up` ends `failed/gave_up` **and still runs `Reply`**; one that exhausts
  `maxFollowUps` ends `failed/result_followups_exhausted` — parity with
  [`loop.ts:104-113,149-160`](../../../convex/engine/loop.ts).
- **Overflow.** A provider overflow with budget remaining compacts and advances to a fresh step that
  re-decodes compacted history (no session entry appended for the overflow step); budget exhausted →
  `FinalizeOverflow` (`context_overflow`) — parity with [`loop.ts:86-95`](../../../convex/engine/loop.ts).
- **Crash recovery (the load-bearing test).** Kill the execution mid-loop (after `DecideStep` finalizes a
  step, before `Dispatch`); on resume/redeploy the re-invoked `DecideStep` returns the **cached** decision
  (no second model call), `Dispatch` re-runs only tools whose result item is absent, and counters resume
  intact. Equivalent to Convex journal replay; proven against LocalStack +
  [G4.8](phase-g4.8-tests-parity-cutover.md).
- **At-most-once side effects.** Force a Task retry (inject a transient error) and assert: the model is
  called ≤ once per finalized step, `compact`'s `generateText` runs ≤ once per `CompactionEntry`, and no
  tool result is double-appended (toolCallId idempotency).
- **Execution identity.** Two `StartExecution(name=submissionId)` with the same submissionId yield one
  execution; the Requests item carries the `executionArn`.
- **Cancel/supersede.** `cancelActiveRequests` flips `status=cancelled` even when `StopExecution` 404s
  (DynamoDB authoritative); an in-flight Task self-aborts on its next status check; a supersede during a
  parked HITL run abandons the parked token (verified jointly with
  [G4.4](phase-g4.4-hitl-task-tokens.md)).
- **History bound.** A 100-step run crosses `RESTART_THRESHOLD` ≥ 2 times, continues-as-new, and completes
  without hitting the 25k execution-history cap.

## Risks & gotchas

- **SFN at-least-once is not optional to reason about.** The whole journal-idempotency contract rests on it.
  If any Task Lambda's replay guard regresses (decode's `reconstructDecision`, compact's `CompactionEntry`
  check, `appendToolResult`-by-toolCallId), a retry double-charges the model/summarizer or double-appends a
  result. These are *mandatory*, owned in [G4.2](phase-g4.2-compute-lambda-actions.md) but **gated by this
  phase's crash-recovery acceptance test**.
- **25k execution-history cap.** `maxSteps=100` × several states/step + the HITL Map + retries +
  `maxFollowUps=32` follow-ups can approach the cap. Continue-as-new (task 4) **must** ship before any
  long-roster run; without it long runs fail mid-loop (D-AWS-12, risks list).
- **256 KB SFN-state limit.** A naive port that threads `StepDecision`/`responseMessages` through state
  breaches it on the first large-roster step. Carrying only ids + scalars (task 1) is non-negotiable; the
  S3 spill (task 11, D-AWS-10) backs it.
- **The two `pending` continuations.** `settleResultRun` is reached from both the zero-tool path
  ([`loop.ts:104`](../../../convex/engine/loop.ts)) and the dispatch path
  ([`loop.ts:127`](../../../convex/engine/loop.ts)) with *different* continuations on `pending`
  (FollowUpBudget vs CompactThreshold). The ASL must disambiguate via an entry flag, or it will mis-route a
  pending dispatch into the follow-up budget (an off-by-one re-nudge bug).
- **Cross-service non-atomicity window** (D-AWS-14). A crash between `StopExecution` and the status write
  leaves a `cancelled` row with a running execution (or vice versa). Mitigated by DynamoDB-authoritative +
  Task self-abort, but it is a latent inconsistency window to call out on the cutover checklist.
- **`Pass`-state counter arithmetic.** SFN has no inline `i++`; every counter bump is a `Pass` with
  `States.MathAdd`. Forgetting one (e.g. on the compact-retry back-edge) yields an infinite loop that only
  the step cap eventually catches — verify each back-edge increments exactly once.
- **Nested `.sync` IAM + recursion.** The state machine must grant itself `states:StartExecution` /
  `DescribeExecution` on its own ARN for both continue-as-new and child `task()`; deep `task()` trees of
  `.sync` executions still consume parent history until the child terminates — bound child depth as today.
- **ASL drift.** If the checked-in `agent-loop.asl.json` diverges from the deployed builder output, the
  SFN-Local parity tests test a stale graph. The `cdk synth` diff guard (task 12) is the only thing keeping
  the spec honest.
