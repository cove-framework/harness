# 04 — The Durable Engine

flue's agent loop is in-process pi code; Cove's is a **durable workflow**. This is
where most of the "hard" work lives. Code below is illustrative (pseudo-Convex), not
the final source.

This doc is the prose home of the loop. The **execution boundary** it implements
(Convex owns the loop, the sandbox executes, the LLM decides but does not control
flow) and the **exact contract constants** it must honor are canonical in
[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md);
this doc explains *how* the loop satisfies them and links back for the numbers.

## The workflow manager

```ts
// convex/workflow.ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";
export const workflow = new WorkflowManager(components.workflow);
```

## The loop

```ts
// convex/engine/runHandler.ts
export const agentRun = workflow.define({
  args: { requestId: v.id("agentRequests") },
  handler: async (step, { requestId }) => {
    // 0. setup — resolve + freeze the plan (idempotent; cached by the journal)
    const plan = await step.runAction(internal.engine.setup.run, { requestId });

    let stepNumber = 0;
    let followUps = 0; // durable counter; replayed from the journal, never re-derived
    while (stepNumber < plan.maxSteps) {
      // 1. one LLM decode (streams into agentRequestSteps as it goes)
      const decision = await step.runAction(internal.engine.llmStep.run, {
        requestId, stepNumber, plan, followUps,
      });

      if (decision.finishReason === "stop") {
        if (!plan.resultSchema) break;          // free-form run: stop is terminal
        // result-schema run: stop is only terminal once a validated result exists
        const outcome = await step.runQuery(internal.engine.getOutcome.run, { requestId });
        if (outcome.kind === "finished") break; // validated result captured → done
        if (outcome.kind === "gave_up")         // give_up tool fired
          throw new ResultUnavailableError(outcome.reason, outcome.assistantText);
        // kind === "pending": no result yet → re-nudge, bounded by maxFollowUps
        if (followUps >= plan.maxFollowUps) {
          await step.runMutation(internal.engine.finalize.run, {
            requestId, reason: "result_followups_exhausted",
          });
          throw new ResultUnavailableError("result_followups_exhausted");
        }
        await step.runAction(internal.engine.appendFollowUp.run, {
          requestId, prompt: buildResultFollowUpPrompt(plan.resultSchema),
        });
        followUps++;
        stepNumber++;
        continue;                               // decode again against the nudged history
      }

      // 2. HITL gate — park on any approval-required tool call
      const gated = decision.toolCalls.filter((c) => c.isHitl);
      for (const call of gated) {
        // durable wait: the workflow suspends here until submitApproval wakes it
        const decisionEvent = await step.waitForEvent(
          `approval:${requestId}:${call.toolCallId}`,
        );
        await step.runMutation(internal.engine.applyApproval.run, { requestId, stepNumber, call, decisionEvent });
      }

      // 3. run the (approved) tools, write results idempotently by toolCallId
      await step.runAction(internal.engine.dispatchTools.run, {
        requestId, stepNumber, toolCalls: decision.toolCalls,
      });

      // 4. compaction between steps when context approaches the window reserve
      if (decision.shouldCompact) {
        await step.runAction(internal.engine.compact.run, { requestId, plan });
      }
      stepNumber++;
    }

    // 5. terminalize
    await step.runMutation(internal.engine.finalize.run, { requestId });
  },
});
```

The key property: every `step.run*` call is a **journaled checkpoint**. If the
process dies after `llmStep` step 3 but before `dispatchTools`, replay returns the
cached `llmStep` result and resumes at `dispatchTools`. Recovery is the workflow's
job — flue's lease/attempt-marker layer is not re-implemented.

### Step cap & termination

