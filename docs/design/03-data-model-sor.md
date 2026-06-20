# 03 — Data Model (System-of-Record)

The schema is the heart of the rewrite: it is both the **durable record** and the
**realtime transport**. Live definition:
[`cove-harness/convex/schema.ts`](../../convex/schema.ts).

Naming, the reference-header convention, the execution boundary, and the hardened
engine contracts this schema must honor all live in
[08 — Conventions & Execution Boundary](08-conventions-and-execution-boundary.md);
this doc does not restate them — it links into them where the table design depends
on a contract.

## Design principles

1. **Decompose the blob.** flue persisted `SessionData` (version 6) as one JSON
   blob holding an entry *tree* (see
   [`flue/packages/runtime/src/types.ts`](../../../flue/packages/runtime/src/types.ts)
   → `SessionData`/`SessionEntry`). Convex wants relational rows + indexes, so the
   header and the tree nodes are split into two tables.
2. **Rows are the stream.** Anything a client needs to watch live is a row that
   gets patched in place; a reactive query over it *is* the stream.
3. **Scalars in the journal, rich state in tables.** The workflow journal never
   holds messages — only ids and counters.
4. **External ids stay strings.** Convex `_id`/`_creationTime` are the primary
   key + sort key. LLM-issued `toolCallId`, flue `entryId`/`submissionId`, and the
   workflow `convexWorkflowId` are *not* Convex ids and stay plain strings.
