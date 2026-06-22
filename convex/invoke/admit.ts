// New (Convex backend) · @cove/runtime — P6 admission helpers (ctx-taking, shared by the invoke mutations
// and the dev entry). Realizes the surviving ADMISSION contract (doc 06 P6, D5): open the session,
// optionally supersede the in-flight request (atomic cancel, doc 08 §4.3), admit the new request, append
// the user turn, and start the durable agentRun. No "use node".

import type { WorkflowId } from "@convex-dev/workflow";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { AgentMessage } from "../../src/runtime/messages.ts";
import type { McpServerOptions } from "../../src/runtime/mcp-types.ts";
import { assertPublicSessionName } from "../../src/runtime/session-identity.ts";
import type { ReplyContext } from "../channels/types.ts";
import { appendCanonicalEntry, generateAffinityKey } from "../sessions/persist.ts";
import { workflow } from "../workflow.ts";

export interface SessionRef {
	instanceId: string;
	harnessName: string;
	sessionName: string;
}

export async function findSessionId(ctx: QueryCtx, ref: SessionRef): Promise<Id<"sessions"> | null> {
	const s = await ctx.db
		.query("sessions")
		.withIndex("by_instance_harness_session", (q) =>
			q
				.eq("instanceId", ref.instanceId)
				.eq("harnessName", ref.harnessName)
				.eq("sessionName", ref.sessionName),
		)
		.unique();
	return s?._id ?? null;
}

export async function getOrCreateSessionId(ctx: MutationCtx, ref: SessionRef): Promise<Id<"sessions">> {
	const existing = await findSessionId(ctx, ref);
	if (existing) return existing;
	const now = Date.now();
	return ctx.db.insert("sessions", {
		instanceId: ref.instanceId,
		harnessName: ref.harnessName,
		sessionName: ref.sessionName,
		version: 6,
		affinityKey: generateAffinityKey(),
		leafId: null,
		taskSessions: [],
		metadata: {},
		state: "idle",
		createdAt: now,
		updatedAt: now,
	});
}

/**
 * Cancel the in-flight (pending/running) requests on a session — the atomic abort sequence (doc 08 §4.3):
 * `workflow.cancel` + set `agentRequests.status = cancelled` together. Used for both supersede and an
 * explicit stop. Returns how many were cancelled.
 */
export async function cancelActiveRequests(
	ctx: MutationCtx,
	sessionId: Id<"sessions">,
	reason: "superseded" | "stop" | "timeout",
): Promise<number> {
	let cancelled = 0;
	for (const status of ["pending", "running"] as const) {
		const rows = await ctx.db
			.query("agentRequests")
			.withIndex("by_session_and_status", (q) => q.eq("sessionId", sessionId).eq("status", status))
			.collect();
		for (const r of rows) {
			if (r.convexWorkflowId) {
				try {
					await workflow.cancel(ctx, r.convexWorkflowId);
				} catch {
					// The workflow may have already settled between the status read and here — ignore.
				}
			}
			await ctx.db.patch(r._id, { status: "cancelled", cancelReason: reason, updatedAt: Date.now() });
			cancelled++;
		}
	}
	return cancelled;
}

export interface AdmitPromptArgs extends SessionRef {
	prompt: string;
	model?: string;
	resultSchema?: unknown;
	/** Tool names that require human approval before dispatch (HITL gate, doc 08 §4.4). */
	approvalTools?: string[];
	/** Declared MCP servers (G2.2); discovered + frozen as kind:"mcp" plan tools at setup. */
	mcpServers?: McpServerOptions[];
	/** Channel reply-address (G2.3); frozen on the request so the post-finalize reply can address the channel. */
	replyContext?: ReplyContext;
	/** Supersede any in-flight request on the session before admitting (doc 06 P6 concurrent-prompt gate). */
	supersede: boolean;
}

export interface AdmitResult {
	sessionId: Id<"sessions">;
	requestId: Id<"agentRequests">;
	submissionId: string;
	workflowId: WorkflowId;
}

export async function admitPrompt(ctx: MutationCtx, args: AdmitPromptArgs): Promise<AdmitResult> {
	assertPublicSessionName(args.sessionName); // task:* is reserved for delegated tasks
	const sessionId = await getOrCreateSessionId(ctx, args);
	if (args.supersede) await cancelActiveRequests(ctx, sessionId, "superseded");

	const now = Date.now();
	const submissionId = crypto.randomUUID();
	const requestId = await ctx.db.insert("agentRequests", {
		sessionId,
		instanceId: args.instanceId,
		submissionId,
		kind: "prompt",
		input: args.prompt,
		status: "pending",
		model: args.model ?? "cove-test/mock",
		expectsResult: args.resultSchema !== undefined ? true : undefined,
		resultSchema: args.resultSchema,
		approvalTools: args.approvalTools,
		mcpServers: args.mcpServers,
		replyContext: args.replyContext,
		createdAt: now,
		updatedAt: now,
	});

	const userMessage: AgentMessage = { role: "user", content: args.prompt, timestamp: now };
	await appendCanonicalEntry(ctx, sessionId, `u-${requestId}`, userMessage, now);

	const workflowId = await workflow.start(ctx, internal.engine.runHandler.agentRun, { requestId });
	await ctx.db.patch(requestId, { convexWorkflowId: workflowId });

	return { sessionId, requestId, submissionId, workflowId };
}
