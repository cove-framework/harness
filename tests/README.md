# tests/ — the hermetic convex-test suite (G2.6)

Full-stack verification against the **live Convex adapters** in an in-memory deployment (`convex-test`),
complementing the ~320 pure-logic units under `convex/**/__tests__` and `src/**/__tests__`.

## Run

```bash
npm test          # both vitest projects (units on node, integration on edge-runtime)
```

`vitest.config.ts` is a **multi-project** config:
- **units** — `environment: node` — the existing pure-logic specs (DI ports, the decode/dispatch cores, the
  pure compaction/redaction/reducer logic). They import `"use node"` modules transitively and need node globals.
- **integration** — `environment: edge-runtime` — this `tests/` tree. `convexTest(schema)` runs Convex
  functions inside an edge-runtime VM.

## What this tree proves

- `contract/session-store.test.ts`, `contract/event-stream-store.test.ts`, `contract/run-store.test.ts` —
  the three store-contract harnesses (ports of flue's `defineStoreContractTests` **SessionStore half** + the
  run/event-stream contracts), reshaped to the Convex mutation/query backend.
- `e2e/recovery.test.ts` — the crash-recovery **persistence invariants** (finalized-row replay source,
  idempotent `appendToolResult` by `toolCallId`, idempotent `insertStreaming`).
- `e2e/compaction.test.ts` — the compaction **store invariant** (`CompactionEntry` → `[summary + tail]`
  next-decode context) + the threshold predicate.
- `perf/throughput.test.ts` — the delta-batcher coalescing at production cadence, full-stack through the real
  `patchStreaming` mutation.

## Constraints (by design)

- **The edge-runtime VM does not execute `"use node"` actions** (`llmStep`/`dispatchTools`/`compact`). The
  model is injected at the `resolveModel` seam (`cove-test/mock`); no live provider, no live box. The
  decode/dispatch **execution** cores (incl. the at-most-once-model-call replay guard) are proven **pure** in
  the units; this tree proves the **DB-contract + persistence** behavior those cores depend on.
- **M6 / D5: exactly three store harnesses** — there is **no** `AgentSubmissionStore` harness; durable
  recovery is owned by `@convex-dev/workflow`, so flue's lease/turn-journal/attempt-marker contract is dropped.
  `grep -rn AgentSubmissionStore tests/` returns only the M6 non-port comment.
- **`convex-test` + `@edge-runtime/vm`** are the only added devDeps (the documented external prerequisite).