`maxSteps` (the `while` bound above) is a **defense-in-depth ceiling, not a flue
behavior** — flue runs the turn loop with no framework cap, relying on the model to
terminalize via `finish`/`give_up`. Cove preserves that intent: a run normally ends on
`finishReason === "stop"` or a terminal tool call; `maxSteps` only catches a runaway.
It is resolved at `setup` from `DurabilityConfig.maxSteps` (**default 100**) and frozen
onto the plan ([08 §4.9](08-conventions-and-execution-boundary.md#49-step-cap--loop-termination)).
Reaching it stops the loop and `finalize`s the request as `failed` with a
`step_limit_exceeded` reason, so the ceiling is observable rather than a silent stop.

### Result-tool re-nudge & termination

For a **result-schema run**, `finishReason === "stop"` is *not* unconditionally
terminal: the model may stop talking without ever calling the per-call `result` tool.
So the loop consults `getOutcome` — `finished` (a validated result was captured),
`gave_up` (the model fired `give_up`), or `pending` (it stopped with neither). A
`pending` stop triggers a **bounded re-nudge**: `appendFollowUp` writes the prompt from
`buildResultFollowUpPrompt(plan.resultSchema)` and the loop decodes again. Re-nudges are
capped by **`maxFollowUps` (default 32)**, resolved at `setup` from
`DurabilityConfig.maxFollowUps` and frozen onto the plan exactly parallel to `maxSteps`.

The `followUps` counter is a **durable, per-run scalar threaded through the journal**:
it is passed into each `llmStep` and incremented only after the `appendFollowUp`
checkpoint commits, so a replay reads the same `followUps` value the original run saw at
that point and re-takes the identical branch — the re-nudge decision is replay-deterministic,
never re-derived from live state. (It is a distinct axis from `stepNumber`; both advance,
but `followUps` exists only to bound the result-completion sub-loop.)

Two terminal exits, both **rejecting the `CallHandle` with `ResultUnavailableError`** (a
`CoveError` subclass carrying the `give_up` `reason` and the model's trailing assistant
text) — a result-schema run **never resolves `PromptResultResponse<T>` with unvalidated
`data`**:

- **`gave_up`** — the model declared it could not satisfy the schema.
- **Follow-ups exhausted** — `followUps` reaches `maxFollowUps`; the loop `finalize`s the
  request `failed` with reason **`result_followups_exhausted`** (parallel to
  `step_limit_exceeded`) before rejecting.

Exact rules and the `getOutcome` contract live in
[08 §4.10](08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination).

### Control flow pattern — *watch and proceed*

Cove never lets the LLM drive. Each iteration is the same three-beat,
Convex-owned cycle:

1. **Convex runs `llmStep`** — it invokes the model, **watches** the streamed
   output as it lands in `agentRequestSteps`, and **writes the finalized
   `toolCalls`** onto the step row. The model produces a decision; it does not act.
2. **Convex runs `dispatchTools`** — it executes each returned tool call against the
   sandbox and **watches each tool result** as it is written back through the
   idempotent `appendToolResult` mutation, then **proceeds** once all results are
   committed.
3. **Convex reads current state and decides** — between iterations the loop reads the
   request/step rows and chooses to **continue**, **compact**, or **finalize**.

Because every one of those decisions is a `step.run*` checkpoint, the **workflow
journal makes each decision durable**: on replay the same branch is taken from the
recorded outcome, never re-derived. **Convex owns the loop; the LLM never initiates
a step** — it only answers when asked. This is the [08] execution boundary expressed
as a runtime cadence.

## `setup` — freeze the plan

Runs the [`createAgent`](../../src/runtime/agent-definition.ts)
initializer once, resolves the profile (model, instructions, tools, skills,
subagents), composes the system prompt, resolves the sandbox, and **freezes** the
result onto the session/request row. After this, the loop reads only frozen state
so replay is byte-identical (no live registry lookups mid-run). Mirrors flue's
`initializeCreatedAgent` + `composeSystemPrompt`.

**What "composes the system prompt" keeps.** `composeSystemPrompt` assembles three
parts, in order:

1. The **`HEADLESS_PREAMBLE`** autonomy preamble (the "you run unattended; do not ask
   the user, decide and proceed" framing) — ported verbatim.
2. The rendered **`## Available Skills`** registry — one row per skill (name +
   description + the `activate_skill` instruction), built from the **D13 skill catalog
   rows resolved at setup** (a Convex query against the `skills` catalog), **not** a
   sandbox FS scan. Skills are host state, not workspace state, so this resolves without
   touching the box.
3. The **Date / Working-directory / Directory-structure** block.

**Resolve-only vs. `readdir` tension.** flue's third block embeds a live `readdir`
listing of the workspace, which would force `setup` to provision a box just to compose a
prompt. Cove keeps `setup` **resolve-only** (it provisions *no* box): the
**Directory-structure listing is DEFERRED** to an **on-demand `SessionEnv` read** at the
first tool that needs it, and the **frozen `systemPrompt` omits the directory listing**
entirely (it still carries Date + Working-directory, which are known without an FS walk).
This extends [D13](07-risks-and-decisions.md) — both the skills registry *and* the
directory listing are resolved off host/lazy state rather than a setup-time sandbox scan.

## `llmStep` — one decode, streamed

```ts
// convex/engine/llmStep.ts ("use node")
export const run = internalAction({ handler: async (ctx, { requestId, stepNumber, plan }) => {
  // (REPLAY GUARD) if this step already finalized, return its decision — do NOT call the model
  const existing = await ctx.runQuery(internal.steps.byRequestStep, { requestId, stepNumber });
  if (existing?.isFinalized) return reconstructDecision(existing);

  // (a) rebuild the model context from the entry tree
  const data = await ctx.runQuery(internal.sessions.load, { sessionId: plan.sessionId });
  const history = SessionHistory.fromData(data);
  const messages = history.buildContext();              // ← ported pure logic

  // (b) rebuild tools from frozen descriptors (closures can't cross the journal)
  const tools = buildTools(plan.tools);                 // JSON-Schema → AI SDK tool, execute stripped

  // (c) create the streaming step row
  await ctx.runMutation(internal.steps.insertStreaming, { requestId, stepNumber });

  // (d) stream from the AI SDK; delta-batch text/reasoning into the row
  const batcher = new DeltaBatcher((patch) =>
    ctx.runMutation(internal.steps.patchStreaming, { requestId, stepNumber, ...patch }));
  const model = resolveModel(plan.model);               // provider registry
  const result = streamText({ model, system: plan.systemPrompt, messages: toModelMessages(messages), tools });
  for await (const part of result.fullStream) {
    if (part.type === "text-delta")      batcher.text(part.text);
    if (part.type === "reasoning-delta") batcher.reasoning(part.text);
  }
  await batcher.flush();                                 // durably committed before the workflow advances

  // (e) finalize the step atomically (toolCalls, usage, responseMessages, model)
  const finalized = await finalizeFromResult(result);
  await ctx.runMutation(internal.steps.finalize, { requestId, stepNumber, ...finalized });
  return finalized; // {finishReason, toolCalls, shouldCompact}
}});
```

Mirrors flue's `runModelTurnWithRecovery`, but the "recovery" is the workflow
journal + the idempotent step row. flue's `isRetryableModelError` is ported into
this action's error handling (see *Compaction in the loop*).

**Context-rebuild parity (two-action turn).** flue's in-process loop carried decode
output and tool results in memory across the decode→execute boundary; Cove splits one
turn into two journaled actions (`llmStep`, then `dispatchTools`), so the *next*
`llmStep` reconstructs the provider context from rows via
`SessionHistory.buildContext()`. For this to be lossless the **verbatim
`responseMessages`** (provider signatures / reasoning metadata, persisted on the step
row) must round-trip byte-for-byte — that is what preserves reasoning-signature
continuity and prompt-cache affinity (`sessions.affinityKey`) across the split. P4
carries a parity test that *demonstrates* this round-trip rather than asserting it (see
[06 P4 acceptance](06-phase-roadmap.md#-phase-4--durable-engine)).

### `toModelMessages` — outbound message normalization

`toModelMessages` is the last transform before the provider call, and it does two
provider-defensive fixups the AI SDK does **not**:

- **Surrogate sanitization.** It applies the ported **`sanitizeSurrogates`** (lone
  unpaired-surrogate stripping) to **every outbound text field** before handing messages
  to `streamText`. The AI SDK passes text through untouched, and several providers
  return a hard **400 on a lone `\udXXX`** code unit (e.g. from a truncated emoji in
  prior tool output). Stripping is uniform across text, reasoning, and tool-result text.
- **Non-vision image downgrade (contract).** When the resolved
  **`ModelHandle.supportsVision === false`**, image blocks in `user` and `toolResult`
  messages are **REPLACED, not dropped**, with a text placeholder (e.g.
  `[image omitted: model has no vision]`). Replacing rather than dropping preserves
  positional context for the model; **consecutive placeholders are de-duped** to a single
  marker. The downgrade is mandatory because a non-vision model **400s on raw image
  parts** — leaving them in is not an option, and silently dropping them loses the signal
  that an image was present.

### Replay guard — the model is called at most once per step

The guard at the top of `llmStep` is non-negotiable. On a workflow replay the action
**re-runs**, and re-calling the AI SDK would double-charge, double-stream, and
produce a non-deterministic decision. So on entry `llmStep` queries
`agentRequestSteps` by `(requestId, stepNumber)`; **if the row `isFinalized`, it
reconstructs and returns the cached decision without touching the AI SDK**. The
finalized step row — not the model — is the source of truth on replay. See
[08 §4.1](08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical).

### Stream deadline & force-finalize

A streaming decode cannot be allowed to outlive its action budget. `llmStep` carries
a **stream deadline (≈ 240 s)**; on deadline it **force-finalizes the partial
result** — committing whatever text/tool-calls it has — rather than letting the
action be killed and the journal entry left ambiguous. Both this deadline and the
per-tool deadline below are surfaced through `DurabilityConfig`; exact values live in
[08 §4.2](08-conventions-and-execution-boundary.md#42-action-budgets--timeouts).

## `dispatchTools` — parallel, idempotent, cancel-aware

```ts
// convex/engine/dispatchTools.ts ("use node")
export const run = internalAction({ handler: async (ctx, { requestId, stepNumber, toolCalls }) => {
  const env = await resolveSandbox(...);                // @upstash/box SessionEnv
  const tools = buildTools(plan.tools);                 // rebuilt from the FROZEN descriptor
  await Promise.all(toolCalls.map(async (call) => {
    // CANCEL SHORT-CIRCUIT: re-check status before each tool; skip + discard if cancelled
    const status = await ctx.runQuery(internal.invoke.requestStatus, { requestId });
    if (status === "cancelled") return;

    let result, isError = false;
    try { result = await runTool(tools, call, env, signal); }  // per-tool timeout ≈ 30s
    catch (e) { result = String(e); isError = true; }
    // idempotent: keyed on toolCallId, replace-in-place
    await ctx.runMutation(internal.steps.appendToolResult, {
      requestId, stepNumber, toolCallId: call.toolCallId, toolName: call.toolName, result, isError,
    });
  }));
}});
```

A failed tool **does not fail the request** — the result is returned to the model
as an error tool-result so it can self-correct (flue semantics). `appendToolResult`
is idempotent (keyed on `toolCallId`, replace-in-place) so a `dispatchTools` replay
is safe and never double-executes a side-effecting tool.

### Tool rebuild from frozen descriptors

Closures cannot cross the workflow journal, so the model context and the dispatcher
both **rebuild tools from the frozen tool descriptor** stored on the request — that
descriptor is **authoritative for the whole run** (registry edits affect only *new*
runs). `buildTools` lives in `convex/engine` and imports `normalizeToolDefinition`
from [`src/runtime/tool.ts`](../../src/runtime/tool.ts) to re-wrap each
tool's `execute`; `dispatchTools` then invokes it. A `buildTools` failure becomes an
**error tool-result, never a step crash**. See
[08 §4.5](08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors).

**MCP tools are the one exception to box-binding.** Their `execute` closes over a live
network client that cannot be frozen, so the descriptor carries the server identity +
transport (not a closure) and `buildTools` **re-resolves an MCP client** from it rather
than binding against the box `SessionEnv`. Since `callTool` is side-effecting, a
replayed `dispatchTools` returns the persisted result (idempotent by `toolCallId`)
instead of re-calling the server. Full rule:
[08 §4.5](08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors).

### Per-tool timeout

Each tool's `execute` runs under a **per-tool deadline (≈ 30 s)**; a hung tool yields
an **error tool-result**, not a starved action. The underlying box `exec` carries its
own default `timeoutMs` (≈ 30 s) as the floor. Values in
[08 §4.2](08-conventions-and-execution-boundary.md#42-action-budgets--timeouts).

## Built-in framework tools

The same built-in tool set flue ships is reconstructed inside `dispatchTools`. The
`createTools` factory (from flue's
[`agent.ts`](../../../flue/packages/runtime/src/agent.ts)) supplies
**read / write / edit / bash / grep / glob / task / activate_skill**, and the
per-call **result / finish / give_up** tools (flue's
[`result.ts`](../../../flue/packages/runtime/src/result.ts)) are injected when the run
declares an output schema. Each of these maps onto the session's `SessionEnv`
`fs`/`exec` surface: read/write/edit/grep/glob go through `env.fs`, bash through
`env.exec`, all inside the one designated workspace folder ([08 §3]). **Two of these
do not touch the box:** `activate_skill` resolves a skill by name from the `skills`
catalog via a Convex query — never an `env.readFile`/FS walk (skills are host state,
not workspace state; see
[08 §3 — Skills resolve at the call site](08-conventions-and-execution-boundary.md#skills-resolve-at-the-call-site-not-in-the-sandbox)
and [D13](07-risks-and-decisions.md)) — and `task` spawns a child run. The LLM only
ever sees the JSON-Schema view; the executable closures are rebuilt from the frozen
descriptor at dispatch time.

## Subagents / task delegation

`task()` is a **built-in tool** (flue's `createTaskTool`, wired through
`createTools`) that delegates focused work to a detached child agent with its own
context. In Cove, invoking `task()` spawns a **child `agentRun` as a nested
workflow** rather than an in-process recursion:

- The child runs on a **reserved `task:*` child session** named by
  `createTaskSessionName(parentSession, taskId)` →
  `` `task:${parentSession}:${taskId}` `` (flue's
  [`session-identity.ts`](../../../flue/packages/runtime/src/session-identity.ts);
  `task:`-prefixed names are reserved and rejected for user sessions). Its storage
  key resolves via `childTaskSessionStorageKey`.
- **Depth is tracked and enforced.** Each nested spawn increments `taskDepth`;
  exceeding `MAX_TASK_DEPTH` throws `TaskDepthExceededError`, and requesting a
  subagent the profile never declared throws `SubagentNotDeclaredError` (both
  non-branded subclasses of `CoveError`; see
  [08 §1](08-conventions-and-execution-boundary.md#1-naming--namespace)).
- A **`TaskSessionRef`** (`{ session, taskId }`) is appended to the parent session
  row, linking parent → child. The **child's final answer returns into the parent
  step** as the `task` tool-result — the parent loop proceeds on it exactly like any
  other tool result.
- **Cascade-delete couples parent + children**: deleting the parent session walks the
  `TaskSessionRef` list and removes the child `task:*` sessions, so no orphaned
  subagent state survives.

This keeps subagents fully durable — a parked or crashed child workflow recovers on
its own journal — and keeps the boundary intact: the parent's `dispatchTools` simply
awaits a nested run.

## Delta batching

Patching a row per token would overwhelm Convex mutation throughput. The batcher
coalesces deltas and flushes on the looser of **~400 ms** or **~480 chars**
(configurable). Crucially, **the flush mutation is durably committed before the
workflow advances** (no lost deltas on redeploy), and deltas are **coalesced into the
step row** — patched in-position, not appended to a separate log — so a late
subscriber reading `agentRequestSteps` sees the current text in place. The reactive
query re-broadcasts to subscribers. This is the single most important cost/UX lever —
see [08 §4.6](08-conventions-and-execution-boundary.md#46-streaming-commit--subscription-semantics)
and [07 — Risks & Decisions](07-risks-and-decisions.md).

## Abort & cancel

flue's `CallHandle.abort()` is a synchronous in-process `AbortSignal`. Across the
Convex action boundary that becomes an **async cancel** with an **atomic abort
sequence**: `session.abort()` → `invoke.stopActive` → **one mutation** that does
`workflow.cancel(convexWorkflowId)` *and* sets `agentRequests.status = cancelled`
together.

The cancel then **short-circuits the dispatcher**: `dispatchTools` re-reads
`agentRequests.status` **before each tool**, and once `cancelled` it **skips the
remaining tools and discards any late results**. A tool already mid-execution in a
`dispatchTools` action won't observe the cancel until its action returns (the box
`exec` `timeoutMs` bounds the worst case) — a documented weakening of flue's mid-tool
abort. See [08 §4.3](08-conventions-and-execution-boundary.md#43-cancel-short-circuit)
and the risk register.

## HITL — the approval state machine

Human-in-the-loop is a new capability, natural on a durable workflow. A tool flagged
`isHitl` (or a skill/policy that requires approval) parks the loop on a durable wait.
The full state machine:

1. **Park.** The loop writes an `approvals` row (`status: pending`) and marks the
   `agentRequestSteps` `toolCalls[].isHitl = true` (the UI renders an approval card
   from `args`). It then calls
   `step.waitForEvent(`approval:${requestId}:${toolCallId}`)` — the event key is
   **globally unique** across requests and tool calls — and the workflow **suspends
   durably** (no compute burns while parked).
2. **Submit (idempotent, fail-loud).** `invoke.submitApproval` **rejects if
   `approvals.status !== "pending"`**, so a double-submit cannot flip an already
   resolved approval. On success it writes the decision and **emits the workflow
   event**.
3. **No lost wakeups.** The workflow event is **durable / queued**, so a
   `submitApproval` arriving *before* the run reaches `waitForEvent` is **not lost** —
   the wait observes the queued event when it parks.
4. **Approved with edits.** On approve, the tool runs — optionally with
   **approver-edited args**, which are **re-validated**; a `ToolInputValidationError`
   returns as an **error tool-result**, not a crash. On reject, a rejection
   tool-result is returned to the model.
5. **Timeout while parked.** A request that exceeds `durability.timeoutMs` while
   parked **terminalizes as `cancelled`** rather than waiting forever.

Because the wait is a durable workflow suspension, a parked approval survives
redeploys and can stay parked indefinitely. Exact rules in
[08 §4.4](08-conventions-and-execution-boundary.md#44-hitl-state-machine).

## Compaction in the loop

The pure helpers (token estimation, cut-point selection) port from flue's
[`compaction.ts`](../../../flue/packages/runtime/src/compaction.ts); the
**summarization LLM call** is a workflow step (`compact`) that appends a
`CompactionEntry` row. There are **two explicit modes** (flue's threshold vs.
overflow), both preserved:

1. **Proactive threshold.** Fired **between `llmStep`s**: when the estimated context
   tokens exceed `contextWindow - reserveTokens`, the loop compacts before the next
   decode. No retry — the next `llmStep` simply runs on the compacted history.
2. **Reactive overflow.** When a decode fails with a context-overflow error
   (`isContextOverflow`, ported), the loop compacts and then **retries the *same*
   step** so the model re-decodes against the shrunken context.

flue's `isRetryableModelError` is ported into `llmStep`'s error handling, so transient
model errors retry the step without a full request failure, distinct from the
overflow-driven compact-then-retry path above. All compaction identifiers follow Cove
naming ([08 §1](08-conventions-and-execution-boundary.md#1-naming--namespace)); the
copied message shapes (`CompactionEntry`, `SessionEntry`) keep their flue names.

## Why this shape

- **Durability for free:** the journal owns crash recovery.
- **Realtime for free:** every step/patch is a reactive read.
- **Small journal:** only scalars cross it; messages live in tables.
- **Replay-safe:** frozen plan + replay-guarded `llmStep` + idempotent step rows +
  idempotent `appendToolResult` mean a replayed step never double-acts and never
  re-calls the model.
- **Boundary-clean:** Convex orchestrates, the sandbox executes, the LLM decides —
  the *watch-and-proceed* cadence above is that boundary in motion ([08 §3]).
