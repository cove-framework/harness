# Phase G5.7 — Observability depth

> Make observability **production-grade** without ceding the durable loop: ship a live OTLP exporter
> as a standalone *"use node"* consumer that folds the durable `events` table through the **existing**
> pure span-fold ([otel.ts](../../../convex/observability/otel.ts)) **outside** the workflow journal,
> and capture TTFT / streaming-throughput stats on the step row beside the `durationMs` Cove already
> records. Both are downstream/observational reads of durable Convex state — events stay the source of
> truth, the journal is never touched, and the AI SDK stays at the model boundary. Design-of-record:
> [04 — Durable Engine](../../design/04-durable-engine.md),
> [08 — Conventions](../../design/08-conventions-and-execution-boundary.md) (§4.7 usage, §5 events →
> spans), [07 — Risks & Decisions](../../design/07-risks-and-decisions.md) (replay determinism).
> **This phase SUPERSEDES the unbuilt group-3 [G3.2 item E](../group-3/phase-g3.2-native-leverage.md)**
> (native perf stats) — item B below is the re-scoped, shipped successor.

## Goal & scope

Each item below is a **mini-spec** (what · where · why-native · effort · risk · acceptance), anchored
to the exact call site the analysis verified. The hard parts are already built: the pure
`CoveEvent → span` fold (run/operation/turn/tool/task/compaction spans with GenAI semconv + usage/cost)
is shipped and tested, and the injectable clock + delta loop already live in `decode.ts`. This phase
*wires* a real OTLP exporter onto the fold and *adds* the latency breakdown onto the step row.

**In scope:** (A) a thin OTLP-exporting *"use node"* consumer that drives the existing observer from the
durable `events` table, run **outside** the journal; (B) `ttftMs` (+ optional throughput) persisted on
the finalized step row, propagated to the `turn` event and a new OTel turn-span attribute.

**Out of scope (thesis boundary):** re-proposing the observer/fold (`otel.ts`) or the read query
(`exportSpans` in `read.ts`) — **both already shipped and tested**; running the exporter as a journaled
step inside `runHandler`/the replayed loop (a non-deterministic OTLP network push inside replay would
violate journal determinism — this is the one hard guardrail); consuming the AI SDK's ephemeral
in-memory `finalStep.performance`; replacing the deterministic query-only `exportSpans`/`SpanTreeRecorder`
test seam. No durable state leaves Convex; the `events` table stays the single source of truth.

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| A | G5.1 (model-boundary hardening landed) | the pure fold (`otel.ts`) + `exportSpans` read seam + the durable `events` table all exist; A adds only the exporter + deps |
| A | `@opentelemetry/sdk-node` + `@opentelemetry/exporter-trace-otlp-*` (new deps) | today `package.json` carries only `@opentelemetry/api` ([package.json:80](../../../package.json)) |
| B | the `decode.ts` `fullStream` loop + injectable clock (exist) | additive field on `FinalizedStep` + the `agentRequestSteps` row + the `turn` variant + an `otel.ts` attribute |
| B | supersedes [G3.2 item E](../group-3/phase-g3.2-native-leverage.md) | re-scoped: `ttftMs` is the load-bearing metric; tokens/sec + chunkCount are optional/derived |

---

## A — Live OTLP exporter action (ship spans to an external collector)

