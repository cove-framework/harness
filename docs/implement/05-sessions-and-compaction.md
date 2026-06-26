# Sessions & Compaction

A **session** is one continuous conversation: a tree of messages that grows as you prompt, and the unit Cove addresses, persists, deletes, and compacts. This page covers how sessions are named and reused for multi-turn continuity, how to inspect and delete them, how Cove rebuilds model context from the persisted entry tree, and how compaction summarizes old turns to keep long conversations inside the model's context window.

If you have not yet run a prompt, start with [Getting Started](01-getting-started.md) and [Invoking Agents](03-invoking-agents.md). For the delegated-task (`task:*`) sessions that subagents run in, see [Subagents & Workflows](06-subagents-and-workflows.md).

---

## Session addressing: the (instanceId, harnessName, sessionName) tuple

Cove has **no opaque public session id**. Every session is addressed by a tuple of three strings:

```ts
export interface SessionRef {
  instanceId: string;
  harnessName: string;
  sessionName: string;
}
```

That tuple is the universal key. The Convex `sessions` table resolves it through the `by_instance_harness_session` index, and every public/internal session function keys on it (or, for internal-only functions, on the resolved `Id<"sessions">`).

Where each component comes from when you author a run:

| Component     | Set by                                              | Default     |
| ------------- | --------------------------------------------------- | ----------- |
| `instanceId`  | `ctx.init` / submission `id` (the agent instance)   | `"default"` |
| `harnessName` | `ctx.init(agent, { name })`                         | `"default"` |
| `sessionName` | `harness.session(name)` / `sessions.get/create(name)` | `"default"` |

In the native SDK the chain reads top-to-bottom into that tuple:

```ts
const ctx = cove.context({ id: "user-42" });          // instanceId = "user-42"
const harness = await ctx.init(helloAgent, { name: "support" }); // harnessName = "support"
const session = await harness.session("ticket-1001");  // sessionName = "ticket-1001"
await session.prompt("What's the status of my order?");
```

Over HTTP, `POST /agents/:name/:id` maps the `:id` path segment to `instanceId` and the optional body field `sessionName` (default `"default"`) to the session name. See [Invoking Agents](03-invoking-agents.md) for the full HTTP contract.

> **`sessionName` starting with `task:` is reserved.** Names beginning with `task:` belong to the delegated-task namespace (see [Subagents & Workflows](06-subagents-and-workflows.md)). `harness.session(name)` and `sessions.get/create(name)` validate the name with `assertPublicSessionName`, which throws `[cove] Session names beginning with "task:" are reserved for delegated tasks.` Pick another name.

---

## Multi-turn continuity is implicit: reuse the tuple

There is **no explicit "resume" call**. Continuity is purely a function of reusing the same `(instanceId, harnessName, sessionName)` tuple.

Under the hood, the first prompt on a tuple goes through `admitPrompt` (`convex/invoke/admit.ts`), which calls the `getOrCreateSessionId` helper. That helper is **idempotent on the tuple**: it returns the existing session row's id or inserts a fresh one (`version: 6`, a generated `affinityKey`, `leafId: null`, empty `taskSessions`/`metadata`, `state: "idle"`). A second prompt with the same tuple re-attaches to the same entry tree and continues the conversation:

```ts
const session = await harness.session("ticket-1001");

await session.prompt("My order number is 5567.");
// ...later, same tuple → same conversation, full history in context:
await session.prompt("Did it ship yet?");
```

A **different `sessionName`** (or a different `instanceId`/`harnessName`) starts a brand-new tree with no shared history:

```ts
await harness.session("ticket-1001").then((s) => s.prompt("..."));  // conversation A
await harness.session("ticket-2002").then((s) => s.prompt("..."));  // conversation B, independent
```

> **Note on `harness.session(name)` vs `sessions.get/create`.** `harness.session(name)` validates the name but does **not** check existence — it just hands you a session handle (which `getOrCreate`s on first prompt). If you want existence semantics, use `harness.sessions.get(name)` (throws `SessionNotFoundError` if missing) or `harness.sessions.create(name)` (throws `SessionAlreadyExistsError` if present). Both also validate the name via `assertPublicSessionName`.

