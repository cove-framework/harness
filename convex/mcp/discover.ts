"use node";
// New (Convex backend) · @cove/runtime
// Pattern source: flue · @flue/runtime · packages/runtime/src/mcp.ts (connect + createMcpTools discovery).
// The "use node" discovery hop (doc 08 §3 network carve-out): runHandler runs this BEFORE the setup freeze
// mutation when the request declares mcpServers, so the freeze stays a deterministic mutation reading the
// discovered descriptors. For each declared server: connect once, enumerate tools, freeze each into a
// closure-free McpToolDescriptor, close the discovery connection. A per-server connect failure becomes a
// DIAGNOSTIC descriptor (so buildTools surfaces it as an error tool-result, never crashing setup). The
// intra-server duplicate-name reject (flue mcp.ts:159) is kept (→ diagnostic). Returns the descriptors as the
// (journaled) step result; runHandler hands them to setup. NO box — this provisions network only.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { connectMcpServer } from "./connect.ts";
import { diagnosticDescriptor, freezeMcpTool } from "./descriptors.ts";
import type { McpServerOptions, McpToolDescriptor } from "../../src/runtime/mcp-types.ts";

export const run = internalAction({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }): Promise<McpToolDescriptor[]> => {
		const mcpServers = (await ctx.runQuery(internal.engine.requests.getMcpServers, {
			requestId,
		})) as McpServerOptions[];
		return discoverMcpDescriptors(mcpServers);
	},
});

/** Connect each declared server, freeze its tools; a per-server failure → a diagnostic descriptor. */
export async function discoverMcpDescriptors(
	mcpServers: McpServerOptions[],
): Promise<McpToolDescriptor[]> {
	const out: McpToolDescriptor[] = [];
	for (const options of mcpServers) {
		try {
			const conn = await connectMcpServer(options.name, options);
			try {
				const seen = new Set<string>();
				for (const tool of conn.tools) {
					// flue skips task-execution MCP tools (mcp.ts:146-152); cove does too.
					if (tool.execution?.taskSupport === "required") continue;
					const descriptor = freezeMcpTool(options.name, options, tool);
					if (seen.has(descriptor.name)) {
						throw new Error(
							`[cove] MCP tools from server "${options.name}" produced duplicate tool name "${descriptor.name}".`,
						);
					}
					seen.add(descriptor.name);
					out.push(descriptor);
				}
			} finally {
				await conn.close().catch(() => undefined);
			}
		} catch (err) {
			out.push(
				diagnosticDescriptor(options.name, options, err instanceof Error ? err.message : String(err)),
			);
		}
	}
	return out;
}
