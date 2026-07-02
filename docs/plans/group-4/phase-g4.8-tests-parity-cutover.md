# Phase G4.8 — Tests, parity & the hard Convex cutover

> Group 4 (Convex → AWS migration). This is the **terminal, gating** phase. It replaces the entire
> `convex-test` suite (424 test cases across 57 files — the "412-test suite" of the spine, here counted
> exactly) with a test stack that has **no Convex deployment to run against**: Step Functions Local + ASL
> state-machine tests, `aws-sdk-client-mock` for unit-level store/handler tests, and **LocalStack** for
> integration. It proves **durable crash-recovery on SFN** (kill mid-loop → resume from the DynamoDB journal),
> walks the **parity checklist** against the hardened contracts in
> [`../../design/08`](../../design/08-conventions-and-execution-boundary.md) §3–§4, and then performs the
> **HARD cutover**: `convex/`, `@convex-dev/workflow`, `@convex-dev/workpool`, `convex`, `convex-helpers`, and
> `convex-test` are DELETED; the portable cores are MOVED into ONE consolidated `backend/` folder; `cove init`
> scaffolds the AWS stack and `cove deploy` becomes `cdk deploy`.

## Goal & scope

This phase owns the **proof of parity** and the **irreversible switch**. Concretely:

- **The replacement test stack.** Because the edge-runtime VM that ran `convexTest(schema)`
  ([`vitest.config.ts:22-29`](../../../vitest.config.ts)) is gone with `convex/`, every test that touched a
  live Convex adapter is re-platformed onto one of three rungs: (1) **pure units** — the portable cores keep
  their existing specs verbatim (they never imported Convex); (2) **store/handler units** — `aws-sdk-client-mock`
  mocks `DynamoDBDocumentClient`/`SFNClient`/`S3Client` so a handler's idempotency + conditional-write
  semantics are asserted without a network; (3) **integration** — **LocalStack** stands up real DynamoDB +
  Streams + S3 + SFN + API Gateway in a container, and **Step Functions Local** validates the `agent-loop.asl.json`
  ASL and runs the machine with mocked Task results.
- **The crash-recovery E2E.** A direct successor to
  [`tests/e2e/recovery.test.ts`](../../../tests/e2e/recovery.test.ts): start an `AgentLoop` execution under
  LocalStack/SFN-Local, **kill it mid-loop** (abort the execution between `DecideStep` and `Dispatch`),
  re-drive from the journal, and assert the model/summarizer was **not** re-invoked and no tool result was
  double-written — the SFN at-least-once analogue of the three persistence invariants that test proves today.
- **The parity checklist.** A line-by-line mapping of every hardened contract (08 §4.1–§4.15) and every actor
  boundary (08 §3) to the test that proves it survived the migration, plus the `surfaceMapping` table from the
  spine as the "every Convex surface has an AWS owner" ledger.
- **The HARD cutover.** Delete `convex/` (119 `.ts` files), the three Convex deps + `convex-test`, and the
  `convex`/`deploy` npm scripts; MOVE the portable cores into `backend/engine/`, `backend/runtime/`,
  `backend/channels/`, `backend/registries/`; retarget `cove init`/`cove deploy`/`cove dev`
  ([`src/cli/commands/`](../../../src/cli/commands/)) to scaffold and `cdk deploy/watch` the AWS stack.
- **Packaging, CI/CD, and rollback posture.** `cove init` vendors `backend/` instead of `convex/`; CI runs the
  three test rungs + `cdk synth` + ASL validation; rollback is a CDK/CloudFormation concern (the convex backend
  is gone — rollback is "redeploy the prior CDK stack version", not "flip back to Convex").

**Out of scope (owned elsewhere, cross-linked):**

- The resources under test are **authored** by their owning phases; G4.8 only *exercises* them. The DynamoDB
  tables + `store/` seam → [G4.1](phase-g4.1-foundation-cdk-dynamodb.md); the task Lambdas →
  [G4.2](phase-g4.2-compute-lambda-actions.md); the `AgentLoop` state machine + journal idempotency →
  [G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md); HITL task tokens →
  [G4.4](phase-g4.4-hitl-task-tokens.md); ingress + authorizer → [G4.5](phase-g4.5-ingress-apigw-auth.md); the
  WS reactive substrate → [G4.6](phase-g4.6-reactive-websocket-streaming.md); channels/workflows/scheduler →
  [G4.7](phase-g4.7-channels-workflows-scheduler.md).
