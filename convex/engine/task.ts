// New (Convex backend) · @cove/runtime — subagent task() delegation (doc 04 "Subagents / task delegation").
// task() spawns a child agentRun as its own durable workflow on a reserved `task:<parent>:<taskId>` session.
// These mutations/queries are the child-request lifecycle; the dispatchTools action does the workflow.start
// + poll-to-terminal and feeds the child's final answer back as the parent's task tool-result. No "use node".
//
// Idempotency: the child request's submissionId is deterministic (`task:<parentRequestId>:<toolCallId>`), so
// a dispatchTools replay reuses the existing child instead of spawning a second one.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import type { AgentMessage } from "../../src/runtime/messages.ts";
import { assertTaskDepth, createTaskSessionName } from "../../src/runtime/session-identity.ts";
import { appendCanonicalEntry, generateAffinityKey } from "../sessions/persist.ts";
import { workflow } from "../workflow.ts";

/** Model-facing parameters for the built-in `task` tool. */
export const TASK_PARAMS = {
	type: "object",
	properties: {
		prompt: { type: "string", description: "Focused instructions for the child agent" },
		description: { type: "string", description: "Short human-readable label for the delegated work" },
		agent: { type: "string", description: "Declared subagent profile to use (optional)" },
		cwd: { type: "string", description: "Working directory for the child agent (optional)" },
	},
	required: ["prompt"],
	additionalProperties: false,
} as const;

export const TASK_DESCRIPTION =
	"Delegate a focused task to a detached child agent with its own context. Use this for independent " +
	"research, file exploration, or parallel work. The task returns only its final answer to this conversation.";

/** Create (idempotently) the child request + its task:* session for a task tool-call; depth-guarded. */
export const createChildRequest = internalMutation({
	args: {
		parentRequestId: v.id("agentRequests"),
		toolCallId: v.string(),
		prompt: v.string(),
		agent: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args,
	): Promise<{ childRequestId: Id<"agentRequests">; sessionName: string }> => {
		const submissionId = `task:${args.parentRequestId}:${args.toolCallId}`;
		const existing = await ctx.db
			.query("agentRequests")
			.withIndex("by_submission", (q) => q.eq("submissionId", submissionId))
			.unique();
		const parent = await ctx.db.get(args.parentRequestId);
		if (!parent) throw new Error(`[cove] parent request ${args.parentRequestId} not found`);
		const parentSession = await ctx.db.get(parent.sessionId);
		if (!parentSession) throw new Error("[cove] parent session not found");
		const sessionName = createTaskSessionName(parentSession.sessionName, args.toolCallId);
		if (existing) return { childRequestId: existing._id, sessionName };

		const depth = (parent.taskDepth ?? 0) + 1;
		assertTaskDepth(depth);

		const now = Date.now();
		const childSessionId = await ctx.db.insert("sessions", {
			instanceId: parent.instanceId,
			harnessName: parentSession.harnessName,
			sessionName,
			version: 6,
			affinityKey: generateAffinityKey(),
			leafId: null,
			taskSessions: [],
			metadata: {},
			state: "idle",
			model: parent.model,
			createdAt: now,
			updatedAt: now,
		});
		const childRequestId = await ctx.db.insert("agentRequests", {
			sessionId: childSessionId,
			instanceId: parent.instanceId,
			submissionId,
			kind: "task",
			input: args.prompt,
			status: "pending",
			model: parent.model,
			target: args.agent,
			taskDepth: depth,
			createdAt: now,
			updatedAt: now,
		});
		const userMessage: AgentMessage = { role: "user", content: args.prompt, timestamp: now };
		await appendCanonicalEntry(ctx, childSessionId, `u-${childRequestId}`, userMessage, now);

		// Link parent → child for the cascade-delete (doc 04).
		await ctx.db.patch(parent.sessionId, {
			taskSessions: [...parentSession.taskSessions, { session: sessionName, taskId: args.toolCallId }],
			updatedAt: now,
		});

		// Start the child's durable workflow now (this is a mutation ctx, so workflow.start is valid here;
		// the dispatchTools action then just polls). Idempotent overall: an existing child returned above.
		const workflowId = await workflow.start(ctx, internal.engine.runHandler.agentRun, {
			requestId: childRequestId,
		});
		await ctx.db.patch(childRequestId, { convexWorkflowId: workflowId, status: "running", updatedAt: now });

		return { childRequestId, sessionName };
	},
});

/** Read a child request's terminal state (the dispatchTools poll target). */
export const getChildResult = internalQuery({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const r = await ctx.db.get(requestId);
		if (!r) return null;
		return { status: r.status, finalText: r.finalText, error: r.error };
	},
});

export interface TaskResult {
	content: { type: "text"; text: string }[];
	details: { taskId: string; session: string; status?: string };
	isError: boolean;
}

/** Format a child's terminal snapshot as the parent's task tool-result (the child's final answer). */
export function formatTaskResult(
	snap: { status: string; finalText?: string; error?: string } | null,
	taskId: string,
	sessionName: string,
): TaskResult {
	if (snap?.status === "completed") {
		return {
			content: [{ type: "text", text: snap.finalText ?? "" }],
			details: { taskId, session: sessionName },
			isError: false,
		};
	}
	const status = snap?.status ?? "unknown";
	return {
		content: [{ type: "text", text: `[cove] task did not complete (${snap?.error ?? status}).` }],
		details: { taskId, session: sessionName, status },
		isError: true,
	};
}
