# cove-harness — Phased Execution Plans

The **build plans** for cove-harness, organized into **groups**. Each group is a
self-contained bulk of dependency-ordered phases; each phase has a uniform structure
(**Goal & scope · Dependencies · Deliverables · Source map · Hardened-contract
obligations · Implementation tasks · Acceptance · Risks & gotchas**) so it can be
executed without re-deriving the design.

> **Authoritative design** lives in [`../design/`](../design/) (README + 01–08);
> decisions run **D1–D19** in [07](../design/07-risks-and-decisions.md); the hardened
> contracts are [08 §3–§4](../design/08-conventions-and-execution-boundary.md). These
> plans *schedule* that design — where they disagree, the design-of-record wins.

## Groups

| Group | Theme | Status |
| --- | --- | --- |
| **[group-1/](group-1/)** | Core framework — engine, sessions, harness, HITL, HTTP, registries, SDK, skills catalog, Slack-inbound channel, compaction | ✅ **Built + live-verified** (P0–P12 substantive cores) |
| **group-2/** | Surface completion & production-readiness — MCP, reactive UI/`@cove/react`, CLI+codegen, channel outbound + breadth, the consolidated test suite, sample agent, observability | ◻ **Proposed** — all six detailed per-phase plans written (see [group-2/README.md](group-2/)) |

---

## Group 1 — Core framework (done)

Phases **P0–P12**, all built and live-verified on the dev deployment
`patient-antelope-291` (`tsc --noEmit` 0; 200 unit tests green; functions verified via
`convex dev --once` + `convex run`). Detailed per-phase plans live in
[`group-1/`](group-1/).

| Phase | Plan | Builds |
| --- | --- | --- |
| **P2** | [Sandbox + bash() adapter](group-1/phase-02-sandbox.md) | `convex/sandbox/` — `@upstash/box` SessionEnv + the local **real-machine** `bash()` adapter (D7) |
| **P3** | [Provider registry](group-1/phase-03-providers.md) | `convex/providers/` — AI SDK gateway, thinking budgets, non-vision downgrade, the `MockLanguageModelV2` test seam |
| **P4** | [Durable engine](group-1/phase-04-durable-engine.md) | `convex/engine/` — the `setup → (llmStep → dispatchTools)* → finalize` loop |
| **P5** | [Session store](group-1/phase-05-session-store.md) | `convex/sessions/` — SessionStore over Convex, entry-tree diff-sync, image pipeline, cascade delete |
| **P6** | [Harness + invoke + shell](group-1/phase-06-harness-invoke.md) | `convex/invoke/` + the `CoveContext→Harness→Session` facade; shell envelope + env redaction; `task()` delegation |
| **P7** | [HITL approval gate](group-1/phase-07-hitl.md) | `approvals` + `submitApproval` + the durable `awaitEvent` gate (§4.4) |
| **P8** | [HTTP + auth + workflows](group-1/phase-08-http-auth-workflows.md) | `convex/http.ts` submit/poll + `authorize` hook + `CoveHttpError` 4xx layer + `POST /workflows/:name` (D18) |
| **P8.5** | [CLI + codegen](group-1/phase-08.5-cli-codegen.md) | `defineAgentRegistry`/`defineWorkflow` constructs + registration seams (the `cove` binary + codegen carry into group-2) |
| **P9** | [Events + SDK + react](group-1/phase-09-events-sdk.md) | `src/sdk/` `createCoveClient` over reactive `requests`/`steps` queries (the `@cove/react` UI layer carries into group-2) |
| **P10** | [Skills + MCP](group-1/phase-10-skills-mcp.md) | skills catalog + import action + `activate_skill` (MCP `connectMcpServer` carries into group-2) |
| **P11** | [Channels](group-1/phase-11-channels.md) | Slack **inbound** webhook onto the P8 submit surface (outbound + breadth carry into group-2) |
| **P12** | [Compaction + tests](group-1/phase-12-compaction-tests.md) | the pure `compact` step + explicit `compact` action (auto-trigger, sample agent, and the `convex-test` harnesses carry into group-2) |

**Where group-1 stopped short.** Several phases shipped their *substantive core* and
live-verified it, but left clearly-scoped remainders — most blocked on an external
resource (a live MCP server, channel bot tokens, a browser, an installable
`convex-test`) or deferred as packaging/operability glue. **Those remainders are the
seed of group-2.**

---

## Group 2 — Surface completion & production-readiness (proposed)

Group 1 shipped the substantive cores; several phases stopped there and left a
clearly-scoped remainder — mostly blocked on an external resource (a live MCP server,
channel bot tokens, a browser, an installable `convex-test`) or deferred as
operability glue. **Group 2 finishes those halves and lands the demonstrable surface.**
Every phase *completes a group-1 remainder* — none is net-new scope. Full roadmap (goals,
deliverables, acceptance bars, risks, external prerequisites) in
[`group-2/README.md`](group-2/).

| Phase | Title | Completes | Cx |
| --- | --- | --- | --- |
| **G2.1** | [Reactive events + native SDK + `@cove/react`](group-2/#g21--reactive-events-substrate--native-sdk--covereact) | P9 | L |
| **G2.2** | [MCP integration (`connectMcpServer`)](group-2/#g22--mcp-integration-connectmcpserver) | P10 | M |
| **G2.3** | [Channels outbound + ship-first adapters](group-2/#g23--channels-outbound-reply--ship-first-adapter-set) | P11 | L |
| **G2.4** | [CLI + codegen (`cove` binary)](group-2/#g24--cli--codegen-cove-binary) | P8.5 | L |
| **G2.5** | [Compaction auto-trigger + facades + sample agent + OTel](group-2/#g25--compaction-auto-trigger--facades--sample-agent--otel-observer) | P12 glue + obs | L |
| **G2.6** | [`convex-test` harnesses + E2E crash-recovery + throughput](group-2/#g26--convex-test-store-contract-harnesses--e2e-crash-recovery--throughput-gate) | P12 tests | L |

```
G2.1 ─┬─▶ G2.2 ─┐
      │         ├─▶ G2.4 ─▶ G2.5 ─▶ G2.6
      └─▶ G2.3 ─┘
```

**Hard external blocker to confirm first:** `convex-test` must install offline (gates
G2.6 entirely). Other installs: `react`/`happy-dom` (G2.1), `@modelcontextprotocol/sdk`
(G2.2). Live-only secrets: channel bot tokens (G2.3), provider key + box token (G2.5).

---

## Conventions every phase honors

- **Reference-header convention** ([08 §2](../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)) — every new source file cites its flue/pi origin + npm package.
- **`tsc --noEmit` stays green** at the end of every phase.
- **The execution boundary** ([08 §3](../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)) — Convex orchestrates, the sandbox executes, the LLM decides; only `"use node"` engine actions touch the box.
- **Tests live in `__tests__/`** folders, never blended with source (project `.rules`).
