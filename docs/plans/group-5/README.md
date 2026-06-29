# Group 5 — Enhancement & depth

The **fourth bulk** of cove-harness build plans. Where groups 1–3 **built and shipped** the
framework (core engine, sessions, harness, HITL, HTTP, registries, SDK, skills, MCP, channels,
compaction, the `@cove/react` layer, the `cove` CLI, packaging, and the AI-SDK-7 bump — **all
merged to `main`**), **group 5 enhances what exists**: it finishes Cove's own *latent and stubbed*
core, and ports the best *proven* ideas from **pi** (the agent-loop ancestor) and **flue** (the
interface ancestor) — every one re-checked against the durable-loop thesis before it made the cut.

> Same conventions as groups 1–3 — reference headers ([08 §2](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)),
> `tsc --noEmit` green per phase, the execution boundary ([08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)),
> tests in `__tests__/`. Where this roadmap and the [design-of-record](../../design/) disagree, the
> design wins. The thesis is load-bearing throughout: **Convex owns the durable loop; the LLM
> decides but does not control flow; tools dispatch out-of-band with no AI-SDK `execute`; the AI SDK
> stays thin (model boundary only); anything a step consumes must be replay-reconstructable from the
> frozen plan + journaled state.** Every item below is measured against that.

## Method & ground truth

This group was scoped from a **56-agent audit** (8 parallel deep-readers over Cove's code, Cove's
plans, pi, and flue → 134 raw capabilities → 46 candidates → **adversarial verification of each
against the real code + thesis** → 42 survivors / 4 dropped). The verification mattered: it caught
that the plans index was **stale** (it still called group-2 "Proposed"), and corrected a wrong
starting assumption (that Cove had "Slack inbound only" — it actually ships **eight** channel
adapters already).

**Ground truth going in (all on `main`):**