5. **Bytes never travel by accident.** Image base64 is hoisted out of every entry
   into a content-addressed store and redacted out of the event log; only the
   model-context read path rehydrates it. See the image pipeline below and
   [08 § 4.8](08-conventions-and-execution-boundary.md#48-image-pipeline).

## Tables

### `sessions` — the SessionData *header*

One row per flue session. Key tuple `(instanceId, harnessName, sessionName)` —
flue addresses a session by name within a harness within a context (`ctx.id`).

| field | role |
| --- | --- |
| `instanceId`, `harnessName`, `sessionName` | the addressing tuple |
| `version` (6), `affinityKey`, `leafId`, `taskSessions[]`, `metadata` | the `SessionData` header fields |
| `state` (`idle`/`active`/`deleting`) | flue's per-session serialization + delete guard |
| `model`, `plan` (frozen) | default model + the resolved/frozen `AgentRuntimeConfig` snapshot |

Indexes: `by_instance_harness_session` (lookup), `by_instance` (cascade/list).

### `sessionEntries` — the entry *tree*

One row per `SessionEntry` (`MessageEntry | CompactionEntry`). flue's
`entries[]` is a parent-linked tree walked by
[`SessionHistory.getActivePath`](../../src/runtime/session-history.ts);
here nodes are flat rows and the active path is rebuilt in app logic after an
indexed load.

| field | role |
| --- | --- |
| `sessionId`, `entryId`, `parentId` | the tree links (`entryId`/`parentId` are flue-generated strings) |
| `position` | monotonic insertion order → stable, indexed ordered rebuild |
| `kind`, `data` | `message`/`compaction` + the full entry payload (**minus hoisted images**) |
| `imageAttachmentIds[]` | content hashes into `imageChunks` for hoisted image bytes |

Indexes: `by_session_and_position`, `by_session_and_entry`.

**Diff-sync.** `SessionStore.save(id, data)` does **not** rewrite the tree — it
appends only the new entries (the tree is append-only except `setLeaf` rewinds)
and patches the header's `leafId`. This keeps writes O(new entries), not
O(history).

### `agentRequests` — one submission/turn

One row per admitted `prompt`/`skill`/`task`/`compact`. Drives the workflow; the
caller awaits terminal `status`.

Lifecycle:

```
pending ──schedule──▶ running ──stop──▶ completed   (finishReason: stop; finalText/result set)
                         │     ──throw─▶ failed      (error set)
                         └──cancel/supersede/timeout─▶ cancelled (cancelReason set)
```

Carries `submissionId` (returned to the caller + correlates events),
`convexWorkflowId` (for `workflow.cancel`), and the structured `result` when the
caller passed `options.result`. Indexes: `by_session`,
`by_session_and_status` (the supersede/pending gate), `by_submission`,
`by_instance`.

**Result-schema rejection contract.** When `options.result` is set, the persisted
`result` is only ever a **validated** `T`. A run that gives up (the model called
the result tool's give-up branch) or that exhausts the re-nudge budget terminates
`failed` with reason `result_followups_exhausted` and the request carries **no**
`result` — the data layer never writes an unvalidated `data:T`. The CallHandle
correspondingly rejects with `ResultUnavailableError` (carrying the give-up
`reason` + assistant text) rather than resolving `PromptResultResponse<T>`. The
re-nudge bound (`maxFollowUps`, default 32) and terminal contract live in
[08 § 4.10](08-conventions-and-execution-boundary.md#410-result-tool-re-nudge--termination).

**Usage & cost.** Each loop step captures usage from the AI SDK result via
[`fromProviderUsage`](../../../flue/packages/runtime/src/usage.ts), which normalizes
pi-ai's `Usage` into the runtime's public `PromptUsage` (the shapes are identical
today, but the normalizer keeps the public surface decoupled from pi-ai). Steps
are folded with `addUsage` (`emptyUsage` is the identity element) into the request
rollups — `totalTokens`, `totalSteps`, `durationMs` — written at terminal time.
The aggregated `PromptUsage` is surfaced to callers and carried on the terminal
`CoveEvent`; **cost** is computed from the token rollup (model-rate driven, the
nested `cost` sub-object on `PromptUsage`). Contract values in
[08 § 4.7](08-conventions-and-execution-boundary.md#47-usage--cost).

> **Persisted field-name divergence.** The persisted rollup on `agentRequests`
> stores token counts as `inputTokens`/`outputTokens`, whereas the public
> `PromptUsage` surface names them `input`/`output`. The mapping is intentional
> and one-directional (persisted ⇒ public via the `PromptUsage` projection); the
> persisted `cost` and cache fields (e.g. cached/cache-write tokens) are carried
> through verbatim from the per-step `PromptUsage` so the terminal projection can
> reconstruct the full public shape without recomputation. See the canonical
> field map in [08 § 4.7](08-conventions-and-execution-boundary.md#47-usage--cost).

### `agentRequestSteps` — the streaming substrate

**This table is the SSE replacement.** One row per agent-loop step. While the
model streams, `text`/`reasoning` are patched ~10–20× per turn by the delta
batcher; when the step ends, the structured fields fill atomically with
`isFinalized: true`.

| field | role |
| --- | --- |
| `requestId`, `stepNumber`, `isFinalized` | identity + in-flight flag |
| `text`, `reasoning` | streaming channels (patched in place) |
| `finishReason`, `toolCalls[]`, `toolResults[]`, `responseMessages[]` | finalized step data |
| `usage`, `model`, `durationMs`, `error` | per-step telemetry (`usage` is the per-step `PromptUsage` folded into the rollup above) |

`toolResults` grows as each tool completes and is **idempotent on `toolCallId`**
(replace-in-place, not append) — so a step replay never double-writes a result.
The finalized step row is also the replay source of truth — see
[08 § 4.1](08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical).
Index: `by_request_and_step`.

### `runs` — top-level inspection

Backs `getRun`/`listRuns`/`listAgents`. One row per top-level run: `runId`,
`agentName`, `instanceId`, `status`, `payload`/`result`/`error`,
`convexWorkflowId`. A `kind: 'agent' | 'workflow'` discriminator distinguishes the
two run senses — agent runs (a submission's `agentRun` workflow) from
`defineWorkflow` runs invoked via `POST /workflows/:name` (restored as a
first-class construct per [D18](07-risks-and-decisions.md)). This resolves the
prior `agentName`-only keying, which conflated an agent's run with a named
workflow run; `kind` lets `getRun`/`listRuns` page either sense without ambiguity.
Indexes: `by_run`, `by_agent`, `by_instance`.

### `events` — durable + reactive event log

The `CoveEvent` stream and the `observe()` substitute. `seq` is monotonic per
`streamKey` (`runId` | `instanceId` | `${instanceId}:${session}`); native clients
read reactively, HTTP/SDK callers page by `seq`. Image content blocks keep
`mimeType` but carry the `IMAGE_DATA_OMITTED` sentinel — events **never** carry raw
bytes (matching flue; see the image pipeline below). Indexes:
`by_stream_and_seq`, `by_submission`.

**Grouping ids (`operationId`/`turnId`).** Both are opaque correlation ids
generated on the `events`/`agentRequestSteps` write path, *not* table keys. An
`operationId` is minted 1:1 with the `submissionId` (one per admitted
`prompt`/`skill`/`task`/`compact`) and stamps every event for that operation. A
`turnId` is minted per LLM turn — at each `llmStep` entry, alongside the
`agentRequestSteps` insert — and stamped into `events.data` so a turn's deltas and
tool events group together. Both are deliberately distinct from the structural
`(requestId, stepNumber)` step key: `turnId ≠ (requestId, stepNumber)` (a turn is
the unit a consumer groups by; the step key is the replay coordinate per
[08 § 4.1](08-conventions-and-execution-boundary.md#41-llmstep-replay-determinism-critical)).

### `approvals` — HITL (new)

A parked approval-gated tool call. The workflow awaits a decision; the UI renders
an approval card from `args`; `submitApproval` flips `status` and wakes the run.
Indexes: `by_request_and_status`, `by_session_and_status`, `by_toolCall`. See
[04 — The Durable Engine](04-durable-engine.md#hitl) and the HITL state-machine
contract in [08 § 4.4](08-conventions-and-execution-boundary.md#44-hitl-state-machine).

### `skills` — knowledge catalog

`slug`/`name`/`description`/`instructions`/`references[]`/`requiredTools[]`,
soft-deleted via `isActive`, idempotent on `contentHash`. Read by the skill tool
at runtime. Indexes: `by_slug`, `by_isActive`.

### `imageChunks` — content-addressed image store

flue hoists image bytes out of entries and dedups them; Cove keeps that pipeline
intact and backs it with one Convex table. Each distinct image is one row keyed by
content `hash`; entries (`imageAttachmentIds[]`) and submissions reference it by
hash. Live shape (`hash`, `mediaType`, `data?`, `storageId?`, `refCount`,
`createdAt`); index `by_hash`. Full pipeline and contract:
[08 § 4.8](08-conventions-and-execution-boundary.md#48-image-pipeline).

**The write path (entry persistence).** Before any entry is stored,
[`assertImagesWithinLimit`](../../../flue/packages/runtime/src/persisted-images.ts)
rejects any image whose base64 exceeds `MAX_IMAGE_DATA_LENGTH` (a fail-loud
persistence invariant applied at the operation entry points — `prompt`/`skill`/
`task` — so an oversized image never lands an unsaveable entry in history).
`extractImageBlocks` then **hoists** every `{type:"image"}` block's base64 out of
the entry, replacing it in-place with a marker (`__flue_image_chunks__:<id>`) and
emitting the bytes as `PersistedImageChunk`s sliced into `IMAGE_DATA_CHUNK_LENGTH`
(256 KB) pieces. The stripped entry goes to `sessionEntries.data`; the bytes are
deduped into `imageChunks` by content `hash` (a re-used image just bumps an
existing row).

- **`refCount`** tracks how many entries reference a hash. The session-delete
  cascade **decrements** it per referenced hash; a row dropping to zero is the
  signal to reclaim its bytes (and any `_storage` object).
- **Inline vs. `_storage` threshold:** images **≲ 100 KB** live inline as base64
  in `imageChunks.data`; **larger** images move to Convex `_storage` (`storageId`),
  keeping row sizes bounded and large blobs off the hot read path.

**The read path (model context).** When the engine assembles model context it
loads the entry plus its `imageChunks` rows and calls
[`hydratePersistedSessionEntry`](../../../flue/packages/runtime/src/persisted-image-placement.ts),
which reassembles the chunked bytes and swaps each marker back for the original
base64. Hydration asserts the marker set and the persisted chunk groups match
exactly (fail-loud on a missing or extra chunk). **Only this path** rehydrates
bytes — entries persist stripped, and they stay stripped everywhere except live
model context.

**The event path (never carries bytes).**
[`redactEventImages`](../../../flue/packages/runtime/src/event-redaction.ts) rewrites
every image block in an outgoing event to the `IMAGE_DATA_OMITTED` sentinel
(copy-on-write — the live harness message objects are never mutated, since they
*are* the model context). So `events` rows keep an image's presence and `mimeType`
but never its payload, matching flue's contract that the event/observe stream and
persisted run history retain no image bytes.

### `meta` — schema version / kv

`migrate()` is a no-op under Convex's declarative schema; `meta` holds the format
version and any small kv the runtime needs. Index: `by_key`.

## Lifecycles at a glance

**A turn (prompt → answer):**

```
invoke.submitPrompt (mutation)
  └─ assertImagesWithinLimit (reject oversized images, fail-loud)
  └─ insert agentRequests {status: pending}
  └─ schedule agentRun workflow, store convexWorkflowId
agentRun:
  setup        → freeze plan onto request/session
  llmStep      → insert agentRequestSteps {isFinalized:false}
               → patch text/reasoning (delta-batched)   ← clients see tokens live
               → finalize step {toolCalls, usage, isFinalized:true}
  dispatchTools→ per tool: patch toolResults[toolCallId] (idempotent)
  (loop until finishReason: stop)
  finalize     → extractImageBlocks → append assistant entries to sessionEntries,
                 dedup image bytes into imageChunks (refCount++)
               → patch agentRequests {status: completed, finalText,
                 usage rollups (addUsage of per-step PromptUsage)}
```

**A session delete (cascade):** walk `taskSessions` depth-first, reject if any
descendant request is `pending`/`running`, then delete `sessionEntries` +
`sessions` rows and **decrement** `imageChunks.refCount` per referenced hash
(rows hitting zero reclaim their inline `data` or `_storage` object).