**What.** Today the read-side observer is driven only into an **in-module serializable recorder**: the
`exportSpans` query reads `events` `by_stream_and_seq`, folds them through
`createCoveOpenTelemetryObserver`, and returns a `SerializableSpan[]` tree — proving the fold **without**
standing up an external collector (the `read.ts` header calls a real OTLP exporter "a deployment concern,
out of scope" — [read.ts:233-237](../../../convex/observability/read.ts)). There is no
`NodeTracerProvider`/OTLP wiring anywhere. Add a thin *"use node"* exporter (an action or scheduled
consumer) that folds a stream's `CoveEvent`s through `createCoveOpenTelemetryObserver({ tracer })` backed
by a **real** `@opentelemetry/sdk-node` `NodeTracerProvider` + `OTLPTraceExporter` + `BatchSpanProcessor`,
so spans actually leave the process.

**Where.** The pure fold is built and AI-SDK-free (imports `@opentelemetry/api` only):
[otel.ts:17-28](../../../convex/observability/otel.ts) (imports), the observer factory
[otel.ts:55-62](../../../convex/observability/otel.ts), the turn span
[otel.ts:268-285](../../../convex/observability/otel.ts), `usageAttributes`
[otel.ts:549-571](../../../convex/observability/otel.ts) (GenAI semconv). The read seam to reuse:
[read.ts:54-62](../../../convex/observability/read.ts) `buildSpanTree`,
[read.ts:238-248](../../../convex/observability/read.ts) `exportSpans` (the `by_stream_and_seq` event read
+ `r.data as CoveEvent` mapping), the forwarded redactor
[read.ts:38](../../../convex/observability/otel.ts)/[read.ts:56-59](../../../convex/observability/read.ts)
`exportContent`. Durable source: the `events` table
[schema.ts:344-357](../../../convex/schema.ts) (the `by_stream_and_seq` index at
[schema.ts:356](../../../convex/schema.ts)). *"use node"* precedent: the action header in
[compact.ts:1](../../../convex/engine/compact.ts) and [llmStep.ts:1](../../../convex/engine/llmStep.ts).
Current dep floor: only `@opentelemetry/api` ([package.json:80](../../../package.json)).

**Target.** A new *"use node"* file (e.g. `convex/observability/export.ts`) that: (1) reads a stream's
`events` rows by `by_stream_and_seq` (reuse `buildSpanTree`'s seam — fold the same `CoveEvent[]`); (2)
builds a real `NodeTracerProvider` with an `OTLPTraceExporter` + `BatchSpanProcessor`, passes
`provider.getTracer("cove")` into `createCoveOpenTelemetryObserver({ tracer, exportContent })`, and
forwards `exportContent` for redaction (already supported); (3) on flush, awaits `provider.forceFlush()`.
Trigger it as a **standalone consumer off the `events` table** (scheduled drain by `seq` watermark, or an
explicitly-invoked admin action) — **never** from inside `runHandler`/the replayed loop.

**Why native / why it fits.** The exporter is a pure **downstream read-side consumer**: it reads the
durable `events` rows (Convex remains the source of truth — events are not relocated, they remain durable
rows) and ships spans onward. The expensive part — `CoveEvent → span` semantics with GenAI semconv +
usage/cost — is fully built and AI-SDK-free ([otel.ts:17-28](../../../convex/observability/otel.ts)
imports zero AI SDK). It touches neither the `@convex-dev/workflow` journal nor replay determinism, and
introduces no competing loop/durability engine. **Hard guardrail:** it must run *outside* the journal — a
non-deterministic OTLP network push inside the replayed loop would break journal determinism (this is the
single reason it is an exporter *consumer*, not a journaled step). The *"use node"* action shape reading
durable state is already idiomatic ([compact.ts:1](../../../convex/engine/compact.ts),
[llmStep.ts:1](../../../convex/engine/llmStep.ts)). Keep the deterministic query-only
`exportSpans`/`SpanTreeRecorder` ([read.ts:71-105,238-248](../../../convex/observability/read.ts)) as the
offline test seam — **do not replace it**.

> **Decision note.** The exporter being deferred is intentional history, not an oversight: G2.5 shipped
> the observer + an in-memory `Tracer` test and **explicitly deferred** "a live OTel collector / exporter
> wiring" as "an app-deployment concern, not framework scope"
> ([phase-g2.5:18,58,80](../group-2/phase-g2.5-glue-sample-otel.md)). This item lands exactly that deferred
> half — and only that half — now that a deployment surface exists.

**Effort** M (deps + provider/exporter wiring + the drain trigger; the fold is free). **Risk** low — a
read-side consumer of durable state; no journal/loop/durability change, the new deps are V8-incompatible
so they live only in the *"use node"* file.

**Acceptance.** Invoking the exporter for a finished stream ships run/operation/turn/tool/task/compaction
spans (with GenAI semconv usage/cost attributes) to a configured OTLP endpoint, byte-for-byte the same
span shape the `exportSpans` query already returns; `exportContent` redaction suppresses content
attributes as in the query path; the exporter is **never** reachable from `runHandler`/the journaled loop
(a test or lint asserts no journaled caller); the existing `exportSpans` query + `otel.test.ts` remain
green and unchanged (the deterministic test seam is untouched); re-running the exporter over the same
`events` rows re-emits the same spans (idempotent fold over an append-only log).

---

## B — Capture TTFT + streaming throughput stats on the step row

**What.** Persist per-step **time-to-first-output** (and optionally throughput) alongside the
`durationMs` Cove already records. Today `decode.ts` stamps only total `durationMs = now() - start`; there
is no time-to-first-token, tokens/sec, or chunk count — so a fast-first-token-then-slow turn is
indistinguishable from a slow-to-start one. Using Cove's **injectable clock** inside the existing
`fullStream` loop, timestamp the first text/reasoning/tool-call delta as `ttftMs` and fold it onto the
finalized step row, the `turn` event, and a new OTel turn-span attribute.

**Where.** The clock + loop already exist: [decode.ts:123-124](../../../convex/engine/decode.ts)
`now = deps.now ?? Date.now; start = now()` (injectable), `durationMs` computed at
[decode.ts:252](../../../convex/engine/decode.ts) on the `FinalizedStep`
([decode.ts:44-53](../../../convex/engine/decode.ts), which carries `durationMs` but no latency
breakdown). Sinks to mirror: the `turn` event emit
[decode.ts:261-276](../../../convex/engine/decode.ts) (carries `durationMs`/`model`/`usage`); the
persisted row `agentRequestSteps` [schema.ts:269-316](../../../convex/schema.ts) (`durationMs` at
[schema.ts:311](../../../convex/schema.ts), no perf field); the `turn` `CoveEvent` variant
[types.ts:885-898](../../../src/runtime/types.ts) (`durationMs` at
[types.ts:889](../../../src/runtime/types.ts), `usage` at [types.ts:894](../../../src/runtime/types.ts) —
no throughput fields); the OTel turn span [otel.ts:268-285](../../../convex/observability/otel.ts) (today
sets `cove.duration_ms`) and `usageAttributes` [otel.ts:549-571](../../../convex/observability/otel.ts).
Prior art: pi's display-only tokens/sec extension `pi/.pi/extensions/tps.ts` (not TTFT, not persisted).

**Target.** Timestamp the first delta inside the `fullStream` loop → `ttftMs` (the **load-bearing,
non-derivable** metric); add `ttftMs?: number` to `FinalizedStep`
([decode.ts:44-53](../../../convex/engine/decode.ts)), thread it through `finalizeStep` onto
`agentRequestSteps` ([schema.ts:269-316](../../../convex/schema.ts)), the `turn` variant
([types.ts:885-898](../../../src/runtime/types.ts)), and a new `gen_ai`/`cove` turn-span attribute in
[otel.ts:268-285](../../../convex/observability/otel.ts) — wiring it to **mirror the existing `durationMs`
plumbing exactly**. Treat `outputTokensPerSecond` and `chunkCount` as **optional/derived**: tokens/sec ≈
`usage.output / durationMs` is already recoverable post-hoc, and `chunkCount` is marginal — ship them only
if free.

**Why native / why it fits.** This **supersedes [G3.2 item E](../group-3/phase-g3.2-native-leverage.md)**
(native perf stats), re-scoped to the one metric that cannot be recomputed downstream. It adds durable
observability fields **into** Convex (step row + turn event), not out; introduces no competing
loop/durability engine; and explicitly **declines** to consume the AI SDK's ephemeral in-memory
`finalStep.performance` (which evaporates on a workflow replay that rebuilds from the persisted row and is
absent on the force-finalize path) — keeping the SDK thin. It reuses the already-injectable clock
([decode.ts:123](../../../convex/engine/decode.ts)).

> **Decision note (replay framing).** `ttftMs`/`tokensPerSec` are wall-clock-derived and will **not** be
> bit-identical across a crash-replay re-decode — but neither is the existing `durationMs` (also
> `now() - start`). They are **observational, non-control-flow metadata in the same replay class as
> `durationMs`**: the loop's `StepDecision` control flow never consumes them, so they introduce no new
> determinism hazard. Describe them as "same replay class as `durationMs`," **not** "bit-stable on replay."

**Effort** S (one additive field mirrored across four already-existing sinks). **Risk** low — additive,
reuses the injectable clock, no flow/durability change.

**Acceptance.** A streamed step records `ttftMs` (start → first text/reasoning/tool-call delta) on the
persisted `agentRequestSteps` row and emits it on the `turn` event and as a new OTel turn-span attribute,
threaded exactly like `durationMs`; a force-finalized / no-delta step degrades gracefully (no crash;
`ttftMs` absent or `null`, `durationMs` still recorded); a replay reconstructs the step from the row
without re-decoding and the loop's `StepDecision` is unchanged (the values are non-control-flow metadata,
same replay class as `durationMs`); existing `decode`/usage tests stay green.

## Risks & gotchas (cross-item)

- **A — never a journaled step (the one hard guardrail).** The exporter must be a standalone *"use node"*
  consumer triggered **off** the `events` table, *never* invoked from `runHandler`/the replayed loop. A
  non-deterministic OTLP network push inside the journal would break replay determinism. Wire it as a
  scheduled drain / admin action, not a `step.run*` dependency.
- **A — keep the deterministic test seam.** Do **not** replace the query-only
  `exportSpans`/`SpanTreeRecorder` ([read.ts:238-248](../../../convex/observability/read.ts)) — it is the
  offline/unit-test seam that proves the fold without a collector. The exporter is *additive*: the same
  `buildSpanTree` fold, a different tracer backend.
- **A — new deps are V8-incompatible.** `@opentelemetry/sdk-node` + the OTLP exporter must be imported
  only inside the *"use node"* file ([compact.ts:1](../../../convex/engine/compact.ts) precedent); the
  pure fold ([otel.ts](../../../convex/observability/otel.ts)) keeps its `@opentelemetry/api`-only floor so
  it stays usable from the query path.
- **A — forward `exportContent`.** Redaction is already plumbed through the observer
  ([otel.ts:38](../../../convex/observability/otel.ts)); the exporter must forward it so content
  attributes are stripped on the export path exactly as in the query path — do not ship un-redacted
  content to an external collector.
- **B — observational, not bit-stable.** Stamp `ttftMs` from the injectable clock and treat it as
  non-control-flow metadata. The `StepDecision`/loop must never branch on it, or a replay whose wall-clock
  differs would diverge. Same discipline already applied to `durationMs`.
- **A + B — events stay the source of truth.** Both items only *read* (A) or *append observational fields
  to* (B) durable Convex state. Neither relocates the `events` table, neither adds a competing durability
  engine, and neither lets the AI SDK own anything above the model call.
