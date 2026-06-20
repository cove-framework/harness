# Phase 10 — Skills catalog + MCP
> Catalog-backed skill resolution (host import → `skills` table → `session.skill()`/`activate_skill`, never a sandbox FS walk) plus declarative MCP servers whose network `execute` re-resolves per step from a frozen descriptor. Design-of-record: [06 — Roadmap](../design/06-phase-roadmap.md) + [04 — Durable Engine](../design/04-durable-engine.md), [03 — Data Model](../design/03-data-model-sor.md), [05 — Public API](../design/05-public-api-and-sdk.md), [08 — Conventions](../design/08-conventions-and-execution-boundary.md), [02 — Architecture](../design/02-architecture-and-mapping.md). Decisions: [D1–D19](../design/07-risks-and-decisions.md) (notably [D13](../design/07-risks-and-decisions.md), [D15](../design/07-risks-and-decisions.md)).

## Goal & scope

Two capabilities land here, both layered on the durable loop and the harness facade
already built in P4/P6:

1. **Skills catalog.** A host-side **import action** parses a host/repo-supplied
   `SKILL.md` (via the already-ported `parseSkillMarkdown`) and writes **idempotent**
   rows into the `skills` table — provisioning **no box** and reading **no sandbox FS**.
   At runtime a skill is resolved **only from the catalog** (a Convex query): both the
   autonomous **`activate_skill`** built-in tool and the host-facing **`session.skill()`**
   route resolve identity/frontmatter/instructions/reference bodies from catalog rows.
   This is the concrete replacement for flue's filesystem `context.ts` discovery
   ([D13](../design/07-risks-and-decisions.md), [08 §3](../design/08-conventions-and-execution-boundary.md#skills-resolve-at-the-call-site-not-in-the-sandbox)).

2. **MCP integration.** A new **`convex/mcp/` `"use node"` module** ports flue's
   `connectMcpServer`. The agent profile gains a declarative **`mcpServers`** field
   resolved at `setup`; discovered tools **freeze as descriptors carrying server
   identity + transport** (not a closure). `buildTools` **re-resolves a network MCP
   client per `llmStep`/`dispatchTools`** — the one sanctioned network exception to
   box-binding ([08 §4.5](../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors),
   [D15](../design/07-risks-and-decisions.md)) — with connection caching + eviction +
   `close()` ownership, and replay de-dup by `toolCallId`.

**In scope:** the import action + catalog read query; `session.skill()` catalog routing;
the `activate_skill` catalog resolution wired into `dispatchTools`; the `Available Skills`
system-prompt rendering sourced from catalog rows at `setup`; `mcpServers` on the profile;
`convex/mcp/` connect + descriptor freeze + per-step re-resolution + connection lifecycle;
on-demand `SessionEnv` reads for **non-skill** workspace context.

**Out of scope (deferred / dropped):** build-time skill *packaging*
(`SkillReference`/`PackagedSkillDirectory` producer, import-attribute machinery) is
deferred to [P8.5](phase-08.5-cli-codegen.md) — only the *runtime* catalog side is here
([08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit));
flue's `context.ts` directory-walk discovery is **not** ported; MCP image/audio/resource
content beyond flue's text formatting is unchanged from the port.

## Dependencies

- **P6 (Harness facade + invoke)** — *hard.* `session.skill()` is a `CoveSession`
  method that routes onto the same prompt/submission path as `session.prompt()`
  (`runPromptCall` equivalent); the `skill` request kind already exists on
  `agentRequests`. The facade, `invoke.submitPrompt`, and the operation-scoping gate must
  be live first.
- **P4 (Durable engine)** — *hard.* `buildTools`, the frozen-descriptor rebuild in both
  `llmStep` and `dispatchTools`, `setup`'s system-prompt composition, and the built-in
  tool set (`createTools` incl. the `activate_skill` slot) are the seams this phase
  extends. MCP descriptor freeze happens in `setup`; per-step re-resolution happens in
  `buildTools`.
- **P1 (pure core)** — `parseSkillMarkdown` ([`src/runtime/skill-frontmatter.ts`](../../src/runtime/skill-frontmatter.ts))
  and the `Skill`/`SkillReference` types ([`src/runtime/types.ts`](../../src/runtime/types.ts))
  are already on disk; the `skills` table is already in [`convex/schema.ts`](../../convex/schema.ts).
- **P2 (sandbox)** — *soft.* On-demand non-skill `SessionEnv` reads use the resolved
  box from `dispatchTools`; the acceptance test for "non-skill workspace context"
  needs a working `SessionEnv`.

Per the critical path in [06](../design/06-phase-roadmap.md#critical-path), P10 sits on
the P9→P10 leg downstream of P6.

## Deliverables

| Path | Purpose |
| --- | --- |
| `convex/skills/import.ts` | `"use node"`-free **import action** (an `internalAction`/`action` that parses host `SKILL.md` text via `parseSkillMarkdown` and upserts catalog rows; **no box**, no sandbox FS). Idempotent on `contentHash`. |
| `convex/skills/catalog.ts` | Catalog **mutations + queries**: `upsertSkill` (idempotent insert/patch keyed by `slug`/`contentHash`), `getBySlug`, `listActive`, `deactivateSkill` (soft-delete via `isActive`). The single box-free resolution surface for both `activate_skill` and `session.skill()`. |
| `convex/skills/resolve.ts` | Pure helpers mapping a catalog row → the skill **activation prompt** (port of `buildWorkspaceSkillPrompt`/`buildSkillByPathlessNamePrompt` shape, catalog-sourced) and → the `## Available Skills` registry line. Shared by `setup`, `session.skill()`, and `activate_skill`. |
| `convex/mcp/connect.ts` | **`"use node"`** module porting flue's `connectMcpServer` (+ `connectMcpServerWithClient`, transport creation, tool-name sanitization, result formatting). Adapts MCP tools → `ToolDefinition[]`. |
| `convex/mcp/descriptors.ts` | Freeze logic: a discovered MCP tool → a **frozen descriptor** (`{ mcpServerId, transport, url, headers, toolName, name, description, parameters }`, *no closure*) for the plan; the inverse `mcpDescriptorToToolDefinition(descriptor, client)` that binds `execute` against a re-resolved client. |
| `convex/mcp/pool.ts` | **`"use node"`** connection lifecycle: a process-local cache keyed by **server identity**, lazy open on cold action, explicit eviction + `close()` owner, drift handling (frozen descriptors win). |
| `src/runtime/mcp-types.ts` | Pure (V8-safe) types ported from flue's `mcp.ts`: `McpTransport`, `McpServerOptions`, `McpServerConnection`, plus the new `McpToolDescriptor` shape. **No `@modelcontextprotocol/sdk` import** (that stays in `convex/mcp/`). |
| `convex/engine/buildTools.ts` (extend) | Re-resolve MCP descriptors to executable tools via `convex/mcp/`; thread `activate_skill` resolution to the catalog query. (File exists from P4; this phase adds the MCP + skill branches.) |
| `convex/engine/setup.ts` (extend) | Resolve `mcpServers` → frozen MCP descriptors onto the plan; render `## Available Skills` from catalog rows (no FS scan). (File exists from P4.) |
| `src/runtime/types.ts` (extend) | Add `mcpServers?: McpServerOptions[]` to `AgentProfile` (+ `AgentRuntimeConfig`/op options where flue surfaces them); re-export the MCP runtime types. |
| `package.json` (extend) | Add `@modelcontextprotocol/sdk` (flue pins `^1.29.0`) as a dependency (used only by `convex/mcp/`). |

> Future files (not yet built) are written as inline code (`convex/skills/import.ts`),
> not links, per the link convention.

## Source map (flue/pi → cove)

| flue/pi source (verified) | cove target | port / transform notes |
| --- | --- | --- |
| [`packages/runtime/src/mcp.ts`](../../../flue/packages/runtime/src/mcp.ts) (`connectMcpServer`, `connectMcpServerWithClient`, `createTransport`, `createMcpTools`, `validateMcpResult`, `createToolName`, `formatMcpResult`) | `convex/mcp/connect.ts` | Port near-verbatim into a **`"use node"`** module (the `@modelcontextprotocol/sdk` import forbids the pure barrel). Rename the SDK client identity `'flue'` → `'cove'`; `[flue]` error prefix → `[cove]`. `execute` still calls `client.callTool`; the closure-over-client is what makes it network, not box. |
| `packages/runtime/src/mcp.ts` types (`McpTransport`, `McpServerOptions`, `McpServerConnection`) | `src/runtime/mcp-types.ts` | Pure type-only port (no SDK runtime import) so `AgentProfile.mcpServers` and the frozen descriptor stay V8-safe on the `@cove/runtime` barrel. |
| [`packages/runtime/src/context.ts`](../../../flue/packages/runtime/src/context.ts) (`composeSystemPrompt`, `HEADLESS_PREAMBLE`, `## Available Skills` block) | `convex/skills/resolve.ts` (registry line) + `convex/engine/setup.ts` | **Discovery is NOT ported.** Keep only the *rendering*: `HEADLESS_PREAMBLE` (already owned by `setup` from P4) + the `## Available Skills` list built from **catalog rows**, not `discoverLocalSkills`. `readAgentsMd`/`discoverLocalSkills`/`discoverSessionContext`/`skillsDirIn` are dropped ([D13](../design/07-risks-and-decisions.md)). |
| [`packages/runtime/src/result.ts`](../../../flue/packages/runtime/src/result.ts) (`buildWorkspaceSkillPrompt`, `buildSkillByPathlessNamePrompt`) | `convex/skills/resolve.ts` (`buildCatalogSkillPrompt`) | Collapse the two shapes into one catalog-sourced builder: `Run the skill named "<name>"\n<skill_instructions>…</skill_instructions>` from the row's `instructions`; append the result-footer when a result schema is set (reuse the P4 `buildResultFooter`). Packaged-skill `atob`/`PackagedSkillDirectory` path is **deferred** (P8.5). |
| [`packages/runtime/src/agent.ts`](../../../flue/packages/runtime/src/agent.ts) (`createActivateSkillTool`, lines 333–371) | `convex/engine/buildTools.ts` (activate_skill branch) | The literal/union-of-literals `name` param is now built from **catalog slugs** resolved at `setup` (frozen onto the plan's skill list). The `execute` (line 356) resolves the named skill via `catalog.getBySlug` (a Convex query) and returns the activation prompt — **never `env.readFile`**. |
| [`packages/runtime/src/session.ts`](../../../flue/packages/runtime/src/session.ts) `skill()` (922–971) + `activateSkillForTool` (1114–1129) | `convex/invoke/*` skill route + `CoveSession.skill()` (P6 facade, extended) | `session.skill(name)` resolves the catalog prompt and routes through the existing **skill** request kind onto the prompt path. The flue `isWorkspaceSkill`/`__flueSkillReference`/`resolvePackagedSkill` branches collapse to a single **catalog** branch; missing slug → `SkillNotRegisteredError`. |
| [`packages/runtime/src/skill-frontmatter.ts`](../../../flue/packages/runtime/src/skill-frontmatter.ts) → already ported [`src/runtime/skill-frontmatter.ts`](../../src/runtime/skill-frontmatter.ts) | `convex/skills/import.ts` (consumer) | **No re-port.** The import action imports `parseSkillMarkdown` from the existing pure module and maps `ParsedSkillMarkdown` → a `skills` row (`name`→`name`, `description`→`description`, `body`→`instructions`, `allowedTools`→`requiredTools`, slug from directory name). |

## Hardened-contract obligations

- **[08 §3](../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy) — execution boundary / the two sanctioned non-box executions.**
  Both carve-outs land in this phase and **must not touch the box**: (a) `activate_skill`
  resolves a skill **by name from the `skills` catalog via a Convex query**, never an
  `env.readFile`/FS walk; (b) MCP tools reach an **external server over the network**, not
  the box. Queries/mutations (`convex/skills/catalog.ts`) stay box-free; only the
  `"use node"` `convex/mcp/` actions open transports.
- **[08 §3 — Skills resolve at the call site](../design/08-conventions-and-execution-boundary.md#skills-resolve-at-the-call-site-not-in-the-sandbox) ([D13](../design/07-risks-and-decisions.md)).**
  A skill is host state, not workspace state. **No `SKILL.md` is ever read from the sandbox
  FS to *resolve* a skill at runtime.** On-demand `SessionEnv` reads remain available **only
  for non-skill workspace context** (files the run operates on) and must never be the path
  that discovers or loads a skill.
- **[08 §4.5](../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors) — tool rebuild from frozen descriptors (MCP named exception).**
  The frozen descriptor carries **server identity + transport** (url/transport/headers + tool
  name), *not* a closure. `buildTools` re-resolves an MCP client from that descriptor on
  **each** `llmStep`/`dispatchTools` and binds `execute` against the client, not the box. A
  `buildTools` failure (e.g. connect failure during rebuild) becomes an **error tool-result,
  never a step crash**.
- **[08 §4.5](../design/08-conventions-and-execution-boundary.md#45-tool-rebuild-from-frozen-descriptors) — replay de-dup.**
  `callTool` is side-effecting, so a replayed `dispatchTools` **returns the persisted result**
  (idempotent `appendToolResult` keyed on `toolCallId`) and **never re-issues the network call**.
- **[08 §4.2](../design/08-conventions-and-execution-boundary.md#42-action-budgets--timeouts) — per-tool timeout.**
  An MCP `callTool` runs under the `dispatchTools` per-tool deadline (≈ 30 s); the ported
  `McpServerOptions.timeoutMs` (default 60 s SDK) must be clamped so it cannot outlive the
  action budget — a hung MCP call yields an error tool-result, not a starved action.
- **[08 §4.3](../design/08-conventions-and-execution-boundary.md#43-cancel-short-circuit) — cancel short-circuit.**
  The MCP `execute` honors the per-tool `signal` (flue already aborts on `signal?.aborted`);
  the `dispatchTools` status re-check before each tool still applies, so a cancelled run skips
  remaining MCP calls and discards late results.
- **[08 §2](../design/08-conventions-and-execution-boundary.md#2-reference-header-convention) — reference header.**
  Every new file opens with the `// Ported from flue · @flue/runtime · …` (or `// New (Convex
  backend) · @cove/runtime`) header; `convex/mcp/connect.ts` cites `packages/runtime/src/mcp.ts`.
- **[08 §1](../design/08-conventions-and-execution-boundary.md#1-naming--namespace) — naming.**
  `connectMcpServer` is a **kept generic verb** but is **Convex-app-bound** (lives under
  `convex/mcp/`, not the `@cove/runtime` barrel). The SDK client name and `[flue]` prefixes
  rebrand to `cove`/`[cove]`.

## Implementation tasks

Ordered; each is a buildable checkpoint. `tsc --noEmit` must stay green at every step.

- [ ] **1. Add the MCP SDK dependency.** Add `@modelcontextprotocol/sdk` (`^1.29.0`, matching flue) to `package.json` dependencies; `npm install`; confirm it resolves and `tsc --noEmit` stays green.
- [ ] **2. Port pure MCP types** into `src/runtime/mcp-types.ts` (`McpTransport`, `McpServerOptions`, `McpServerConnection`, and the new `McpToolDescriptor`). **No SDK runtime import** — types only. Re-export from [`src/runtime/index.ts`](../../src/runtime/index.ts).
- [ ] **3. Extend the profile.** Add `mcpServers?: McpServerOptions[]` to `AgentProfile` (and the runtime-config / op-option surfaces flue exposes) in [`src/runtime/types.ts`](../../src/runtime/types.ts). Keep it optional — most agents declare none.
- [ ] **4. Catalog mutations/queries** in `convex/skills/catalog.ts`: `upsertSkill` (insert if no `by_slug` row, else patch when `contentHash` differs — **idempotent**, re-run is a no-op when the hash matches; bump `updatedAt`/`updatedBy`), `getBySlug`, `listActive` (filter `isActive`), `deactivateSkill` (soft-delete). All **box-free** queries/mutations.
- [ ] **5. Import action** `convex/skills/import.ts`: takes host-supplied `{ directoryName, path, content }[]` (or a single SKILL.md), calls `parseSkillMarkdown` from the pure module, maps to a catalog row (compute `contentHash` over the parsed payload), and calls `upsertSkill` per skill. **Provisions no box, reads no sandbox FS** — the source is the host argument. Re-running with identical content is a no-op (idempotent acceptance bar).
- [ ] **6. Skill resolution helpers** `convex/skills/resolve.ts`: `buildCatalogSkillPrompt(row, { args?, schema? })` → the activation prompt; `renderAvailableSkillsBlock(rows)` → the `## Available Skills` markdown list. Reuse the P4 result-footer when a result schema is present.
- [ ] **7. `setup` skill rendering.** In `convex/engine/setup.ts`, replace any FS-discovery placeholder with a **catalog query** (`listActive` filtered to the agent's declared skills) and render `## Available Skills` from rows. Freeze the resolved **skill slug list** onto the plan so `activate_skill`'s param union is deterministic across replay. **No box provisioned** (setup stays resolve-only, [04](../design/04-durable-engine.md)).
- [ ] **8. `activate_skill` catalog branch** in `convex/engine/buildTools.ts`: build the `name` param as a literal/union from the **frozen plan slug list**; the rebuilt `execute` runs a Convex query (`catalog.getBySlug`) and returns `buildCatalogSkillPrompt(row)`. Assert it never calls `env.readFile`. A missing/deactivated slug returns an **error tool-result** (not a crash).
- [ ] **9. `session.skill()` catalog routing** (extend the P6 `CoveSession.skill()`): resolve the named skill from the catalog, build the prompt via `buildCatalogSkillPrompt`, and submit through the existing **`skill`** request kind onto the prompt path. Missing slug → `SkillNotRegisteredError` (carry available slugs). No packaged/workspace branches.
- [ ] **10. Port `connectMcpServer`** into `convex/mcp/connect.ts` (`"use node"`): copy the transport creation (streamable-http default, sse fallback), pagination loop with repeated-cursor guard, `createMcpTools`, `validateMcpResult`, `formatMcpResult`, `createToolName`/`sanitizeToolNamePart`. Rebrand `'flue'`→`'cove'`, `[flue]`→`[cove]`.
- [ ] **11. Descriptor freeze/inverse** in `convex/mcp/descriptors.ts`: `freezeMcpTool(serverId, options, tool)` → `McpToolDescriptor` (server identity + transport + tool name + JSON-Schema params, **no closure**); `mcpDescriptorToToolDefinition(descriptor, client)` → a `ToolDefinition` whose `execute` calls `client.callTool` (the network bind). Descriptors are plain JSON, journal-safe.
- [ ] **12. `setup` MCP resolution.** In `convex/engine/setup.ts` (`"use node"` already), for each `plan.mcpServers` call `connectMcpServer`, discover tools, `freezeMcpTool` each, append the descriptors to the plan's frozen `tools` (tagged `source: "mcp"`), then `close()` the discovery connection (discovery is one-shot; runtime re-resolves per step). The model only ever sees JSON-Schema.
- [ ] **13. Connection pool** `convex/mcp/pool.ts` (`"use node"`): `getOrOpen(descriptor)` returns a cached client keyed by **server identity** (url+transport+headers hash), lazily opening on a cold action; `evict(serverId)` calls `close()`; a module-scope `Map` that does **not** survive across actions (re-open on cold). Clamp `timeoutMs` to the per-tool budget.
- [ ] **14. `buildTools` MCP branch** in `convex/engine/buildTools.ts`: for each descriptor tagged `source:"mcp"`, **re-resolve a client** via `pool.getOrOpen` and bind `execute` via `mcpDescriptorToToolDefinition`. A connect/resolve failure → **error tool-result** (wrap in the `buildTools`-failure path, never throw out of the step). The `llmStep` view strips `execute` (model sees schema only); `dispatchTools` runs it.
- [ ] **15. Drift handling.** When a re-resolved connection's live tool list **differs** from the frozen descriptors mid-run, the **frozen descriptors win**: a now-missing tool's `execute` returns an error tool-result (`[cove] MCP tool "<name>" no longer offered by server "<id>"`) rather than discovering new tools.
- [ ] **16. Replay de-dup wiring.** Confirm the MCP `execute` path flows through the idempotent `appendToolResult` (keyed `toolCallId`) so a replayed `dispatchTools` returns the persisted result without re-calling `callTool`. (Mechanism is P4's; this phase asserts MCP rides it.)
- [ ] **17. On-demand non-skill `SessionEnv` reads.** Confirm/extend the seam (P2/P4) so a run can `env.readFile` **non-skill** workspace files on demand. Add a guard/comment asserting this path is never used to resolve a skill. No discovery walk.
- [ ] **18. Reference headers + barrel exports.** Every new file opens with its [08 §2](../design/08-conventions-and-execution-boundary.md#2-reference-header-convention) header; re-export the public MCP types from the runtime barrel; `connectMcpServer` is exported from the **app/CLI surface**, not the pure barrel ([08 §1](../design/08-conventions-and-execution-boundary.md#1-naming--namespace)).
- [ ] **19. Tests** (see Acceptance). `tsc --noEmit` green; targeted unit/integration tests pass.

## Acceptance

Starts from [06 P10's acceptance bar](../design/06-phase-roadmap.md#-phase-10--skills--mcp) plus coverage additions:

- **Catalog skill runs, no box.** `session.skill("review-pr")` loads and runs a skill seeded **only** by the import action; assert **no box is provisioned** to resolve it (spy/mock the `SandboxFactory` — zero `resolveSandbox` calls on the skill-resolution path).
- **Import idempotency.** The import action parses a host `SKILL.md`, writes a row; re-running with **identical content** is a no-op (same `contentHash`, no new row, `updatedAt` unchanged); re-running with **changed content** patches the existing `by_slug` row in place (no duplicate).
- **`parseSkillMarkdown` mapping fidelity.** A SKILL.md with frontmatter (`name`/`description`/`allowed-tools`) and body maps to `{ slug, name, description, instructions: body, requiredTools: allowedTools }`; a malformed frontmatter import **fails loud** with a `[cove]` message (import is strict — unlike flue's discovery, which skipped-with-warning).
- **`activate_skill` is box-free.** A run whose model calls `activate_skill("<slug>")` resolves via the **catalog query** and returns the activation prompt; assert **no `env.readFile`/FS** call on that path; a missing/deactivated slug returns an **error tool-result**, not a crash.
- **MCP tools are model-callable with frozen schemas.** An MCP server declared via `mcpServers` surfaces its tools (named `mcp__<server>__<tool>`) as JSON-Schema tools the model can call; the descriptors on the plan carry **server identity + transport, not a closure**.
- **MCP replay survives `dispatchTools` without a second `callTool`.** Drive a `dispatchTools` replay (re-run the action) for an MCP tool call and assert the persisted result is returned and `callTool` is invoked **at most once** (mock the MCP client; count calls). This is the §4.5 de-dup bar.
- **Per-step re-resolution.** Across two `llmStep`/`dispatchTools` beats, `buildTools` re-resolves an MCP client each beat (reusing a cached connection when warm, re-opening on cold); a connect failure during rebuild yields an **error tool-result**, not a step crash.
- **Connection lifecycle.** A cold action with no live connection re-opens one; eviction calls `close()`; a mid-run **tool-list drift** (cached connection now omits a frozen tool) returns an error tool-result for the missing tool — **frozen descriptors win**.
- **Non-skill workspace context.** An on-demand `SessionEnv` read surfaces a **non-skill** workspace file **without** a discovery walk and **without** being mistaken for skill resolution.
- **`tsc --noEmit` exits 0** with the new `@modelcontextprotocol/sdk` dependency and all new modules.

## Risks & gotchas

- **`"use node"` quarantine.** `@modelcontextprotocol/sdk` and `connectMcpServer` open a
  network transport — they **must** live in `convex/mcp/` (`"use node"`) and **never** be
  imported from the pure `src/runtime` barrel or from a query/mutation, or the V8 isolate
  build breaks. Only `setup`/`dispatchTools`/`buildTools` (already `"use node"`) reach them.
  The pure `src/runtime/mcp-types.ts` carries **types only** (no SDK import) so the profile
  shape stays V8-safe.
- **Closures can't cross the journal.** An MCP tool's `execute` closes over a live client —
  it **cannot** be frozen. Freeze the **descriptor** (server identity + transport) only;
  re-resolve the client every step. Forgetting this and trying to persist the connection (or
  the `ToolDefinition` with its closure) is the classic replay-determinism break.
- **Replay must not re-issue network calls.** `callTool` is side-effecting; rely on the
  §4.5 `appendToolResult` idempotency (keyed `toolCallId`) so a replayed `dispatchTools`
  returns the persisted result. Do **not** add a "re-run on replay" path for MCP.
- **Connection cache is per-process, not durable.** The `convex/mcp/pool.ts` `Map` lives in
  one action's process; a cold action re-opens. Treat warm connections as a best-effort
  cache, exactly like the box handle cache ([08 §3](../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy),
  [R5](../design/07-risks-and-decisions.md)). Never assume a connection survives across
  actions.
- **Skill discovery temptation.** It is tempting to fall back to `env.readFile('SKILL.md')`
  when a slug is missing from the catalog — **do not.** [D13](../design/07-risks-and-decisions.md)
  forbids any sandbox-FS skill resolution; a missing slug is an error tool-result /
  `SkillNotRegisteredError`, never an FS walk. The only sandbox reads allowed are **non-skill**
  workspace context.
- **Setup stays resolve-only for skills, but MCP discovery is a network call in `setup`.**
  MCP tool discovery (`listTools`) happens in `setup` (one-shot, then `close()`), which is
  acceptable because it is a **network** call, not a box provision — `setup` still provisions
  **no box**. Don't conflate "resolve-only (no box)" with "no network": MCP discovery is the
  intended exception.
- **Tool-name collisions.** `createToolName` sanitizes + rejects duplicate `mcp__server__tool`
  names; also ensure MCP tool names don't collide with the framework-reserved built-ins
  (`activate_skill`, `task`, `finish`, …) — surface a deterministic `[cove]` error at `setup`,
  not a silent shadow.
- **Timeout layering.** The MCP SDK default per-request timeout is 60 s, but the
  `dispatchTools` per-tool budget is ≈ 30 s ([08 §4.2](../design/08-conventions-and-execution-boundary.md#42-action-budgets--timeouts)).
  Clamp `McpServerOptions.timeoutMs` to the action budget so the SDK timeout never outlives
  the action.
- **Import idempotency hinges on `contentHash`.** Hash a **stable** projection of the parsed
  skill (not the raw bytes with volatile whitespace) so re-imports of semantically-identical
  SKILL.md are no-ops; an unstable hash defeats the idempotency acceptance bar.
