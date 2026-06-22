// New (Convex backend) · @cove/runtime — P6 public invoke surface (the production form of dev.startPrompt).
// submitPrompt admits a prompt, superseding any in-flight request on the session; stopActive runs the
// atomic abort sequence on the session's in-flight request(s) (doc 08 §4.3). The CoveContext →
// CoveHarness → CoveSession facade (next P6 tick) calls these. No "use node".

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { type AdmitResult, admitPrompt, cancelActiveRequests, findSessionId } from "./admit.ts";

export const submitPrompt = mutation({
	args: {
		prompt: v.string(),
		model: v.optional(v.string()),
		instanceId: v.optional(v.string()),
		harnessName: v.optional(v.string()),
		sessionName: v.optional(v.string()),
		resultSchema: v.optional(v.any()),
		approvalTools: v.optional(v.array(v.string())),
		mcpServers: v.optional(v.array(v.any())),
		replyContext: v.optional(v.any()),
	},
	handler: async (ctx, args): Promise<AdmitResult> =>
		admitPrompt(ctx, {
			instanceId: args.instanceId ?? "default",
			harnessName: args.harnessName ?? "default",
			sessionName: args.sessionName ?? "default",
			prompt: args.prompt,
			model: args.model,
			resultSchema: args.resultSchema,
			approvalTools: args.approvalTools,
			mcpServers: args.mcpServers,
			replyContext: args.replyContext,
			supersede: true,
		}),
});

export const stopActive = mutation({
	args: {
		instanceId: v.optional(v.string()),
		harnessName: v.optional(v.string()),
		sessionName: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ cancelled: number }> => {
		const sessionId = await findSessionId(ctx, {
			instanceId: args.instanceId ?? "default",
			harnessName: args.harnessName ?? "default",
			sessionName: args.sessionName ?? "default",
		});
		if (!sessionId) return { cancelled: 0 };
		return { cancelled: await cancelActiveRequests(ctx, sessionId, "stop") };
	},
});
