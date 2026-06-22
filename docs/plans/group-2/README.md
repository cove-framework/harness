# Group 2 — Surface completion & production-readiness

The **second bulk** of cove-harness build plans. Group 1 ([`../group-1/`](../group-1/))
shipped and live-verified the *substantive cores* of P0–P12; several phases deliberately
stopped at their core and left a clearly-scoped remainder — most blocked on an external
resource (a live MCP server, channel bot tokens, a browser, an installable `convex-test`)
or deferred as packaging/operability glue. **Group 2 finishes those halves and lands the
demonstrable surface** so Cove's public API, durability, and observability become
end-to-end provable.

> Same conventions as group 1 — reference headers ([08 §2](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)),
> `tsc --noEmit` green per phase, the execution boundary ([08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)),
> tests in `__tests__/`. Where this roadmap and the [design-of-record](../../design/) disagree,
> the design wins.

## Theme

> Finish the deferred halves of group-1 (reactive events/SDK, MCP, channel outbound,
> CLI codegen, compaction auto-trigger, `convex-test` harnesses) and add the demonstrable
> surface (worked sample agent + OpenTelemetry observer).

## Status

◻ **Proposed** — this is the roadmap-of-record for the next bulk. **All six** detailed
per-phase plans (mirroring group-1's *Goal · Deps · Deliverables · Source map ·
Hardened-contract obligations · Implementation tasks · Acceptance · Risks* structure)
are now written and linked from the [Phases table](#phases) below:

- ✅ **G2.1** — [phase-g2.1-events-sdk-react.md](phase-g2.1-events-sdk-react.md)
- ✅ **G2.2** — [phase-g2.2-mcp.md](phase-g2.2-mcp.md)
- ✅ **G2.3** — [phase-g2.3-channels-outbound.md](phase-g2.3-channels-outbound.md)
- ✅ **G2.4** — [phase-g2.4-cli-codegen.md](phase-g2.4-cli-codegen.md)
- ✅ **G2.5** — [phase-g2.5-glue-sample-otel.md](phase-g2.5-glue-sample-otel.md)
- ✅ **G2.6** — [phase-g2.6-convex-test-suite.md](phase-g2.6-convex-test-suite.md)

## Phases

Each phase **completes a group-1 remainder** (none are net-new scope — group 2 is about
finishing, hardening, and proving what group 1 began).

| Phase | Title | Plan | Completes | Cx |
| --- | --- | --- | --- | --- |
| **G2.1** | [Reactive events + native SDK + `@cove/react`](#g21--reactive-events-substrate--native-sdk--covereact) | [phase-g2.1](phase-g2.1-events-sdk-react.md) | P9 | L |
| **G2.2** | [MCP integration (`connectMcpServer`)](#g22--mcp-integration-connectmcpserver) | [phase-g2.2](phase-g2.2-mcp.md) | P10 | M |
| **G2.3** | [Channels outbound + ship-first adapter set](#g23--channels-outbound-reply--ship-first-adapter-set) | [phase-g2.3](phase-g2.3-channels-outbound.md) | P11 | L |
| **G2.4** | [CLI + codegen (`cove` binary)](#g24--cli--codegen-cove-binary) | [phase-g2.4](phase-g2.4-cli-codegen.md) | P8.5 | L |
| **G2.5** | [Compaction auto-trigger + facades + sample agent + OTel](#g25--compaction-auto-trigger--facades--sample-agent--otel-observer) | [phase-g2.5](phase-g2.5-glue-sample-otel.md) | P12 glue + post-P12 obs | L |
| **G2.6** | [`convex-test` harnesses + E2E crash-recovery + throughput](#g26--convex-test-store-contract-harnesses--e2e-crash-recovery--throughput-gate) | [phase-g2.6](phase-g2.6-convex-test-suite.md) | P12 tests | L |

## Build order

```
G2.1 ─┬─▶ G2.2 ─┐
      │         ├─▶ G2.4 ─▶ G2.5 ─▶ G2.6
      └─▶ G2.3 ─┘
```

**G2.1 goes first** — it has no upstream deps and unblocks the most downstream value:
the reactive event stream is empty today, and the OTel observer (G2.5), the channel
streaming-reply option (G2.3), and the event-stream store harness (G2.6) all read it.
**G2.2 (MCP) and G2.3 (channels)** are parallelizable peers that soft-depend on G2.1;
MCP is sequenced first because it touches the engine boundary (the `setup` → `"use node"`
conversion) that later phases reason about, and carries the riskier replay/quarantine
invariants worth landing while the engine is fresh. **G2.4 (CLI codegen)** follows
channels so `convex/http.ts` ownership is settled before the http-entry codegen targets
it; it also installs the registry seams the sample agent consumes. **G2.5 (glue + sample
+ OTel)** needs G2.1's event contract, G2.2's MCP tools, and G2.4's consumed registry to
demonstrate G1–G5. **G2.6 (test capstone)** goes last so it verifies finished behavior
rather than a moving target — and it is gated on the external `convex-test` install
regardless of code readiness.

---

## G2.1 — Reactive events substrate + native SDK + `@cove/react`

📄 **Detailed plan:** [phase-g2.1-events-sdk-react.md](phase-g2.1-events-sdk-react.md)

**Completes P9.** Replace the poll-only SDK and the `steps`/`requests` stand-in reads with
the real durable + reactive events path.

**Deliverables (highlights):**
- `convex/events/{seq,redact,append,read}.ts` — monotonic `seq` over `by_stream_and_seq`,
  full-`CoveEvent` `redactEventImages` (covers `message_*`/`turn_messages`/`agent_end`/`tool`),
  the `append` internalMutation (decorate `v:1`/`eventIndex`/timestamp → redact → seq → fan
  out to stream keys), and reactive `listForStream`/`listForSubmission` queries.
- **Engine emitter wiring** at `setup`/`llmStep`/`dispatchTools`/`finalize` — *the hidden
  cost:* the engine emits **zero** events today, so the read path is empty until the emitter
  call sites land. This is in-scope, not just the `append` mutation.
- `convex/runs.ts` `get`/`listRuns` so the SDK `runs.get(runId)` has a backend.
- `src/sdk/{types,client,event-stream}.ts` — `createCoveReactiveClient({ convex })`
  (distinct from the existing runtime-facade `createCoveClient`) whose `runs.events()`
  async-iterates `convex.onUpdate(api.events.listForStream)` with catch-up-by-`seq` +
  live tail + cancel (coexists with the current poll transport).
- `src/react/*` — the ported reducer (`role:'signal'` early-return + `IMAGE_DATA_OMITTED`
  file-part reuse) + `CoveProvider`/`useAgentPrompt`/`useRunEvents` hooks.

**External prereqs:** offline devDeps `react`, `@types/react`, `@testing-library/react`,
`happy-dom`; `react>=18` peerDep. No live services (query/mutation + client only, never
`"use node"`).

**Acceptance highlights:** full ordered live sequence with **zero SSE imports** (grep
proves it); events carry **no bytes** (`IMAGE_DATA_OMITTED`, `mimeType` intact); the 14
ported reducer cases pass (receipt/echo both collapse to one message; redacted re-emit
reuses the prior file part); `tsc --noEmit` 0 + vitest green with `src/react/**` under
happy-dom.

**Top risks:** the empty-stream emitter cost; Convex `onUpdate` re-delivers the whole
result each tick (the stream must diff by `seq`/event-id); `PATCHED` step rows vs
append-only events must not double-count text; React stays a **peerDep** (no second
bundled instance).

## G2.2 — MCP integration (`connectMcpServer`)

📄 **Detailed plan:** [phase-g2.2-mcp.md](phase-g2.2-mcp.md)

**Completes P10** (the MCP half; the skills catalog half already shipped). Network tools as
**closure-free frozen descriptors** — the one sanctioned departure from box-binding
([08 §4.5](../../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors)).

**Deliverables (highlights):**
- `package.json` += `@modelcontextprotocol/sdk ^1.29.0` (imported **only** under `convex/mcp/`).
- `src/runtime/mcp-types.ts` — type-only port (no SDK runtime import); `mcpServers?:` added
  to `AgentProfile`; threaded onto the request via `convex/invoke/{submit,admit}.ts`.
- `convex/mcp/{connect,descriptors,pool}.ts` (`"use node"`) — near-verbatim port of flue
  `mcp.ts` (incl. `connectMcpServerWithClient` injectable seam), `freezeMcpTool` →
  `McpToolDescriptor`, and a per-process connection pool (cache / evict / `close()`).
- `convex/engine/setup.ts` → `"use node"` (or a `"use node"` discovery helper) to run
  `listTools`, freeze each tool `kind:'mcp'`, reserved-name collision check.
- `convex/engine/buildTools.ts` — replace the `case "mcp"` stub with `pool.getOrOpen` +
  re-resolution per beat; connect failure / drift → **error tool-result**, never a crash.

**External prereqs:** `@modelcontextprotocol/sdk ^1.29.0` must install offline (transports +
`validation/ajv` subpaths importable under `"use node"`). **No live MCP server** — acceptance
uses an injected `Pick<Client>` stub via `connectMcpServerWithClient` (mirrors
`MockLanguageModelV2`).

**Acceptance highlights:** `mcp__<server>__<tool>` JSON-Schema tools, persisted plan rows
carry server identity + transport with **no closure**; per-step re-resolution + **replay
de-dup** (`callTool` fires at most once); drift → `[cove] no-longer-offered` (frozen wins);
`timeoutMs` clamped to the ~30s budget; `"use node"` quarantine intact (barrel stays V8-safe).

**Top risks:** `setup` becoming network-capable without re-conflating the box/network
boundary; freezing the descriptor (not the closure) so the journal stays replay-deterministic;
the per-process pool must **not** be assumed durable across actions.

## G2.3 — Channels outbound reply + ship-first adapter set

📄 **Detailed plan:** [phase-g2.3-channels-outbound.md](phase-g2.3-channels-outbound.md)

**Completes P11.** Today only **Slack inbound** exists (and it skips `runAuthorize`).

**Deliverables (highlights):**
- `convex/channels/inbound.ts` — shared `verifyThenAdmit(adapter, req)`: read raw body once
  → `runAuthorize` + `adapter.verify` → handshake → dedup → `mapPayload` → `submitPrompt` →
  persist reply-context.
- `convex/channels/dedup.ts` — promote `markWebhookSeen` to the shared `(provider, eventId)`
  helper over the `meta` `by_key` index.
- `convex/channels/reply.ts` — **outbound** dispatch *after* the run terminalizes
  (`scheduler.runAfter`/completion hook, **never** inside the ~3s ack window).
- **Reply-context** field on `agentRequests` (provider + channel id + thread ts +
  `response_url` + target) so a finished run can address its reply.
- Refactor the inline Slack route into a `ChannelAdapter{name,verify,mapPayload,postReply}`;
  port the 7 remaining ship-first channels (Discord Ed25519, GitHub HMAC, Teams JWT,
  Telegram secret-token, Google Chat JWT, Linear, Notion) against that one contract — **zero
  engine work**.

**External prereqs:** none for offline CI (mocked provider HTTP clients + `convex-test`).
Live-only: Slack bot token / captured `response_url`, `GITHUB_WEBHOOK_SECRET`,
`DISCORD_PUBLIC_KEY`, `TELEGRAM_SECRET_TOKEN`, Teams/Google-Chat JWT audiences+issuers.
No new npm deps strictly required (Web Crypto covers HMAC/Ed25519).

**Acceptance highlights:** Slack end-to-end on mocks (valid → run + reply to captured ref;
forged → 401 **no admission**; replay → exactly one run); reply is **async** (acks
immediately, posts only after terminal, exactly once); the shared contract holds for ≥2 more
channels via adapter-only diffs; **`authorize` gates inbound**; no new inbound table (D14).

**Top risks:** the 3s ack window vs run latency (reply must be async); the reply-trigger
mechanism (`runAfter` vs finalize callback) and its **replay-idempotency** (must not
double-post); JWT/JWKS verify for Teams/Google-Chat needs a `"use node"` action; bot-echo
self-reply loops need per-channel guards.

## G2.4 — CLI + codegen (`cove` binary)

📄 **Detailed plan:** [phase-g2.4-cli-codegen.md](phase-g2.4-cli-codegen.md)

**Completes P8.5.** The registry *constructs* (`defineAgentRegistry`/`defineWorkflow`) and
their seams exist but are **orphaned** — nothing installs them, and `POST /workflows/:name`
is a hard-404 stub.

**Deliverables (highlights):**
- `bin/cove.{ts,mjs}` + a `"bin"` field; `src/cli/` tree (`commands/{dev,build,deploy}`,
  `codegen/*`, `validation/validate-registry.ts`, `lib/*`).
- `registry-loader.ts` — tsx child-import of the app-bound registries.
- `validate-registry.ts` — name regex, `__coveCreatedAgent` brand, **declared-subagent-exists**,
  provider-resolvable, `Durability`/`Compaction` shape, workflow name/uniqueness/handler — all
  as single-line `[cove]` diagnostics, **fail-closed before any deploy**.
- Codegen that **installs the orphaned seams** (`registerAgentRegistry`/`registerWorkflowRegistry`)
  and binds `POST /workflows/:name` to declared handlers (replacing the 404 stub + the
  model-only resolution in `setup`), producing a `kind:'workflow'` run. Idempotent
  content-compare emission; user-authored `http.ts`/`app.ts` preserved.

**External prereqs:** none hard for build/validation/codegen checks (`tsx 4.21` + `convex 1.39`
present). Live `dev`/`deploy` acceptance needs a Convex deployment + provider/auth env.

**Acceptance highlights:** `cove build` on `examples/cli-smoke` → load→validate→codegen→`tsc`
exits 0, `getRegisteredAgent` resolves, `POST /workflows/<name>` reaches the handler as a
distinct `kind:'workflow'` run; each invalid fixture → exit non-zero with exactly one
`[cove]` line and **no** `convex deploy` spawn; the runtime barrel stays free of registry
re-exports (V8-safe); idempotent rebuild rewrites zero files; no brand leakage in generated
artifacts.

**Top risks:** loading app-bound registries can drag in Convex globals (isolate via tsx child
import); barrel-purity regressions; scope-creep into P8's `runs.kind` path; non-deterministic
codegen churning the `convex dev` watcher; the `m3` sensitive-file exclusion is a **security
boundary**.

## G2.5 — Compaction auto-trigger + facades + sample agent + OTel observer

📄 **Detailed plan:** [phase-g2.5-glue-sample-otel.md](phase-g2.5-glue-sample-otel.md)

**Completes P12 glue + the post-P12 observability strand.**

**Deliverables (highlights):**
- **Auto-trigger:** derive + freeze compaction settings at `setup` (honor profile
  `compaction:false`); replace the hard-coded `shouldCompact:false` in `decode.ts` with the
  real threshold from per-step usage; add a **journaled `compact` step** to
  `RunLoopDeps`/`runAgentLoop`/`runHandler` (replay-safe via `step.runAction`).
- **Facades:** implement `session.compact()` and `session.skill()` in `src/runtime/context.ts`
  (replace the `not_implemented`/`deferredCall` throws) through new transport seams onto
  `invoke` + catalog `getSkill` (catalog-only, **no box** — [08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy)).
- **Sample agent** under `examples/` registered via `defineAgentRegistry`, demonstrating
  **G1–G5** (prompt + reactive streaming + a HITL-gated tool + a skill).
- **OTel observer** (read-side over the `events` table) folding `CoveEvent` rows into
  run/turn/tool/compaction spans; promote `@opentelemetry/api` to a direct dep.

**External prereqs:** none for the wiring + observer (`@opentelemetry/api` already vendored
transitively; no live collector needed). Live G1–G5 demo: a deployable Convex deployment +
a real provider key (or `cove-test/mock`) + an `@upstash/box` token if the sample exercises a
real sandbox.

**Acceptance highlights:** a session past `contextWindow − reserveTokens` invokes `compact`
**exactly once**, appends a `kind:'compaction'` entry, next decode context = `[summary +
tail]`, and a mid-loop replay re-runs the journaled compact **without a second summarization
call**; `compaction:false` never triggers; `session.skill('review-pr')` resolves from the
catalog (no box), unknown → typed `[cove]` error; the sample demonstrates G1–G5; the OTel
observer produces nested spans with correct error status + content redaction.

**Top risks:** in-loop threshold must reuse persisted per-step usage (or it fires
inconsistently vs the manual action); the compact step mutates entries mid-run — the frozen
plan + cut-point must keep the next `llmStep` context byte-faithful and replay must re-yield
the journaled summary; `session.skill()` must stay catalog-only.

## G2.6 — `convex-test` store-contract harnesses + E2E crash-recovery + throughput gate

📄 **Detailed plan:** [phase-g2.6-convex-test-suite.md](phase-g2.6-convex-test-suite.md)

**Completes the P12 test strand** (acceptance bars 3/4/6). The verification capstone — moves
Convex-function verification from `convex run` live to a hermetic, reproducible suite.

**Deliverables (highlights):**
- Add `convex-test` devDep + a vitest config running the existing unit suite **and** the new
  `tests/` tree.
- Three store-contract harnesses — `session-store`, `run-store`, `event-stream-store` (port
  flue's **SessionStore half**; **omit** `AgentSubmissionStore` per **M6** with an explicit
  comment).
- `tests/e2e/multi-turn-recovery.test.ts` — kill-mid-loop → journal replay → coherent terminal
  state (no duplicate tool exec; at-most-once model call per finalized step).
- `tests/e2e/compaction.test.ts` — threshold auto-compact + overflow→retry-**same-step**, no
  double-charge on replay. (The overflow→retry mode — `isContextOverflow` in `retry.ts` +
  same-`stepNumber` retry in `llmStep` — lands **once in G2.5**; G2.6 only tests it.)
- `tests/perf/throughput.test.ts` — full-stack delta-batcher stress at production cadence.

**External prereqs:** **`convex-test` must be installable offline** — the documented **hard
blocker** (not in `node_modules`; registry access unavailable in the current sandbox). The
`convex-test` in-memory runtime must execute `"use node"` actions (or the E2E injects
`testModel.ts` at the `resolveModel` seam). No live provider, no live box.

**Acceptance highlights:** `npm test` green incl. the new tree (existing 200 still pass);
**exactly three** harnesses (grep for `AgentSubmissionStore` returns only an M6 comment),
passing against the live Convex adapters; crash-recovery asserts each tool result written
exactly once + at-most-once model call per finalized step; compaction E2E asserts a
`CompactionEntry` + `generateText` call-count 1 across a forced replay; throughput coalesces
≥200 deltas into far fewer in-position patches.

**Top risks:** `convex-test` offline-installability is the single largest external risk for
group 2; the in-memory runtime must run `"use node"` actions; the crash test must interrupt at
the correct `step.run*` seam to actually exercise replay; porting flue's ~1006-line store
contract to Convex mutation/query shape is fiddly.

---

## External prerequisites (consolidated)

Offline npm installs are the recurring gate, and the current sandbox lacks registry access —
**confirm these resolve in the build env** before the dependent phases can fully land:

| Prereq | Needed by | Kind |
| --- | --- | --- |
| `react`, `@types/react`, `@testing-library/react`, `happy-dom` (+ `react>=18` peer) | G2.1 | devDep install |
| `@modelcontextprotocol/sdk ^1.29.0` (transports + `validation/ajv` under `"use node"`) | G2.2 | dep install |
| **`convex-test`** | G2.6 (+ integration assertions in G2.2/G2.3/G2.5) | devDep install — **hard blocker** |
| Promote `@opentelemetry/api` to a direct dep | G2.5 | already vendored transitively |
| Slack bot token / `response_url`; `GITHUB_WEBHOOK_SECRET`; `DISCORD_PUBLIC_KEY`; `TELEGRAM_SECRET_TOKEN`; Teams/Google-Chat JWT audiences+issuers | G2.3 (live e2e only) | secrets |
| Deployable Convex deployment + provider key (or `cove-test/mock`) + `@upstash/box` token | G2.5 (live G1–G5 demo only) | env |

Offline CI can use mocks/`testModel` throughout — **no browser** and **no bot tokens** are
needed for the offline build/test path.

## Open questions (surface before committing)

1. **`convex-test` offline-installability** — if it can't be installed here, G2.6 (all three
   harnesses + both E2Es + throughput) can't fully land and verification stays `convex run`-only.
2. **Does `convex-test` run `"use node"` actions?** If not, the E2E/MCP/channel integration
   tests must inject `testModel.ts` at the `resolveModel` seam and stub the node-action path.
3. **`setup.ts` → `"use node"` vs a separate discovery helper** (G2.2) — affects the V8-isolate
   build and the box/network boundary.
4. **Channel reply-trigger mechanism** (G2.3) — `scheduler.runAfter` polling vs a finalize-stage
   callback; the choice has replay-idempotency implications.
5. **Workflow run-kind scope** (D18) — how far to build the `kind:'workflow'` creation path in
   G2.4 vs defer; the audit flags scope-creep risk into P8.
6. **Overflow→retry ownership** — land it once in G2.5 (auto-trigger) so G2.6 only tests it.
7. **Channel streaming "typing" reply** (soft-depends on G2.1) — in scope for G2.3, or
   final-result-only for this cut?
