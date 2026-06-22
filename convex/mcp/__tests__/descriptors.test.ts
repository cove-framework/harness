// New · @cove/runtime — G2.2: frozen MCP descriptors are plain JSON (no closure); the per-beat binder maps
// callTool → tool-result, clamps the timeout, and honors abort/isError.
import { describe, expect, it } from "vitest";
import { PER_TOOL_TIMEOUT_MS } from "../../engine/dispatch.ts";
import {
	clampTimeout,
	createToolName,
	diagnosticDescriptor,
	formatMcpResult,
	freezeMcpTool,
	mcpDescriptorToToolDefinition,
	mcpServerIdentity,
} from "../descriptors.ts";
import type {
	McpCallToolResult,
	McpClient,
	McpServerOptions,
	McpToolInfo,
} from "../../../src/runtime/mcp-types.ts";

const tool: McpToolInfo = {
	name: "my tool!",
	description: "does a thing",
	inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};
const options: McpServerOptions = {
	name: "My Server",
	url: "https://example.test/mcp",
	transport: "streamable-http",
	headers: { authorization: "Bearer x" },
	timeoutMs: 60_000,
};

function recordingClient(canned: McpCallToolResult): {
	client: McpClient;
	calls: { name: string; args?: Record<string, unknown>; timeout?: number }[];
} {
	const calls: { name: string; args?: Record<string, unknown>; timeout?: number }[] = [];
	const client: McpClient = {
		async connect() {},
		async listTools() {
			return { tools: [] };
		},
		async callTool(params, _schema, opts) {
			calls.push({ name: params.name, args: params.arguments, timeout: opts?.timeout });
			return canned;
		},
		async close() {},
	};
	return { client, calls };
}

describe("freezeMcpTool", () => {
	it("freezes a plain-JSON descriptor with a sanitized name, normalized schema, clamped timeout — NO closure", () => {
		const d = freezeMcpTool(options.name, options, tool);
		expect(d.name).toBe("mcp__My_Server__my_tool"); // trailing "_" from "!" is stripped
		expect(d.toolName).toBe("my tool!");
		expect(d.serverId).toBe("My Server");
		expect(d.transport).toBe("streamable-http");
		expect(d.url).toBe("https://example.test/mcp");
		expect(d.timeoutMs).toBe(PER_TOOL_TIMEOUT_MS); // 60_000 clamped to 30_000
		expect(d.parameters).toMatchObject({ type: "object", properties: { q: { type: "string" } } });
		// Journal-safe: round-trips through JSON with no function fields.
		expect(JSON.parse(JSON.stringify(d))).toEqual(d);
		expect(Object.values(d).some((v) => typeof v === "function")).toBe(false);
	});
});

describe("mcpDescriptorToToolDefinition", () => {
	it("binds execute → callTool, returns the formatted text, clamps the request timeout", async () => {
		const d = freezeMcpTool(options.name, options, tool);
		const { client, calls } = recordingClient({ content: [{ type: "text", text: "hello" }] });
		const engineTool = mcpDescriptorToToolDefinition(d, client);
		const r = await engineTool.execute({ q: "hi" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0]).toEqual({ type: "text", text: "hello" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ name: "my tool!", args: { q: "hi" }, timeout: PER_TOOL_TIMEOUT_MS });
	});

	it("maps an isError result to an error tool-result", async () => {
		const d = freezeMcpTool(options.name, options, tool);
		const { client } = recordingClient({ content: [{ type: "text", text: "boom" }], isError: true });
		const r = await mcpDescriptorToToolDefinition(d, client).execute({ q: "x" });
		expect(r.isError).toBe(true);
	});

	it("honors an aborted signal", async () => {
		const d = freezeMcpTool(options.name, options, tool);
		const { client } = recordingClient({ content: [] });
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(mcpDescriptorToToolDefinition(d, client).execute({}, ctrl.signal)).rejects.toThrow(
			/aborted/i,
		);
	});
});

describe("formatMcpResult", () => {
	it("renders structured content + text and collapses image bytes to a placeholder", () => {
		const text = formatMcpResult({
			structuredContent: { ok: true },
			content: [
				{ type: "text", text: "line" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
			],
		});
		expect(text).toContain("Structured content");
		expect(text).toContain("line");
		expect(text).toContain("[Image: image/png, 4 base64 chars]");
		expect(text).not.toContain("AAAA");
	});
	it("returns a sentinel for an empty result", () => {
		expect(formatMcpResult({})).toBe("(MCP tool returned no content)");
	});
});

describe("helpers", () => {
	it("createToolName sanitizes both parts", () => {
		expect(createToolName("a b", "c/d")).toBe("mcp__a_b__c_d");
	});
	it("clampTimeout caps at the per-tool budget and defaults to it", () => {
		expect(clampTimeout(60_000)).toBe(PER_TOOL_TIMEOUT_MS);
		expect(clampTimeout(undefined)).toBe(PER_TOOL_TIMEOUT_MS);
		expect(clampTimeout(5_000)).toBe(5_000);
	});
	it("mcpServerIdentity is stable per server and varies by url", () => {
		const a = freezeMcpTool(options.name, options, tool);
		const b = freezeMcpTool(options.name, { ...options, url: "https://other.test/mcp" }, tool);
		expect(mcpServerIdentity(a)).toBe(mcpServerIdentity(a));
		expect(mcpServerIdentity(a)).not.toBe(mcpServerIdentity(b));
	});
	it("diagnosticDescriptor carries the error and an error tool name", () => {
		const d = diagnosticDescriptor("srv", options, "connect refused");
		expect(d.error).toBe("connect refused");
		expect(d.name).toBe("mcp__srv__error");
	});
});
