// New (Convex backend) · @cove/runtime — public reactive query for a request's terminal state. The native
// consumer transport (doc 05): submit via invoke.submitPrompt, then `useQuery(api.requests.get,{requestId})`
// to watch status flip to completed/failed and read the result/usage. No "use node".

import { v } from "convex/values";
import { query } from "./_generated/server";

export const get = query({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const r = await ctx.db.get(requestId);
		if (!r) return null;
		return {
			submissionId: r.submissionId,
			status: r.status,
			finalText: r.finalText,
			result: r.result,
			error: r.error,
			cancelReason: r.cancelReason,
			usage: r.usage,
			totalTokens: r.totalTokens,
			totalSteps: r.totalSteps,
			totalToolCalls: r.totalToolCalls,
			durationMs: r.durationMs,
		};
	},
});
