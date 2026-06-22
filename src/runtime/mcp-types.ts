// Ported from flue · @flue/runtime · packages/runtime/src/mcp.ts (the type surface) → @cove/runtime
//
// Pure / V8-safe: type-only port of flue's MCP contract. NO `@modelcontextprotocol/sdk` import — the SDK
// runtime stays quarantined under convex/mcp/ ("use node"). `AgentProfile.mcpServers` and the frozen
// `McpToolDescriptor` ride this barrel, so they must stay SDK-free. `McpClient` is a STRUCTURAL `Pick`-shaped
// interface (callTool/close/connect/listTools) so the connect module + the test stub share one type without
// importing the SDK `Client`. See doc 08 §3 (network carve-out) / §4.5 (frozen-descriptor rebuild).

import type { ToolParameters } from "./tool-types.ts";

/** Remote MCP transport. */
export type McpTransport = "streamable-http" | "sse";

/** Options for connecting to a remote MCP server (declared on an AgentProfile). */
export interface McpServerOptions {
	/** Server name — the `<server>` in `mcp__<server>__<tool>`. Required for the declarative array form. */
	name: string;
	/** MCP server endpoint. */
	url: string | URL;
	/** Defaults to modern streamable HTTP. Use `'sse'` for legacy MCP servers. */
	transport?: McpTransport;
	/** Headers merged into MCP transport requests (e.g. auth). Frozen onto the plan — see Risks. */
	headers?: Record<string, string>;
	/** Per-request timeout (ms). Clamped to the dispatch per-tool budget (PER_TOOL_TIMEOUT_MS). */
	timeoutMs?: number;
	/** Reset the per-request timeout on each server progress notification. Defaults to false. */
	resetTimeoutOnProgress?: boolean;
}

/** Request options in the MCP SDK's shape (its `timeout` is milliseconds). */
export interface McpRequestOptions {
	timeout?: number;
	resetTimeoutOnProgress?: boolean;
	signal?: AbortSignal;
}

/** Structural subset of an MCP `Tool` discovery record (assignable from the SDK `Tool`). */
export interface McpToolInfo {
	name: string;
	title?: string;
	description?: string;
	inputSchema: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
	outputSchema?: object;
	annotations?: { title?: string; [key: string]: unknown };
	execution?: { taskSupport?: string };
}

/** A content item in an MCP tool result (structural subset of the SDK `CallToolResult.content`). */
export type McpContentItem =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string }
	| { type: "audio"; mimeType: string; data: string }
	| {
			type: "resource";
			resource: { uri: string } & ({ text: string } | { blob: string });
	  }
	| { type: "resource_link"; name: string; uri: string; description?: string }
	| { type: string; [key: string]: unknown };

/** Structural subset of the SDK `CallToolResult`. */
export interface McpCallToolResult {
	content?: McpContentItem[];
	structuredContent?: unknown;
	isError?: boolean;
}

/**
 * Structural MCP client — the `Pick<Client, 'callTool'|'close'|'connect'|'listTools'>` flue used, expressed
 * without importing the SDK so the test stub and the pure descriptor binder share one type. The real SDK
 * `Client` is cast to this at the connect.ts boundary ("use node").
 */
export interface McpClient {
	connect(transport: unknown): Promise<void>;
	listTools(
		params?: { cursor?: string },
		options?: McpRequestOptions,
	): Promise<{ tools: McpToolInfo[]; nextCursor?: string }>;
	callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		resultSchema?: unknown,
		options?: McpRequestOptions,
	): Promise<McpCallToolResult>;
	close(): Promise<void>;
}

/** A live MCP connection: the connected client + the discovered raw tools. close() owns the transport. */
export interface McpServerConnection {
	/** Server name supplied to connectMcpServer. */
	name: string;
	/** The connected client (reused by the pool on the execution path). */
	client: McpClient;
	/** Raw MCP tool discovery records (frozen into descriptors by freezeMcpTool). */
	tools: McpToolInfo[];
	/** Close the underlying MCP client connection. */
	close(): Promise<void>;
}

/**
 * A FROZEN, journal-safe MCP tool descriptor: server identity + transport + the model-facing JSON Schema,
 * **no closure**. `buildTools` re-resolves a client from this on each beat and binds `execute` against it
 * (doc 08 §4.5 — the one sanctioned departure from box-binding). A `error`-bearing descriptor is a
 * diagnostic produced when discovery could not reach the server; it surfaces as an error tool-result.
 */
export interface McpToolDescriptor {
	/** Declared server name (the `<server>` in `mcp__<server>__<tool>`). */
	serverId: string;
	transport: McpTransport;
	url: string;
	headers?: Record<string, string>;
	/** Original MCP tool name (what `callTool` is invoked with). */
	toolName: string;
	/** Adapted model-facing name `mcp__<server>__<tool>`. */
	name: string;
	description: string;
	/** Normalized JSON Schema for the tool arguments. */
	parameters: ToolParameters;
	outputSchema?: object;
	timeoutMs?: number;
	/** Present only on a diagnostic descriptor (discovery connect failure) → an error tool-result. */
	error?: string;
}
