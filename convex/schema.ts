// New (Convex backend). Realizes flue's storage contract:
//   packages/runtime/src/sql-agent-execution-store.ts (SessionStore),
//   packages/runtime/src/sql-run-store.ts (RunStore),
//   packages/runtime/src/session-history.ts (SessionData v6 entry tree).
import { vWorkflowId } from "@convex-dev/workflow";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * cove-harness system-of-record.
 *
 * This is the Convex realization of flue's storage contract (`SessionStore`,
 * `AgentExecutionStore`, `RunStore`, `EventStreamStore`). flue persisted a
 * `SessionData` blob (version 6: an entry *tree* + leaf cursor + task-session
 * refs) through SQL/KV adapters; here that blob is decomposed into relational
 * Convex tables so the engine reads/writes scalars and the UI subscribes to
 * reactive queries instead of polling a stream.
 *
 * Layout (flue's SessionData v6 decomposed into relational Convex tables):
 *   sessions          — one row per flue session (the SessionData *header*).
 *   sessionEntries    — one row per tree node (MessageEntry | CompactionEntry).
 *   agentRequests     — one row per submission (a prompt / skill / task turn).
 *   agentRequestSteps — one row per agent-loop step; holds BOTH the in-flight
 *                       streaming text AND the finalized step data. Reactive
 *                       queries on this table REPLACE flue's Durable-Streams
 *                       SSE transport.
 *   runs              — top-level workflow runs (inspect: getRun/listRuns).
 *   events            — durable + reactive CoveEvent log (observe() substitute).
 *   approvals         — HITL approval gates (new cove-harness capability).
 *   skills            — knowledge catalog the skill tool reads at runtime.
 *   imageChunks       — content-addressed image blob store (hoisted out of entries).
 *   meta              — schema-version / kv.
 *
 * Convex `_id` is every table's primary key and `_creationTime` the implicit
 * sort key on each index, so we don't carry separate id/createdAt columns
 * except where a value is an EXTERNAL identifier (an LLM-issued `toolCallId`,
 * a flue `entryId`/`submissionId`, the workflow component's `convexWorkflowId`).
 */

// A frozen, resolved agent plan snapshotted at admission so the durable loop
// reads only frozen state and replay never drifts (flue resolves the
// AgentProfile at init; we freeze the resolution). Kept intentionally loose
// (nested `v.any()`) — the portable resolver in src/runtime owns the real shape.
const frozenPlanValidator = v.object({
  model: v.optional(v.union(v.string(), v.literal(false))),
  instructions: v.optional(v.string()),
  systemPrompt: v.optional(v.string()),
  thinkingLevel: v.optional(v.string()),
  compaction: v.optional(v.union(v.literal(false), v.any())),
  durability: v.optional(v.any()),
  // Defense-in-depth loop ceiling (resolved from DurabilityConfig.maxSteps, default
  // 100). The durable loop runs `while (stepNumber < plan.maxSteps)`; at the cap,
  // finalize terminalizes the request as failed/step_limit_exceeded. See doc 08 §4.9.
  maxSteps: v.optional(v.number()),
  // Result-tool re-nudge budget for result-schema runs (DurabilityConfig.maxFollowUps,
  // default 32). Exhausting it terminalizes failed/result_followups_exhausted and the
  // CallHandle rejects with ResultUnavailableError. See doc 08 §4.10.
  maxFollowUps: v.optional(v.number()),
  // Resolved tool descriptors (name/description/JSON-Schema params) — NOT the
  // live `execute` closures, which can't cross the workflow journal. Rebound
  // per-llmStep from the agent registry.
  tools: v.optional(v.array(v.any())),
  skills: v.optional(v.array(v.any())),
  subagents: v.optional(v.any()),
  cwd: v.optional(v.string()),
});

const usageValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
});

