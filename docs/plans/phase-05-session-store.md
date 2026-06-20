# Phase 5 — Session store over Convex
> Realize flue's `SessionStore` contract as Convex `sessions/` mutations + queries: header upsert, append-only entry diff-sync, the content-addressed image pipeline, cascade delete, and the per-session state guard. Design-of-record: [06 — Roadmap](../design/06-phase-roadmap.md) (Phase 5) + [03 — Data Model](../design/03-data-model-sor.md), [04 — Durable Engine](../design/04-durable-engine.md), [08 — Conventions & Execution Boundary](../design/08-conventions-and-execution-boundary.md). Decisions: [D1–D19](../design/07-risks-and-decisions.md) (esp. [D5](../design/07-risks-and-decisions.md), [D13](../design/07-risks-and-decisions.md)).

## Goal & scope

Decompose flue's `SessionData` v6 blob into the relational Convex tables already
declared in [`convex/schema.ts`](../../convex/schema.ts) (`sessions`,
`sessionEntries`, `imageChunks`) and expose flue's `SessionStore.{save,load,delete}`
contract as Convex functions the durable engine (P4) consumes. Concretely this phase
delivers:

- **`convex/sessions/`** — `getOrCreate` / `get` / `create` / `delete` mutations + the
  `SessionStore.save` / `load` internal functions that the engine's `setup` and
  `llmStep`/`finalize` call (`internal.sessions.load` is invoked verbatim in the
  [04 §llmStep](../design/04-durable-engine.md) sketch: `ctx.runQuery(internal.sessions.load, { sessionId })` → `SessionHistory.fromData(data)`).
- **`save` = header upsert + entry-tree diff-sync + image-chunk replace** — append only
  the new/changed entries (O(new), not O(history)), patch `sessions.leafId`, and
  reconcile hoisted image bytes by content hash with `refCount` accounting. Ported from
  flue's `SqlSessionStore.save` ([`sql-agent-execution-store.ts`](../../../flue/packages/runtime/src/sql-agent-execution-store.ts)),
  re-keyed from per-owner chunks onto Cove's content-addressed `imageChunks` table.
- **`load` = header read + ordered entry rebuild + hydration** — read the header,
  load `sessionEntries` by `(sessionId, position)`, and `hydratePersistedSessionEntry`
  each entry from its referenced `imageChunks` rows. Ported from `SqlSessionStore.load`.
- **Cascade delete** over `taskSessions` — walk the `TaskSessionRef` tree depth-first,
  **reject while any descendant request is `pending`/`running`**, then delete entries +
  session rows and **decrement `imageChunks.refCount`** per referenced hash (rows hitting
  zero reclaim inline `data` or the `_storage` object).
- **State guard** — the `sessions.state` (`idle`/`active`/`deleting`) gate for flue's
  per-session serialization + the delete guard.
- **Image pipeline §4.8** — port flue's pure `extractImageBlocks` /
  `assertImagesWithinLimit` / `hydratePersistedSessionEntry` /
  `redactEventImages` logic into `src/runtime/` (no Convex deps), and build the Convex
  persistence layer around it: hoist base64 out of entries → chunk
  (`IMAGE_DATA_CHUNK_LENGTH`) → content-address into `imageChunks` (dedup by `hash`,
  `refCount`) → **~100 KB inline threshold** → spill larger payloads to Convex `_storage`.

**Out of scope** (other phases): the engine loop that *calls* save/load (P4, co-developed);
admission/supersede gate and `invoke/*` (P6); subagent spawning that *creates* task sessions
(P6, though the cascade-delete that *consumes* `taskSessions` lands here); compaction entry
append from a summarization step (P12 — `appendCompaction` already exists on the ported
`SessionHistory`); HITL (P7); event-log writes + `redactEventImages` *call sites* (P9 owns
the event path, but the pure redaction helper is ported here so §4.8 is complete in one place).

## Dependencies

