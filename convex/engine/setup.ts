// New (Convex backend) · @cove/runtime
// engine/setup — step 0 of the durable loop (doc 04 "setup"): resolve + FREEZE the plan onto the session
// so the loop reads only frozen state and replay is stable (no live registry lookups mid-run). For P4 this
// is resolve-only (no box provisioned): it composes a minimal system prompt and freezes the built-in tool
// descriptors. (Full composeSystemPrompt + skills registry + sandbox descriptor land in P6/P10.) The model
// string is re-resolved per llmStep, so this is a plain mutation (no "use node").

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { SessionEnv } from "../../src/runtime/types.ts";
import { createFrameworkTools } from "./frameworkTools.ts";
import { buildResultFooter, createResultToolsFromJsonSchema } from "./resultTools.ts";
import { TASK_DESCRIPTION, TASK_PARAMS } from "./task.ts";
import type { FrozenToolDescriptor } from "./types.ts";

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_MAX_FOLLOWUPS = 32;

const SYSTEM_PREAMBLE =
	"You are an autonomous agent operating unattended. Do not ask the user questions — decide and proceed. " +
	"Use the available tools to inspect and modify the workspace; finish when the task is complete.";

export const run = internalMutation({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const request = await ctx.db.get(requestId);
		if (!request) throw new Error(`[cove] request ${requestId} not found`);
		const session = await ctx.db.get(request.sessionId);
		if (!session) throw new Error(`[cove] session for request ${requestId} not found`);

		const model = request.model ?? session.model ?? "cove-test/mock";
		const maxSteps = DEFAULT_MAX_STEPS;
		const maxFollowUps = DEFAULT_MAX_FOLLOWUPS;
		const hasResultSchema = request.expectsResult === true && request.resultSchema !== undefined;

		// Frozen tool descriptors (schema only; execute is rebound per action). A stub env is safe here
		// because reading name/description/parameters never invokes env.
		const stubEnv = {} as unknown as SessionEnv;
		const tools: FrozenToolDescriptor[] = createFrameworkTools(stubEnv).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
			kind: "builtin" as const,
		}));

		// Built-in subagent delegation: task() spawns a child agentRun (handled by dispatchTools/the loop,
		// not the box). Depth/declaration are guarded at spawn time (doc 04).
		tools.push({ name: "task", description: TASK_DESCRIPTION, parameters: TASK_PARAMS, kind: "task" });

		const sections: string[] = [SYSTEM_PREAMBLE];

		// Skills catalog (D13): offer activate_skill + render the ## Available Skills registry when the
		// catalog has active skills. activate_skill resolves a skill by name from the catalog (a Convex
		// query in dispatchTools), never a sandbox FS walk (doc 08 §3). The enum is frozen onto the plan.
		const activeSkills = await ctx.db
			.query("skills")
			.withIndex("by_isActive", (q) => q.eq("isActive", true))
			.collect();
		if (activeSkills.length > 0) {
			tools.push({
				name: "activate_skill",
				description:
					"Load the full instructions for one available skill before performing work that matches its description.",
				parameters: {
					type: "object",
					properties: {
						name: { type: "string", enum: activeSkills.map((s) => s.slug), description: "The skill to activate." },
					},
					required: ["name"],
					additionalProperties: false,
				},
				kind: "skill",
			});
			sections.push(
				`## Available Skills\nCall \`activate_skill\` to load a skill's full instructions before related work.\n${activeSkills
					.map((s) => `- ${s.slug}: ${s.description}`)
					.join("\n")}`,
			);
		}

		// Result-shaped run: freeze the per-call finish/give_up descriptors (built from the JSON Schema so
		// they rebuild deterministically across the journal) and append the result footer (doc 08 §4.10).
		if (hasResultSchema) {
			const bundle = createResultToolsFromJsonSchema(request.resultSchema);
			for (const t of bundle.tools) {
				tools.push({ name: t.name, description: t.description, parameters: t.parameters, kind: "result" });
			}
			sections.push(buildResultFooter());
		}
		const systemPrompt = sections.join("\n\n");

		await ctx.db.patch(request.sessionId, {
			model,
			plan: {
				model,
				systemPrompt,
				tools,
				maxSteps,
				maxFollowUps,
				cwd: session.plan?.cwd,
				resultSchema: hasResultSchema ? request.resultSchema : undefined,
				approvalTools: request.approvalTools,
			},
			updatedAt: Date.now(),
		});
		await ctx.db.patch(requestId, { status: "running", updatedAt: Date.now() });

		return { sessionId: request.sessionId, maxSteps, maxFollowUps, hasResultSchema };
	},
});
