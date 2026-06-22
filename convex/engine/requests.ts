// New (Convex backend) · @cove/runtime
// Request-level queries the engine actions read (the frozen plan context). No "use node".

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
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
			// Event-emit context (G2.1): the stream-key + correlation fields the engine stamps on
			// every CoveEvent it emits from llmStep/dispatchTools.
			instanceId: request.instanceId,
			submissionId: request.submissionId,
			sessionName: session.sessionName,
		};
	},
});