- **P1 (landed)** — supplies the pure `SessionHistory`
  ([`src/runtime/session-history.ts`](../../src/runtime/session-history.ts)),
  `SessionData` / `SessionEntry` / `TaskSessionRef` / `SessionStore` / `PromptImage`
  types ([`src/runtime/types.ts`](../../src/runtime/types.ts)), the `[cove]` error
  prefix, and the schema ([`convex/schema.ts`](../../convex/schema.ts) — `sessions`,
  `sessionEntries`, `imageChunks`, `agentRequests` tables are already defined). **This
  phase writes no new schema tables** — it only reads/writes existing ones.
- **P4 (co-developed)** — the durable engine is the primary consumer of
  `internal.sessions.load` / `save`. Per [06](../design/06-phase-roadmap.md) "P4 and P5
  are co-developed; the loop needs `sessions.load`/`save`." Build the store first so P4
  has stable signatures; the context-rebuild parity test in P4 exercises `load` →
  `SessionHistory.buildContext()`.
- **Not required:** P2 (sandbox), P3 (providers). The session store is **box-free and
  provider-free** — it is pure SOR persistence ([08 §3](../design/08-conventions-and-execution-boundary.md#which-convex-functions-may-touch-the-sandbox): `sessions/*` mutations/queries never touch the box).

## Deliverables

| file | purpose |
| --- | --- |
| `src/runtime/persisted-images.ts` | **Ported pure logic.** `extractImageBlocks` (hoist base64 → marker `__cove_image_chunks__:<id>`), `assertImagesWithinLimit`, `MAX_IMAGE_DATA_LENGTH` (re-exported from a ported `schemas` const), `IMAGE_DATA_CHUNK_LENGTH = 256*1024`, `PersistedImageChunk`. No Convex deps. |
| `src/runtime/persisted-image-placement.ts` | **Ported pure logic.** `extractSessionEntryImages` / `prepareSessionEntry`, `hydrateSessionEntryImages` / `hydratePersistedSessionEntry`, `reassemblePersistedChunks` (fail-loud on missing/extra chunk), `samePersistedChunks`. No Convex deps. |
| `src/runtime/event-redaction.ts` | **Ported pure logic.** `redactEventImages` + `IMAGE_DATA_OMITTED` sentinel (copy-on-write; never mutates live message objects). Completes §4.8 in `src/runtime`; the event-write *call site* is P9. |
| `src/runtime/session-identity.ts` | **Ported pure logic.** `assertPublicSessionName`, `createTaskSessionName`, `createSessionStorageKey`, `childTaskSessionStorageKey`, `TASK_SESSION_PREFIX`. Used by the cascade walk + the `getOrCreate` reservation guard. |
| `src/runtime/index.ts` (edit) | Re-export the four new pure modules from the `@cove/runtime` barrel (extend the existing P1 export block). |
| `convex/sessions/store.ts` | **The core.** `load` (internalQuery), `save` (internalMutation), header/entry/image reconciliation helpers. The Convex realization of `SqlSessionStore.{save,load}`. |
| `convex/sessions/mutations.ts` | `getOrCreate` / `create` / `get` / `delete` (public-ish admission-adjacent mutations + queries) + the `state`-guard helpers (`acquireSessionState` / `releaseSessionState`). |
| `convex/sessions/cascade.ts` | `deleteSessionCascade` — depth-first walk over `taskSessions`, active-descendant rejection, entry + header deletion, `imageChunks.refCount` decrement + reclaim. |
| `convex/sessions/images.ts` | The Convex image-persistence layer: `putImageChunks` (dedup-by-hash insert / `refCount++`, ~100 KB inline-vs-`_storage` decision), `readImageChunksForEntry`, `releaseImageHashes` (`refCount--` + reclaim). Bridges the pure `PersistedImageChunk`s onto `imageChunks` rows. |
| `convex/sessions/index.ts` | Barrel re-export of the public function references used by the engine + invoke layers. |
| `convex/sessions/store.test.ts` | The per-phase store contract test (save/load round-trip, O(new) append, image round-trip + refCount, cascade reject/decrement, state guard). Consolidated into the P12 Session-store contract harness. |

## Source map (flue/pi → cove)

| flue/pi file (verified) | target cove file | port / transform notes |
| --- | --- | --- |
| [`packages/runtime/src/persisted-images.ts`](../../../flue/packages/runtime/src/persisted-images.ts) | `src/runtime/persisted-images.ts` | Copy `extractImageBlocks` / `assertImagesWithinLimit` / chunk slicing verbatim. **Rename marker `__flue_image_chunks__:` → `__cove_image_chunks__:`** and `[flue]` → `[cove]`. Import `MAX_IMAGE_DATA_LENGTH` from a ported `schemas` const (flue value `14*1024*1024`). |
| [`packages/runtime/src/persisted-image-placement.ts`](../../../flue/packages/runtime/src/persisted-image-placement.ts) | `src/runtime/persisted-image-placement.ts` | Copy `prepareSessionEntry` / `hydratePersistedSessionEntry` / `reassemblePersistedChunks` / `samePersistedChunks`. **Drop** the `DirectAgentSubmission*` helpers (flue's `agent-submissions` machinery is dropped, [D5](../design/07-risks-and-decisions.md)) — keep only the `SessionEntry` path. Keep `PersistedChunkRow` shape. |
| [`packages/runtime/src/runtime/schemas.ts`](../../../flue/packages/runtime/src/runtime/schemas.ts) (`MAX_IMAGE_DATA_LENGTH`) | `src/runtime/persisted-images.ts` (const) | Port only the `MAX_IMAGE_DATA_LENGTH = 14*1024*1024` const (flue defines it via valibot `maxLength`; we just need the number + the assert). Do **not** port the whole valibot schema module. |
| [`packages/runtime/src/event-redaction.ts`](../../../flue/packages/runtime/src/event-redaction.ts) | `src/runtime/event-redaction.ts` | Copy `redactEventImages` + `IMAGE_DATA_OMITTED` verbatim (copy-on-write). `[flue]`→`[cove]`. |
| [`packages/runtime/src/session-identity.ts`](../../../flue/packages/runtime/src/session-identity.ts) | `src/runtime/session-identity.ts` | Copy `createTaskSessionName` / `assertPublicSessionName` / `createSessionStorageKey` / `childTaskSessionStorageKey`. `[flue]`→`[cove]`. The storage-key string is now just the `(instanceId, harnessName, sessionName)` lookup tuple — Cove keys the row by the schema index, not the JSON string, so `createSessionStorageKey` becomes a cascade-walk helper, not the primary key. |
| [`packages/runtime/src/sql-agent-execution-store.ts`](../../../flue/packages/runtime/src/sql-agent-execution-store.ts) → `SqlSessionStore.save` | `convex/sessions/store.ts` `save` | **Transform, not copy.** flue's transaction → one Convex `internalMutation` body (Convex mutations are transactional). `flue_sessions` upsert → `sessions` header patch; `flue_session_entries` diff-sync → `sessionEntries` diff-sync (retained-set + delete-missing). `prepareSessionEntry` stays; the per-owner chunk replace re-targets the content-addressed `imageChunks` table (see `convex/sessions/images.ts`). |
| `SqlSessionStore.load` (same file) | `convex/sessions/store.ts` `load` | Read `sessions` header by id; read `sessionEntries` via `by_session_and_position`; `hydratePersistedSessionEntry` each from `imageChunks` rows resolved by the entry's `imageAttachmentIds[]`. Returns a `SessionData` (v6) for `SessionHistory.fromData`. |
| `SqlSessionStore.delete` + `AgentSubmissionStoreImpl.deleteSession` (active-guard + receipt-retain phases) | `convex/sessions/cascade.ts` | Port the **active-submission rejection** (flue: "reject when any submission is queued or running") onto an `agentRequests.by_session_and_status` scan for `pending`/`running`. Drop the lease/turn-journal/stream-chunk/receipt machinery ([D5](../design/07-risks-and-decisions.md), [08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)). Add the `taskSessions` depth-first walk (no flue analogue at the SQL layer — flue walks it in `session.ts`). |
| [`packages/runtime/src/sql-persisted-chunk-store.ts`](../../../flue/packages/runtime/src/sql-persisted-chunk-store.ts) | `convex/sessions/images.ts` | **Re-keyed.** flue keys chunks by `(owner_kind, owner_id, owner_part, image_id, chunk_index)` with no dedup. Cove keys by content `hash` with `refCount` dedup + `_storage` spill. So `replace(owner, chunks)` → `putImageChunks(entryImages)` (hash each image's reassembled bytes, dedup, ref-count); `read(owner)` → `readImageChunksForEntry(imageAttachmentIds)`; `deleteOwner` → `releaseImageHashes(hashes)`. Keep the chunk-slicing shape so `hydratePersistedSessionEntry` still consumes `PersistedChunkRow[]`. |
| [`packages/runtime/src/session.ts`](../../../flue/packages/runtime/src/session.ts) (session lifecycle, `taskSessions` append/walk) | `convex/sessions/*` (reference) | Reference for the `state`/serialization semantics and the parent→child `TaskSessionRef` linkage. The facade itself lands in P6; here we port only the **persistence** half. |
| [`src/runtime/session-history.ts`](../../src/runtime/session-history.ts) (already ported) | consumed by `store.ts` | `SessionHistory.fromData` / `toData` are the in/out boundary of `load`/`save` — the store reconstructs the flat `SessionData` the pure class expects; **the engine** (P4) wraps it in `SessionHistory`. Note `toData(affinityKey, taskSessions, metadata, createdAt, updatedAt)` is the exact shape `save` deconstructs. |

## Hardened-contract obligations

- **[08 §3](../design/08-conventions-and-execution-boundary.md#which-convex-functions-may-touch-the-sandbox) — `sessions/*` is box-free.** Every function here is a query or mutation; **none** may import `@upstash/box`, take a `SessionEnv`, or be `"use node"`. They are pure SOR persistence. (This is the single biggest boundary rule for this phase.)
- **[08 §4.8](../design/08-conventions-and-execution-boundary.md#48-image-pipeline) — image pipeline (the contract this phase owns end-to-end).**
  - `assertImagesWithinLimit(MAX_IMAGE_DATA_LENGTH)` is a **fail-loud** invariant applied at the operation entry points (the actual `prompt`/`skill`/`task` admission is P6, but the **assert helper and the persistence-layer re-check inside `extractImageBlocks` land here** so an oversized image never lands an unsaveable entry).
  - `extractImageBlocks` hoists base64 → marker; `IMAGE_DATA_CHUNK_LENGTH` chunking preserved.
  - `imageChunks` is **content-addressed by `hash`**, carries `refCount`, and the delete cascade **decrements** it; a row dropping to zero reclaims bytes (inline `data` or `_storage` object).
  - **Inline threshold ~100 KB**: images ≲ 100 KB live inline as base64 in `imageChunks.data`; larger spill to Convex `_storage` (`storageId`).
  - `hydratePersistedSessionEntry` on read; **fail-loud** if the marker set and persisted chunk groups don't match exactly (missing or extra chunk).
  - The event path **never carries bytes** — `redactEventImages` → `IMAGE_DATA_OMITTED` (ported here; called in P9).
- **[08 §4.3](../design/08-conventions-and-execution-boundary.md#43-cancel-short-circuit) / [D5](../design/07-risks-and-decisions.md) — delete blocks on active work.** The cascade **rejects while any descendant `agentRequests` is `pending` or `running`** (flue's "queued or running" guard), surfaced via `sessions.state = "deleting"` so new admissions (P6) see the guard. flue's lease/turn-journal/attempt/stream-chunk/receipt machinery is **dropped** ([08 §5](../design/08-conventions-and-execution-boundary.md#5-dropped--obsolete-explicit)) — `@convex-dev/workflow` owns recovery.
- **Per-session serialization (flue semantics).** The `sessions.state` field (`idle`/`active`/`deleting`) is flue's per-session op gate. This phase delivers the **state transitions + guard helpers**; the supersede/serialize *admission* decision is P6's `by_session_and_status` gate — keep the two layered, not conflated.
- **Reference-header convention ([08 §2](../design/08-conventions-and-execution-boundary.md#2-reference-header-convention)).** Every new file opens with its origin header. Ported pure files cite the flue source + `@flue/runtime` → `@cove/runtime`; the `convex/sessions/*` files cite the SQL store they realize and say "New (Convex backend)" where there is no 1:1 flue function (e.g. the content-addressed `imageChunks` re-keying, the `taskSessions` cascade).

## Implementation tasks

Ordered; each step keeps `tsc --noEmit` green.

1. **Port the pure image modules into `src/runtime/`.**
   - [ ] `src/runtime/persisted-images.ts` — copy `extractImageBlocks` / `assertImagesWithinLimit` / `PersistedImageChunk` / `IMAGE_DATA_CHUNK_LENGTH`; define `MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024` locally (don't pull in valibot). Rename marker prefix to `__cove_image_chunks__:` and all `[flue]` → `[cove]`. Reference-header cites `packages/runtime/src/persisted-images.ts`.
   - [ ] `src/runtime/persisted-image-placement.ts` — copy `prepareSessionEntry` / `hydratePersistedSessionEntry` / `reassemblePersistedChunks` / `samePersistedChunks` / `PersistedChunkRow`. **Delete the `DirectAgentSubmission*` branch** entirely (dropped machinery). Keep the fail-loud `assertExactImageGroups` + `reassemblePersistedChunks` malformed-chunk guards.
   - [ ] `src/runtime/event-redaction.ts` — copy `redactEventImages` + `IMAGE_DATA_OMITTED` (copy-on-write).
   - [ ] `src/runtime/session-identity.ts` — copy the task-name + storage-key helpers.
   - [ ] Extend `src/runtime/index.ts` to export the four modules. Run `tsc --noEmit`.

2. **Image persistence layer — `convex/sessions/images.ts` (the trickiest divergence from flue).**
   - [ ] `hashImageBytes(mediaType, base64) → hash` — content hash over `mediaType + bytes` (use a stable algorithm available in the Convex V8 runtime, e.g. a SHA-256 over the bytes; do **not** depend on Node `crypto`). The hash is the dedup + reclaim key.
   - [ ] `putImageChunks(ctx, images: {mediaType, data}[]) → hashes: string[]` — for each image: compute `hash`; query `imageChunks.by_hash`; if present, `refCount++` and return the hash; else insert a new row. **Inline vs `_storage`:** if `data.length ≲ 100 KB` store inline in `data`; else `ctx.storage.store(blob)` and set `storageId`, leaving `data` unset. `refCount` starts at 1.
   - [ ] `readImageChunksForEntry(ctx, hashes) → Map<imageId, base64>` — load each `imageChunks` row by hash; for `_storage`-backed rows `ctx.storage.get(storageId)` and read bytes; return data keyed so `hydratePersistedSessionEntry` can reassemble (see task 4 for the marker-id ↔ hash mapping).
   - [ ] `releaseImageHashes(ctx, hashes)` — `refCount--` per hash; when it hits 0, delete the row **and** `ctx.storage.delete(storageId)` if present.
   - [ ] **Tricky bit — marker-id ↔ content-hash bridge.** flue's `extractImageBlocks` numbers images `0,1,2…` *per entry* (`imageId`), and `hydratePersistedSessionEntry` expects a `Map<imageId, data>`. Cove dedups across entries by *hash*. So `save` must record, per entry, an **ordered list of hashes** in `sessionEntries.imageAttachmentIds[]` (index = the entry-local `imageId`), and `load` rebuilds the `Map<imageId,data>` by zipping `imageAttachmentIds[i] → hash → bytes`. Keep `IMAGE_DATA_CHUNK_LENGTH` chunking *inside* the inline `data` string only if you choose to store chunked; simplest correct path: store the **whole reassembled base64** per hash (inline or `_storage`) and let `hydratePersistedSessionEntry` see a single-chunk `PersistedChunkRow` (`{imageId, index:0, count:1, data}`). Document this in the file header.

3. **Cascade + state guard — `convex/sessions/cascade.ts` + `convex/sessions/mutations.ts`.**
   - [ ] `acquireSessionState(ctx, sessionId, to: "active"|"deleting")` / `releaseSessionState(ctx, sessionId)` — patch `sessions.state`; reject acquiring `active`/`deleting` when already `deleting`. These are the per-session serialization primitives P6's admission uses.
   - [ ] `getOrCreate(ctx, {instanceId, harnessName, sessionName, ...})` — `assertPublicSessionName(sessionName)` (reject `task:` for user sessions); look up `by_instance_harness_session`; create with `version:6`, a fresh `affinityKey` (`aff_<ULID>` matching the `/^aff_[0-7][0-9A-HJKMNP-TV-Z]{25}$/` regex in `SessionHistory.fromData`), empty `taskSessions`, `state:"idle"`, `leafId:null` if absent; return the row id + whether it was created.
   - [ ] `create` / `get` — thin wrappers (`get` returns the header; entries via `load`).
   - [ ] `deleteSessionCascade(ctx, sessionId)` — (1) set `state:"deleting"`; (2) DFS over `taskSessions` resolving each child via `createSessionStorageKey`/the index lookup; (3) for the node **and every descendant**, scan `agentRequests.by_session_and_status` for `pending`/`running` — if any, **throw `[cove] Session cannot be deleted while requests are pending/running`** and revert `state` to `idle` (fail-loud, matches flue's marker-removal-on-failure); (4) on the clean path, collect all referenced image hashes from the entries, delete `sessionEntries` then `sessions` rows bottom-up, and `releaseImageHashes(allHashes)`.
   - [ ] `delete` public mutation wraps `deleteSessionCascade`.

4. **The store — `convex/sessions/store.ts`.**
   - [ ] `load` (internalQuery, args `{ sessionId }`): read the `sessions` header; if missing return `null`. Read `sessionEntries` by `by_session_and_position` ascending. For each entry row: resolve `imageAttachmentIds[] → hashes`, `readImageChunksForEntry` → `PersistedChunkRow[]`, `hydratePersistedSessionEntry(entry.data, rows)`. Assemble and return the full `SessionData` (`{version:6, affinityKey, entries, leafId, taskSessions, metadata, createdAt, updatedAt}`). **Note:** `load` reads `_storage`, so if any image spilled to storage, `load` must be an **action or use `ctx.storage` in a query** — confirm: Convex `query` ctx **cannot** read storage. ⚠ See Risks: if storage-backed images must be hydrated on the model-context read path, `load` (or a sibling `loadForContext`) is an **internalAction** that runs queries for rows + reads storage. The engine's `llmStep` (an action) calls it, so an action-typed `load` is compatible with the [04 §llmStep](../design/04-durable-engine.md) call site (`ctx.runQuery` there becomes `ctx.runAction` for the storage path, or split: a row-only query + an in-action storage hydrate). Decide and document.
   - [ ] `save` (internalMutation, args `{ sessionId, data: SessionData }`): deconstruct `const { entries, ...header } = data`. (a) Patch the `sessions` header (`leafId`, `taskSessions`, `metadata`, `updatedAt`, `affinityKey` immutable after create). (b) **Diff-sync entries:** load existing `sessionEntries` by session into a `Map<entryId,row>`; for each incoming entry at `position`: `prepareSessionEntry(entry)` → `{value, chunks}`; compute the entry's image hashes via `putImageChunks`; compare `(position, JSON(value), hashes)` to the existing row — if unchanged, skip (the **O(new)** fast path); if new/changed, upsert the `sessionEntries` row (`data:value`, `imageAttachmentIds:hashes`) and, when the hash set changed, `releaseImageHashes(oldHashes)` for any dropped hashes. (c) **Delete-missing:** any existing entry whose `entryId` is not in the incoming set is removed and its hashes released (handles `setLeaf` rewinds that prune a branch). Mirror flue's `retained`-set logic exactly.
   - [ ] Keep `save` writes **idempotent on replay** — re-running `save` with the same `data` must converge to the same rows and the **same `refCount`** (the diff-sync skip path guarantees no double-increment; assert this in the test).

5. **Barrels + wiring.**
   - [ ] `convex/sessions/index.ts` re-exports the function references the engine/invoke layers import (`load`, `save`, `getOrCreate`, `delete`, the state helpers).
   - [ ] Confirm no `convex/sessions/*` file imports anything `"use node"` or box-related.

6. **Tests — `convex/sessions/store.test.ts`** (per-phase; rolled into P12 Session-store contract harness).
   - [ ] save→load byte-faithful round-trip of a `SessionData` v6 (deep-equal after `SessionHistory.fromData(load(...)).toData(...)`).
   - [ ] O(new) append: save N entries, then save N+1 — assert only one `sessionEntries` insert/patch occurred (instrument via a write counter or compare row `_creationTime`/`updatedAt`).
   - [ ] image round-trip + refCount: an entry with an image hoists into `imageChunks` (`refCount:1`); a second entry reusing the same image bytes bumps `refCount:2`; deleting one entry decrements to 1; deleting the session releases to 0 and reclaims.
   - [ ] `_storage` spill: an image > 100 KB lands in `_storage` (`storageId` set, `data` unset) and hydrates back byte-faithfully on `load`.
   - [ ] cascade reject: a session with a `pending`/`running` `agentRequests` row rejects delete and leaves `state` recoverable (`idle`).
   - [ ] cascade decrement: deleting a parent with a `task:*` child removes both and decrements shared image hashes correctly.
   - [ ] state guard: acquiring `active` on a `deleting` session rejects.

## Acceptance

Pass/fail bar (from [06 Phase 5 acceptance](../design/06-phase-roadmap.md) + coverage-audit additions):

- **Round-trip fidelity.** `save(id, data)` then `load(id)` returns a `SessionData` v6 that is **byte-faithful** to the input (entries, `leafId`, `affinityKey`, `taskSessions`, `metadata` all preserved; `SessionHistory.fromData(load(...))` rebuilds the same active path).
- **Append is O(new).** Saving a session that grew by one entry writes **one** entry row (plus the header patch), not a full tree rewrite — verified by a write-count assertion, not prose.
- **Image lifecycle.** An image entry round-trips through `extractImageBlocks` → `imageChunks` → `hydratePersistedSessionEntry` with **correct `refCount` on add (dedup bumps, not duplicates) and on delete (decrement + zero-reclaim)**. An image > ~100 KB spills to `_storage` and hydrates back identically.
- **Cascade delete.** Deleting a parent session cascades to its `task:*` children and **rejects while any descendant `agentRequests` is `pending`/`running`**, reverting `state` to a usable value on rejection.
- **State guard.** A second concurrent op on a `deleting` (or actively-held) session is rejected by the `sessions.state` gate.
- **Replay idempotence.** Re-invoking `save` with identical `data` converges to identical rows and **unchanged `refCount`** (no double-increment) — the diff-sync skip path holds.
- **Boundary.** No `convex/sessions/*` file is `"use node"` or imports the box / a provider (grep-asserted in review).
- **Build.** `tsc --noEmit` exits 0 after every task; the per-phase `store.test.ts` passes (and slots into the P12 Session-store contract harness unchanged).

## Risks & gotchas

- **⚠ `query` ctx cannot read `_storage`.** Convex **queries** have no `ctx.storage` read; only **actions** (and mutations, for `store`/`delete`, not `get`) touch storage. Because images > 100 KB live in `_storage`, the **hydrating** `load` cannot be a plain `internalQuery` if it must return bytes. Resolution options (pick one, document in `store.ts`): (a) make the hydrating path an **`internalAction`** (`loadForContext`) that runs a row-only query then reads storage — the engine's `llmStep` is already an action, so this is compatible with the [04 §llmStep](../design/04-durable-engine.md) call site; (b) keep `load` a query that returns entries with **storage-backed images still as markers** + a side list of `storageId`s, and have the caller (action) hydrate. **Recommendation:** ship a row-only `load` query (used by cheap reads) **and** a `loadForContext` action used by `llmStep`. Keep inline-only images fully hydratable from the query for the common case.
- **Content-address re-keying vs flue's per-owner chunks.** flue keyed chunks by owner+`imageId` with no dedup; Cove dedups by content `hash` with `refCount`. The **marker `imageId` is entry-local and ordinal**, so `save` must persist an **ordered hash list** in `imageAttachmentIds[]` and `load` must zip `imageId → imageAttachmentIds[imageId] → hash → bytes`. Getting this mapping wrong silently swaps images between attachments — the round-trip test must assert **byte identity per attachment slot**, not just presence.
- **`refCount` double-increment on replay.** Convex retries a mutation on conflict; a naive `save` that always `refCount++` would inflate counts. The diff-sync **skip path** (unchanged entry → no image work) is the guard — only ref/unref when an entry's hash set actually changes. Test the replay-of-identical-`save` case explicitly.
- **`refCount` decrement must be hash-set-accurate on entry *edit*.** A `setLeaf` rewind or a branch prune removes entries; their hashes must be released, but only for hashes **no longer referenced by any surviving entry**. Compute the release set as `oldHashes − stillReferencedHashes`, not blindly `oldHashes`, or you'll reclaim a still-live image.
- **Cascade ordering.** Delete children before parents (bottom-up) and collect **all** referenced hashes across the whole subtree before releasing, so a shared image referenced by both parent and child decrements exactly once per reference (not once per session). Walk `taskSessions` defensively against cycles (a malformed ref shouldn't infinite-loop — bound the depth or track visited storage keys).
- **`affinityKey` is immutable + format-validated.** `SessionHistory.fromData` throws on a malformed `affinityKey` (`/^aff_[0-7][0-9A-HJKMNP-TV-Z]{25}$/`). `getOrCreate` must mint a **conforming ULID-shaped** key and `save` must **never overwrite** it — round-tripping a session whose key drifts will throw on the next `load`.
- **Determinism / no wall-clock divergence.** `save`/`load` run inside the durable loop's replay window. Avoid `Date.now()` in persisted *content* (timestamps come from the entry data the pure `SessionHistory` already stamped); only operational columns (`updatedAt`) may use server time. Don't let a replayed `save` rewrite entry timestamps.
- **Mutation size limits.** A `save` that re-reads + diffs a very long history loads many `sessionEntries` rows; the diff-sync is O(history) on *reads* even though writes are O(new). For large sessions, paginate the existing-entry read by `position` or bound it to the active path window. Note this for P12 if a long-conversation session stresses the read.
- **Box-free assertion is load-bearing.** It is tempting to resolve a workspace path or read a file in `save`/`delete` (e.g. to wipe the box folder on session delete). **Do not** — [08 §3](../design/08-conventions-and-execution-boundary.md#3-the-execution-boundary-core-philosophy) keeps `sessions/*` box-free; the optional box-folder cleanup is a separate engine action, not a session mutation.