- The **per-phase acceptance bars** live in each phase doc; this phase aggregates them into the **cutover gate**
  and adds only the cross-cutting parity + crash-recovery + delete-and-move bars.

## Dependencies

- **ALL of G4.1–G4.7.** This is the join point of the build order — the cutover cannot complete until every
  Convex surface has a deployed AWS owner. The crash-recovery E2E needs the full G4.3 state machine + G4.2
  Lambdas + G4.1 journal; the parity run needs every contract's AWS implementation present.
- **[G4.1](phase-g4.1-foundation-cdk-dynamodb.md)** — the `store/` adapter seam and the 9 DynamoDB tables are
  the substrate every `aws-sdk-client-mock` and LocalStack test binds to. The CDK app (`backend/cdk/`) is what
  `cdk synth`/`cdk deploy` in CI act on.
- **[G4.3](phase-g4.3-durable-orchestrator-stepfunctions.md)** — `backend/sfn/agent-loop.asl.json` (the
  checked-in, CDK-generated ASL) is the artifact the Step Functions Local tests validate and execute; the
  journal-idempotency keys `(requestId, stepNumber, op)` are what the crash-recovery E2E asserts.
- **The portable cores must already be `convex/`-free** (no `ctx.db`/`ctx.scheduler`/`ctx.storage` import) so
  that MOVING them into `backend/` is a path change, not a rewrite. `loop.ts` already declares itself "Pure /
  V8-safe: no Convex, no AI SDK" ([`loop.ts:15`](../../../convex/engine/loop.ts)).

## Deliverables

In `backend/` and at repo root:

- **`backend/cdk/`-rooted CI artifacts:** a `cdk synth` step (renders all 6 stacks) + a CDK assertions test
  (`aws-cdk-lib/assertions` `Template.fromStack`) per stack asserting the spine's resource shape (9 DynamoDB
  tables; Streams `NEW_IMAGE` on `Steps`/`Events`/`Requests`/`Approvals` only; the `AgentLoop` STANDARD state
  machine; the REST + WS APIs).
- **`backend/sfn/__tests__/agent-loop.asl.test.ts`** — Step Functions Local: load `agent-loop.asl.json`,
  `CreateStateMachine`, and run it with **mocked Task results** (the SFN-Local `MockConfigFile` feature) to
  assert each branch of `loop.ts` is transcribed faithfully (Choice ordering, the overflow/zero-tool/HITL/result/
  step-cap/compact-threshold branches, the continue-as-new `RestartChoice`).
- **`backend/__tests__/recovery.e2e.test.ts`** — the durable crash-recovery E2E against LocalStack (DynamoDB +
  Streams + S3 + SFN). Successor to [`tests/e2e/recovery.test.ts`](../../../tests/e2e/recovery.test.ts).
- **`backend/store/__tests__/*.test.ts`** — `aws-sdk-client-mock` units for every `store/` module: conditional-put
  idempotency, atomic-counter `seq`/`position`, idempotent `appendToolResult` by `toolCallId`, `repliedAt`
  exactly-once guard.
- **`backend/handlers/**/__tests__/*.test.ts`** — handler units (mocked clients) for `llmStep` replay guard,
  `dispatchTools` cancel short-circuit, `park`/`submitApproval` two-sided guard, `inboundChannel` raw-byte verify.
- **`docs/plans/group-4/PARITY.md`** (or a `## Parity checklist` table here) — the contract → test ledger.
- **The cutover commit(s):** `git rm -r convex/`; `package.json` deletes `convex`, `convex-helpers`,
  `@convex-dev/workflow`, `@convex-dev/workpool`, `convex-test`, `@edge-runtime/vm`; removes the `convex`/`deploy`
  scripts; the portable cores MOVED to `backend/`; `vitest.config.ts` re-projected (no `edge-runtime` project).
