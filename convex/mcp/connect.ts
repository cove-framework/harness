"use node";
// Ported from flue · @flue/runtime · packages/runtime/src/mcp.ts → @cove/runtime · @modelcontextprotocol/sdk
//
// The MCP SDK boundary. "use node": imports `@modelcontextprotocol/sdk` (Client + transports). Near-verbatim
// port of flue's connectMcpServer / connectMcpServerWithClient / createTransport (incl. the `'sse'` dynamic
// import) + the paginated listTools with the repeated-cursor guard. flue's createMcpTools (live closures) is
// NOT ported here — cove freezes descriptors (descriptors.ts) and rebinds execute per beat. The SDK stays
// quarantined: `grep -rn "@modelcontextprotocol/sdk" src/` is empty; this file + pool.ts/discover.ts are the
// only importers, all "use node". Rebranded `'flue'`→`'cove'`, `[flue]`→`[cove]`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	McpClient,
	McpRequestOptions,
	McpServerConnection,
	McpServerOptions,
	McpToolDescriptor,
	McpToolInfo,
} from "../../src/runtime/mcp-types.ts";

const COVE_VERSION = "0.0.0";

/** Connect to a remote MCP server and discover its raw tools (one-shot, for setup discovery). */
export async function connectMcpServer(
	name: string,
	options: McpServerOptions,
): Promise<McpServerConnection> {
	const url = options.url instanceof URL ? options.url : new URL(options.url);
	const transport = await createTransport(url, options.transport ?? "streamable-http", options.headers);
	const client = new Client({ name: "cove", version: COVE_VERSION }) as unknown as McpClient;
	return connectMcpServerWithClient(name, client, transport, {
		timeout: options.timeoutMs,
		resetTimeoutOnProgress: options.resetTimeoutOnProgress,
	});
}

/** The injectable seam (flue mcp.ts:85): connect + paginated discovery against any McpClient (incl. a test stub). */
export async function connectMcpServerWithClient(
	name: string,
	client: McpClient,
	transport: unknown,
	requestOptions: McpRequestOptions = {},
): Promise<McpServerConnection> {
	try {
		await client.connect(transport);
		const tools = await listAllTools(name, client, requestOptions);
		return { name, client, tools, close: () => client.close() };
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

/**
 * Open a connected client from a FROZEN descriptor (the per-beat execution path; used by the pool).
 * Returns the client + the set of original tool names it currently offers (for the drift check).
 */
export async function openMcpConnection(
	descriptor: McpToolDescriptor,
): Promise<{ client: McpClient; toolNames: Set<string> }> {
	const url = new URL(descriptor.url);
	const transport = await createTransport(url, descriptor.transport, descriptor.headers);
	const client = new Client({ name: "cove", version: COVE_VERSION }) as unknown as McpClient;
	try {
		await client.connect(transport);
		const tools = await listAllTools(descriptor.serverId, client, {
			timeout: descriptor.timeoutMs,
		});
		return { client, toolNames: new Set(tools.map((t) => t.name)) };
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

/** Paginated tools/list with the repeated-cursor guard (flue mcp.ts:93-105). */
async function listAllTools(
	name: string,
	client: McpClient,
	requestOptions: McpRequestOptions,
): Promise<McpToolInfo[]> {
	let page = await client.listTools(undefined, requestOptions);
	const tools = [...page.tools];
	const seenCursors = new Set<string>();
	while (page.nextCursor !== undefined) {
		if (seenCursors.has(page.nextCursor)) {
			throw new Error(
				`[cove] MCP server "${name}" repeated tools/list cursor ${JSON.stringify(page.nextCursor)} during tool discovery.`,
			);
		}
		seenCursors.add(page.nextCursor);
		page = await client.listTools({ cursor: page.nextCursor }, requestOptions);
		tools.push(...page.tools);
	}
	return tools;
}

/** streamable-http default; `'sse'` dynamic import so a streamable-only build never bundles it (flue mcp.ts:118). */
async function createTransport(
	url: URL,
	transport: McpToolDescriptor["transport"],
	headers: Record<string, string> | undefined,
): Promise<unknown> {
	const requestInit: RequestInit = headers ? { headers } : {};
	if (transport === "sse") {
		const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
		return new SSEClientTransport(url, { requestInit });
	}
	return new StreamableHTTPClientTransport(url, { requestInit });
}
