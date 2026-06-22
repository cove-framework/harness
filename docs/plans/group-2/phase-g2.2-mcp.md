# G2.2 — MCP integration (`connectMcpServer`): network tools as frozen descriptors

> _Completes the **MCP half** of P10 (the skills catalog half already shipped). Today the seam is a stub: [`convex/engine/types.ts`](../../../convex/engine/types.ts) declares `FrozenToolKind "mcp"` + a placeholder `mcp?: { serverId; transport }` descriptor, and [`convex/engine/buildTools.ts`](../../../convex/engine/buildTools.ts) `case "mcp"` returns `errorTool(d, \`MCP tool "${d.name}" is not available yet (P10).\`)` — covered by the stub test at [`buildTools.test.ts:131`](../../../convex/engine/__tests__/buildTools.test.ts) (which asserts only `r.isError === true`). This phase ports flue's [`mcp.ts`](../../../../flue/packages/runtime/src/mcp.ts) into a `"use node"`-quarantined `convex/mcp/` module: a declarative `mcpServers` field on `AgentProfile` resolves at `setup` to **closure-free frozen descriptors carrying server identity + transport**, and `buildTools` re-resolves a network MCP client **per `llmStep`/`dispatchTools` beat** from those descriptors — the one sanctioned departure from box-binding ([08 §4.5](../../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors)). Connect failure, tool-list drift, and replay all degrade to deterministic error tool-results, never a step crash._

## Goal & scope

One capability lands here, layered on the durable loop, the frozen-descriptor rebuild,
and the catalog/partition patterns already built in P4/P10-skills:

**MCP integration.** A new `convex/mcp/` **`"use node"`** module ports flue's
`connectMcpServer` (and the injectable `connectMcpServerWithClient` seam). `AgentProfile`
gains a declarative **`mcpServers?: McpServerOptions[]`** threaded onto the request at
admission ([`convex/invoke/{submit,admit}.ts`](../../../convex/invoke/admit.ts)). At
`setup`, each declared server is connected once, its tools discovered via `listTools`, and
each tool **frozen as a descriptor** — `{ serverId, transport, url, headers, toolName,
name, description, parameters }`, **no closure** — appended to the plan's `tools` tagged
`kind: "mcp"`. `buildTools` replaces the stub: for each `kind:"mcp"` descriptor it
re-resolves a client via a per-process connection **pool** and binds `execute` against
`client.callTool` — the network bind, done **fresh every beat**. The model only ever sees
`mcp__<server>__<tool>` JSON-Schema tools.

**In scope:**
- `@modelcontextprotocol/sdk` dependency (imported **only** under `convex/mcp/`).
- Pure (V8-safe) MCP types in `src/runtime/mcp-types.ts` (no SDK runtime import) + barrel re-export.
- `mcpServers` on `AgentProfile` (and the runtime-config / op-option surfaces flue exposes);
  threaded `submit → admit → agentRequests → plan`.
- `convex/mcp/{connect,descriptors,pool}.ts` — port of flue `mcp.ts` (incl.
  `connectMcpServerWithClient`), `freezeMcpTool`/`mcpDescriptorToToolDefinition`, and the
  per-process connection cache (`getOrOpen`/`evict`/`close`).
- `setup` → `"use node"` (or a `"use node"` discovery helper) running MCP discovery + freeze +
  reserved-name collision check.
- `buildTools` `case "mcp"` → `pool.getOrOpen` + per-beat re-resolution; connect-fail / drift →
  error tool-result.
- `FrozenToolDescriptor.mcp` widened from the placeholder `{ serverId; transport }` to the real shape.
- `buildTools.test.ts:131` updated from the stub assertion to the real branch.

**Out of scope (deferred / dropped):**
- **Skills half of P10** — already built ([`convex/skills.ts`](../../../convex/skills.ts),
  `activate_skill` partition in [`convex/engine/dispatchTools.ts`](../../../convex/engine/dispatchTools.ts)).
  This phase only **mirrors** that partition pattern for MCP; it does not touch skills.
- **MCP image/audio/resource content** beyond flue's existing text formatting (`formatMcpResult`
  is ported verbatim — base64 blobs already collapse to `[Image: …, N base64 chars]` placeholders).
- **MCP task-based execution** (`tool.execution.taskSupport === 'required'`) — flue skips these
  with a warning; the port keeps that skip (no task-MCP support).
- **Durable cross-action connection reuse** — the pool `Map` is per-process only; a cold action
  re-opens. No connection persistence (D15 / [R5](../../design/07-risks-and-decisions.md)).
- **Live MCP server in CI** — acceptance uses an injected `Pick<Client>` stub via
  `connectMcpServerWithClient` (mirrors [`testModel.ts`](../../../convex/providers/testModel.ts)).
  `convex-test`-backed integration tests soft-depend on G2.6's offline install.

