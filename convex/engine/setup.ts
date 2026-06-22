// New (Convex backend) · @cove/runtime
// engine/setup — step 0 of the durable loop (doc 04 "setup"): resolve + FREEZE the plan onto the session
// so the loop reads only frozen state and replay is stable (no live registry lookups mid-run). For P4 this
// is resolve-only (no box provisioned): it composes a minimal system prompt and freezes the built-in tool
// descriptors. (Full composeSystemPrompt + skills registry + sandbox descriptor land in P6/P10.) The model
// string is re-resolved per llmStep, so this is a plain mutation (no "use node").

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
// Side-effect import: installs the agent registry into this isolate so getRegisteredAgent(name) resolves
// (G2.4). In a user project, cove codegen emits _cove/agentResolver.ts from the project's registry.
import "../_cove/agentResolver.ts";
import { getRegisteredAgent } from "../agentRegistry.ts";
import { resolveAgentProfile } from "../../src/runtime/agent-definition.ts";
import { deriveCompactionDefaults } from "../../src/runtime/compaction.ts";
import type { AgentCreateContext, CompactionConfig } from "../../src/runtime/types.ts";
import type { McpToolDescriptor } from "../../src/runtime/mcp-types.ts";
import type { SessionEnv } from "../../src/runtime/types.ts";
import { lookupCaps } from "../providers/capabilities.ts";
import { emitFromMutation } from "../events/emit.ts";

/** Frozen compaction settings on the plan (G2.5). `false` = threshold disabled (overflow + explicit still run). */
type FrozenCompaction =
	| false
	| { enabled: true; reserveTokens: number; keepRecentTokens: number; contextWindow: number };
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
	args: {
		requestId: v.id("agentRequests"),
		// Frozen MCP descriptors from the "use node" discovery hop (G2.2); appended as kind:"mcp" tools.
		discoveredMcp: v.optional(v.array(v.any())),
	},
	handler: async (ctx, { requestId, discoveredMcp }) => {
		const request = await ctx.db.get(requestId);
		if (!request) throw new Error(`[cove] request ${requestId} not found`);
		const session = await ctx.db.get(request.sessionId);
		if (!session) throw new Error(`[cove] session for request ${requestId} not found`);

		// G2.4: when this prompt addresses a registered agent by name (target), source its model + instructions
		// from the registry; otherwise fall back so dev submits without a registry still run. The rich
		// initializer context (payload/env) is G2.5 — here we run it best-effort and degrade on any error.
		let registeredModel: string | undefined;
		let registeredInstructions: string | undefined;
		let registeredCompaction: false | CompactionConfig | undefined;
		if (request.kind === "prompt" && request.target) {
			const created = getRegisteredAgent(request.target);
			if (created) {
				try {
					const config = await created.initialize({
						id: request.instanceId,
					} as AgentCreateContext);
					const profile = resolveAgentProfile(config);
					if (typeof profile.model === "string") registeredModel = profile.model;
					registeredInstructions = profile.instructions;
					registeredCompaction = profile.compaction;
				} catch {
					// fall through to the request/session model
				}
			}
		}

		const model = registeredModel ?? request.model ?? session.model ?? "cove-test/mock";
		const maxSteps = DEFAULT_MAX_STEPS;
		const maxFollowUps = DEFAULT_MAX_FOLLOWUPS;

		// Compaction settings (G2.5): derive from model caps (V8-safe lookupCaps — no AI SDK, setup stays a
		// mutation) + freeze onto the plan. Honor the profile `compaction:false`. Unknown model → contextWindow
		// 0 → threshold disabled by shouldCompact() (overflow + explicit session.compact() still run).
		let compaction: FrozenCompaction;
		if (registeredCompaction === false) {
			compaction = false;
		} else {
			const slash = model.indexOf("/");
			const caps =
				slash > 0 ? lookupCaps(model.slice(0, slash), model.slice(slash + 1)) : undefined;
			const derived = deriveCompactionDefaults({
				contextWindow: caps?.contextWindow ?? 0,
				maxTokens: caps?.maxOutputTokens ?? 0,
			});
			const override = registeredCompaction ?? {};
			compaction = {
				enabled: true,
				reserveTokens: override.reserveTokens ?? derived.reserveTokens,
				keepRecentTokens: override.keepRecentTokens ?? derived.keepRecentTokens,
				contextWindow: caps?.contextWindow ?? 0,
			};
		}
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
		if (registeredInstructions) sections.push(registeredInstructions);

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
		// MCP tools (G2.2): append the closure-free descriptors discovered by the "use node" discovery hop.
		// The reserved-name + inter-server collision check fails loud here — an MCP tool can never silently
		// shadow a framework built-in (task/finish/give_up/activate_skill) or another server's frozen name.
		const mcpDescriptors = (discoveredMcp ?? []) as McpToolDescriptor[];
		if (mcpDescriptors.length > 0) {
			const existingNames = new Set(tools.map((t) => t.name));
			for (const descriptor of mcpDescriptors) {
				if (existingNames.has(descriptor.name)) {
					throw new Error(
						`[cove] MCP tool "${descriptor.name}" collides with an existing tool name (framework built-in or another MCP server).`,
					);
				}
				existingNames.add(descriptor.name);
				tools.push({
					name: descriptor.name,
					description: descriptor.description,
					parameters: descriptor.parameters,
					kind: "mcp",
					mcp: descriptor,
				});
			}
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
				compaction,
			},
			updatedAt: Date.now(),
		});
		await ctx.db.patch(requestId, { status: "running", updatedAt: Date.now() });

		// Open the event stream for this operation (G2.1). operationId === submissionId; the operation kind
		// mirrors the request kind. Carries the stream-key fan-out fields (instanceId/session).
		await emitFromMutation(ctx, {
			type: "operation_start",
			operationId: request.submissionId,
			operationKind: request.kind,
			instanceId: request.instanceId,
			submissionId: request.submissionId,
			session: session.sessionName,
		});

		return { sessionId: request.sessionId, model, maxSteps, maxFollowUps, hasResultSchema, compaction };
	},
});
