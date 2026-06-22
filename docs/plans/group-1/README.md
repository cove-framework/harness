# cove-harness — Phased Execution Plans

The **build plan** for cove-harness: one actionable plan per phase, derived from the
[design-of-record](../../design/README.md) (the *what/why*) into the *how/when*. Each plan
has a uniform structure — **Goal & scope · Dependencies · Deliverables · Source map
(flue/pi → cove) · Hardened-contract obligations · Implementation tasks · Acceptance ·
Risks & gotchas** — so a phase can be executed without re-deriving the design.

> **Authoritative design** lives in [`../design/`](../../design/) (README + 01–08); decisions
> run **D1–D19** in [07](../../design/07-risks-and-decisions.md); the hardened contracts are
> [08 §3–§4](../../design/08-conventions-and-execution-boundary.md). These plans *schedule*
> that design — where they disagree, the design-of-record wins.

## Status

**Phases 0–1 are done** (scaffold + the SOR schema + the ported pure core in
[`src/runtime/`](../../../src/runtime/); `tsc --noEmit` clean). The plans below cover the
remaining build, **P2–P12**.

| Phase | Plan | Builds | Depends on |
| --- | --- | --- | --- |
| **P2** | [Sandbox + bash() adapter](phase-02-sandbox.md) | `convex/sandbox/` — `@upstash/box` SessionEnv + the local **real-machine** `bash()` adapter (D7) | P1 |
| **P3** | [Provider registry](phase-03-providers.md) | `convex/providers/` — AI SDK gateway, thinking budgets, non-vision downgrade, the `MockLanguageModelV2` test seam | P1 |
| **P4** | [Durable engine](phase-04-durable-engine.md) | `convex/engine/` — the `setup → (llmStep → dispatchTools)* → finalize` loop; honors **all** of [08 §4](../../design/08-conventions-and-execution-boundary.md#4-hardened-engine-contracts) | P2, P3, P5 |
| **P5** | [Session store](phase-05-session-store.md) | `convex/sessions/` — SessionStore over Convex, entry-tree diff-sync, image pipeline, cascade delete | P1 (co-dev w/ P4) |
| **P6** | [Harness + invoke + shell](phase-06-harness-invoke.md) | `convex/invoke/` + the `CoveContext→Harness→Session` facade; shell envelope + env redaction (§4.11); admission test (M6) | P4, P5 |
| **P7** | [HITL approval gate](phase-07-hitl.md) | `approvals` + `submitApproval` + the durable `awaitEvent` gate (§4.4) | P4, P6 |
| **P8** | [HTTP + auth + workflows](phase-08-http-auth-workflows.md) | `convex/http.ts` submit/poll + `authorize` hook + `CoveHttpError` 4xx layer + **restored** `defineWorkflow`/`POST /workflows/:name` (D18) | P4, P5, P6 |
| **P8.5** | [CLI + codegen](phase-08.5-cli-codegen.md) | the `cove` binary + `defineAgentRegistry`/`defineWorkflow` codegen + build-time validation | P8 |
| **P9** | [Events + SDK + react](phase-09-events-sdk.md) | `convex/events/` + `createCoveClient` + `@cove/react` (the `UIMessage` reducer, m1) | P4, P6 |
| **P10** | [Skills + MCP](phase-10-skills-mcp.md) | skills catalog + import action + `session.skill()`; `convex/mcp/` (the one network exception to box-binding, §4.5) | P6 |
| **P11** | [Channels](phase-11-channels.md) | channel adapters onto the P8 submit surface (D14); SQL-adapter collapse (D1) | P8 |
| **P12** | [Compaction + sample + tests](phase-12-compaction-tests.md) | the `compact` step (threshold + overflow→retry); sample agent (G1–G5); the consolidated test suite | P4, P5, P9 |

## Build order (critical path)

```
P1 ──▶ P2 ─┐
           ├─▶ P4 ──▶ P6 ──┬─▶ P7
P1 ──▶ P3 ─┘     ▲         ├─▶ P8 ──▶ P8.5
P1 ──▶ P5 ───────┘         │     └──▶ P11
                           ├─▶ P9 ─────────┐
                           └─▶ P10         ├─▶ P12
                                           ┘
```

- **P4 + P5 are co-developed** — the loop needs `sessions.load/save`; build them together.
- **P6 is the fan-out point** — P7/P8/P9/P10 all build on the admission + facade surface.
- **P12 is the gate** — it consolidates the store-contract harnesses, the E2E crash-recovery
  test, and the throughput regression, and proves G1–G5 with the sample agent.

## Conventions every phase honors

- **Reference-header convention** ([08 §2](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)) — every new source file cites its flue/pi origin + npm package.
- **`tsc --noEmit` stays green** at the end of every phase.
- **The execution boundary** ([08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)) — Convex orchestrates, the sandbox executes, the LLM decides; only `"use node"` engine actions touch the box.
- **Coverage-audit additions are folded in** — result re-nudge + `ResultUnavailableError` (P4/P12, §4.10), shell env redaction (P6, §4.11), the restored Workflow surface (P8, D18), the `MockLanguageModelV2` test seam (P3), the admission-contract test (P6, M6), and the §5 scope-cut citations.
