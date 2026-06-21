// New (Convex backend) · @cove/runtime — HITL approval lifecycle (doc 04 "HITL" / 08 §4.4). `park` writes
// the pending approval rows the loop awaits; `submitApproval` (public) is idempotent + fail-loud (rejects a
// non-pending approval, so a double-submit can't flip a resolved one) and emits the durable workflow event
// that wakes the parked run; `listPending` backs the approval-card UI. No "use node".
//
// The runHandler/loop awaitEvent gate (step.awaitEvent(`approval:<requestId>:<toolCallId>`)) + dispatch of
// the approved set is wired in the next P7 step; these are the additive lifecycle primitives.

import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import { applyApprovalDecision } from "./hitl.ts";
import type { ToolResultRecord } from "./types.ts";
import { workflow } from "../workflow.ts";

/** Event name the parked workflow awaits for a given gated tool call (globally unique, doc 08 §4.4). */
export function approvalEventName(requestId: string, toolCallId: string): string {
	return `approval:${requestId}:${toolCallId}`;
}

/** Park approval-gated tool calls: insert pending rows (idempotent by toolCallId within the request). */
export const park = internalMutation({
	args: {
		requestId: v.id("agentRequests"),
		sessionId: v.id("sessions"),
		calls: v.array(v.object({ toolCallId: v.string(), toolName: v.string(), args: v.any() })),
	},
	handler: async (ctx, { requestId, sessionId, calls }) => {
		const now = Date.now();
		for (const call of calls) {
			const existing = await ctx.db
				.query("approvals")
				.withIndex("by_toolCall", (q) => q.eq("toolCallId", call.toolCallId))
				.filter((q) => q.eq(q.field("requestId"), requestId))
				.first();
			if (existing) continue;
			await ctx.db.insert("approvals", {
				requestId,
				sessionId,
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				args: call.args,
				status: "pending",
				createdAt: now,
				updatedAt: now,
			});
		}
	},
});

/**
 * Apply a resolved approval to the step (called from the loop after the awaitEvent fires): a rejection
 * writes an error tool-result (so dispatch skips the call); an approval (optionally with edited args)
 * patches the call's args so dispatch runs the approved version. Edited args are re-validated by the tool's
 * normal execute-time validation at dispatch.
 */
export const applyApproval = internalMutation({
	args: {
		requestId: v.id("agentRequests"),
		stepNumber: v.number(),
		toolCallId: v.string(),
		toolName: v.string(),
		args: v.any(),
		decision: v.object({
			approved: v.boolean(),
			editedArgs: v.optional(v.any()),
			reason: v.optional(v.string()),
		}),
	},
	handler: async (ctx, a) => {
		const step = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", a.requestId).eq("stepNumber", a.stepNumber))
			.unique();
		if (!step) return;

		const outcome = applyApprovalDecision(
			{ toolCallId: a.toolCallId, toolName: a.toolName, args: a.args, isHitl: true },
			a.decision,
		);

		if (outcome.action === "reject") {
			const next = (step.toolResults as ToolResultRecord[]).filter((r) => r.toolCallId !== a.toolCallId);
			next.push({ toolCallId: a.toolCallId, toolName: a.toolName, result: outcome.result, isError: true });
			await ctx.db.patch(step._id, { toolResults: next, hadToolError: true, updatedAt: Date.now() });
			return;
		}
		// Approved: patch the call's args so dispatchTools runs the (possibly edited) approved version.
		const toolCalls = (step.toolCalls ?? []).map((c) =>
			c.toolCallId === a.toolCallId ? { ...c, args: outcome.call.args } : c,
		);
		await ctx.db.patch(step._id, { toolCalls, updatedAt: Date.now() });
	},
});

/** List the pending approvals for a request (the approval-card UI subscribes to this). */
export const listPending = query({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const rows = await ctx.db
			.query("approvals")
			.withIndex("by_request_and_status", (q) => q.eq("requestId", requestId).eq("status", "pending"))
			.collect();
		return rows.map((r) => ({ toolCallId: r.toolCallId, toolName: r.toolName, args: r.args }));
	},
});

/**
 * Resolve a parked approval (public). Idempotent + fail-loud: rejects if the approval is not `pending`, so a
 * double-submit cannot flip an already-resolved decision (doc 08 §4.4). On success it records the decision
 * and emits the durable workflow event that wakes the parked run; approver-edited args are re-validated by
 * the tool's normal execute-time validation when the loop dispatches the approved call.
 */
export const submitApproval = mutation({
	args: {
		requestId: v.id("agentRequests"),
		toolCallId: v.string(),
		approved: v.boolean(),
		editedArgs: v.optional(v.any()),
		reason: v.optional(v.string()),
		decidedBy: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ ok: true }> => {
		const approval = await ctx.db
			.query("approvals")
			.withIndex("by_toolCall", (q) => q.eq("toolCallId", args.toolCallId))
			.filter((q) => q.eq(q.field("requestId"), args.requestId))
			.first();
		if (!approval) throw new Error("[cove] approval not found.");
		if (approval.status !== "pending") {
			throw new Error("[cove] approval has already been resolved.");
		}

		const decision = { approved: args.approved, editedArgs: args.editedArgs, reason: args.reason };
		await ctx.db.patch(approval._id, {
			status: args.approved ? "approved" : "rejected",
			decision,
			decidedBy: args.decidedBy,
			updatedAt: Date.now(),
		});

		// Wake the parked run. The event is durable/queued, so a submit that arrives before the loop parks
		// is not lost (doc 08 §4.4).
		const request = await ctx.db.get(args.requestId);
		if (request?.convexWorkflowId) {
			await workflow.sendEvent(ctx, {
				workflowId: request.convexWorkflowId,
				name: approvalEventName(args.requestId, args.toolCallId),
				value: decision,
			});
		}
		return { ok: true };
	},
});
