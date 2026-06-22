"use node";
// New (Convex backend) · @cove/runtime
// Pattern source: flue · @flue/runtime · packages/runtime/src/mcp.ts (McpServerConnection.close ownership).
// Per-PROCESS MCP connection cache + the per-beat resolver dispatchTools injects as `mcpResolve`. A module
// Map keyed by server identity (transport+url+headers) reuses a warm client within one action; a cold action
// starts empty and re-opens (D15 / R5 — never assumed durable across actions). The resolver returns an
// EngineTool whose `execute` LAZILY opens the pooled connection (so buildExecutableTools stays synchronous),
// checks drift (frozen descriptor wins), and degrades every failure to an error tool-result — never a crash.
// "use node": transitively opens transports via connect.ts.

import { openMcpConnection } from "./connect.ts";
import { mcpDescriptorToToolDefinition, mcpServerIdentity } from "./descriptors.ts";
import type { EngineTool, EngineToolResult, FrozenToolDescriptor } from "../engine/types.ts";
import type { McpClient, McpToolDescriptor } from "../../src/runtime/mcp-types.ts";

interface PooledConnection {
	client: McpClient;
	/** Original tool names the server currently offers (for the drift check). */
	toolNames: Set<string>;
}

const pool = new Map<string, PooledConnection>();

/** The connection opener. Swappable for tests (mirrors the testModel/MockLanguageModel injection seam). */
type ConnectionOpener = (descriptor: McpToolDescriptor) => Promise<PooledConnection>;
let opener: ConnectionOpener = openMcpConnection;

/** Test seam: inject a fake opener (a Pick<Client> stub) so the resolver is testable without a live server. */
export function __setMcpOpenerForTests(o: ConnectionOpener | null): void {
	opener = o ?? openMcpConnection;
}
/** Test seam: clear the per-process pool between cases. */
export function __resetMcpPoolForTests(): void {
	pool.clear();
}

async function getOrOpen(descriptor: McpToolDescriptor): Promise<PooledConnection> {
	const key = mcpServerIdentity(descriptor);
	const cached = pool.get(key);
	if (cached) return cached;
	const conn = await opener(descriptor);
	pool.set(key, conn);
	return conn;
}

/** Evict + close one pooled connection (best-effort) — called when a cached client errors. */
async function evict(descriptor: McpToolDescriptor): Promise<void> {
	const key = mcpServerIdentity(descriptor);
	const conn = pool.get(key);
	if (!conn) return;
	pool.delete(key);
	await conn.client.close().catch(() => undefined);
}

/** Close every pooled connection (action teardown). */
export async function closeAll(): Promise<void> {
	const conns = [...pool.values()];
	pool.clear();
	await Promise.all(conns.map((c) => c.client.close().catch(() => undefined)));
}

/**
 * Resolve a frozen `kind:"mcp"` descriptor into an executable tool (the per-beat network bind). Returns
 * synchronously; the connection is opened lazily inside `execute` so buildExecutableTools stays pure-sync and
 * every failure (connect / drift / callTool) becomes an error tool-result rather than a step crash.
 */
export function resolveMcpTool(d: FrozenToolDescriptor): EngineTool {
	const descriptor = d.mcp;
	if (!descriptor) return errorEngineTool(d, `MCP tool "${d.name}" is missing its descriptor.`);
	// A diagnostic descriptor (server failed discovery) degrades immediately.
	if (descriptor.error) return errorEngineTool(d, descriptor.error);

	return {
		name: d.name,
		description: d.description,
		parameters: d.parameters,
		async execute(args, signal) {
			try {
				const { client, toolNames } = await getOrOpen(descriptor);
				// Drift: the frozen descriptor wins. A tool the server no longer offers degrades — the run
				// never silently picks up a new tool the model never saw a schema for.
				if (!toolNames.has(descriptor.toolName)) {
					return errorResult(
						`MCP tool "${descriptor.name}" no longer offered by server "${descriptor.serverId}"`,
					);
				}
				const tool = mcpDescriptorToToolDefinition(descriptor, client);
				return await tool.execute(args, signal);
			} catch (err) {
				await evict(descriptor);
				return errorResult(getErrorMessage(err));
			}
		},
	};
}

function errorEngineTool(d: FrozenToolDescriptor, message: string): EngineTool {
	return {
		name: d.name,
		description: d.description,
		parameters: d.parameters,
		execute: async () => errorResult(message),
	};
}

function errorResult(message: string): EngineToolResult {
	return { content: [{ type: "text", text: `[cove] ${message}` }], isError: true };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