> **Submitting always supersedes in-flight work.** The `submitPrompt` mutation (`api.invoke.submit.submitPrompt`) admits a new prompt with `supersede: true`, cancelling any pending/running request on the same session tuple with `cancelReason: "superseded"`. If you need a non-superseding driver (e.g. local exercising), use `api.dev.startPrompt`, which sets `supersede: false`. See [Invoking Agents](03-invoking-agents.md).

---

## Inspecting and deleting sessions

Only **two** session-store functions are public (callable from an untrusted client). Everything else is `internalMutation`/`internalQuery`/`action`.

### `exists` — does this session exist?

```ts
// convex/sessions/store.ts — PUBLIC query
export const exists = query({
  args: { instanceId: v.string(), harnessName: v.string(), sessionName: v.string() },
  handler: async (ctx, args): Promise<boolean> => { /* ... */ },
});
```

Returns `true` iff a session row exists for that tuple. This is exactly what the SDK transport's `sessions.get`/`sessions.create` use as their existence check (`CoveApiRefs.sessionExists`). Reference it as `api.sessions.store.exists`:

```ts
const present = await client.query(api.sessions.store.exists, {
  instanceId: "user-42",
  harnessName: "support",
  sessionName: "ticket-1001",
});
```

### `remove` — delete a session (and its task children)

```ts
// convex/sessions/store.ts — PUBLIC mutation
export const remove = mutation({
  args: { instanceId: v.string(), harnessName: v.string(), sessionName: v.string() },
  handler: async (ctx, args) => { /* cascadeDeleteSession */ },
});
```

`remove` deletes the session by tuple and **cascades to its delegated-task child sessions**. Two behaviors to know:

- **It refuses (throws) while any descendant request is still active.** Deletion is not unconditional — `cascadeDeleteSession` will not delete out from under a running task. Stop in-flight work first (the `stopActive` mutation, `api.invoke.submit.stopActive`) if you need to force it.
- **It is a no-op when the session is absent** — no error.

Reference it as `api.sessions.store.remove`. In the SDK facade this is what `session.delete()` and `harness.sessions.delete(name)` drive (`transport.deleteSession`):

```ts
const session = await harness.session("ticket-1001");
await session.delete();          // → transport.deleteSession → api.sessions.store.remove
// or, without a session handle:
await harness.sessions.delete("ticket-1001");
```

> **Internal-only functions.** `load`, `appendUserPrompt`, `appendToolResults`, `appendCompactionEntry`, `deleteSession`, and the `compact` action key on `v.id("sessions")` and are not directly callable from an untrusted client. You drive them indirectly through the engine and the two public functions above.

---

## How context is built from the entry tree

A session is **not** a flat message list — it is a **parent-linked tree** of `SessionEntry` rows. The session row carries a `leafId`; the **active path** is `leafId` walked back through each entry's `parentId`, then reversed into chronological order.

```ts
export interface SessionData {
  version: 6;                       // literal 6 — older versions are rejected
  affinityKey: string;             // /^aff_[0-7][0-9A-HJKMNP-TV-Z]{25}$/
  entries: SessionEntry[];
  leafId: string | null;
  taskSessions: TaskSessionRef[];
  metadata: Record<string, any>;   // application-owned; Cove never reads/writes keys
  createdAt: string;
  updatedAt: string;
}

export type SessionEntry = MessageEntry | CompactionEntry;
```

Each submission appends entries to the tree, both idempotently keyed so a durable-workflow replay never duplicates them:

- **`appendUserPrompt`** — the user-prompt entry that opens a submission, idempotent by entry id `u-<requestId>`.
- **`appendToolResults`** — the ordered tool-result entries for a step, idempotent by entry id `t-<requestId>-<stepNumber>-<toolCallId>`.

### `SessionHistory` — the in-memory view

The persisted tree is hydrated into a `SessionHistory` (`src/runtime/session-history.ts`). The constructor is private; build one via `fromData` (from the hydrated `SessionData`) or `empty`:

```ts
import { SessionHistory } from "../src/runtime/session-history.ts";

const history = SessionHistory.fromData(sessionData);  // SessionData | null
// or:
const fresh = SessionHistory.empty();
```

`fromData` is strict and **throws** (it does not return `null`) on persisted-state it cannot trust:

- `data.version !== 6` → `[cove] Session data version <N> is unsupported. Clear persisted session state created by an earlier Cove beta.`
- a `data.affinityKey` that doesn't match `/^aff_[0-7][0-9A-HJKMNP-TV-Z]{25}$/` → a malformed-affinity error.

The key methods for turning the tree into model context:

| Method                  | Returns           | Use                                                           |
| ----------------------- | ----------------- | ------------------------------------------------------------ |
| `getActivePath()`       | `SessionEntry[]`  | the ordered entries on the active path (leaf → root, reversed) |
| `buildContext()`        | `AgentMessage[]`  | messages ready to send to the model                          |
| `buildContextEntries()` | `ContextEntry[]`  | each `{ message, entry? }` so you can map a context message back to its persisted entry id |

`buildContext()` is just `buildContextEntries().map((e) => e.message)`. You need `buildContextEntries()` (not `buildContext()`) when you must resolve a context message back to its persisted entry — which is exactly what compaction does to find its boundary entry id.

```ts
export interface ContextEntry {
  message: AgentMessage;   // model-facing message
  entry?: SessionEntry;    // the persisted row it came from (if any)
}
```

### What context-building drops

`buildContextEntries()` does not blindly emit every entry — it sanitizes the path so the model never sees a malformed turn:

- **Aborted/error assistant turns are dropped** (unless they form a resumable partial stream).
- **Tool-call / tool-result batches are only included when complete and correctly ordered** (the internal `isCompleteToolResultBatch` check: count, uniqueness, and matching `toolCallId`/`toolName`). A partial tool batch silently disappears from context.

---

## Compaction

As a session grows, its context approaches the model's window. **Compaction** summarizes the older slice of the conversation into a single summary message and keeps only a recent tail — bounding context size while preserving what matters.

Compaction is **incremental**. When a prior summary already exists on the path, the engine doesn't redo everything from scratch: it carries the prior summary forward with an **UPDATE prompt** and summarizes only the **new slice** since the last cut. If the chosen cut point falls *inside* a single turn that is itself too large to keep, that turn's **prefix is summarized separately** (a "split turn") so the cut never lands mid-turn in context. The token usage of the summarization call is now persisted on the compaction entry.

There are three ways compaction is meant to fire:

1. **Threshold** — when estimated context tokens exceed `contextWindow - reserveTokens`, compact (no retry).
2. **Explicit** — you (or the agent) call the `compact` action directly.
3. **Overflow recovery** — when the provider rejects a request for exceeding the context window, the engine compacts and retries automatically (see [Overflow recovery](#overflow-recovery) below).

> **Documented gap — the threshold auto-trigger is not yet wired.** The pure `shouldCompact` gate exists, and the explicit `compact` action exists, but the loop's automatic threshold trigger that calls the action when the gate fires is the **remaining wire** (P12). Today, compaction runs when you invoke the action explicitly (overflow recovery on a provider context-overflow signal still runs regardless of the `compaction` config). Note also that `session.compact()` in the SDK facade currently rejects with a `not_implemented` `CoveError` — drive the action directly (below) until P12 lands.

### Overflow recovery

Independent of the threshold gate, Cove guards against the provider rejecting a request for exceeding the context window. When that happens the engine does **not** just fail the run: it **compacts the session and automatically retries once on a fresh step**. If the retried request *still* overflows, the run is finalized as **failed** with reason `context_overflow`.

The recovery retry budget defaults to one attempt, and this path runs even when threshold compaction is disabled (`compaction: false`) — disabling threshold compaction does not disable overflow recovery. So a single oversized turn is self-healing, but a request that can't fit even after a compaction terminates cleanly with a clear failure reason rather than looping.

### The decision is pure: `prepareCompaction`

All of the "when and what to compact" logic lives in `src/runtime/compaction.ts` and is **pure** — no I/O, V8-safe, unit-testable on its own:

```ts
export function prepareCompaction(
  messages: AgentMessage[],
  settings: CompactionSettings,
  previousCompaction?: { summary: string; firstKeptIndex: number; details?: { readFiles: string[]; modifiedFiles: string[] } },
): CompactionPreparation | undefined;
```

It decides the cut point and the slice to summarize. It **returns `undefined`** (it does not throw) when there is nothing to compact — empty messages, or a cut point `<=` the boundary start (`boundaryStart = previousCompaction?.firstKeptIndex ?? 0`). It **never cuts at a `toolResult`** — cut points are user/assistant messages only.

```ts
export interface CompactionPreparation {
  firstKeptIndex: number;          // index of the first message to KEEP
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary: string | undefined;
  fileOps: FileOps;
  settings: CompactionSettings;
}
```

Supporting pure helpers you can reuse:

- **`shouldCompact(contextTokens, contextWindow, settings)`** — the threshold gate: `true` when enabled and `contextTokens > contextWindow - reserveTokens`. Returns `false` when `contextWindow <= 0` (unknown window — threshold skipped; overflow recovery still runs).
- **`estimateContextTokens(messages)`** — uses the last assistant `Usage` if present plus a trailing estimate, else a `chars/4` estimate over all messages. (Conservative — overestimates; images count ~4800 tokens. Not exact.)
- **`deriveCompactionDefaults({ contextWindow, maxTokens })`** — model-aware defaults real sessions use instead of the flat `DEFAULT_COMPACTION_SETTINGS`.

```ts
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 20000,
  keepRecentTokens: 8000,
};
```

### The explicit compact action

`convex/engine/compact.ts` exports the `compact` action (a `"use node"` action — it imports the AI SDK and gateway):

```ts
export const compact = action({
  args: {
    sessionId: v.id("sessions"),
    model: v.optional(v.string()),
    keepRecentTokens: v.optional(v.number()),
    reserveTokens: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{
    compacted: boolean;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    reason?: string;
  }> => { /* ... */ },
});
```

What it does, in order:

1. Resolves the model — `args.model ?? "anthropic/claude-haiku-4-5"` (the hardcoded default when omitted); throws `[cove] no model resolved for compaction` if `resolveModel` returns nothing.
2. Loads `SessionData` (`internal.sessions.store.load`) and builds **`buildContextEntries()`** — it needs the entry-paired view to map back to a persisted entry id.
3. Runs the pure `prepareCompaction(messages, settings)` (settings fall back to `DEFAULT_COMPACTION_SETTINGS` for any omitted arg).
4. Maps `prep.firstKeptIndex` back to a persisted entry id via `contextEntries[prep.firstKeptIndex]?.entry?.id`.
5. Summarizes the older slice with a **one-shot `generateText` call** (`SUMMARIZATION_SYSTEM_PROMPT` + `SUMMARIZATION_PROMPT`, with file-operation sections appended).
6. Appends a `CompactionEntry` via `internal.sessions.store.appendCompactionEntry`.

It returns `{ compacted: false, reason }` (it does **not** throw) in two no-op cases:

- `"nothing older than the retained tail"` — `prepareCompaction` returned `undefined`.
- `"cut point has no persisted entry"` — the computed cut point had no backing entry id.

On success it returns `{ compacted: true, firstKeptEntryId, tokensBefore }`.

> **Extensions can intervene.** An extension's `session_before_compact` hook (a content-mutation hook — see [Tools, Skills & Human-in-the-Loop — Extensions](04-tools-skills-hitl.md#extensions)) runs before a compaction commits. It can **cancel** the compaction (leaving the path untouched, a no-op) or **replace** the summary that would be produced. Use it to keep something the default summarizer would drop, or to skip compaction for a session that must retain its full history.

Drive it directly (internal action — call from the engine, a `convex run`, or another action):

```bash
# from the repo root
node node_modules/convex/bin/main.js run engine/compact:compact \
  '{ "sessionId": "<session id>", "keepRecentTokens": 8000 }'
```

> The Convex `appendCompactionEntry` mutation persists `summary`, `firstKeptEntryId`, `tokensBefore`, `details`, **and** the optional `usage` — the summarization call's token usage now round-trips through the append path and is recorded on the compaction entry for cost accounting. (`appendCompactionEntry` accepts an optional `usage` argument; omit it and the field is simply absent.)

### What a `CompactionEntry` does to context

A compaction is just another entry on the tree — a row with `kind: "compaction"` inserted at the leaf, with `leafId` advanced to it:

```ts
export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;        // must be an existing entry id, or the append throws
  tokensBefore: number;
  details?: { readFiles: string[]; modifiedFiles: string[] };
  usage?: PromptUsage;             // optional; persisted by the Convex append path
}
```

`appendCompactionEntry` **validates that `firstKeptEntryId` resolves to a real entry** before inserting — otherwise it throws `[cove] cannot compact: kept entry "<id>" not found`.

The behavioral change happens the next time context is built. **`buildContextEntries()` is the compaction boundary.** It walks the active path, finds the **latest** compaction entry, and serves:

```
[ synthesized user/context-summary message built from compaction.summary ]
[ the kept tail: entries from firstKeptEntryId up to the compaction ]
[ everything after the compaction ]
```

If there is no compaction on the path, it returns the whole path unchanged. So after compaction, the model sees a single summary message in place of everything older than `firstKeptEntryId`, plus the recent tail — the conversation continues seamlessly, but its token footprint drops. The summary message itself is built by `createContextSummaryMessage(compaction.summary, compaction.timestamp)`, which first renders the summary inside a `context_summary` signal — a `<compaction type="context_summary">…</compaction>` XML block via `renderSignalMessage()` — and only then wraps that rendered string as a user context message (`createUserContextMessage(renderSignalMessage(signal), timestamp)`). The model therefore sees the summary inside the `<compaction>` tags, not the raw `compaction.summary` passed directly to `createUserContextMessage`.

Because the boundary is recomputed from the tree on every context build (and `firstKeptEntryId` is a session entry id, not a Convex `_id` — typically a string like `u-<requestId>` for a canonical message entry, since the kept entry is a user/assistant turn; only auto-generated entries, such as compaction entries and in-memory `appendMessage` entries, use the short 8-char form), compactions compose: a later compaction's kept tail can include an earlier compaction's summary message, and `prepareCompaction`'s `previousCompaction` argument lets the summarizer extend the prior summary rather than start over.

---

## Recap

- A session is addressed by the tuple `(instanceId, harnessName, sessionName)` — there is no opaque public id.
- Multi-turn continuity is implicit: reuse the same tuple (`getOrCreate` is idempotent on it). A different name starts a fresh tree.
- Public surface is just `exists` (existence) and `remove` (cascade delete, refuses while a descendant is active, no-op when absent).
- Context is built from a parent-linked entry tree via `SessionHistory.buildContextEntries()`, which sanitizes incomplete/aborted turns.
- Compaction's decision is the pure `prepareCompaction`; the explicit `compact` action summarizes the older slice and appends a `CompactionEntry` (now including the summarization `usage`); `buildContextEntries()` then serves `[summary + retained tail]`. Compaction is **incremental** — a prior summary is carried forward with an UPDATE prompt, and a too-large turn's prefix is split out. The threshold auto-trigger is the documented remaining wire (P12), and `session.compact()` in the SDK still throws `not_implemented`.
- **Overflow recovery** is separate from the threshold: on a provider context-overflow the engine compacts and retries once, then finalizes the run as `failed` with reason `context_overflow` if it still doesn't fit. It runs even when `compaction: false`. An extension's `session_before_compact` hook can cancel or replace a compaction.

Next: [Subagents & Workflows](06-subagents-and-workflows.md) for the `task:*` child sessions, or [Deployment & Operations](08-deployment-and-operations.md) for running and driving the engine.