- **Retargeted CLI** ([`src/cli/commands/deploy.ts`](../../../src/cli/commands/deploy.ts),
  [`init.ts`](../../../src/cli/commands/init.ts), [`dev.ts`](../../../src/cli/commands/dev.ts)) — `cove deploy`
  runs `build()` fail-closed then `cdk deploy` (not `npx convex deploy`); `cove init` vendors `backend/`; `cove
  dev` runs `cdk watch`.
- **CI/CD workflow** — units → store/handler mocks → `cdk synth` + ASL validation → LocalStack integration →
  crash-recovery E2E; deploy job runs `cdk deploy` to a staging account.

## Source map

The convex/* test + tooling surface this phase replaces → the new AWS test + tooling files it creates.

| Convex surface (deleted) | AWS replacement (created) |
| --- | --- |
| [`vitest.config.ts`](../../../vitest.config.ts) `integration` project (`environment: edge-runtime`, `convex-test` inline) | `vitest.config.ts` with a `localstack` project (Node env, AWS SDK pointed at `http://localhost:4566`) + the `node` units project unchanged |
| [`tests/e2e/recovery.test.ts`](../../../tests/e2e/recovery.test.ts) (`convexTest(schema)` finalized-row + idempotent `appendToolResult`/`insertStreaming`) | `backend/__tests__/recovery.e2e.test.ts` (LocalStack SFN execution killed mid-loop → journal resume; same three invariants under at-least-once Tasks) |
| [`tests/e2e/compaction.test.ts`](../../../tests/e2e/compaction.test.ts) (`CompactionEntry` store invariant) | `backend/store/__tests__/sessionStore.compaction.test.ts` (DynamoDB `aws-sdk-client-mock`) + a LocalStack compact-idempotency E2E |
| [`tests/contract/session-store.test.ts`](../../../tests/contract/session-store.test.ts), [`run-store.test.ts`](../../../tests/contract/run-store.test.ts), [`event-stream-store.test.ts`](../../../tests/contract/event-stream-store.test.ts) (3 store-contract harnesses) | `backend/store/__tests__/{sessionStore,runStore,eventStore}.contract.test.ts` — the SAME contract-harness shape rebound from `ctx.db` to the `DynamoDBDocumentClient` port |
| [`tests/perf/throughput.test.ts`](../../../tests/perf/throughput.test.ts) (delta-batcher through real `patchStreaming`) | `backend/handlers/tasks/__tests__/llmStep.delta.test.ts` (deltaBatcher sink → mocked `postToConnection`; **no DynamoDB write per delta** — D-AWS-3) |
| `convex/engine/__tests__/*` (11 files: loop/decode/dispatch/hitl/usage/retry/buildTools/resultTools/entries/frameworkTools/deltaBatcher) | MOVED verbatim to `backend/engine/__tests__/*` — pure cores, no Convex import; only the import paths change |
| `convex/channels/__tests__/*`, `convex/mcp/__tests__/*`, `convex/providers/__tests__/*`, `convex/sandbox/__tests__/*`, `convex/sessions/__tests__/*`, `convex/observability/__tests__/*` | MOVED verbatim to the matching `backend/` subtree (all pure) |
| [`convex/__tests__/registries.test.ts`](../../../convex/__tests__/registries.test.ts) | MOVED to `backend/registries/__tests__/registries.test.ts` |
| [`src/**/__tests__/*`](../../../src) (runtime/react/sdk/cli) | UNCHANGED in place — these never imported Convex; only `cli` specs gain `cdk` assertions |
| [`convex.config.ts`](../../../convex/convex.config.ts) (`app.use(workflow)`) | DELETED — no component graph; the state machine is `backend/cdk/stacks/orchestrator-stack.ts` |
| [`convex/schema.ts`](../../../convex/schema.ts) (10 tables + ~20 indexes) | DELETED — replaced by `backend/cdk/stacks/data-stack.ts` (G4.1) |
| [`src/cli/commands/deploy.ts`](../../../src/cli/commands/deploy.ts) (`npx convex deploy`) | retargeted to `cdk deploy` (keep the fail-closed `build()` precondition) |
| [`src/cli/commands/dev.ts`](../../../src/cli/commands/dev.ts) (`convex dev`) | retargeted to `cdk watch` (+ optional LocalStack/`cdklocal`) |
| [`src/cli/commands/init.ts`](../../../src/cli/commands/init.ts) (vendors `convex/`) | vendors `backend/` (the consolidated folder) |
| `package.json` deps `convex`, `convex-helpers`, `@convex-dev/workflow`, `@convex-dev/workpool`; devDeps `convex-test`, `@edge-runtime/vm` | DELETED; add `aws-cdk-lib`, `constructs`, `aws-sdk-client-mock`, `@aws-sdk/*` clients, `aws-cdk-local`/LocalStack tooling (devDeps) |

## Hardened-contract obligations

This phase does not *implement* the contracts — it **proves** they survived. Each must have a named test on the
parity checklist; the THESIS clauses are the non-negotiable column.

- **THESIS — orchestrator owns the durable loop.** The crash-recovery E2E is the load-bearing proof: a killed
  execution resumes from the DynamoDB journal + SFN execution history, never from live mutable state. The test
  must assert resume re-reads the frozen `runPlan` (Sessions `HEADER`) + journaled `Steps` and that the loop
  counters (`stepNumber/followUps/overflowRetries`) come from SFN state, not a re-derivation (mirrors
  [`loop.ts:74-77`](../../../convex/engine/loop.ts)).
- **THESIS — the LLM decides but does not control flow.** The ASL test asserts every branch in
  `agent-loop.asl.json` is a Choice/Map state evaluating a *small decision summary* (`{overflow, toolCallCount,
  gatedCount, shouldCompact}`) — never the model steering the machine. The branch order must match `loop.ts`
  exactly (overflow → zero-tool → HITL → dispatch → result → compact-threshold → step-cap).
- **THESIS — tools dispatch OOB in the EC2/Docker sandbox with NO AI-SDK `execute`.** A handler unit asserts the
  `tool()` objects built in `llmStep` carry **no `execute`** (the decode.ts contract, 08 §3 / 04) and that tool
  execution happens only in `dispatchTools` against the resolved `SessionEnv` (D-AWS-15, EC2/Docker over SSM —
  not `@upstash/box`). Grep-gate in CI: no `execute:` inside the `tool()` builder.
- **THESIS — the AI SDK stays THIN.** A boundary test asserts `streamText`/`generateText`/`tool()` appear ONLY
  in `llmStep`/`compact` Lambdas — no SDK agent loop, durability, HITL, telemetry, or sandbox above the model
  boundary (the `convex/providers/__tests__/boundary.test.ts` + `sandbox/__tests__/boundary.test.ts` pattern,
  moved and re-pointed at `backend/`).
- **THESIS — replay-reconstructable.** Every E2E asserts a step consumes only `{frozen runPlan + journaled
  DynamoDB state}`; nothing re-derived from live mutable state. The S3-spill round-trip (D-AWS-10) is tested:
  a >256 KB `responseMessages` spills to S3 and `reconstructDecision` follows the pointer.
- **§4.1 `llmStep` replay determinism (critical).** The decode unit (moved verbatim) proves
  `loadStep → reconstructDecision` returns the cached `StepDecision` without a model call; the LocalStack E2E
  proves it end-to-end under an SFN **at-least-once Task retry** — re-invoking the SAME `llmStep` Lambda with
  the SAME input does NOT re-call the model. This is the single sharpest at-least-once obligation (D-AWS-7).
- **§4.5 idempotent `appendToolResult` by `toolCallId`.** The successor to
  [`recovery.test.ts:69-92`](../../../tests/e2e/recovery.test.ts): a replayed `dispatchTools` writes exactly one
  tool-result child item (`SK=STEP#<n>#TR#<toolCallId>`) per `toolCallId`. Plus the MCP de-dup (network call
  not re-issued on replay).
- **§4.3 cancel short-circuit.** Assert `dispatchTools` re-reads `Requests` status with a **strongly-consistent
  GetItem on the base item** (never a GSI) before AND after each tool; a cancelled run skips remaining tools.
- **§4.4 HITL state machine.** Assert the two-sided early-submit guard (D-AWS-5): an approval that arrives
  *before* the park self-completes via the park Lambda's `SendTaskSuccess`; a double-submit 409s
  (`status = pending` condition fails); the `maxConcurrency:1` Map preserves sequential `for (const call of
  gatedCalls)` semantics; an `approval_timeout` Catch terminalizes `failed`.
- **§4.6 streaming commit.** Assert deltas go to `postToConnection` ONLY (no per-token DynamoDB write,
  D-AWS-3) and that ONLY `finalizeStep` writes the `Steps` table; the throughput successor proves the
  batcher cadence (`deltaBatchMs=400`, `deltaBatchChars=480`).
- **§4.9 step cap / §4.10 result re-nudge.** Assert the ASL `StepCapChoice` fails `step_limit_exceeded` at the
  cap and `FollowUpBudgetChoice` fails `result_followups_exhausted` at `maxFollowUps`, with the `CallHandle`
  rejecting `ResultUnavailableError` — distinct from a model-driven `completed`. The `loop.test.ts` cases
  (moved verbatim) remain the executable spec the ASL is checked against (D-AWS-9).
- **§4.7 usage fidelity / §4.8 image pipeline.** Assert the usage rollup carries `cacheRead`/`cacheWrite`/
  `cacheWrite1h` + `cost{}` through a `Steps` Query rollup; assert images >100 KB land in S3 via `Blobs.s3Key`
  with `refCount` GC.
- **Continue-as-new (D-AWS-12).** Assert a run crossing the step threshold `RestartChoice`-es into a fresh
  `StartExecution` carrying the counters, and that the journal makes the boundary stateless (no lost/duplicated
  step). This guards the 25,000-event SFN history cap.

## Implementation tasks

An ordered, checkable list. Earlier rungs gate later ones; the delete-and-move is LAST.

1. **[ ] Re-project `vitest.config.ts`.** Drop the `integration` (`edge-runtime`) project. Keep the `node`
   `units` project (now globbing `backend/**/__tests__` + `src/**/__tests__`). Add a `localstack` project (Node
   env, `setupFiles` that point the AWS SDK clients at `http://localhost:4566` and provision tables/S3/SFN via
   `cdklocal deploy` or a fixture). Preserve the per-file `happy-dom` pragma for `src/react`.
