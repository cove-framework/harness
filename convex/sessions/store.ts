// New (Convex backend) · @cove/runtime
// SessionStore over Convex (flue's SessionStore.save/load + getOrCreate/get/create/delete). load rebuilds
// a hydrated SessionData; the append mutations are the O(new) diff-sync of canonical entries; deleteSession
// cascades over taskSessions and refuses while a descendant request is active. No "use node".

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { AgentMessage } from "../../src/runtime/messages.ts";
import { orderToolResults, toolResultToMessage } from "../engine/entries.ts";
import type { ToolCallRecord, ToolResultRecord } from "../engine/types.ts";
import {
	appendCanonicalEntry,
	cascadeDeleteSession,
	generateAffinityKey,
	loadSessionData,
	persistCustomEntries,
} from "./persist.ts";

/** Load a hydrated SessionData v6 (the llmStep context source). */
export const load = internalQuery({
	args: { sessionId: v.id("sessions") },
	handler: async (ctx, { sessionId }) => loadSessionData(ctx, sessionId),
});

/** Get-or-create a session by its (instanceId, harnessName, sessionName) tuple. Returns the session id. */
export const getOrCreate = internalMutation({
	args: { instanceId: v.string(), harnessName: v.string(), sessionName: v.string() },
	handler: async (ctx, args): Promise<Id<"sessions">> => {
		const existing = await ctx.db
			.query("sessions")
			.withIndex("by_instance_harness_session", (q) =>
				q
					.eq("instanceId", args.instanceId)
					.eq("harnessName", args.harnessName)
					.eq("sessionName", args.sessionName),
			)
			.unique();
		if (existing) return existing._id;

		const now = Date.now();
		return ctx.db.insert("sessions", {
			instanceId: args.instanceId,
			harnessName: args.harnessName,
			sessionName: args.sessionName,
			version: 6,
			affinityKey: generateAffinityKey(),
			leafId: null,
			taskSessions: [],
			metadata: {},
			state: "idle",
			createdAt: now,
			updatedAt: now,
		});
	},
});

/** Append the user-prompt entry that opens a submission (idempotent by requestId). */
export const appendUserPrompt = internalMutation({
	args: { sessionId: v.id("sessions"), requestId: v.id("agentRequests"), text: v.string() },
	handler: async (ctx, { sessionId, requestId, text }) => {
		const message: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
		await appendCanonicalEntry(ctx, sessionId, `u-${requestId}`, message, Date.now());
	},
});

/** Append the ordered tool-result entries for a step (idempotent by toolCallId-derived entry id). */
export const appendToolResults = internalMutation({
	args: {
		sessionId: v.id("sessions"),
		requestId: v.id("agentRequests"),
		stepNumber: v.number(),
	},
	handler: async (ctx, { sessionId, requestId, stepNumber }) => {
		const step = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId).eq("stepNumber", stepNumber))
			.unique();
		if (!step) return;
		const toolCalls = (step.toolCalls ?? []) as ToolCallRecord[];
		const results = step.toolResults as ToolResultRecord[];
		const ordered = orderToolResults(toolCalls, results);
		for (const r of ordered) {
			const message = toolResultToMessage(r, Date.now());
			await appendCanonicalEntry(
				ctx,
				sessionId,
				`t-${requestId}-${stepNumber}-${r.toolCallId}`,
				message,
				Date.now(),
			);
		}
	},
});

/** Delete a session and cascade to its task-session children; refuse while a descendant is active. */
export const deleteSession = internalMutation({
	args: { sessionId: v.id("sessions") },
	handler: async (ctx, { sessionId }) => {
		await cascadeDeleteSession(ctx, sessionId);
	},
});

/** Public: does a session exist? (the SDK transport's sessions.get/create existence check). */
export const exists = query({
	args: { instanceId: v.string(), harnessName: v.string(), sessionName: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const s = await ctx.db
			.query("sessions")
			.withIndex("by_instance_harness_session", (q) =>
				q
					.eq("instanceId", args.instanceId)
					.eq("harnessName", args.harnessName)
					.eq("sessionName", args.sessionName),
			)
			.unique();
		return s !== null;
	},
});