## Dependencies

- **P10 skills half (built, DONE)** — *hard.* This phase mirrors the **partition pattern** in
  [`convex/engine/dispatchTools.ts`](../../../convex/engine/dispatchTools.ts): `task`/`activate_skill`
  calls are filtered out of `otherCalls` and handled by dedicated routines; MCP tools instead ride
  the **`otherCalls` sandbox-less path** but with executables rebuilt from the pool (they are not a
  new partition — they are real `execute`-bearing tools, just network-bound not box-bound). The
  `setup` skills-catalog query + `## Available Skills` rendering and the `kind:"skill"`/`kind:"task"`
  descriptors are already live and untouched.
- **P4 (Durable engine, DONE)** — *hard.* The seams this phase extends:
  [`setup.run`](../../../convex/engine/setup.ts) (freezes the plan; today a plain `internalMutation`
  called via `step.runMutation` in [`runHandler.ts`](../../../convex/engine/runHandler.ts)),
  [`buildModelView`/`buildExecutableTools`](../../../convex/engine/buildTools.ts) (model-view strip
  + executable rebuild from frozen descriptors), and the idempotent
  [`appendToolResult`](../../../convex/engine/dispatch.ts) (replace-in-place by `toolCallId` — the
  replay-dedup mechanism MCP rides). The per-tool deadline `PER_TOOL_TIMEOUT_MS = 30_000` in
  [`dispatch.ts`](../../../convex/engine/dispatch.ts) is the budget MCP `timeoutMs` clamps to.
- **P6 (Harness facade + invoke, DONE)** — *hard.* `mcpServers` is threaded through
  [`invoke/submit.ts`](../../../convex/invoke/submit.ts) → [`invoke/admit.ts`](../../../convex/invoke/admit.ts)
  → `agentRequests` → `setup` plan freeze, exactly like `model`/`resultSchema`/`approvalTools`.
- **P1 (pure core, DONE)** — `AgentProfile` ([`src/runtime/types.ts`](../../../src/runtime/types.ts))
  and the runtime barrel ([`src/runtime/index.ts`](../../../src/runtime/index.ts)) gain the MCP types;
  `FrozenToolDescriptor` ([`convex/engine/types.ts`](../../../convex/engine/types.ts)) widens.