2. **[ ] Move the pure-core specs.** `git mv` the 11 `convex/engine/__tests__/*` + the channels/mcp/providers/
   sandbox/sessions/observability/registries specs into the matching `backend/` subtree; fix relative imports
   only. These pass unchanged — they never imported Convex. CI gate: the moved suites are green before any
   adapter work.
3. **[ ] Author the `store/` unit tests with `aws-sdk-client-mock`.** For each `backend/store/*.ts`:
   `mockClient(DynamoDBDocumentClient)`; assert (a) create-once uses `ConditionExpression
   attribute_not_exists(pk)` and a duplicate throws `ConditionalCheckFailedException`; (b) `events.seq` /
   `sessionEntries.position` use `UpdateItem ADD :1 RETURN_VALUES UPDATED_NEW` against the `SEQCOUNTER`/
   `ENTCOUNTER` item — NOT read-max+1 (D-AWS-4); (c) `appendToolResult` is idempotent by `toolCallId`;
   (d) `repliedAt` is a conditional `SET … IF attribute_not_exists(repliedAt)`. These are the moved successors
   of the three `tests/contract/*` harnesses.
4. **[ ] Author the handler unit tests (mocked clients).** `llmStep` replay guard (mock a finalized `Steps`
   item → assert no `streamText`); `dispatchTools` cancel short-circuit (mock `Requests.status=cancelled` →
   assert remaining tools skipped); `park`/`submitApproval` two-sided guard (mock `SFNClient` `SendTaskSuccess`);
   `inboundChannel` raw-byte verify (feed `isBase64Encoded` body → assert HMAC over exact bytes; assert
   `markWebhookSeen` conditional Put runs BEFORE `StartExecution`).