/**
 * Append a CompactionEntry (the compact action persists its summary here). Validates the kept-boundary entry
 * exists, then inserts a kind="compaction" row at the leaf — after which SessionHistory.buildContextEntries()
 * serves [summary + retained tail]. Mirrors appendCanonicalEntry's position/leaf advance.
 */
export const appendCompactionEntry = internalMutation({
	args: {
		sessionId: v.id("sessions"),
		summary: v.string(),
		firstKeptEntryId: v.string(),
		tokensBefore: v.number(),
		details: v.optional(v.any()),
		// Summed summarization-call usage (pragmatic-refactor Phase 4); stored on the entry for cost accounting.
		usage: v.optional(v.any()),
	},
	handler: async (ctx, args): Promise<{ entryId: string }> => {
		const session = await ctx.db.get(args.sessionId);
		if (!session) throw new Error(`[cove] session ${args.sessionId} not found`);
		const kept = await ctx.db
			.query("sessionEntries")
			.withIndex("by_session_and_entry", (q) =>
				q.eq("sessionId", args.sessionId).eq("entryId", args.firstKeptEntryId),
			)
			.unique();
		if (!kept) throw new Error(`[cove] cannot compact: kept entry "${args.firstKeptEntryId}" not found`);

		let entryId = crypto.randomUUID().slice(0, 8);
		for (let i = 0; i < 8; i++) {
			const clash = await ctx.db
				.query("sessionEntries")
				.withIndex("by_session_and_entry", (q) => q.eq("sessionId", args.sessionId).eq("entryId", entryId))
				.unique();
			if (!clash) break;
			entryId = crypto.randomUUID().slice(0, 8);
		}

		const now = Date.now();
		const last = await ctx.db
			.query("sessionEntries")
			.withIndex("by_session_and_position", (q) => q.eq("sessionId", args.sessionId))
			.order("desc")
			.first();
		const position = (last?.position ?? -1) + 1;
		const data = {
			type: "compaction",
			id: entryId,
			parentId: session.leafId,
			timestamp: new Date(now).toISOString(),
			summary: args.summary,
			firstKeptEntryId: args.firstKeptEntryId,
			tokensBefore: args.tokensBefore,
			details: args.details,
			usage: args.usage,
		};
		await ctx.db.insert("sessionEntries", {
			sessionId: args.sessionId,
			entryId,
			parentId: session.leafId,
			position,
			kind: "compaction",
			data,
			createdAt: now,
		});
		await ctx.db.patch(args.sessionId, { leafId: entryId, updatedAt: now });
		return { entryId };
	},
});

/**
 * Append extension-written `custom` side-state entries (pragmatic-refactor Phase 5b `appendEntry`). Idempotent
 * by the caller-supplied deterministic `entryId` (replay-safe). Does NOT advance `leafId` — custom entries are
 * side-state, never part of the message path, and excluded from the LLM context by buildContextEntries.
 */
export const appendCustomEntries = internalMutation({
	args: {
		sessionId: v.id("sessions"),
		entries: v.array(v.object({ entryId: v.string(), customType: v.string(), data: v.optional(v.any()) })),
	},
	handler: async (ctx, args) => {
		await persistCustomEntries(ctx, args.sessionId, args.entries);
	},
});

/** Public: delete a session by tuple (cascades; refuses while a descendant is active). No-op when absent. */
export const remove = mutation({
	args: { instanceId: v.string(), harnessName: v.string(), sessionName: v.string() },
	handler: async (ctx, args) => {
		const s = await ctx.db
			.query("sessions")
			.withIndex("by_instance_harness_session", (q) =>
				q
					.eq("instanceId", args.instanceId)
					.eq("harnessName", args.harnessName)
					.eq("sessionName", args.sessionName),
			)
			.unique();
		if (s) await cascadeDeleteSession(ctx, s._id);
	},
});
