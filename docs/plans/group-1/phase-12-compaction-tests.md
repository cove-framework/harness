# Phase 12 — Compaction parity + sample agent + test suite
> Land the two-mode compaction (proactive threshold + reactive overflow→retry) as a workflow step, a worked sample agent proving G1–G5, and the consolidated test suite — three store contract harnesses, pure-logic units, an E2E multi-turn crash-recovery test, and the throughput regression gate. Design-of-record: [06 — Roadmap](../../design/06-phase-roadmap.md) + [04 — Durable Engine](../../design/04-durable-engine.md), [08 — Conventions](../../design/08-conventions-and-execution-boundary.md), [01 — Goals](../../design/01-overview-and-goals.md). Decisions: [D5, M6](../../design/07-risks-and-decisions.md).

## Goal & scope

P12 closes parity and proves the whole thing works end-to-end. Two strands:

- **Compaction** — the pure helpers (token estimation, cut-point selection) are already ported in `src/runtime/compaction.ts`; this phase wires them into the loop as the **`compact` workflow step** with both flue modes: **(1) proactive threshold** (fired between `llmStep`s when estimated tokens exceed `contextWindow − reserveTokens`) and **(2) reactive overflow** (a decode fails with a context-overflow error → compact → **retry the same step**). It appends a `CompactionEntry` row; the summarization LLM call is itself a workflow step.
- **Validation** — a worked **sample agent** demonstrating goals G1–G5 from [01](../../design/01-overview-and-goals.md), and the **consolidated test suite**: the three store contract harnesses (Session/Run/EventStream) against the Convex adapter, the pure-logic unit tests, the E2E multi-turn + crash-recovery test, and the throughput regression (re-running the P4 batcher stress as a gate).

**Out of scope:** new engine capabilities (the loop is P4; this only adds the `compact` step + retry wiring), new channels, new providers. The **AgentSubmissionStore** flue contract is explicitly **not** a fourth harness (M6) — its surviving admission invariants were asserted in P6.

## Dependencies

| Must land first | Why |
| --- | --- |
| **P4 — Durable engine** | `compact` is a workflow step the loop invokes between `llmStep`s (threshold) or after a failed decode (overflow→retry-same-step). The retry must thread the journaled `llmStep` replay guard so a re-decode re-runs deterministically. |
| **P5 — Session store** | `compact` appends a `CompactionEntry` to `sessionEntries`; `SessionHistory.buildContext()` reads it so the next decode runs on the shrunken history. The store contract harnesses run **against the P5 Convex adapter**. |
| **P3 — Providers** | The summarization call is a model call (`generateText`) via the provider registry; the E2E + throughput tests drive `llmStep` via the P3 `MockLanguageModelV2` seam — no live provider. |
| **P9 — Events** | The E2E test asserts the full event sequence (`run_start … text_delta … tool … run_end`); the throughput test drives the P4 delta-batcher and reads the coalesced step rows. |
| P1 (done) | `src/runtime/compaction.ts` (the pure helpers) + `CompactionConfig`/`CompactionEntry`/`Usage` types are already on disk. |

## Deliverables

| File / dir | Purpose |
| --- | --- |
| `convex/engine/compact.ts` | The `compact` workflow step: build the summarization context, call the model, append a `CompactionEntry`, return the compacted leaf. Used by both modes. |
| `convex/engine/runHandler.ts` (extend) | Wire **mode 1** — `if (decision.shouldCompact) step.runAction(compact)` between steps; and **mode 2** — catch a context-overflow decode error in `llmStep`, run `compact`, then **retry the same `stepNumber`** (not `stepNumber+1`). |
| `src/runtime/agent-tools/result.ts` | **Ported** `createResultTools` + `buildResultFollowUpPrompt` + `FINISH_TOOL_NAME`/`GIVE_UP_TOOL_NAME` (the result/finish/give_up tools P4 references for §4.10). If P4 already ported these, this phase only consumes them. |
| `examples/sample-agent/` | A worked agent (e.g. a repo-Q&A or PR-review agent) exercising prompt + tools + a skill + a subagent + compaction — the G1–G5 demonstration. |
| `tests/contract/session-store.test.ts` | `defineStoreContractTests` run against the Convex `SessionStore` adapter (P5). |
| `tests/contract/run-store.test.ts` | `defineRunStoreContractTests` against the Convex `RunStore`. |
| `tests/contract/event-stream-store.test.ts` | `defineEventStreamStoreContractTests` against the Convex `EventStreamStore`. |
| `tests/e2e/multi-turn-recovery.test.ts` | A multi-turn run killed mid-loop that resumes from the journal to a coherent terminal state. |
| `tests/e2e/compaction.test.ts` | A long conversation that auto-compacts (threshold) and a forced overflow that compacts-and-retries, both continuing coherently. |
| `tests/perf/throughput.test.ts` | The delta-batcher stress (re-run of the P4 gate) as a P12 regression. |