5. **[ ] Add Step Functions Local ASL tests.** Stand up `amazon/aws-stepfunctions-local` (container or jar).
   `CreateStateMachine` from `backend/sfn/agent-loop.asl.json`; use a `MockConfigFile` to script Task outputs and
   assert each `loop.ts` branch (free-form complete; tool-calls → dispatch; overflow → compact-retry then
   `FinalizeOverflow` at budget; zero-tool + result-schema → settle/re-nudge; HITL Map; step-cap fail;
   compact-threshold; `RestartChoice` continue-as-new). The `loop.test.ts` scenarios are the oracle.
6. **[ ] Add CDK assertion tests.** `Template.fromStack` per stack: exactly 9 DynamoDB tables; `StreamSpecification
   NEW_IMAGE` on `Steps`/`Events`/`Requests`/`Approvals` and ABSENT on `Sessions`/`Skills`/`Blobs`/`Meta`/`Runs`;
   the `AgentLoop` `Type: STANDARD`; the REST API authorizer is `REQUEST`-type; the WS API has `$connect`/
   `$disconnect`/`subscribe` routes; least-privilege IAM (no `dynamodb:*` wildcard on a Lambda role).
7. **[ ] Build the LocalStack integration harness.** A docker-compose or testcontainers fixture: LocalStack with
   `dynamodb,s3,stepfunctions,apigateway,lambda,iam`. Deploy the CDK app with `cdklocal` (or seed tables/SFN
   directly). Provide a `seedRequest()` helper mirroring `recovery.test.ts`'s `setup()` (open a session via the
   `sessionStore`, insert a `running` Requests item).
