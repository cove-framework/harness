// New (Convex backend) · @cove/runtime — P6 public invoke surface (the production form of dev.startPrompt).
// submitPrompt admits a prompt, superseding any in-flight request on the session; stopActive runs the
// atomic abort sequence on the session's in-flight request(s) (doc 08 §4.3). The CoveContext →
// CoveHarness → CoveSession facade (next P6 tick) calls these. No "use node".

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import {
	type AdmitResult,
	admitCompact,
	admitPrompt,
	admitSkill,
	admitWorkflow,
	cancelActiveRequests,
	findSessionId,
} from "./admit.ts";

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
		// Registered agent name (G2.4) — from POST /agents/:name; sourced for the model/profile at setup.
		agent: v.optional(v.string()),
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
			agent: args.agent,
			supersede: true,
		}),
});

/** Admit a workflow invoke as a distinct kind:"workflow" run (D18). Bound to POST /workflows/:name by codegen. */
export const submitWorkflow = mutation({
	args: {
		name: v.string(),
		input: v.optional(v.any()),
		instanceId: v.optional(v.string()),
		sessionName: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<AdmitResult> =>
		admitWorkflow(ctx, {
			name: args.name,
			input: args.input,
			instanceId: args.instanceId ?? `workflow:${args.name}`,
			harnessName: "default",
			sessionName: args.sessionName ?? "default",
		}),
});

/** Activate a catalog skill as a kind:"skill" run (G2.5): resolve the skill body → admit it as the prompt. */
export const submitSkill = mutation({
	args: {
		skill: v.string(),
		args: v.optional(v.any()),
		model: v.optional(v.string()),
		instanceId: v.optional(v.string()),
		harnessName: v.optional(v.string()),
		sessionName: v.optional(v.string()),
	},
	handler: async (ctx, a): Promise<AdmitResult> => {
		const row = await ctx.db
			.query("skills")
			.withIndex("by_slug", (q) => q.eq("slug", a.skill))
			.unique();
		if (!row || !row.isActive) {
			throw new Error(`[cove] skill "${a.skill}" not found in catalog.`);
		}
		const instructions =
			a.args && Object.keys(a.args).length > 0
				? `${row.instructions}\n\nArguments: ${JSON.stringify(a.args)}`
				: row.instructions;
		return admitSkill(ctx, {
			skill: a.skill,
			instructions,
			model: a.model,
			instanceId: a.instanceId ?? "default",
			harnessName: a.harnessName ?? "default",
			sessionName: a.sessionName ?? "default",
		});
	},
});

/** Compact a session's history as a kind:"compact" run (G2.5). */
export const submitCompact = mutation({
	args: {
		instanceId: v.optional(v.string()),
		harnessName: v.optional(v.string()),
		sessionName: v.optional(v.string()),
	},
	handler: async (ctx, a): Promise<AdmitResult> =>
		admitCompact(ctx, {
			instanceId: a.instanceId ?? "default",
			harnessName: a.harnessName ?? "default",
			sessionName: a.sessionName ?? "default",
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
