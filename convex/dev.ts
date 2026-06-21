// New (Convex backend) · @cove/runtime — minimal dev entry to exercise the durable engine end-to-end via
// `convex run` (drive with the reserved test model `cove-test/mock` for a free, deterministic run). The
// production admission path is convex/invoke/submit.ts; startPrompt reuses the same `admitPrompt` helper
// (supersede off). No "use node".

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { type AdmitResult, admitPrompt } from "./invoke/admit.ts";

export const startPrompt = mutation({
	args: {
		prompt: v.string(),
		model: v.optional(v.string()),
		instanceId: v.optional(v.string()),
		sessionName: v.optional(v.string()),
		// Optional result JSON Schema → a result-shaped run (offers finish/give_up, doc 08 §4.10).
		resultSchema: v.optional(v.any()),
		// Optional tool names requiring human approval (HITL gate, doc 08 §4.4).
		approvalTools: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args): Promise<AdmitResult> =>
		admitPrompt(ctx, {
			instanceId: args.instanceId ?? "dev",
			harnessName: "default",
			sessionName: args.sessionName ?? "default",
			prompt: args.prompt,
			model: args.model,
			resultSchema: args.resultSchema,
			approvalTools: args.approvalTools,
			supersede: false,
		}),
});

export const getRequest = query({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const req = await ctx.db.get(requestId);
		if (!req) return null;
		const steps = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId))
			.collect();
		return {
			status: req.status,
			finalText: req.finalText,
			result: req.result,
			error: req.error,
			cancelReason: req.cancelReason,
			totalTokens: req.totalTokens,
			totalSteps: req.totalSteps,
			steps: steps
				.sort((a, b) => a.stepNumber - b.stepNumber)
				.map((s) => ({
					stepNumber: s.stepNumber,
					isFinalized: s.isFinalized,
					finishReason: s.finishReason,
					text: s.text,
					toolCallCount: s.toolCalls?.length ?? 0,
				})),
		};
	},
});