8. **[ ] Write the crash-recovery E2E.** Start an `AgentLoop` execution; after `DecideStep` finalizes step 0 and
   `Dispatch` writes one tool-result, `StopExecution` (the kill) BEFORE the loop advances; re-`StartExecution`
   with the same `{requestId, stepNumber}` (simulating SFN re-drive / redeploy resume). Assert: the `Steps`
   table has exactly ONE finalized row per `stepNumber`, exactly ONE tool-result per `toolCallId`, the model
   mock recorded ZERO additional calls, and the `compact` CompactionEntry was not double-written. This is the
   at-least-once analogue of [`recovery.test.ts`](../../../tests/e2e/recovery.test.ts)'s three invariants.
9. **[ ] Write the S3-spill + continue-as-new E2E.** A large-roster run spills `responseMessages` to S3
   (D-AWS-10) and `reconstructDecision` follows the pointer on replay; a 40+ step run triggers `RestartChoice`
   and completes across executions with a single journal (D-AWS-12).
10. **[ ] Author the parity checklist** (`PARITY.md` / the table below): every 08 §4.x contract + every
    `surfaceMapping` row → its proving test, with a status column. Block cutover on 100% green.
11. **[ ] Audit the `runs`-table parity gap.** The spine flags that `runs` currently has NO writer
    ([`convex/runs.ts`](../../../convex/runs.ts) is read-only inspect; D18/G2.4 pending). Confirm the SFN
    execution lifecycle writes the `Runs` item (G4.3) and add a parity test, or explicitly record it as a known
    deferred gap — it must not be silently missed.
12. **[ ] Retarget the CLI.** `cove deploy` ([`deploy.ts`](../../../src/cli/commands/deploy.ts)) keeps its
    fail-closed `build()` precondition but spawns `cdk deploy` instead of `npx convex deploy`; `cove dev` →
    `cdk watch`; `cove init` ([`init.ts`](../../../src/cli/commands/init.ts)) vendors `backend/` (drop the
    `convex/`-specific `_generated`/`_cove`/demo exclusions and re-target them at the backend layout). Update
    `src/cli/__tests__/{init,codegen}.test.ts` expectations.
13. **[ ] Wire CI/CD.** Jobs: `typecheck` → `units` (node) → `store/handler mocks` → `cdk synth` + ASL
    validation → `localstack integration` → `recovery E2E` → (on main) `cdk deploy` to staging. Cache the
    LocalStack image; run SFN-Local in a service container.
