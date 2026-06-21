// New (Convex backend) · @cove/runtime — public reactive query for a request's step stream. This IS the
// SSE replacement (doc 03 / 05): `useQuery(api.steps.listForRequest,{requestId})` re-broadcasts as the
// delta batcher patches text/reasoning in place and as steps finalize. No "use node".

import { v } from "convex/values";
import { query } from "./_generated/server";

export const listForRequest = query({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const steps = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId))
			.collect();
		return steps
			.sort((a, b) => a.stepNumber - b.stepNumber)
			.map((s) => ({
				stepNumber: s.stepNumber,
				isFinalized: s.isFinalized,
				text: s.text,
				reasoning: s.reasoning,
				finishReason: s.finishReason,
				toolCalls: s.toolCalls,
				toolResults: s.toolResults,
				usage: s.usage,
				model: s.model,
			}));
	},
});