> Reuse the **already-ported** `src/runtime/compaction.ts` pure helpers — do not re-port them. This phase is the **wiring** + **summarization step** + **tests**, not new pure logic.

## Source map (flue/pi → cove)

| flue/pi file | target cove file | port / transform notes |
| --- | --- | --- |
| [`runtime/src/compaction.ts`](../../../../flue/packages/runtime/src/compaction.ts) `compact`(L655) | `convex/engine/compact.ts` | The **async `compact`** (summarization call + entry append) becomes a **workflow step**: the model call is a `step.runAction`, the `CompactionEntry` append is a `step.runMutation`. The pure `deriveCompactionDefaults`/`calculateContextTokens`/`shouldCompact`/`prepareCompaction` (L51/L76/L170/L508) are **already ported** in `src/runtime/compaction.ts` — import them. |
| [`runtime/src/compaction.ts`](../../../../flue/packages/runtime/src/compaction.ts) `shouldCompact`(L170) | `convex/engine/runHandler.ts` | Mode-1 trigger: between `llmStep`s, `shouldCompact(usage, settings)` → run `compact` before the next decode. The `decision.shouldCompact` flag from `llmStep` carries it. |
| flue overflow path (`isContextOverflow`, ported in P4's `llmStep` error handling) | `convex/engine/llmStep.ts` + `runHandler.ts` | Mode-2: a decode that throws context-overflow → `compact` → **retry the same `stepNumber`**. Distinct from `isRetryableModelError` (transient retry, P4). |
| [`runtime/src/result.ts`](../../../../flue/packages/runtime/src/result.ts) `createResultTools`(L159)/`buildResultFollowUpPrompt`(L27)/`ResultUnavailableError`(L303) | `src/runtime/agent-tools/result.ts` | The result/finish/give_up tools + the re-nudge prompt. `ResultUnavailableError` is **already** in `src/runtime/errors.ts` (M1) — `result.ts` throws it; don't redefine. (If P4 ported `result.ts`, P12 only validates §4.10 behavior.) |
| [`runtime/src/test-utils/define-store-contract-tests.ts`](../../../../flue/packages/runtime/src/test-utils/define-store-contract-tests.ts) `defineStoreContractTests`(L121) | `tests/contract/session-store.test.ts` | Run the **SessionStore half** against the Convex adapter. The **AgentSubmissionStore half** is **NOT ported as a 4th harness** (M6) — its surviving admission invariants live in the P6 admission-contract test; the lease/attempt/turn-journal/stream-chunk assertions die with the dropped machinery ([D5](../../design/07-risks-and-decisions.md), [08 §5](../../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)). |
| [`runtime/src/test-utils/define-run-store-contract-tests.ts`](../../../../flue/packages/runtime/src/test-utils/define-run-store-contract-tests.ts) `defineRunStoreContractTests`(L9) | `tests/contract/run-store.test.ts` | Run against the Convex `RunStore`. Same contract flue's stores satisfied. |
| [`runtime/src/test-utils/define-event-stream-store-contract-tests.ts`](../../../../flue/packages/runtime/src/test-utils/define-event-stream-store-contract-tests.ts) `defineEventStreamStoreContractTests`(L9) | `tests/contract/event-stream-store.test.ts` | Run against the Convex `EventStreamStore`. |

## Hardened-contract obligations

- **[08 §4.7 — usage & cost](../../design/08-conventions-and-execution-boundary.md#47-usage--cost).** Compaction is driven by the usage rollup (`calculateContextTokens(usage)` vs `contextWindow − reserveTokens`). The persisted rollup carries `cacheRead/cacheWrite/cacheWrite1h + cost{}` (m14), not just the three token fields — the threshold math reads from it.
- **[08 §4.1 — replay determinism](../../design/08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical).** Mode-2 overflow→retry re-runs the **same `stepNumber`**; the summarization `compact` step and the re-decode are journaled `step.run*` checkpoints, so a replay after compaction returns the cached compacted leaf and the cached re-decode — the model is still called **at most once per (stepNumber, attempt)**. Do not let overflow-retry double-charge.
- **[04 §Compaction in the loop](../../design/04-durable-engine.md).** Two explicit modes, both preserved: proactive threshold (no retry — the next `llmStep` runs on the compacted history) and reactive overflow (retry the same step). `isRetryableModelError` (transient) is a **separate** path from overflow-compact-retry.
- **[08 §4.10 — result termination](../../design/08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination).** The result-tool tests assert: a result-schema run that stops-without-finish re-nudges (bounded by `maxFollowUps`), `give_up`/exhaustion rejects with `ResultUnavailableError`, and a `completed` result run **always** carries validated `data`.
- **M6 — no 4th harness.** The test suite has exactly **three** store contract harnesses (Session/Run/EventStream). The flue AgentSubmissionStore contract is not reconstituted; record the deliberate non-port.
- **[01 — success criteria](../../design/01-overview-and-goals.md#success-criteria).** The sample agent demonstrates G1–G5 (the framework's stated goals) as the human-facing acceptance.

## Implementation tasks

- [ ] **1. Build `convex/engine/compact.ts`** — the `compact` step: load the active path, run `prepareCompaction` (pure, already ported) to pick the cut point + build the summarization messages, `step.runAction` the summarization `generateText`, `step.runMutation` to append a `CompactionEntry` (new leaf), return the compacted leaf id. Header cites `compaction.ts`.
- [ ] **2. Wire mode 1 (threshold)** into `runHandler.ts` — after a step, if `decision.shouldCompact` (set by `llmStep` from `shouldCompact(usage, settings)`), run `compact` before the next `llmStep`. No retry; the next decode runs on the compacted history.
- [ ] **3. Wire mode 2 (overflow→retry)** — in `llmStep` catch the context-overflow error (`isContextOverflow`, ported in P4); on overflow, signal the handler to run `compact` then **re-enter the same `stepNumber`** (a bounded retry — cap overflow-retries so a pathological case can't loop forever, distinct from `maxSteps`/`maxFollowUps`).
- [ ] **4. Ensure `result.ts` is ported** (if P4 didn't): `createResultTools`/`buildResultFollowUpPrompt`/`FINISH`/`GIVE_UP`; confirm it throws the existing `ResultUnavailableError`. Add §4.10 behavior tests here if P4 left them.
- [ ] **5. Build the three store contract harnesses** — import flue's `defineStoreContractTests`/`defineRunStoreContractTests`/`defineEventStreamStoreContractTests` (or port them into `tests/contract/_harness/`) and provide a Convex `convex-test` backend adapter for each. Run the **SessionStore** half of `defineStoreContractTests`; **skip/omit** the AgentSubmissionStore half with a comment citing M6.
- [ ] **6. Write the E2E multi-turn crash-recovery test** — drive a multi-turn run via `MockLanguageModelV2` (scripted turns incl. a tool call), kill the action mid-loop (simulate a workflow interruption), resume, and assert the journal replays to a coherent terminal state with **no** duplicated tool execution and **no** second model call for finalized steps.
- [ ] **7. Write the compaction E2E** — (a) a long scripted conversation that crosses the threshold and auto-compacts, continuing coherently (a `CompactionEntry` appears, the next decode sees the summary); (b) a forced overflow error that triggers compact-and-retry-same-step, succeeding on the retry. Assert no double-charge on replay.
- [ ] **8. Re-run the throughput gate** (`tests/perf/throughput.test.ts`) — the P4 delta-batcher stress as a regression; confirm the production `deltaBatchMs`/`deltaBatchChars` still hold and step rows coalesce in-position (§4.6).
- [ ] **9. Build the sample agent** (`examples/sample-agent/`) — a realistic agent using `createAgent`, a custom `defineTool`, a catalog skill, a declared subagent (`task`), and enough turns to exercise compaction. Document how to run it (`cove dev`, P8.5). Map each of G1–G5 to an observable behavior.
- [ ] **10. Pure-logic unit tests** — consolidate/confirm `session-history`, `compaction`, `tool-schema`, `agent-definition` unit tests (these run per-phase already; gather them as the P12 regression set).
- [ ] **11. `tsc --noEmit` green; full `vitest run` green;** wire `npm test` to run the suite. Confirm the suite needs **no live provider** (everything mock-driven) and **no live box** where avoidable (or a hermetic box).

## Acceptance

Start from [06 P12's bar](../../design/06-phase-roadmap.md):

1. **Auto-compaction (threshold).** A long conversation crossing `contextWindow − reserveTokens` auto-compacts: a `CompactionEntry` is appended, the next decode runs on the summarized history, and the conversation continues coherently — no manual `compact()` call.
2. **Overflow → compact → retry.** A decode that hits a context-overflow error compacts and **retries the same step**, succeeding — and a journal replay of that step does **not** double-charge the model (the replay guard holds across the compact+retry).
3. **Three store contract harnesses pass** against the Convex adapter (Session/Run/EventStream) — the same contracts flue's in-memory/SQL stores satisfied. **No fourth (AgentSubmissionStore) harness exists** (M6); its admission invariants are covered by the P6 test.
4. **E2E multi-turn + crash-recovery** — a multi-turn run killed mid-loop resumes from the journal to a coherent terminal state, with idempotent tool results and at-most-once model calls per finalized step.
5. **Result-path (§4.10)** — stop-without-finish re-nudges (bounded by `maxFollowUps`); `give_up`/exhaustion rejects with `ResultUnavailableError`; a `completed` result run carries validated `data`.
6. **Throughput regression** — the delta-batcher stress passes at the production cadence (§4.6).
7. **Sample agent demonstrates G1–G5** from [01](../../design/01-overview-and-goals.md#success-criteria).
8. **`tsc --noEmit` exits 0; `vitest run` green; suite needs no live provider.**

## Risks & gotchas

- **Overflow-retry must not double-charge.** Mode 2 re-enters the same `stepNumber` after a failed decode. The `compact` step and the re-decode are journaled; on replay both return cached results. The trap is treating the retry as a fresh step (new `stepNumber`) — keep it the **same** step so the replay guard de-dups the model call. Add an explicit overflow-retry cap (separate from `maxSteps`) so a model that overflows even after compaction can't loop forever.
- **Compaction changes the leaf, not history-in-place.** `compact` appends a `CompactionEntry` as a **new leaf** (the summary replaces the cut-off prefix); `buildContext()` walks from the new leaf. Do not mutate/delete prior entries — replay and audit need them. The "shrink" is a new active path, not a destructive edit.
- **The summarization call is itself a step.** It must be a `step.runAction` (journaled) so a crash during summarization recovers; doing it inline in the handler would re-summarize (and re-charge) on replay.
- **Store contract harnesses against `convex-test`.** Providing a Convex backend to flue's `defineStoreContractTests` means adapting the store interface to `convex-test`'s in-memory runtime; some flue contract assertions assume synchronous store semantics — translate to the mutation/query shape. Skip the AgentSubmissionStore assertions explicitly (M6) rather than stubbing them to pass.
- **`reserveTokens` and cache-token accounting (m14).** `calculateContextTokens` must read the **widened** usage rollup (incl. cache fields) so the threshold isn't computed off a too-small token count; a token-only rollup would compact too late. Confirm P3/P4 populate the cache fields before the threshold math relies on them.
- **Crash-recovery test must kill at the right seam.** To prove durability, interrupt **between** a `step.run*` checkpoint and its successor (e.g. after `llmStep` finalize, before `dispatchTools`), then resume — that's the journal-replay path. Killing at an arbitrary JS line won't exercise the workflow recovery.
- **Sample agent is a contract, not a toy.** Keep it small but real — it's the human-facing proof and the first thing a new contributor copies. If it can't exercise compaction in a reasonable run, script a low `reserveTokens` so the demo actually compacts.
