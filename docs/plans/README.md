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
| **[group-2/](group-2/)** | Surface completion & production-readiness — MCP, reactive UI/`@cove/react`, CLI+codegen, channel outbound + breadth, the consolidated test suite, sample agent, observability | ✅ **Built + merged** (G2.1–G2.6, PR #1 on `main`) |
| **[group-3/](group-3/)** | AI SDK 7 — upgrade & leverage — the v5→v7 bump (done), the Tier-0 native-leverage wins, and the Tier-1 `coveHarness` invert-expose play | ✅ **G3.1 bump done & merged** (`789b180` on `main`; tsc 0 / 412 tests / tsup OK). **G3.2 superseded by group-5** (its items folded in); **G3.3 deferred** (gated on the v7 harness API leaving canary) |
| **[group-4/](group-4/)** | **Convex → AWS migration (hard cut)** — re-platform the durable loop onto Step Functions Standard, the 10 tables onto DynamoDB, the reactive substrate onto API Gateway WebSockets + DynamoDB Streams, ingress onto API Gateway REST (closed-by-default auth), blobs onto S3 — all via AWS CDK; `convex/` deleted at cutover, the portable core reused | ◻ **Proposed** — 8 dependency-ordered phases (G4.1–G4.8); 14 decisions (D-AWS-1…14); thesis preserved (orchestrator still owns the loop). See [group-4/README.md](group-4/) |
| **[group-5/](group-5/)** | Enhancement & depth — finish Cove's latent/stubbed core + port proven pi/flue ideas (model-boundary hardening, pending-input substrate, out-of-band orchestration, DX/auth/CLI, channel breadth, coding-tool depth, observability) | ◻ **Proposed — deferred** (renamed from group-4 on 2026-06-28 to free the group-4 slot for the AWS migration; tackle later) — 7 dependency-ordered phases / 41 verified items (see [group-5/README.md](group-5/)) |

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

## Group 2 — Surface completion & production-readiness (built + merged)

Group 1 shipped the substantive cores; several phases stopped there and left a
clearly-scoped remainder — mostly blocked on an external resource (a live MCP server,
channel bot tokens, a browser, an installable `convex-test`) or deferred as
operability glue. **Group 2 finished those halves and landed the demonstrable surface** —
G2.1–G2.6 are **built and merged to `main`** (PR #1). Every phase *completed a group-1
remainder* — none was net-new scope. Full roadmap (goals, deliverables, acceptance bars,
risks, external prerequisites) in [`group-2/README.md`](group-2/).

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

## Group 3 — AI SDK 7 — upgrade & leverage (bump merged; G3.2 superseded)

Cove's AI-SDK surface is deliberately minimal (one `streamText`, two `generateText`, `tool()` with
no `execute`) because Convex owns the durable loop. That minimalism makes the **v5→v7 bump cheap**
and makes most of v7's headline features **already-native or would-conflict** rather than gaps to
fill. The user **decided to bump** (overriding the earlier "stay on v5" recommendation) — and the
v5→v7 migration (**G3.1**) is **done and merged** (`789b180` on `main`; `ai ^7.0.2`, `@ai-sdk/*@4`/`@5`).
The leverage tiers it unlocked have since been **absorbed by [group-5](group-5/)**: G3.2's Tier-0 items
fold into G5.1/G5.2/G5.3/G5.7, leaving only **G3.3** (`coveHarness` invert-expose) as a deferred,
canary-gated item. Full opportunity report (12-feature matrix, 4-tier breakdown, GA/beta nuance,
decision log) in [`group-3/README.md`](group-3/).

| Phase | Title | Plan | Tier | Status |
| --- | --- | --- | --- | --- |
| **G3.1** | AI SDK 7 upgrade (v5→v7) | [phase-g3.1](group-3/phase-g3.1-ai-sdk-7-upgrade.md) | 2 (bump) | ✅ Done & merged (`789b180` on `main`; tsc 0 / 412 tests / tsup OK) |
| **G3.2** | Native leverage (Tier 0, A–F) | [phase-g3.2](group-3/phase-g3.2-native-leverage.md) | 0 | ⤳ **Superseded by [group-5](group-5/)** — items A/B/C/D/E folded into G5.1/G5.2/G5.3/G5.7; F dropped |
| **G3.3** | Cove as an AI-SDK harness adapter (`coveHarness`) | [phase-g3.3](group-3/phase-g3.3-harness-adapter.md) | 1 | ◻ Proposed — deferred (gated on canary) |

```
G3.1 (bump, ACTIVE) ─▶ G3.2 (native leverage; A/C/D shippable independently)
                        └─▶ G3.3 (invert-expose; gated on harness API leaving canary)
```

**The hard v7 gate is already cleared** — Node 22+/ESM (`engines.node ">=22.18"` + `"type":"module"`)
and Cove is already on `ModelMessage` — so G3.1 is a small, mechanical migration: two-hop codemods +
~6 manual fix-sites + the load-bearing `LanguageModelV2→V3` spec bump. **Tier 3 is explicitly
do-not-adopt** (`WorkflowAgent`, `ToolLoopAgent`, v7 `timeout`, `registerTelemetry`, `toolApproval`,
`contextSchema`/`toolsContext`, `uploadSkill`) — each surrenders the Convex-owns-the-loop thesis.

---

## Group 4 — Convex → AWS migration (hard cut)

A **hard re-platform off Convex onto AWS** — no strangler-fig, no dual backend. The durable agent loop
moves from `@convex-dev/workflow` to **Step Functions STANDARD**; the 10 logical tables fold onto **9
DynamoDB tables**; the reactive substrate (flue's SSE replacement) moves to **API Gateway WebSocket +
DynamoDB Streams**; ingress to **API Gateway REST + a closed-by-default Lambda authorizer**; large blobs
to **S3**; all provisioned with **AWS CDK (TypeScript)** in one consolidated `backend/` folder. The
portable, backend-agnostic core (`convex/engine/loop.ts` — already pure over `RunLoopDeps` — plus
`decode`/`compact`/`resultTools`/registries/channel-verify cores and `src/runtime/*`) is reused verbatim;
only the Convex **adapter** seam is replaced, then `convex/` + `@convex-dev/*` are deleted. Full roadmap
(surface mapping, the DynamoDB key design, the ASL loop-translation, journal-replay crash-recovery, the
14-entry `D-AWS-*` decision log, considered-&-cut) in [`group-4/README.md`](group-4/).

| Phase | Title | Replaces | Depends on |
| --- | --- | --- | --- |
| **G4.1** | [Foundation — CDK + DynamoDB + S3 + `store/`](group-4/phase-g4.1-foundation-cdk-dynamodb.md) | `defineSchema` (10 tables), `ctx.db`/`ctx.storage`, `sessions/*` | — |
| **G4.2** | [Compute — task-worker Lambdas](group-4/phase-g4.2-compute-lambda-actions.md) | the `"use node"` engine actions (`llmStep`/`dispatchTools`/`compact`/`finalize`/`setup`/`mcpDiscover`) | G4.1 |
| **G4.3** | [Orchestrator — Step Functions STANDARD](group-4/phase-g4.3-durable-orchestrator-stepfunctions.md) | `WorkflowManager` + `workflow.define` + the `loop.ts` driver (`runHandler.ts`) | G4.2 |
| **G4.4** | [HITL — task tokens](group-4/phase-g4.4-hitl-task-tokens.md) | `step.awaitEvent` + `workflow.sendEvent` + `approvals` | G4.3 |
| **G4.5** | [Ingress — API GW REST + closed authorizer](group-4/phase-g4.5-ingress-apigw-auth.md) | `httpRouter`/`httpAction` + the open-by-default `runAuthorize` | G4.1, G4.3 |
| **G4.6** | [Reactive — WebSocket + Streams fan-out](group-4/phase-g4.6-reactive-websocket-streaming.md) | reactive queries + `deltaBatcher`→`patchStreaming` + the `convex/react` transport | G4.1, G4.2/G4.3 |
| **G4.7** | [Channels / workflows / scheduler](group-4/phase-g4.7-channels-workflows-scheduler.md) | channels inbound+reply, `workflow.invoke`, `ctx.scheduler.runAfter(0)` | G4.3 |
| **G4.8** | [Tests / parity / cutover](group-4/phase-g4.8-tests-parity-cutover.md) | `convex-test` (412 tests); the HARD delete of `convex/` + `@convex-dev/*` | ALL |

```
G4.1 ─┬─▶ G4.2 ─▶ G4.3 ─┬─▶ G4.4
      │                 └─▶ G4.7
      ├─▶ G4.5                        G4.8  gates cutover (depends on ALL)
      └─▶ G4.6
```

**Thesis preserved.** The orchestrator still owns the loop (Step Functions, not a Lambda); the LLM
decides but does not control flow (`llmStep` returns a small `{overflow, toolCallCount, gatedCount,
shouldCompact}` decision the ASL Choice states branch on); tools dispatch out-of-band in `@upstash/box`
with no AI-SDK `execute`; the AI SDK stays thin; every step is replay-reconstructable from the frozen
runPlan + journaled DynamoDB state. Headline calls: **multi-table** DynamoDB (D-AWS-1), **STANDARD not
Express** (D-AWS-2), **deltas over WS / only finalized steps persisted** (D-AWS-3), **closed-by-default
auth** (D-AWS-6), **`loop.ts` kept as the executable spec the ASL is derived from** (D-AWS-9),
**continue-as-new** to bound SFN history (D-AWS-12).

---

## Conventions every phase honors

- **Reference-header convention** ([08 §2](../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)) — every new source file cites its flue/pi origin + npm package.
- **`tsc --noEmit` stays green** at the end of every phase.
- **The execution boundary** ([08 §3](../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)) — Convex orchestrates, the sandbox executes, the LLM decides; only `"use node"` engine actions touch the box.
- **Tests live in `__tests__/`** folders, never blended with source (project `.rules`).