14. **[ ] THE HARD CUTOVER (one commit, reviewable diff).** In order:
    - `git rm -r convex/` (all 119 files) and `convex/convex.config.ts`.
    - `git mv` the portable cores into `backend/engine/`, `backend/runtime/` (from `src/runtime`),
      `backend/channels/`, `backend/registries/` per the spine layout. (The cores listed in the spine —
      `loop.ts`, `dispatch.ts`, `decode.ts` core, `retry.ts`, `deltaBatcher.ts`, `resultTools.ts`, `usage.ts`,
      `hitl.ts`, `buildTools.ts`, `entries.ts`, `sessions/diff.ts`, `sessions/images.ts`, all registries,
      `observability/otel.ts`, the 8 channel adapter cores — move unchanged.)
    - Edit `package.json`: delete `convex`, `convex-helpers`, `@convex-dev/workflow`, `@convex-dev/workpool`
      (deps) and `convex-test`, `@edge-runtime/vm` (devDeps); delete the `convex`/`deploy` scripts (or repoint
      `deploy` at `cove deploy`); add `aws-cdk-lib`, `constructs`, `aws-sdk-client-mock`, the `@aws-sdk/*`
      clients, `aws-cdk-local`.
    - Update every reference-header (08 §2) on moved files: `… → @cove/runtime` plus the new transformation note
      (`ctx.db → store/ DocumentClient`).
    - `npm install` (lockfile drops the convex tree) → `npm run typecheck` → `npm test` MUST be green with ZERO
      `convex` imports remaining: `grep -rn "from \"convex" backend src` returns nothing;
      `grep -rn "@convex-dev" backend src package.json` returns nothing.
15. **[ ] Document rollback posture.** Record that rollback is **CDK/CloudFormation rollback to the prior stack
    version** (the Convex backend no longer exists). No dual-backend, no strangler — per locked decision #4.

## Acceptance

Objective bars — what proves the phase done. Each mirrors a Convex behavior it replaces.

- **Parity ledger 100% green.** Every 08 §4.1–§4.15 contract and every `surfaceMapping` row has a passing,
  named test. No row is "deferred" except the explicitly-recorded `runs`-table gap (task 11).
- **Test count parity.** The 424 pre-cutover cases are accounted for: pure cores moved (≈360 cases pass
  unchanged), the 3 store-contract harnesses + recovery + compaction + throughput E2Es re-platformed onto
  `aws-sdk-client-mock`/LocalStack with equivalent assertions. `grep -rn "convex-test" .` returns nothing.
- **Crash-recovery E2E passes under at-least-once.** Kill an execution mid-loop; resume re-yields the cached
  decision (no second model call), one tool-result per `toolCallId`, one finalized row per `stepNumber`,
  no double-compact — the exact invariants of [`recovery.test.ts`](../../../tests/e2e/recovery.test.ts) now
  proven against SFN re-drive, not Convex workflow replay.
- **ASL transcription verified.** Step Functions Local runs every `loop.ts` branch; the ASL Choice order
  matches [`loop.ts`](../../../convex/engine/loop.ts) line-for-line; `cdk synth` is deterministic and the
  checked-in `agent-loop.asl.json` matches the CDK-generated output (drift gate).
- **CDK shape asserted.** `Template.fromStack` confirms 9 tables, Streams on exactly the 4 fan-out tables,
  STANDARD state machine, REQUEST authorizer, WS routes, least-privilege IAM.
- **THESIS proofs present.** Named tests prove: no AI-SDK `execute` in built tools; AI SDK confined to
  `llmStep`/`compact`; the loop owned by SFN (counters from state); steps replay-reconstructable from
  `runPlan`+journal (incl. S3 spill).
- **The hard delete is complete and the tree builds.** `convex/` gone; `@convex-dev/*` + `convex` + `convex-test`
  removed from `package.json`; portable cores live ONLY under `backend/`; `npm run typecheck && npm test` green;
  `grep -rn "from \"convex" backend src` and `grep -rn "@convex-dev" .` (outside docs) return nothing.
- **CLI retargeted.** `cove deploy` runs `build()` fail-closed then `cdk deploy` (proven by
  `src/cli/__tests__`); `cove init` vendors `backend/`, not `convex/`.
- **CI gates cutover.** The pipeline runs all rungs + `cdk synth` + ASL validation + LocalStack + recovery E2E;
  a red parity ledger blocks merge.

## Risks & gotchas

- **Open→closed authorizer inversion is a visible cutover behavior change (D-AWS-6).** Every previously-open
  native/test caller — and the WS `$connect` ([G4.6](phase-g4.6-reactive-websocket-streaming.md)) — **403s**
  until an authorizer policy is configured. This MUST be the first item on the cutover checklist and the deploy
  runbook, or the cutover *looks* broken. [`convex/auth.ts`](../../../convex/auth.ts) returning `undefined`
  (OPEN) is the behavior we are deliberately inverting; the parity test asserts DENY-by-default, so "the test
  expects 403" is correct, not a regression.
