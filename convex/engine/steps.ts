// New (Convex backend) · @cove/runtime
// The agentRequestSteps persistence layer — the streaming substrate + replay source of truth (doc 03,
// 08 §4.1/§4.6). insertStreaming/patchStreaming feed the delta batcher; finalizeStep atomically writes the
// finalized step AND appends the canonical assistant entry (so a replay never double-appends, doc 04
// context-rebuild); appendToolResult is idempotent by toolCallId; getOutcome derives the durable
// result outcome from persisted rows (doc 08 §4.10). No "use node".

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { AgentMessage } from "../../src/runtime/messages.ts";
import { stepToAssistantMessage } from "./entries.ts";
import { computeResultOutcome } from "./resultTools.ts";
import type { ToolResultRecord } from "./types.ts";
import { appendCanonicalEntry } from "../sessions/persist.ts";

const toolCallValidator = v.object({
	toolCallId: v.string(),
	toolName: v.string(),
	args: v.any(),
	isHitl: v.optional(v.boolean()),
});

const usageValidator = v.object({
	input: v.number(),
	output: v.number(),
	cacheRead: v.number(),
	cacheWrite: v.number(),
	cacheWrite1h: v.optional(v.number()),
	totalTokens: v.number(),
	cost: v.object({
		input: v.number(),
		output: v.number(),
		cacheRead: v.number(),
		cacheWrite: v.number(),
		total: v.number(),
	}),
});

/** Replay-guard source: the finalized (or in-flight) step row, or null. */
export const byRequestStep = internalQuery({
	args: { requestId: v.id("agentRequests"), stepNumber: v.number() },
	handler: async (ctx, { requestId, stepNumber }) =>
		ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId).eq("stepNumber", stepNumber))
			.unique(),
});

/** Create the streaming step row. Idempotent: keeps an existing (non-finalized) row on retry. */
export const insertStreaming = internalMutation({
	args: { requestId: v.id("agentRequests"), stepNumber: v.number() },
	handler: async (ctx, { requestId, stepNumber }) => {
		const existing = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId).eq("stepNumber", stepNumber))
			.unique();
		if (existing) return;
		await ctx.db.insert("agentRequestSteps", {
			requestId,
			stepNumber,
			isFinalized: false,
			text: "",
			reasoning: "",
			toolResults: [],
			updatedAt: Date.now(),
		});
	},
});

/** Append coalesced streaming deltas in place (doc 08 §4.6). */
export const patchStreaming = internalMutation({
	args: {
		requestId: v.id("agentRequests"),
		stepNumber: v.number(),
		text: v.optional(v.string()),
		reasoning: v.optional(v.string()),
	},
	handler: async (ctx, { requestId, stepNumber, text, reasoning }) => {
		const row = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId).eq("stepNumber", stepNumber))
			.unique();
		if (!row) return;
		await ctx.db.patch(row._id, {
			text: row.text + (text ?? ""),
			reasoning: row.reasoning + (reasoning ?? ""),
			updatedAt: Date.now(),
		});
	},
});

/** Finalize the step atomically AND append the canonical assistant entry (idempotent via the entry id). */
export const finalizeStep = internalMutation({
	args: {
		requestId: v.id("agentRequests"),
		stepNumber: v.number(),
		sessionId: v.id("sessions"),
		finishReason: v.string(),
		text: v.string(),
		reasoning: v.string(),
		toolCalls: v.array(toolCallValidator),
		responseMessages: v.array(
			v.object({ role: v.string(), content: v.any(), providerMetadata: v.optional(v.any()) }),
		),
		usage: usageValidator,
		model: v.string(),
		durationMs: v.number(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) =>
				q.eq("requestId", args.requestId).eq("stepNumber", args.stepNumber),
			)
			.unique();
		if (row) {
			await ctx.db.patch(row._id, {
				isFinalized: true,
				finishReason: args.finishReason,
				text: args.text,
				reasoning: args.reasoning,
				toolCalls: args.toolCalls,
				responseMessages: args.responseMessages,
				usage: args.usage,
				model: args.model,
				durationMs: args.durationMs,
				updatedAt: Date.now(),
			});
		}
		const assistant = stepToAssistantMessage(
			{
				finishReason: args.finishReason,
				text: args.text,
				reasoning: args.reasoning,
				toolCalls: args.toolCalls,
				usage: args.usage,
				model: args.model,
			},
			Date.now(),
		) as AgentMessage;
		await appendCanonicalEntry(
			ctx,
			args.sessionId,
			`a-${args.requestId}-${args.stepNumber}`,
			assistant,
			Date.now(),
		);
	},
});

/** Persist a tool result, idempotent on toolCallId (replace-in-place, doc 04). */
export const appendToolResult = internalMutation({
	args: {
		requestId: v.id("agentRequests"),
		stepNumber: v.number(),
		toolCallId: v.string(),
		toolName: v.string(),
		result: v.any(),
		isError: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) =>
				q.eq("requestId", args.requestId).eq("stepNumber", args.stepNumber),
			)
			.unique();
		if (!row) return;
		const next = (row.toolResults as ToolResultRecord[]).filter((r) => r.toolCallId !== args.toolCallId);
		next.push({
			toolCallId: args.toolCallId,
			toolName: args.toolName,
			result: args.result,
			isError: args.isError,
		});
		await ctx.db.patch(row._id, {
			toolResults: next,
			hadToolError: next.some((r) => r.isError) || undefined,
			updatedAt: Date.now(),
		});
	},
});

/** Append a re-nudge follow-up user turn, idempotent by the current leaf (doc 08 §4.10). */
export const appendFollowUp = internalMutation({
	args: { sessionId: v.id("sessions"), requestId: v.id("agentRequests"), prompt: v.string() },
	handler: async (ctx, { sessionId, requestId, prompt }) => {
		const session = await ctx.db.get(sessionId);
		const leaf = session?.leafId ?? "root";
		const message: AgentMessage = { role: "user", content: prompt, timestamp: Date.now() };
		await appendCanonicalEntry(ctx, sessionId, `f-${requestId}-${leaf}`, message, Date.now());
	},
});

/** Durable result outcome (pending | finished | gave_up) over all persisted tool results (doc 08 §4.10). */
export const getOutcome = internalQuery({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const steps = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId))
			.collect();
		const results: ToolResultRecord[] = [];
		for (const s of steps) results.push(...(s.toolResults as ToolResultRecord[]));
		return computeResultOutcome(results);
	},
});

/** Current request status (cancel short-circuit, doc 08 §4.3). */
export const requestStatus = internalQuery({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const req = await ctx.db.get(requestId);
		return req?.status ?? "missing";
	},
});