- **Group 1** (P0–P12) — built + live-verified.
- **Group 2** (G2.1–G2.6) — **built + merged** (PR #1): reactive events + native SDK + `@cove/react`,
  MCP (`connectMcpServer`), channels **outbound** + a multi-adapter set, the `cove` binary +
  registry codegen, compaction auto-trigger + facades + OTel observer + sample agent, and the
  `convex-test` store-contract / crash-recovery / throughput suite.
- **Group 3** — **G3.1 (AI-SDK-7 bump) done & merged**; **G3.2 / G3.3 never built** (proposals).

So group 5 is **net-new enhancement scope**, not group-2 cleanup. It also **subsumes the unbuilt
G3.2** (see [Reconciliation with group 3](#reconciliation-with-group-3)).

## Opportunity matrix — 41 enhancements across 7 phases

Source: `cove-gap` (Cove's own latent/stubbed code) · `plan-remainder` (a documented deferral) ·
`pi` · `flue`. Value is the verified `realValue` after adversarial check.

| # | Phase | Item | Source | Value | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | **G5.1** | Wire the dormant thinking/reasoning `providerOptions` seam into decode | cove-gap, plan | **high** | M |
| 2 | G5.1 | Durable transient-retry (declarative Workpool retry on the llmStep action) | cove-gap, pi, flue | **high** | M |
| 3 | G5.1 | Real `AbortSignal` plumbing (cancel reaches `tool.execute` + `streamText`) | cove-gap, pi | med | M |
| 4 | G5.1 | Inter-chunk stall detection (idle deadline distinct from total) | cove-gap, plan | med | S |
| 5 | G5.1 | Truncation `finishReason` marker on forced-finalize | cove-gap | low | S |
| 6 | G5.1 | Pre-decode token-budget compaction guard (remove the one-step lag) | cove-gap | med | M |
| 7 | G5.1 | Cache-write usage accounting (`inputTokenDetails.cacheWriteTokens`) | cove-gap | low | S |
| 8 | G5.1 | OpenAI `strictJsonSchema:false` escape (trigger-gated hardening guard) | plan | low | S |
| 9 | **G5.2** | Mid-run **steering** (durable queue drained post-dispatch) | pi | **high** | M |
| 10 | G5.2 | Follow-up / queue modes (one-at-a-time vs batch) on the same table | pi | med | M |
| 11 | G5.2 | Per-step `activeTools` / `toolChoice` gating (from journaled state) | cove-gap, plan | med | M |
| 12 | G5.2 | Opt-in **sequential** tool-execution mode | cove-gap, pi | low | S |
| 13 | G5.2 | Public async `dispatch()` admission surface (at-least-once) | flue | med | M |
| 14 | G5.2 | Observational `tool_progress` streaming (long-tool live output) | pi | med | M |
| 15 | **G5.3** | Real **workflow-handler execution** (out-of-band, routed via admit) | cove-gap, plan, flue | **high** | L |
| 16 | G5.3 | Wire the **sandbox-factory selector** (local ↔ upstashBox) | cove-gap, plan, flue | **high** | M |
| 17 | G5.3 | Child-task delegation → durable `awaitEvent` (drop the 200 s busy-poll) | cove-gap, flue | med | M |
| 18 | G5.3 | Large-image **spill to Convex `_storage`** (threshold branch) | cove-gap | med | M |
| 19 | G5.3 | `prepareNextTurn` mid-run model/thinking re-read *(optional, deferred)* | pi | low | M |
| 20 | **G5.4** | Wire the inert facade verbs: `task()` / `shell()` / `fs` | cove-gap, plan, flue | **high** | L |
| 21 | G5.4 | Reconcile the two `CoveReactiveClient` contracts (sdk ↔ react) | cove-gap | med | M |
| 22 | G5.4 | `useCoveAgent(instanceId)` combined hook | cove-gap | **high** | S |
| 23 | G5.4 | Reactive (`onUpdate`) transport for the facade `awaitTerminal` | cove-gap | med | M |
| 24 | G5.4 | Wire `workflows.invoke` → POST + watch-to-terminal | cove-gap, flue | low | M |
| 25 | G5.4 | Export `ResultUnavailableError` from `./runtime` (barrel one-liner) | cove-gap | med | S |
| 26 | G5.4 | CLI tool/extension registry codegen + dev-watch symmetry | cove-gap | med | M |
| 27 | G5.4 | `cove logs` — tail/replay a run over the reactive event stream | flue | med | M |
| 28 | G5.4 | **Closed-by-default auth** provider (real security gap) | cove-gap | **high** | M |
| 29 | **G5.5** | Channel SPI: GET `challenge` + form/TwiML body kinds + provider Response | flue | med | M |
| 30 | G5.5 | New channels: **WhatsApp + Twilio** (gated on #29) | flue | **high** | M |
| 31 | G5.5 | New channels: one support channel (Intercom) + email (Resend) | flue | med | M |
| 32 | G5.5 | Inbound **media** ingestion (Slack/Telegram images → `LlmImageContent`) | flue | med | L |
| 33 | G5.5 | Rich outbound (Block Kit / Adaptive Cards / embeds) on the terminal reply | cove-gap | med | M |
| 34 | G5.5 | Per-inbound run options (`approvalTools` / `mcpServers` through the SPI) | cove-gap | med | S |
| 35 | G5.5 | Multi-tenant channel secrets (Convex-table lookup keyed by workspace) | flue | med | M |
| 36 | **G5.6** | Multi-edit tool (disjoint edits vs original, BOM/CRLF, unified patch) | pi, flue | **high** | M |
| 37 | G5.6 | Read-tool image branch (sandbox bytes → image content block) | pi | med | M |
| 38 | G5.6 | Richer grep params (`.gitignore`-aware, context lines, ignore-case) | pi | low | M |
| 39 | G5.6 | Bash output spillover to a box file + `[Full output: …]` footer | pi | low | S |
| 40 | **G5.7** | Live **OTLP exporter** (`use node` consumer outside the journal) | cove-gap, plan, flue | med | M |
| 41 | G5.7 | **TTFT** / throughput stats on the step row | cove-gap, plan | med | S |

## The seven phases

### G5.1 — Model-boundary hardening (seams & resilience)
Everything that lives at Cove's *one* model boundary and is currently latent, missing, or thin. The
headline is the **dormant thinking seam**: `buildProviderOptions()` and the whole `ThinkingLevel`
machinery in [`thinking.ts`](../../../convex/providers/thinking.ts) are fully built, exported, and
unit-tested — but have **zero engine callers**; `streamText` passes no `providerOptions`/`maxTokens`
today. Plus Convex-owned **durable retry** (declarative Workpool retry, not an in-action loop), real
**abort** plumbing, **inter-chunk stall** detection, a **truncation** `finishReason`, a **pre-decode
token-budget** guard that removes the one-step compaction lag, **cache-write** accounting, and the
OpenAI `strictJsonSchema` escape. No deps. **Supersedes G3.2-A and G3.2-C.**

### G5.2 — Pending-input substrate (steering, follow-up, gating)
Build the **one durable pending-input table** the design already names ([D17](../../design/07-risks-and-decisions.md),
[08 §5](../../design/08-conventions-and-execution-boundary.md)), drained per `llmStep` in a single
journaled mutation — then layer the capabilities it unlocks: pi's **mid-run steering** and
**follow-up/queue modes** (the Convex-native form, *not* pi's in-memory queue), per-step
**`activeTools`/`toolChoice`** gating folded from journaled state, an opt-in **sequential** tool
mode, the public async **`dispatch()`** admission surface, and observational **`tool_progress`**
streaming. Depends on G5.1. **Supersedes G3.2-B.**

### G5.3 — Out-of-band orchestration & durable waits
The durability-shaped gaps. Today `POST /workflows/:name` resolves the handler only as a 404 check
and reuses the plain agent-run over a mock model — the registered **workflow handler never runs**;
G5.3 executes it **out-of-band** (a `use node` action / box context) with a `CoveContext` whose
transport routes every sub-prompt back through the Convex **admit** path, so each is its own durable
journaled run. Plus wiring the **sandbox-factory selector** (a serializable selector frozen on the
plan, never a closure), converting **child-task delegation** from a 200 s busy-poll to durable
`step.awaitEvent` (modeled on HITL), and **spilling large images** to Convex `_storage`. Depends on
G5.1, G5.2. **Supersedes G3.2-D.** (`prepareNextTurn` is included **optional/deferred** — a weak fit
for Cove's unattended posture.)

### G5.4 — DX: facade completion, SDK/react reconciliation, auth & CLI
The developer-facing surface. `session.task()` / `session.shell()` / `harness.shell()` / `fs`
currently **throw `not_implemented`** in the facade even though the engine primitives exist — wire
them. Reconcile the **two divergent `CoveReactiveClient` contracts** (sdk's 3-arg `send` vs react's
1-arg), add the combined **`useCoveAgent`** hook (resolving the `streamKey`-vs-`requestId` footgun),
a **reactive transport** for the facade, **`workflows.invoke`**, the missing **`ResultUnavailableError`**
export, **CLI registry codegen + dev-watch** symmetry and **`cove logs`** — and ship a
**closed-by-default auth provider** (today an unconfigured deployment is fully open: a real security
gap). Depends on G5.1, G5.3.

### G5.5 — Channel breadth (SPI generalization & new channels)
Generalize the channel SPI **at the admission boundary only** — an optional GET **`challenge`** hook
(WhatsApp/Messenger handshakes), a declared **`bodyKind: 'json'|'form'`** + provider-owned `Response`
(Twilio TwiML), **inbound media** refs (Slack/Telegram images → `LlmImageContent`), **rich outbound**
(Block Kit / Adaptive Cards / embeds) on the single terminal reply, **per-inbound run options**
(`approvalTools`/`mcpServers`), and **multi-tenant secrets** (a Convex-table lookup). Then ship the
highest-leverage **new channels** onto it: **WhatsApp + Twilio** (hard-gated on the SPI extensions),
then a support channel (Intercom) and email (Resend). flue's **storage** adapters are explicitly
**not** ported — Convex is the store. Depends on G5.3, G5.4.

### G5.6 — Coding-agent tool depth
Bring Cove's **built-in** framework tools ([`frameworkTools.ts`](../../../convex/engine/frameworkTools.ts))
up to pi's bar: a **multi-edit** tool (disjoint edits matched against the original file, overlap
detection, BOM strip + CRLF preservation, generated unified patch), an **image-read** branch (sandbox
bytes → image content block the engine already carries), **richer grep** params, and **bash output
spillover** to a box file. Skip pi's host-only / process-global bits (binary auto-download,
detached-PID tracking — replay-hostile). Depends on G5.3 (sandbox factory).

### G5.7 — Observability depth
The pure `CoveEvent → span` fold in [`otel.ts`](../../../convex/observability/otel.ts) is complete
and tested but only ever drives an in-module recorder — there is **no real exporter**. G5.7 adds a
thin **`use node` OTLP exporter** that folds the durable `events` table through that same pure seam
via a real `NodeTracerProvider` + `OTLPTraceExporter`, running as a standalone consumer **outside the
journal** (never a replay step). Plus **TTFT** (and optional throughput) on the step row, computed
from Cove's injectable clock and persisted durably. Depends on G5.1. **Supersedes G3.2-E.**

## Reconciliation with group 3

Group 3's leverage tiers were **proposals that never shipped**. Group 5 absorbs them:

| Group-3 item | Disposition in group 5 |
| --- | --- |
| G3.2-A — wire thinking/reasoning seam | **Folded into G5.1** (item 1) |
| G3.2-B — per-step `activeTools`/`toolChoice` | **Folded into G5.2** (item 11) |
| G3.2-C — `chunkMs` stall detection | **Folded into G5.1** (item 4) |
| G3.2-D — wire `resolveSandbox` factory | **Folded into G5.3** (item 16) |
| G3.2-E — native TTFT/throughput stats | **Folded into G5.7** (item 41) |
| G3.2-F — input-aware approval predicate | **Dropped** (low value; the flat allowlist suffices) |
| G3.3 — `coveHarness` invert-expose adapter | **Unchanged** — stays a standalone, **deferred** AI-SDK item, gated on the v7 harness API leaving canary |

→ Mark **G3.2 superseded by group 5** in the plans index; **G3.3 remains** as the lone AI-SDK
forward-looking item.

## Decision log

**G5-D1 — Group 5 is "enhance," not "extend the surface."** Groups 1–3 already shipped the surface;
the audit found the highest-value work is **finishing latent Cove code** (dormant seams, inert facade
verbs, an open auth gate, a mock-model workflow path) and **porting proven pi/flue ideas** — not new
subsystems. Every item is an enhancement to something that already exists.

**G5-D2 — One durable pending-input table (D17), not pi's in-memory queue.** Steering, follow-up, and
gating all share a single journaled table drained per `llmStep`. pi's `PendingMessageQueue` +
`while(true)` outer loop is in-memory and replay-hostile; Cove's already-documented D17 form is the
thesis-aligned analog.

**G5-D3 — Workflow handlers execute out-of-band, routed through admit.** The user's handler runs in a
`use node`/box context, and every `ctx.session().prompt()` it makes is re-admitted as its own durable
journaled run. Executing user code *inside* the journaled step handler would break determinism — the
exact trap the thesis forbids.

**G5-D4 — Freeze a sandbox *selector*, not a factory closure.** Setup freezes a serializable
`{ kind, name?, size? }` selector onto the plan; the live handle is re-resolved per dispatch action
and never held across the journal (R5).

**G5-D5 — Ship closed-by-default auth.** The `authorize` hook exists but ships no default provider, so
an out-of-the-box deployment is open. A default identity-requiring provider (and wiring the
`ctx.auth.getUserIdentity()` path the design promises but never calls) is a security fix, not a
feature.

**G5-D6 — Generalize the channel SPI; don't fork 22 adapters.** New channels ride a slightly widened
SPI (GET challenge + body kinds + media refs), and flue's **storage** adapters are out of scope
entirely — Convex is the durable store, so libsql/mongo/mysql/postgres/redis would relocate state out
of the thesis.

**Ordering.** Seams first (G5.1, no deps) → the shared pending-input substrate (G5.2) → out-of-band
durability that needs the substrate (G5.3) → DX that needs the facade/auth/core (G5.4) → channels that
need the SPI + DX (G5.5); coding-tool depth (G5.6) and observability (G5.7) ride alongside off G5.3 /
G5.1.

## Considered & cut

| Item | Why cut |
| --- | --- |
| Durable `runs`-table writer + `endRun` lifecycle | `agentRequests` already covers runs per **D14**; a parallel `runs` table is redundant |
| Sandbox-sourced `AGENTS.md`/`CLAUDE.md` context-file injection | **Thesis conflict** — breaks the resolve-only-once freeze (**D13**); injected context isn't replay-stable |
| "Whole `cove dev/build` codegen" as a feature | **Already built** (G2.4); only the tool/extension-registry symmetry bug remains → kept as item 26 |
| Input-aware per-tool approval predicate (old G3.2-F) | Low value; the flat `approvalTools` allowlist suffices |
| Session branch / fork / navigate (pi) | Low value, high effort (L) for Cove's unattended posture — **deferred** |

## Phases

| Phase | Title | Plan | Items | Effort | Deps |
| --- | --- | --- | --- | --- | --- |
| **G5.1** | Model-boundary hardening | [phase-g5.1](phase-g5.1-model-boundary-hardening.md) | 8 | L | — |
| **G5.2** | Pending-input substrate | [phase-g5.2](phase-g5.2-pending-input-substrate.md) | 6 | L | G5.1 |
| **G5.3** | Out-of-band orchestration | [phase-g5.3](phase-g5.3-out-of-band-orchestration.md) | 5 | XL | G5.1, G5.2 |
| **G5.4** | DX — facade / SDK / auth / CLI | [phase-g5.4](phase-g5.4-dx-sdk-auth-cli.md) | 9 | L | G5.1, G5.3 |
| **G5.5** | Channel breadth | [phase-g5.5](phase-g5.5-channel-breadth.md) | 7 | XL | G5.3, G5.4 |
| **G5.6** | Coding-agent tool depth | [phase-g5.6](phase-g5.6-coding-agent-tools.md) | 4 | L | G5.3 |
| **G5.7** | Observability depth | [phase-g5.7](phase-g5.7-observability-depth.md) | 2 | M | G5.1 |

## Build order

```
G5.1 ──┬─▶ G5.2 ─▶ G5.3 ─┬─▶ G5.4 ─▶ G5.5
       │                  └─▶ G5.6
       └─▶ G5.7
```

**G5.1 goes first** (no deps; the highest-leverage gap — the dormant thinking seam — lives here, and
its items are independently shippable). **G5.2** lands the durable pending-input substrate everything
conversational rides on. **G5.3** is the durability capstone (workflow execution, sandbox factory,
durable child-await). **G5.4** completes the DX/security surface. **G5.5** broadens reach once the SPI
is generalized. **G5.6** and **G5.7** are parallel tracks off G5.3 / G5.1.
