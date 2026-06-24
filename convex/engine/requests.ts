// New (Convex backend) · @cove/runtime
// Request-level queries the engine actions read (the frozen plan context). No "use node".

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { McpServerOptions } from "../../src/runtime/mcp-types.ts";
import type { ExtensionManifestEntry } from "../../src/runtime/extensions/types.ts";
import type { FrozenToolDescriptor } from "./types.ts";

/** The frozen run-plan context an llmStep/dispatchTools action needs (resolved from session.runPlan at setup). */
export const getRunPlanContext = internalQuery({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const request = await ctx.db.get(requestId);
		if (!request) throw new Error(`[cove] request ${requestId} not found`);
		const session = await ctx.db.get(request.sessionId);
		if (!session?.runPlan) throw new Error(`[cove] session run-plan not frozen for request ${requestId}`);
		const model = typeof session.runPlan.model === "string" ? session.runPlan.model : "cove-test/mock";
		return {
			sessionId: request.sessionId,
			model,
			systemPrompt: session.runPlan.systemPrompt ?? "",
			tools: (session.runPlan.tools ?? []) as FrozenToolDescriptor[],
			cwd: session.runPlan.cwd,
			resultSchema: session.runPlan.resultSchema,
			approvalTools: (session.runPlan.approvalTools ?? []) as string[],
			// Frozen compaction settings (G2.5): false (disabled) or { enabled, reserveTokens, keepRecentTokens, contextWindow }.
			compaction: session.runPlan.compaction as
				| false
				| { enabled: boolean; reserveTokens: number; keepRecentTokens: number; contextWindow: number }
				| undefined,
			// Frozen extension manifest (pragmatic-refactor Phase 5): the ordered, data-only manifest the
			// engine binds (re-runs named factories) to recover hook closures behind the replay guard.
			extensions: (session.runPlan.extensions ?? []) as ExtensionManifestEntry[],
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

/** The frozen extension manifest for a session (pragmatic-refactor Phase 5b) — defensive (empty if unset). */
export const getExtensionManifest = internalQuery({
	args: { sessionId: v.id("sessions") },
	handler: async (ctx, { sessionId }): Promise<ExtensionManifestEntry[]> => {
		const session = await ctx.db.get(sessionId);
		return (session?.runPlan?.extensions ?? []) as ExtensionManifestEntry[];
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