- **`?wait=result` 60s → <29s is a wire-contract change (D-AWS-13).** Non-reactive HTTP/SDK callers that relied
  on the [`http.ts:30-53`](../../../convex/http.ts) 60 s synchronous poll now get a bounded poll + re-poll (or
  the WS terminal frame). The parity suite must encode the NEW contract, not the old 60 s one, and the change
  must be in the migration notes. Owned by [G4.5](phase-g4.5-ingress-apigw-auth.md); flagged here for the gate.
- **LocalStack ≠ AWS fidelity.** LocalStack's DynamoDB Streams ordering/latency, SFN task-token timing, and
  conditional-write semantics are *close* but not identical to production. The idempotency/seq-collision proofs
  (D-AWS-4/D-AWS-7) must ALSO have `aws-sdk-client-mock` unit coverage that pins the exact `ConditionExpression`
  /`UpdateExpression` strings — do not rely on LocalStack alone to catch a non-atomic counter.
- **`"use node"` Lambdas don't run in the unit VM.** Just as the edge-runtime VM couldn't execute
  `llmStep`/`dispatchTools`/`compact` ([`tests/README.md:30-35`](../../../tests/README.md)), the unit rung
  can't run the real model or the live EC2/Docker sandbox. Keep the discipline: the **pure cores** prove the algorithm (the moved decode/
  dispatch units), the **mocked-client units** prove the I/O shape (the sandbox adapter against a fake SSM/Docker client — D-AWS-15), and **LocalStack** proves the wiring — the
  model is injected at the `resolveModel` seam (`cove-test/mock`, the `MockLanguageModelV2` per 08 §Dropped).
  Don't try to make LocalStack run a live provider.
- **SFN-Local ASL coverage can drift from the deployed machine.** The ASL is CDK-*generated* (G4.3); a checked-in
  `agent-loop.asl.json` tested by SFN-Local can silently diverge if someone edits the CDK builder without
  regenerating. The synth-vs-checked-in drift gate (acceptance) is mandatory, not optional.
- **The 25k SFN history cap is only exercised by a long run.** Continue-as-new (D-AWS-12) won't be hit by a
  3-step happy-path E2E. The parity suite MUST include a 40+ step run that forces `RestartChoice`, or the cap
  ships untested and a long production run fails mid-loop.
- **The delete is irreversible (locked decision #4).** No strangler, no dual backend, no `convex/` fallback.
  Once `git rm -r convex/` lands and the deps are removed, rollback is **redeploy the prior CDK stack** — there
  is no Convex deployment to flip back to. The cutover commit must be reviewed as a unit and gated on a 100%
  green parity ledger; merging it with a red ledger is the worst-case failure.
- **`runs`-table writer parity gap.** [`convex/runs.ts`](../../../convex/runs.ts) is a read-only inspect surface
  with no writer today (D18/G2.4 pending). The migration is the natural place to add the writer (SFN execution
  lifecycle → `Runs` item), but that is **new work, not a port** — it is the easiest parity row to miss. Task 11
  forces an explicit decision: implement-and-test, or record as a known gap. Do not let it fall through.
- **Sandbox container leak / host saturation has no test, only a policy (D-AWS-15).** Every distinct `sandboxName`
  (`${ctx.id}:${instanceId}:${harnessName}`, 08 §3) keeps a Docker container resident on the single EC2 host;
  unbounded across many runs, and the one host is a scale/availability ceiling. The cutover runbook must include
  the `docker rm -f`-on-finalize cleanup + the host-side age-reaper ([G4.2](phase-g4.2-compute-lambda-actions.md),
  [G4.1](phase-g4.1-foundation-cdk-dynamodb.md)), a `dispatchTools` reserved-concurrency cap, and host
  CPU/disk alarms — these are operational gates on the cutover, not unit-testable. The Fargate upgrade path is the
  documented escape hatch if one host stops being enough.
- **Reference-header debt on the move.** 08 §2 makes the origin header a review-checklist item for every file.
  The mass `git mv` into `backend/` will leave stale `→ @cove/runtime` notes that no longer mention the
  `ctx.db → store/` transformation. A CI grep that flags a moved file whose header still references a `convex/`
  path keeps the convention honest.
