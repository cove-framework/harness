// New (Convex backend) · @cove/runtime
// Request-level queries the engine actions read (the frozen plan context). No "use node".

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { McpServerOptions } from "../../src/runtime/mcp-types.ts";
import type { FrozenToolDescriptor } from "./types.ts";

/** The frozen plan context an llmStep/dispatchTools action needs (resolved from session.plan at setup). */
export const getPlanContext = internalQuery({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const request = await ctx.db.get(requestId);
		if (!request) throw new Error(`[cove] request ${requestId} not found`);
		const session = await ctx.db.get(request.sessionId);
		if (!session?.plan) throw new Error(`[cove] session plan not frozen for request ${requestId}`);
		const model = typeof session.plan.model === "string" ? session.plan.model : "cove-test/mock";
		return {
			sessionId: request.sessionId,
			model,
			systemPrompt: session.plan.systemPrompt ?? "",
			tools: (session.plan.tools ?? []) as FrozenToolDescriptor[],
			cwd: session.plan.cwd,
			resultSchema: session.plan.resultSchema,
			approvalTools: (session.plan.approvalTools ?? []) as string[],
			// Frozen compaction settings (G2.5): false (disabled) or { enabled, reserveTokens, keepRecentTokens, contextWindow }.
			compaction: session.plan.compaction as
				| false
				| { enabled: boolean; reserveTokens: number; keepRecentTokens: number; contextWindow: number }
				| undefined,
			// Event-emit context (G2.1): the stream-key + correlation fields the engine stamps on
			// every CoveEvent it emits from llmStep/dispatchTools.
			instanceId: request.instanceId,
			submissionId: request.submissionId,
			sessionName: session.sessionName,
		};
	},
});

/** Stream-key context for a session (G2.5) — lets the compact action emit compaction events on the stream. */
export const getEmitContext = internalQuery({
	args: { sessionId: v.id("sessions"), requestId: v.optional(v.id("agentRequests")) },
	handler: async (ctx, { sessionId, requestId }) => {
		const session = await ctx.db.get(sessionId);
		const request = requestId ? await ctx.db.get(requestId) : null;
		return {
			instanceId: session?.instanceId,
			sessionName: session?.sessionName,
			submissionId: request?.submissionId,
			kind: request?.kind,
		};
	},
});

/** The declared MCP servers for a request — read by the "use node" discovery hop before the setup freeze (G2.2). */
export const getMcpServers = internalQuery({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }): Promise<McpServerOptions[]> => {
		const request = await ctx.db.get(requestId);
		return (request?.mcpServers ?? []) as McpServerOptions[];
	},
});