export default defineSchema({
  // ── Session header ────────────────────────────────────────────────────────
  // One row per flue session. The (instanceId, harnessName, sessionName) tuple
  // is the stable lookup key — flue addresses sessions by name within a harness
  // within a context (ctx.id). Names beginning with `task:` are delegated tasks.
  sessions: defineTable({
    instanceId: v.string(), // ctx.id — agent instance id or workflow run id
    harnessName: v.string(), // AgentHarnessOptions.name (default "default")
    sessionName: v.string(), // CoveSession.name (default "default")

    version: v.number(), // SessionData.version (6)
    // Opaque provider-facing identity for prompt caching / routing affinity.
    affinityKey: v.string(),
    // Active leaf of the entry tree (SessionData.leafId); null on a fresh session.
    leafId: v.union(v.string(), v.null()),
    // Child task sessions for the recursive delete cascade.
    taskSessions: v.array(
      v.object({ session: v.string(), taskId: v.string() }),
    ),
    // Application-owned; flue never reads/writes keys here.
    metadata: v.any(),

    // Operational state guarding concurrent ops + delete (flue's per-session
    // serialization): idle | active (an op/submission in flight) | deleting.
    state: v.union(
      v.literal("idle"),
      v.literal("active"),
      v.literal("deleting"),
    ),

    // Default model identity ("<provider>/<model>") for this session.
    model: v.optional(v.string()),
    // Frozen resolved plan (see validator above). Snapshotted at create/init.
    plan: v.optional(frozenPlanValidator),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_instance_harness_session", [
      "instanceId",
      "harnessName",
      "sessionName",
    ])
    .index("by_instance", ["instanceId"]),

  // ── Session entry tree ────────────────────────────────────────────────────
  // One row per SessionEntry. flue's SessionData.entries[] is a parent-linked
  // tree walked by SessionHistory.getActivePath/buildContext; we store nodes
  // flat and rebuild the active path in app logic after an indexed load.
  sessionEntries: defineTable({
    sessionId: v.id("sessions"),
    entryId: v.string(), // SessionEntry.id (flue-generated, stable)
    parentId: v.union(v.string(), v.null()), // SessionEntry.parentId
    // Monotonic insertion order — gives a stable, indexed ordered rebuild
    // independent of the tree links (and of _creationTime ties).
    position: v.number(),
    kind: v.union(v.literal("message"), v.literal("compaction")),
    // The full SessionEntry payload (MessageEntry | CompactionEntry), minus
    // hoisted image bytes (see imageAttachmentIds + imageChunks).
    data: v.any(),
    // Hashes into imageChunks for any images hoisted out of `data`.
    imageAttachmentIds: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_session_and_position", ["sessionId", "position"])
    .index("by_session_and_entry", ["sessionId", "entryId"]),

  // ── Submission / turn ─────────────────────────────────────────────────────
  // One row per admitted submission (prompt/skill/task/compact). Drives the
  // durable workflow; the caller awaits terminal `status` via a reactive query
  // (native) or a poll-to-terminal httpAction (?wait=result for HTTP/SDK).
  agentRequests: defineTable({
    sessionId: v.id("sessions"),
    instanceId: v.string(),
    submissionId: v.string(), // correlates events; returned to the caller

    kind: v.union(
      v.literal("prompt"),
      v.literal("skill"),
      v.literal("task"),
      v.literal("compact"),
    ),
    input: v.union(v.string(), v.null()),
    // Image attachments on the user turn (hashes into imageChunks; never raw
    // bytes inline on the hot request row).
    imageAttachmentIds: v.optional(v.array(v.string())),
    // True when the caller passed `options.result` (structured extraction).
    expectsResult: v.optional(v.boolean()),
    // The skill ref / subagent name for kind="skill"/"task".
    target: v.optional(v.string()),

    // Lifecycle:
    //   pending   — admitted, not yet started by the workflow.
    //   running   — workflow active OR parked on a HITL approval.
    //   completed — loop reached a stop; finalText/result set.
    //   failed    — workflow threw; error set.
    //   cancelled — stop / supersede / timeout.
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),

    finalText: v.optional(v.string()),
    result: v.optional(v.any()), // validated structured result (expectsResult)
    error: v.optional(v.string()),
    cancelReason: v.optional(
      v.union(
        v.literal("superseded"),
        v.literal("stop"),
        v.literal("timeout"),
      ),
    ),

    // Workflow component handle; stop/supersede call workflow.cancel with it.
    convexWorkflowId: v.optional(vWorkflowId),

    model: v.optional(v.string()),
    durability: v.optional(
      v.object({
        maxAttempts: v.optional(v.number()),
        timeoutMs: v.optional(v.number()),
      }),
    ),

    // Usage rollups computed at terminal time from the finalized step rows.
    totalTokens: v.optional(v.number()),
    totalToolCalls: v.optional(v.number()),
    totalSteps: v.optional(v.number()),
    durationMs: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_and_status", ["sessionId", "status"])
    .index("by_submission", ["submissionId"])
    .index("by_instance", ["instanceId"]),

  // ── Agent-loop step (streaming substrate) ─────────────────────────────────
  // One row per step. `text`/`reasoning` are patched ~10-20× per turn by the
  // delta batcher while the model streams; the structured fields fill atomically
  // with isFinalized:true. Reactive queries here are flue's SSE replacement.
  agentRequestSteps: defineTable({
    requestId: v.id("agentRequests"),
    stepNumber: v.number(), // 0-indexed within the request
    isFinalized: v.boolean(),

    text: v.string(), // streaming assistant text
    reasoning: v.string(), // streaming reasoning/thinking channel

    finishReason: v.optional(v.string()),
    toolCalls: v.optional(
      v.array(
        v.object({
          toolCallId: v.string(), // LLM-issued; stays a plain string
          toolName: v.string(),
          args: v.any(),
          isHitl: v.optional(v.boolean()), // approval-gated tool
        }),
      ),
    ),
    // Grows as each tool completes; idempotent on duplicate toolCallId.
    toolResults: v.array(
      v.object({
        toolCallId: v.string(),
        toolName: v.string(),
        result: v.any(),
        isError: v.optional(v.boolean()),
        errorKind: v.optional(v.string()),
      }),
    ),
    // Verbatim provider assistant messages (signatures etc.) replayed next step.
    responseMessages: v.optional(
      v.array(
        v.object({
          role: v.string(),
          content: v.any(),
          providerMetadata: v.optional(v.any()),
        }),
      ),
    ),

    usage: v.optional(usageValidator),
    model: v.optional(v.string()), // model that ACTUALLY responded
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
    hadToolError: v.optional(v.boolean()),

    updatedAt: v.number(),
  }).index("by_request_and_step", ["requestId", "stepNumber"]),

  // ── Top-level run (inspect surface) ───────────────────────────────────────
  runs: defineTable({
    runId: v.string(), // public run id (== workflow run id by default)
    agentName: v.string(),
    instanceId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    payload: v.optional(v.any()),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    convexWorkflowId: v.optional(vWorkflowId),
    startedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_agent", ["agentName"])
    .index("by_instance", ["instanceId"]),

  // ── Event log (observe() substitute + DS-compatible read) ─────────────────
  // CoveEvent stream. `seq` is monotonic per `streamKey`; native clients use
  // Convex reactivity, HTTP/SDK callers page by `seq` (the opaque DS offset).
  // Image content blocks keep mimeType but carry the IMAGE_DATA_OMITTED sentinel.
  events: defineTable({
    streamKey: v.string(), // runId | instanceId | `${instanceId}:${session}`
    seq: v.number(), // monotonic per streamKey
    eventIndex: v.number(), // per-context ordering (CoveEvent.eventIndex)
    type: v.string(), // CoveEvent.type discriminator (indexed filtering)
    runId: v.optional(v.string()),
    instanceId: v.optional(v.string()),
    submissionId: v.optional(v.string()),
    session: v.optional(v.string()),
    data: v.any(), // the decorated CoveEvent payload
    createdAt: v.number(),
  })
    .index("by_stream_and_seq", ["streamKey", "seq"])
    .index("by_submission", ["submissionId"]),

  // ── HITL approvals (additive capability) ──────────────────────────────────
  // A parked approval-gated tool call. The workflow awaits a decision; the UI
  // renders an approval card from `args`; submitApproval flips status and wakes
  // the run via the workflow event channel.
  approvals: defineTable({
    requestId: v.id("agentRequests"),
    sessionId: v.id("sessions"),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    decision: v.optional(v.any()), // approver payload / edited args
    decidedBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request_and_status", ["requestId", "status"])
    .index("by_session_and_status", ["sessionId", "status"])
    .index("by_toolCall", ["toolCallId"]),

  // ── Skill catalog ─────────────────────────────────────────────────────────
  skills: defineTable({
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    isActive: v.boolean(),
    instructions: v.string(),
    references: v.array(
      v.object({
        name: v.string(),
        title: v.string(),
        description: v.string(),
        content: v.string(),
      }),
    ),
    requiredTools: v.optional(v.array(v.string())),
    contentHash: v.optional(v.string()),
    updatedAt: v.number(),
    updatedBy: v.optional(v.union(v.string(), v.null())),
  })
    .index("by_slug", ["slug"])
    .index("by_isActive", ["isActive"]),

  // ── Content-addressed image store ─────────────────────────────────────────
  // flue hoists image bytes out of session entries and dedups them. Here each
  // distinct image is one row keyed by content hash; entries/requests reference
  // it by hash. Large blobs may move to _storage later (storageId column).
  imageChunks: defineTable({
    hash: v.string(),
    mediaType: v.string(),
    data: v.optional(v.string()), // base64 (inline for small images)
    storageId: v.optional(v.id("_storage")), // for large images
    refCount: v.number(),
    createdAt: v.number(),
  }).index("by_hash", ["hash"]),

  // ── Meta / kv ─────────────────────────────────────────────────────────────
  meta: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),
});
