// New (Convex backend) · @cove/runtime
// Pattern source: flue · @flue/runtime · packages/runtime/src/mcp.ts (createMcpTools 137-190, the helpers
// 229-294). The INVERSE of flue's connect-time tool build: instead of producing a live ToolDefinition with a
// closure over `client` (which can't cross the workflow journal), `freezeMcpTool` produces a plain-JSON
// `McpToolDescriptor` (server identity + transport + JSON schema, NO closure), and
// `mcpDescriptorToToolDefinition` rebuilds the `execute` per beat from a frozen descriptor + an injected
// client (doc 08 §4.5). The name/description/schema/format helpers are ported verbatim from flue.
//
// Pure / V8-safe: NO `@modelcontextprotocol/sdk` import — the `client` is injected (typed structurally as
// McpClient). Output-schema (ajv) validation is intentionally dropped (an edge feature needing the SDK
// validator; not covered by acceptance) — see G2.2 scope.

import { PER_TOOL_TIMEOUT_MS } from "../engine/dispatch.ts";
import type { EngineTool } from "../engine/types.ts";
import type { ToolParameters } from "../../src/runtime/tool-types.ts";
import type {
	McpCallToolResult,
	McpClient,
	McpServerOptions,
	McpToolDescriptor,
	McpToolInfo,
} from "../../src/runtime/mcp-types.ts";

/** Clamp an MCP request timeout to the dispatch per-tool budget so a hung call can't outlive the action. */
export function clampTimeout(timeoutMs: number | undefined): number {
	return Math.min(timeoutMs ?? PER_TOOL_TIMEOUT_MS, PER_TOOL_TIMEOUT_MS);
}

/** `mcp__<server>__<tool>`, unsupported chars → `_`. */
export function createToolName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
}

function sanitizeToolNamePart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	return sanitized || "unnamed";
}

function createToolDescription(serverName: string, tool: McpToolInfo): string {
	const title = tool.title ?? tool.annotations?.title;
	const parts = [`MCP tool "${tool.name}" from server "${serverName}".`];
	if (title && title !== tool.name) parts.push(`Title: ${title}.`);
	if (tool.description) parts.push(tool.description);
	return parts.join(" ");
}

function normalizeInputSchema(schema: McpToolInfo["inputSchema"]): ToolParameters {
	return {
		...schema,
		type: schema.type ?? "object",
		properties: schema.properties ?? {},
		required: schema.required,
	};
}

/** Stable per-server identity for the connection pool: transport + url + sorted headers. */
export function mcpServerIdentity(descriptor: McpToolDescriptor): string {
	const headers = descriptor.headers
		? Object.keys(descriptor.headers)
				.sort()
				.map((k) => `${k}=${descriptor.headers?.[k]}`)
				.join("&")
		: "";
	return `${descriptor.transport}|${descriptor.url}|${headers}`;
}

/**
 * Freeze one discovered MCP tool into a plain-JSON descriptor (no closure). The duplicate-name reject
 * (flue mcp.ts:159) lands in the discovery loop (callers pass a fresh set per server); the inter-server /
 * framework collision check lands in setup.
 */
export function freezeMcpTool(
	serverId: string,
	options: McpServerOptions,
	tool: McpToolInfo,
): McpToolDescriptor {
	return {
		serverId,
		transport: options.transport ?? "streamable-http",
		url: typeof options.url === "string" ? options.url : options.url.toString(),
		headers: options.headers,
		toolName: tool.name,
		name: createToolName(serverId, tool.name),
		description: createToolDescription(serverId, tool),
		parameters: normalizeInputSchema(tool.inputSchema),
		outputSchema: tool.outputSchema,
		timeoutMs: clampTimeout(options.timeoutMs),
	};
}

/** A diagnostic descriptor for a server that failed discovery — surfaces as an error tool-result. */
export function diagnosticDescriptor(
	serverId: string,
	options: McpServerOptions,
	error: string,
): McpToolDescriptor {
	return {
		serverId,
		transport: options.transport ?? "streamable-http",
		url: typeof options.url === "string" ? options.url : options.url.toString(),
		toolName: "error",
		name: createToolName(serverId, "error"),
		description: `MCP server "${serverId}" failed to connect during discovery.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		error,
	};
}

/** Port of flue formatMcpResult (mcp.ts:256-294): collapse an MCP result to text; image/audio/blobs → placeholders. */
export function formatMcpResult(result: McpCallToolResult): string {
	const parts: string[] = [];
	if (result.structuredContent !== undefined) {
		parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
	}
	for (const item of result.content ?? []) {
		if (item.type === "text") {
			parts.push((item as { text: string }).text);
		} else if (item.type === "image") {
			const it = item as { mimeType: string; data: string };
			parts.push(`[Image: ${it.mimeType}, ${it.data.length} base64 chars]`);
		} else if (item.type === "audio") {
			const it = item as { mimeType: string; data: string };
			parts.push(`[Audio: ${it.mimeType}, ${it.data.length} base64 chars]`);
		} else if (item.type === "resource") {
			const resource = (item as { resource: { uri: string } & ({ text: string } | { blob: string }) })
				.resource;
			if ("text" in resource) parts.push(`[Resource: ${resource.uri}]\n${resource.text}`);
			else parts.push(`[Resource: ${resource.uri}, ${resource.blob.length} base64 chars]`);
		} else if (item.type === "resource_link") {
			const it = item as { name: string; uri: string; description?: string };
			const description = it.description ? ` - ${it.description}` : "";
			parts.push(`[Resource link: ${it.name} (${it.uri})${description}]`);
		} else {
			parts.push(JSON.stringify(item));
		}
	}
	return parts.filter(Boolean).join("\n\n") || "(MCP tool returned no content)";
}

/**
 * Rebuild a tool's `execute` per beat from a frozen descriptor + a re-resolved client (the network bind).
 * The closure-over-client is exactly what makes the tool network-bound — never frozen, always rebuilt. A
 * tool failure (isError) becomes an error tool-result; the timeout is clamped to the per-tool budget.
 */
export function mcpDescriptorToToolDefinition(
	descriptor: McpToolDescriptor,
	client: McpClient,
): EngineTool {
	return {
		name: descriptor.name,
		description: descriptor.description,
		parameters: descriptor.parameters,
		async execute(args, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const result = await client.callTool(
				{ name: descriptor.toolName, arguments: args },
				undefined,
				{ timeout: clampTimeout(descriptor.timeoutMs), signal },
			);
			const text = formatMcpResult(result);
			return result.isError
				? { content: [{ type: "text", text }], isError: true }
				: { content: [{ type: "text", text }] };
		},
	};
}
