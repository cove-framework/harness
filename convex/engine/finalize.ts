// New (Convex backend) · @cove/runtime
// engine/finalize (doc 04 step 5): terminalize the request and roll up usage from the finalized step rows
// (addUsage/emptyUsage, doc 08 §4.7). No "use node".

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { PromptUsage } from "../../src/runtime/types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export const run = internalMutation({
	args: {
		requestId: v.id("agentRequests"),
		status: v.union(v.literal("completed"), v.literal("failed")),
		reason: v.optional(v.string()),
		finalText: v.optional(v.string()),
		result: v.optional(v.any()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const steps = await ctx.db
			.query("agentRequestSteps")
			.withIndex("by_request_and_step", (q) => q.eq("requestId", args.requestId))
			.collect();

		let usage = emptyUsage();
		let totalToolCalls = 0;
		let durationMs = 0;
		for (const s of steps) {
			if (s.usage) usage = addUsage(usage, s.usage as PromptUsage);
			totalToolCalls += s.toolCalls?.length ?? 0;
			durationMs += s.durationMs ?? 0;
		}

		await ctx.db.patch(args.requestId, {
			status: args.status,
			finalText: args.finalText,
			result: args.result,
			error: args.error ?? (args.status === "failed" ? args.reason : undefined),
			totalTokens: usage.totalTokens,
			totalToolCalls,
			totalSteps: steps.length,
			durationMs,
			usage,
			updatedAt: Date.now(),
		});
	},
});