- **G2.1 (Reactive events) — *soft.*** MCP `tool_start`/`tool` events flow through the same emitter
  G2.1 wires; this phase does not block on it (the tool result path is P4's). See the build order in
  [`README.md`](README.md): G2.2 is sequenced after G2.1 but its acceptance does not require the event stream.
- **External install:** `@modelcontextprotocol/sdk` (`^1.29.0`, matching flue) must resolve offline,
  including the `client/streamableHttp.js`, `client/sse.js`, `shared/transport.js`, `types.js`,
  `validation`, and `validation/ajv` subpaths flue imports — **all importable under `"use node"`**
  (the offline-install gate flagged in [`README.md` external-prereqs](README.md#external-prerequisites-consolidated)).

## Deliverables

| Path | Purpose |
| --- | --- |
| `package.json` (extend) | Add `@modelcontextprotocol/sdk` (`^1.29.0`, matching flue) to dependencies. Imported **only** by `convex/mcp/` (`"use node"`); never by `src/runtime/**` or any query/mutation. |
| `src/runtime/mcp-types.ts` | **Pure (V8-safe)** type-only port of flue `mcp.ts`'s types: `McpTransport`, `McpServerOptions`, `McpServerConnection`, plus the new **`McpToolDescriptor`** (the frozen-descriptor shape). **No `@modelcontextprotocol/sdk` import** (the SDK stays in `convex/mcp/`). `[08 §2]` reference header citing flue origin. |
| `src/runtime/index.ts` (extend) | Re-export the public MCP types (`McpTransport`, `McpServerOptions`, `McpServerConnection`, `McpToolDescriptor`) from the barrel — types only, V8-safe. |
| `src/runtime/types.ts` (extend) | Add `mcpServers?: McpServerOptions[]` to `AgentProfile` (and `AgentRuntimeConfig` / `OperationOptions` where flue surfaces them); import the type from `./mcp-types.ts`. |
| `convex/mcp/connect.ts` | **`"use node"`.** Near-verbatim port of flue `connectMcpServer` + `connectMcpServerWithClient` + `createTransport` + `createMcpTools` + `validateMcpResult` + `createToolName`/`sanitizeToolNamePart` + `createToolDescription` + `normalizeInputSchema` + `formatMcpResult`. Rebrand SDK client name `'flue'`→`'cove'` and `[flue]`→`[cove]`. The injectable `connectMcpServerWithClient(name, client, transport, requestOptions)` seam is preserved for the `Pick<Client>` test stub. |
| `convex/mcp/descriptors.ts` | **Pure (V8-safe)** freeze logic: `freezeMcpTool(serverId, options, tool)` → `McpToolDescriptor` (server identity + transport + JSON-Schema params, **no closure**); `mcpDescriptorToToolDefinition(descriptor, client)` → an `EngineTool` whose `execute` calls `client.callTool` (the network bind, with `validateMcpResult`/`formatMcpResult`). No SDK *runtime* import — `client` is injected (typed against the `McpClient` `Pick`). |
| `convex/mcp/pool.ts` | **`"use node"`.** A module-scope `Map` keyed by **server identity** (a stable hash of `transport`+`url`+`headers`): `getOrOpen(descriptor)` returns a cached client, lazily opening (`connectMcpServerWithClient` against a fresh transport) on a cold action; `evict(serverId)` calls `close()`; `closeAll()` for action teardown. Clamps `timeoutMs` to the per-tool budget. **Per-process only** — never assumed durable across actions. |
| `convex/mcp/discover.ts` | **`"use node"`** discovery helper (the chosen alternative to converting `setup` itself to `"use node"`): `discoverMcpDescriptors(mcpServers)` → `McpToolDescriptor[]`. For each declared server: `connectMcpServer` (one-shot), enumerate tools, `freezeMcpTool` each, `close()` the discovery connection. A per-server connect failure → a **diagnostic descriptor** carrying the error (so `buildTools` surfaces it as an error tool-result, never crashing `setup`). |
| `convex/engine/setup.ts` (extend) | Run MCP discovery + freeze + the reserved-name collision check, then append `kind:"mcp"` descriptors to the plan. Because `setup.run` is a `internalMutation` (no network), discovery is delegated to `convex/mcp/discover.ts` via a `step.runAction` hop in [`runHandler.ts`](../../../convex/engine/runHandler.ts) **before** the (mutation) freeze, OR `setup.run` is promoted to `"use node"` and `runHandler` switches `step.runMutation`→`step.runAction`. Decision in **Risks**; the plan defaults to the **discovery-action hop** (keeps the freeze a deterministic mutation). |
| `convex/engine/runHandler.ts` (extend) | Insert the `step.runAction(internal.mcp.discover.run, { requestId })` hop (when `plan.mcpServers` is non-empty) between admission and `step.runMutation(internal.engine.setup.run, …)`, persisting the discovered descriptors so the freeze mutation reads them. Journaled checkpoint → replay-safe (discovery re-runs only on a cold replay before the freeze finalizes). |
| `convex/engine/buildTools.ts` (extend) | Replace the `case "mcp"` stub with: re-resolve a client via `pool.getOrOpen(d.mcp)` and bind `execute` via `mcpDescriptorToToolDefinition(d.mcp, client)`. A connect/resolve failure → `errorTool(d, …)` (the existing degrade path). **`buildModelView` already strips `execute`** — the model still sees only JSON-Schema. Note: `buildExecutableTools` is pure today; the MCP branch needs the pool, so the MCP rebind is injected via a new optional `BuildToolsSources.mcpResolve?` (kept out of the pure core; only `dispatchTools` supplies it). |
| `convex/engine/types.ts` (extend) | Widen `FrozenToolDescriptor.mcp` from the placeholder `{ serverId: string; transport: unknown }` to the real `McpToolDescriptor` shape (imported from `src/runtime/mcp-types.ts`). |
| `convex/engine/__tests__/buildTools.test.ts` (extend) | Replace the `:131` stub test (`"an mcp descriptor degrades to an error tool-result (P10)"`, which asserts only `r.isError === true` against the placeholder branch) with the real branch: a `kind:"mcp"` descriptor + an injected `mcpResolve` stub → a successful tool-result; an injected resolve-failure → an error tool-result. |

> Future files (not yet built) are written as inline code (`convex/mcp/connect.ts`),
> not links, per the link convention.

## Source map (flue/pi → cove)

| flue/pi source (verified) | cove target | port / transform notes |
| --- | --- | --- |
| [`packages/runtime/src/mcp.ts`](../../../../flue/packages/runtime/src/mcp.ts) — `connectMcpServer` (62–83), `connectMcpServerWithClient` (85–116), `createTransport` (118–135), `createMcpTools` (137–190), `validateMcpResult` (192–212), `createToolName`/`sanitizeToolNamePart` (229–236), `createToolDescription` (238–245), `normalizeInputSchema` (247–254), `formatMcpResult` (256–294) | `convex/mcp/connect.ts` | **Near-verbatim** port into a **`"use node"`** module (the `@modelcontextprotocol/sdk` import forbids the pure barrel). Rename `new Client({ name: 'flue', … })` (line 75) → `'cove'`; every `[flue]` error prefix (lines 99, 149, 161) → `[cove]`. `runtimeVersion` from `../package.json` (line 12) → cove's `package.json` version. The pagination loop with the repeated-cursor guard (96–105), the `taskSupport === 'required'` skip (146–152), the duplicate-name reject (159–164), and `AjvJsonSchemaValidator` output validation (144, 181) are kept. The `execute` closure-over-`client` (170–187) is what makes it network — that closure is **rebuilt per beat in cove**, never frozen. |
| `packages/runtime/src/mcp.ts` types — `McpTransport` (16), `McpServerOptions` (18–34), `McpServerConnection` (42–50), the `McpClient = Pick<Client, …>` alias (52) | `src/runtime/mcp-types.ts` | **Pure type-only port** (no SDK runtime import) so `AgentProfile.mcpServers` and the frozen descriptor stay V8-safe on the `@cove/runtime` barrel. `McpClient` ports as a **structural** `Pick`-shaped interface (`callTool`/`close`/`connect`/`listTools`) so the test stub and `connect.ts` share one type **without** importing `Client` into the pure module. `ToolDefinition`/`ToolParameters` (line 13) re-resolve from cove's [`tool-types.ts`](../../../src/runtime/tool-types.ts). |
| `packages/runtime/src/mcp.ts` — the `execute` body inside `createMcpTools` (170–187) | `convex/mcp/descriptors.ts` `mcpDescriptorToToolDefinition` | **Split out** the closure so it can be **rebuilt per beat** from a frozen descriptor + a re-resolved `client`, instead of captured once at connect. `validateMcpResult`/`formatMcpResult`/`signal?.aborted` (171) carry over unchanged; the closed-over `tool.name`/`outputValidator`/`requestOptions` become descriptor fields (`toolName`, `outputSchema`, clamped `timeoutMs`). |
| `packages/runtime/src/mcp.ts` — `createMcpTools` adapter shape (154–189) | `convex/mcp/descriptors.ts` `freezeMcpTool` | **New inverse:** instead of producing a live `ToolDefinition` (with closure), produce a **plain-JSON `McpToolDescriptor`** (`{ serverId, transport, url, headers, toolName, name, description, parameters, outputSchema?, timeoutMs? }`). Journal-safe — no functions. `createToolName`/`createToolDescription`/`normalizeInputSchema` are reused (imported from `connect.ts`'s exported helpers, or duplicated pure into `descriptors.ts`). |
| `packages/runtime/src/mcp.ts` — `McpServerConnection.close()` ownership (49, 110, 113) | `convex/mcp/pool.ts` | **New:** flue returned a connection the caller `close()`d once; cove caches it in a per-process `Map` keyed by server identity, with `getOrOpen`/`evict`/`closeAll`. The `close()`-on-error contract (112–115) is preserved; the cache is best-effort (cold action re-opens, [R5](../../design/07-risks-and-decisions.md)). |
| [`convex/providers/testModel.ts`](../../../convex/providers/testModel.ts) (`makeMockLanguageModel`, the `LanguageModelV2` `Pick`-style injection) | `convex/mcp/__tests__` mock | **Pattern mirror, not a port.** The acceptance `McpClient` stub mirrors `makeMockLanguageModel`: a hand-rolled `Pick<Client, 'callTool'|'close'|'connect'|'listTools'>` with byte-stable canned `listTools`/`callTool` so replay-equality is exact and `callTool` invocations are countable. Injected via `connectMcpServerWithClient` (the flue seam at 85). |

## Hardened-contract obligations

- **[08 §3](../../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy) — the network carve-out is not the box.**
  MCP tools reach an **external server over the network**, never the sandbox. `convex/mcp/`
  opens transports under `"use node"`; the descriptor freeze (`descriptors.ts`) and the
  type port (`mcp-types.ts`) stay box-free **and** SDK-free. MCP discovery (`listTools`) is a
  **network** call, so it cannot happen in a plain mutation — hence the `"use node"` discovery
  action. Don't conflate "resolve-only (no box)" with "no network": MCP discovery is the
  intended network exception, and it still provisions **no box**.
- **[08 §4.5](../../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors) — tool rebuild from frozen descriptors (the MCP named exception).**
  The frozen `McpToolDescriptor` carries **server identity + transport** (url/transport/headers
  + tool name + JSON-Schema params), **not a closure**. `buildTools` re-resolves an MCP client
  from that descriptor on **each** `llmStep`/`dispatchTools` beat and binds `execute` against
  the client. A rebuild failure (connect failure during the rebind) becomes an **error
  tool-result, never a step crash** — it rides the existing `errorTool` degrade in
  [`buildTools.ts`](../../../convex/engine/buildTools.ts).
- **[08 §4.5](../../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors) — replay de-dup.**
  `callTool` is side-effecting, so a replayed `dispatchTools` **returns the persisted result**:
  the `resultedIds` filter in [`dispatchTools.run`](../../../convex/engine/dispatchTools.ts)
  skips already-resulted `toolCallId`s, and `appendToolResult` is idempotent (replace-in-place).
  MCP **must ride this**; do **not** add a "re-run on replay" path. `callTool` fires **at most
  once** per `toolCallId` across replays.
- **[08 §4.2](../../design/08-conventions-and-execution-boundary.md#42-action-budgets--timeouts) — per-tool timeout.**
  An MCP `callTool` runs under the `dispatchTools` per-tool deadline `PER_TOOL_TIMEOUT_MS = 30_000`
  ([`dispatch.ts`](../../../convex/engine/dispatch.ts)). The ported `McpServerOptions.timeoutMs`
  (default 60 s SDK) is **clamped** in `pool.ts`/`descriptors.ts` to `≤ PER_TOOL_TIMEOUT_MS` so the
  SDK request timeout cannot outlive the action budget — a hung MCP call yields an error
  tool-result, not a starved action.
- **[08 §4.3](../../design/08-conventions-and-execution-boundary.md#43-cancel-short-circuit) — cancel short-circuit.**
  The ported MCP `execute` honors the per-tool `signal` (flue's `if (signal?.aborted) throw` at
  mcp.ts:171 is kept). `dispatchOne` in [`dispatch.ts`](../../../convex/engine/dispatch.ts)
  re-checks `isCancelled()` before and after each tool, so a cancelled run skips remaining MCP
  calls and discards late results.
- **[08 §2](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention) — reference header.**
  Every new file opens with its header: `convex/mcp/connect.ts` cites
  `packages/runtime/src/mcp.ts` + the `@modelcontextprotocol/sdk` package; `src/runtime/mcp-types.ts`
  cites the flue types; `descriptors.ts`/`pool.ts`/`discover.ts` are `// New (Convex backend)` with the
  flue pattern source.
- **[08 §1](../../design/08-conventions-and-execution-boundary.md#1-naming--namespace) — naming.**
  `connectMcpServer` is a **kept generic verb** but is **Convex-app-bound** (lives under
  `convex/mcp/`, not the `@cove/runtime` barrel). The SDK client name and `[flue]` prefixes
  rebrand to `cove`/`[cove]`. The pure barrel re-exports **types only**.

## Implementation tasks

Ordered; each is a buildable checkpoint. `tsc --noEmit` must stay green at every step.

1. **Add the MCP SDK dependency.** Add `@modelcontextprotocol/sdk` (`^1.29.0`, matching flue) to
   `package.json` dependencies; `npm install`; confirm it resolves offline and the
   `client/streamableHttp.js`, `client/sse.js`, `shared/transport.js`, `types.js`, `validation`,
   `validation/ajv` subpaths import under `"use node"`; `tsc --noEmit` stays green.
2. **Port pure MCP types** into `src/runtime/mcp-types.ts`: `McpTransport`, `McpServerOptions`,
   `McpServerConnection`, the structural `McpClient` interface (no `Client` import), and the new
   `McpToolDescriptor` (`{ serverId, transport, url, headers?, toolName, name, description,
   parameters, outputSchema?, timeoutMs? }`). **No SDK runtime import** — types only. `[08 §2]` header.
3. **Re-export from the barrel.** Add the four public MCP types to
   [`src/runtime/index.ts`](../../../src/runtime/index.ts) (types only — V8-safe). Update the barrel's
   "Later phases add: … mcp" comment to reflect mcp-types landed.
4. **Extend the profile.** Add `mcpServers?: McpServerOptions[]` to `AgentProfile` (and
   `AgentRuntimeConfig` / the op-option surfaces flue exposes) in
   [`src/runtime/types.ts`](../../../src/runtime/types.ts), importing `McpServerOptions` from
   `./mcp-types.ts`. Keep optional — most agents declare none.
5. **Widen the frozen descriptor.** In [`convex/engine/types.ts`](../../../convex/engine/types.ts)
   replace `mcp?: { serverId: string; transport: unknown }` with `mcp?: McpToolDescriptor` (imported
   from `src/runtime/mcp-types.ts`). Keep the `kind === "mcp"` doc comment.
6. **Thread `mcpServers` through admission.** Add `mcpServers: v.optional(v.array(v.any()))` to
   [`invoke/submit.ts`](../../../convex/invoke/submit.ts)'s args and `admitPrompt`'s
   `AdmitPromptArgs`/insert in [`invoke/admit.ts`](../../../convex/invoke/admit.ts) (mirroring
   `model`/`resultSchema`/`approvalTools`); persist onto `agentRequests` (add the column to
   [`schema.ts`](../../../convex/schema.ts) `agentRequests`). Frozen onto the plan at `setup`.
7. **Port `connectMcpServer`** into `convex/mcp/connect.ts` (`"use node"`): copy the transport
   creation (streamable-http default, sse dynamic-import fallback), the pagination loop + repeated-cursor
   guard, `createMcpTools`, `validateMcpResult`, `createToolName`/`sanitizeToolNamePart`,
   `createToolDescription`, `normalizeInputSchema`, `formatMcpResult`, and the
   `connectMcpServerWithClient` seam. Rebrand `'flue'`→`'cove'`, `[flue]`→`[cove]`. Export the pure
   helpers (`createToolName`, `createToolDescription`, `normalizeInputSchema`, `validateMcpResult`,
   `formatMcpResult`) for reuse by `descriptors.ts`.
8. **Descriptor freeze/inverse** in `convex/mcp/descriptors.ts` (**pure, no SDK runtime import**):
   `freezeMcpTool(serverId, options, tool)` → `McpToolDescriptor` (server identity + transport + JSON
   schema, **no closure**, plain JSON); `mcpDescriptorToToolDefinition(descriptor, client)` → an
   `EngineTool` whose `execute(args, signal)` runs `if (signal?.aborted) throw`, `client.callTool(...)`,
   `validateMcpResult`, `formatMcpResult`, and maps `isError`→an error tool-result. Clamp
   `descriptor.timeoutMs` to `PER_TOOL_TIMEOUT_MS`.
9. **Connection pool** `convex/mcp/pool.ts` (`"use node"`): a module-scope
   `Map<serverIdentity, McpServerConnection>`; `getOrOpen(descriptor)` hashes `transport`+`url`+`headers`
   to the key, returns the cached client or lazily opens one (`createTransport` + `connectMcpServerWithClient`),
   caching it; `evict(serverId)` calls `close()` + deletes; `closeAll()` for teardown. The `Map` does
   **not** survive across actions — re-open on a cold action. Clamp `timeoutMs` to the per-tool budget.
10. **Discovery helper** `convex/mcp/discover.ts` (`"use node"`, an `internalAction`):
    `discoverMcpDescriptors(mcpServers)` — for each declared server, `connectMcpServer` (one-shot),
    enumerate `connection.tools`, `freezeMcpTool` each, `close()` the discovery connection. A per-server
    connect failure → a **diagnostic `McpToolDescriptor`** (`name: mcp__<server>__error`, a
    `parameters: {type:"object"}`, and an embedded error message) so `buildTools` surfaces it as an error
    tool-result. Persist the discovered descriptors onto the request (a column or a scratch field) for the
    freeze mutation to read.
11. **runHandler discovery hop.** In [`runHandler.ts`](../../../convex/engine/runHandler.ts), before
    `step.runMutation(internal.engine.setup.run, …)`, when the request carries `mcpServers`, insert
    `step.runAction(internal.mcp.discover.run, { requestId })` (a journaled checkpoint). The discovery
    action writes the descriptors; the freeze mutation reads them. Replay re-runs discovery only on a cold
    replay **before** the freeze finalizes (the freeze is the durable boundary).
12. **`setup` MCP freeze.** In [`setup.ts`](../../../convex/engine/setup.ts) (stays a mutation): read
    the persisted discovered descriptors, run the **reserved-name collision check** (no MCP
    `mcp__server__tool` name collides with a framework built-in: `activate_skill`, `task`, `finish`,
    `give_up`, or any `createFrameworkTools` name; a collision → a deterministic `throw` with a `[cove]`
    message), then append each as `{ name, description, parameters, kind: "mcp", mcp: descriptor }` to
    the plan's `tools`. Freeze with the rest of the plan.
13. **`buildTools` MCP branch.** In [`buildTools.ts`](../../../convex/engine/buildTools.ts) replace
    `case "mcp": return errorTool(…)` with: `const resolve = sources.mcpResolve; if (!resolve) return
    errorTool(d, "MCP tool unavailable (no resolver)"); return resolve(d)` — where `mcpResolve` (a new
    optional `BuildToolsSources` field) is supplied **only** by `dispatchTools` (the `"use node"`
    action), keeping `buildExecutableTools` pure for `llmStep`/model-view. The resolver does
    `pool.getOrOpen(d.mcp)` + `mcpDescriptorToToolDefinition(d.mcp, client)`; a connect/resolve throw →
    `errorTool(d, message)`.
14. **Wire `dispatchTools`.** In [`dispatchTools.run`](../../../convex/engine/dispatchTools.ts), supply
    `mcpResolve` to the existing `buildExecutableTools(plan.tools, { env, userTools, resultBundle,
    mcpResolve })` call on the `otherCalls` path (MCP tools are real `execute`-bearing tools, so they ride
    `otherCalls` + `runDispatch`, **not** a new partition like `task`/`activate_skill`). The
    `resultedIds`/replay-dedup and per-tool timeout already apply unchanged.
15. **Drift handling.** When a re-resolved connection's live tool list **differs** from the frozen
    descriptor (the cached client no longer offers `descriptor.toolName`), the **frozen descriptor wins**:
    the rebuilt `execute` returns an error tool-result
    `[cove] MCP tool "<name>" no longer offered by server "<serverId>"` rather than discovering new tools.
    Implement as a check in `mcpDescriptorToToolDefinition` / the resolver (compare against the client's
    `listTools` only when cheap; otherwise let `callTool` fail and map the SDK "unknown tool" error to the
    drift message).
16. **Reserved-name + duplicate collision tests.** The flue `createToolName` duplicate-reject (mcp.ts:159)
    is kept (intra-server collision); the **inter-server / framework** collision check lands in `setup`
    (task 12). Both fail loud with a `[cove]` message at `setup` — never a silent shadow.
17. **Reference headers + barrel.** Every new file opens with its
    [08 §2](../../design/08-conventions-and-execution-boundary.md#2-reference-header-convention) header;
    confirm the runtime barrel re-exports MCP **types only**; `connectMcpServer`/`pool`/`discover` stay
    under `convex/mcp/`, never the pure barrel ([08 §1](../../design/08-conventions-and-execution-boundary.md#1-naming--namespace)).
18. **Update `buildTools.test.ts:131`.** Replace the stub assertion with: (a) a `kind:"mcp"` descriptor +
    an injected `mcpResolve` returning a working `EngineTool` → asserts a non-error tool-result and that
    the injected `callTool` fired; (b) an injected `mcpResolve` that throws → asserts an error tool-result.
19. **Tests** (see Acceptance). `tsc --noEmit` green; targeted unit/integration tests pass; the `"use node"`
    quarantine grep is clean.

## Acceptance

Maps to [06 P10's MCP acceptance bar](../../design/06-phase-roadmap.md#-phase-10--skills--mcp); each bar is a
test or a grep/observable check.

- **Installs + `tsc --noEmit` exits 0.** `@modelcontextprotocol/sdk@^1.29.0` resolves offline and all six
  flue-imported subpaths import under `"use node"`; the full tree type-checks with the widened
  `FrozenToolDescriptor.mcp` and the new modules.
- **MCP tools are model-callable JSON-Schema tools; plan rows carry identity + transport, no closure.**
  A server declared via `mcpServers` (driven through a stubbed `connectMcpServerWithClient`) surfaces its
  tools as `mcp__<server>__<tool>` JSON-Schema tools in `buildModelView(plan.tools)`; the persisted
  `agentRequests`/`plan.tools` row for an MCP tool is **plain JSON** (`serverId` + `transport` + `url` +
  `toolName` + JSON-Schema `parameters`) with **no function fields** (assert `JSON.stringify(plan.tools)`
  round-trips; assert no `execute` key).
- **Per-step re-resolution + replay de-dup (`callTool` ≤ 1).** Drive two `dispatchTools` beats with an
  injected `Pick<Client>` stub: `buildTools` re-resolves a client each beat (warm reuse / cold re-open);
  then **re-run** `dispatchTools.run` for the same `(requestId, stepNumber)` and assert the persisted
  result is returned and the stub's `callTool` was invoked **at most once** per `toolCallId` (the
  `resultedIds` filter + `appendToolResult` idempotency). This is the §4.5 de-dup bar.
- **Connect failure → error tool-result, not a crash.** An injected resolver/`connect` that throws yields
  an error tool-result (`isError: true`, `[cove]` text) from `dispatchTools`, and the step/action does
  **not** throw out. (Mirrors the `task` delegation degrade.)
- **Drift → `[cove] no-longer-offered` (frozen wins).** A cached client whose live tool list omits a
  frozen `descriptor.toolName` returns the
  `[cove] MCP tool "<name>" no longer offered by server "<serverId>"` error tool-result for that tool —
  it does **not** discover or call any new tool.
- **`timeoutMs` clamped to ~30 s.** A declared `McpServerOptions.timeoutMs` of `60_000` (or unset → SDK
  60 s default) is clamped to `≤ PER_TOOL_TIMEOUT_MS (30_000)` in the resolved `callTool` request options
  (assert the value passed to the stub's `callTool` ≤ 30 000).
- **Reserved-name collision → deterministic `[cove]` error at setup.** A declared server whose sanitized
  tool name collides with a framework built-in (or another server's frozen name) makes `setup` (the freeze
  mutation) fail with a single deterministic `[cove]` message — never a silent shadow, never a runtime
  surprise.
- **`"use node"` quarantine intact.** `grep -rn "@modelcontextprotocol/sdk" src/` returns **nothing**
  (the pure barrel + types stay SDK-free); every `convex/mcp/*.ts` that imports the SDK begins with
  `"use node"` (except `descriptors.ts`/`mcp-types.ts`, which import **no** SDK runtime — assert via grep);
  `src/runtime/mcp-types.ts` has no SDK import.
- **`buildTools.test.ts:131` updated.** The stub test (`"an mcp descriptor degrades to an error tool-result
  (P10)"`, today asserting only `r.isError === true` on the placeholder branch) is gone; the real
  branch (success via injected `mcpResolve` + failure-degrade) passes.

## Risks & gotchas

- **`setup` must become network-capable without re-conflating box/network or breaking the V8 build.**
  `setup.run` is a plain `internalMutation` (no network); MCP `listTools` is a network call. **Default
  mitigation:** a separate `"use node"` `convex/mcp/discover.ts` action runs discovery
  (`step.runAction`) **before** the freeze mutation in `runHandler` — the freeze stays a deterministic
  mutation reading persisted descriptors. **Alternative** (the [`README.md` open question 3](README.md#open-questions-surface-before-committing)):
  promote `setup.run` to `"use node"` and switch `step.runMutation`→`step.runAction` in `runHandler` —
  simpler but makes the whole freeze a node action (heavier cold start, and the freeze loses
  mutation-transaction atomicity). The plan defaults to the **discovery-action hop**; pick one explicitly
  and note it in the file headers.
- **Freeze the descriptor, not the closure.** An MCP tool's `execute` closes over a live `client` — it
  **cannot** cross the workflow journal. Freeze the **descriptor** (server identity + transport) only and
  re-resolve the client every beat. Persisting the `ToolDefinition` (with its closure) or the connection
  is the classic replay-determinism break. The schema `tools: v.array(v.any())` will silently accept a
  function-bearing object and then fail at journal-serialize time — assert plain-JSON in tests.
- **Replay must not re-issue side-effecting `callTool`.** Rely on the existing `resultedIds` filter in
  `dispatchTools.run` + idempotent `appendToolResult` — do **not** add an MCP-specific "re-run on replay"
  path. A replayed `dispatchTools` returns the persisted result; `callTool` fires at most once.
- **The pool `Map` is per-process, not durable across actions.** `convex/mcp/pool.ts`'s cache lives in one
  action's process; a cold action re-opens. Treat warm connections as best-effort, exactly like the box
  handle cache ([R5](../../design/07-risks-and-decisions.md)). Never assume a connection survives across
  `step.runAction` boundaries; the discovery connection is `close()`d immediately (discovery is one-shot).
- **SDK validation/ajv + transport subpaths must import cleanly under `"use node"` (bundling risk).**
  flue imports `validation`, `validation/ajv`, `client/streamableHttp.js`, `client/sse.js` (dynamic),
  `shared/transport.js`, and `types.js`. The `sse` transport is a **dynamic** `import()` in flue
  (mcp.ts:125) — keep it dynamic so a streamable-http-only build never bundles it. Verify the install +
  imports in task 1 before building the rest (this is the [`README.md` external-prereq](README.md#external-prerequisites-consolidated)
  gate; cf. [`testModel.ts`](../../../convex/providers/testModel.ts)'s note on avoiding the `msw`
  phantom-dep that `ai/test` drags in — the same bundling-hygiene class).
- **Tool-name sanitization collisions must fail loud at setup.** `createToolName` sanitizes
  (`[^A-Za-z0-9_-]`→`_`) and rejects intra-server duplicates (mcp.ts:159), but two **different** servers
  (or a server + a framework built-in) can still produce the same `mcp__server__tool`. The setup-time
  reserved-name + inter-server collision check must `throw` a deterministic `[cove]` message — a silent
  shadow would let an MCP tool hijack `task`/`finish`/`activate_skill`.
- **Timeout layering.** The MCP SDK default per-request timeout is 60 s, but the `dispatchTools` per-tool
  budget is `PER_TOOL_TIMEOUT_MS = 30_000` ([08 §4.2](../../design/08-conventions-and-execution-boundary.md#42-action-budgets--timeouts)).
  Clamp `McpServerOptions.timeoutMs` (in `pool.ts`/`descriptors.ts`) so the SDK timeout never outlives the
  action — otherwise a hung MCP call starves the action instead of degrading to an error tool-result.
- **Drift mid-run.** A long-lived server can drop a tool between `setup` discovery and a later beat. The
  frozen descriptor is authoritative: a now-missing tool degrades to the `no-longer-offered` error
  tool-result; the run never silently picks up a **new** tool the model never saw a schema for (the model
  surface is frozen at `setup`).
