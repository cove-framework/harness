// Tests for buildTools (engine/buildTools.ts): model view + executable rebind by frozen-descriptor kind.
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import type { SessionEnv, ToolDefinition } from "../../../src/runtime/types.ts";
import { buildExecutableTools, buildModelView, freezeUserToolDescriptors, wrapToolsWithHooks } from "../buildTools.ts";
import type { BoundHooks } from "../../../src/runtime/extensions/apply.ts";
import type { ExtensionContext, ExtensionHandler } from "../../../src/runtime/extensions/types.ts";
import { createResultTools, FINISH_TOOL_NAME } from "../resultTools.ts";
import type { EngineTool, EngineToolResult, FrozenToolDescriptor } from "../types.ts";

function readOnlyEnv(files: Record<string, string>): SessionEnv {
	const map = new Map(Object.entries(files));
	const readFile = async (p: string) => {
		const f = map.get(p);
		if (f === undefined) throw new Error(`ENOENT: ${p}`);
		return f;
	};
	return {
		cwd: "/work",
		resolvePath: (p) => p,
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		readFile,
		readFileBuffer: async (p) => new TextEncoder().encode(await readFile(p)),
		writeFile: async () => {},
		stat: async (p) => {
			if (!map.has(p)) throw new Error(`ENOENT: ${p}`);
			return { isFile: true, isDirectory: false };
		},
		readdir: async () => [],
		exists: async (p) => map.has(p),
		mkdir: async () => {},
		rm: async () => {},
	};
}

const firstText = (r: EngineToolResult): string => {
	const block = r.content[0];
	return block && block.type === "text" ? block.text : "";
};

const builtinRead: FrozenToolDescriptor = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	kind: "builtin",
};

describe("buildModelView", () => {
	it("projects name/description/parameters from the frozen descriptors", () => {
		const view = buildModelView([builtinRead]);
		expect(view).toEqual([
			{ name: "read", description: "Read a file", parameters: builtinRead.parameters },
		]);
	});
});

describe("buildExecutableTools", () => {
	it("rebinds a builtin tool against the session env", async () => {
		const env = readOnlyEnv({ "/work/a.txt": "hi" });
		const tools = buildExecutableTools([builtinRead], { env });
		const r = await tools.get("read")!.execute({ path: "/work/a.txt" });
		expect(firstText(r)).toBe("hi");
	});

	it("a builtin with no env degrades to an error tool-result (no crash)", async () => {
		const tools = buildExecutableTools([builtinRead], {});
		const r = await tools.get("read")!.execute({ path: "/x" });
		expect(r.isError).toBe(true);
		expect(firstText(r)).toContain("no sandbox env");
	});

	it("rebinds a re-resolved user tool, wrapping its string output", async () => {
		const echo: ToolDefinition = {
			name: "echo",
			description: "echo",
			parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
			execute: async (args) => `echoed:${(args as { msg: string }).msg}`,
		};
		const desc: FrozenToolDescriptor = {
			name: "echo",
			description: "echo",
			parameters: echo.parameters,
			kind: "user",
		};
		const tools = buildExecutableTools([desc], { userTools: new Map([["echo", echo]]) });
		const r = await tools.get("echo")!.execute({ msg: "hey" });
		expect(firstText(r)).toBe("echoed:hey");
	});

	it("rebinds a user tool returning a structured ToolResult (image + isError + details)", async () => {
		const rich: ToolDefinition = {
			name: "rich",
			description: "rich",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => ({
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
				isError: true,
				details: { k: 1 },
			}),
		};
		const desc: FrozenToolDescriptor = {
			name: "rich",
			description: "rich",
			parameters: rich.parameters,
			kind: "user",
		};
		const tools = buildExecutableTools([desc], { userTools: new Map([["rich", rich]]) });
		const r = await tools.get("rich")!.execute({});
		expect(r.isError).toBe(true);
		expect(r.details).toEqual({ k: 1 });
		expect(r.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
	});

	it("validates a valibot user tool's args at execute (throws → dispatcher error result)", async () => {
		const typed: ToolDefinition = {
			name: "typed",
			description: "typed",
			parameters: v.object({ n: v.number() }),
			execute: async (args) => `n=${(args as { n: number }).n}`,
		};
		const desc: FrozenToolDescriptor = {
			name: "typed",
			description: "typed",
			parameters: { type: "object" },
			kind: "user",
		};
		const tools = buildExecutableTools([desc], { userTools: new Map([["typed", typed]]) });
		await expect(tools.get("typed")!.execute({ n: "not-a-number" })).rejects.toThrow();
	});

	it("an unresolved user tool degrades to an error tool-result", async () => {
		const desc: FrozenToolDescriptor = {
			name: "missing",
			description: "missing",
			parameters: { type: "object" },
			kind: "user",
		};
		const tools = buildExecutableTools([desc], { userTools: new Map() });
		const r = await tools.get("missing")!.execute({});
		expect(r.isError).toBe(true);
		expect(firstText(r)).toContain("could not be resolved");
	});

	it("rebinds result tools from the bundle", async () => {
		const bundle = createResultTools(v.object({ answer: v.string() }));
		const desc: FrozenToolDescriptor = {
			name: FINISH_TOOL_NAME,
			description: "finish",
			parameters: { type: "object" },
			kind: "result",
		};
		const tools = buildExecutableTools([desc], { resultBundle: bundle });
		const r = await tools.get(FINISH_TOOL_NAME)!.execute({ answer: "ok" });
		expect(r.terminate).toBe(true);
	});

	const mcpDesc: FrozenToolDescriptor = {
		name: "mcp__srv__search",
		description: "MCP search tool",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		kind: "mcp",
		mcp: {
			serverId: "srv",
			transport: "streamable-http",
			url: "https://example.test/mcp",
			toolName: "search",
			name: "mcp__srv__search",
			description: "MCP search tool",
			parameters: { type: "object", properties: {} },
		},
	};

	it("exposes an mcp descriptor as a JSON-Schema tool in the model view", () => {
		const view = buildModelView([mcpDesc]);
		expect(view).toEqual([
			{
				name: "mcp__srv__search",
				description: "MCP search tool",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		]);
	});

	it("an mcp descriptor binds via the injected resolver (success path)", async () => {
		let called = false;
		const mcpResolve = (d: FrozenToolDescriptor) => ({
			name: d.name,
			description: d.description,
			parameters: d.parameters,
			async execute(): Promise<EngineToolResult> {
				called = true;
				return { content: [{ type: "text" as const, text: "mcp ok" }] };
			},
		});
		const tools = buildExecutableTools([mcpDesc], { mcpResolve });
		const r = await tools.get("mcp__srv__search")!.execute({});
		expect(called).toBe(true);
		expect(r.isError).toBeFalsy();
		expect(firstText(r)).toBe("mcp ok");
	});

	it("an mcp resolver failure degrades to an error tool-result (never a crash)", async () => {
		const mcpResolve = () => {
			throw new Error("connect failed");
		};
		const tools = buildExecutableTools([mcpDesc], { mcpResolve });
		const r = await tools.get("mcp__srv__search")!.execute({});
		expect(r.isError).toBe(true);
	});

	it("an mcp descriptor with no resolver degrades (llmStep model-view path)", async () => {
		const tools = buildExecutableTools([mcpDesc], {});
		const r = await tools.get("mcp__srv__search")!.execute({});
		expect(r.isError).toBe(true);
		expect(firstText(r)).toContain("no resolver");
	});
});

describe("wrapToolsWithHooks (extension tool_call/tool_result)", () => {
	const CTX: ExtensionContext = { appendEntry: () => {}, getContextUsage: () => undefined };
	const hooksOf = (event: string, ...handlers: ExtensionHandler[]): BoundHooks =>
		new Map([[event as never, handlers]]);
	const echoTool = (): Map<string, EngineTool> =>
		new Map([
			[
				"echo",
				{
					name: "echo",
					description: "echo",
					parameters: { type: "object" },
					execute: async (args: Record<string, unknown>): Promise<EngineToolResult> => ({
						content: [{ type: "text", text: String(args.msg ?? "") }],
					}),
				},
			],
		]);

	it("returns the map unchanged when no tool hooks are bound", () => {
		const tools = echoTool();
		expect(wrapToolsWithHooks(tools, new Map(), CTX)).toBe(tools);
	});

	it("blocks a call when a tool_call hook returns block", async () => {
		const wrapped = wrapToolsWithHooks(echoTool(), hooksOf("tool_call", () => ({ block: true, reason: "nope" })), CTX);
		const r = await wrapped.get("echo")!.execute({ msg: "hi" });
		expect(r.isError).toBe(true);
		expect(firstText(r)).toContain("blocked by extension: nope");
	});

	it("mutates args before execute and patches the result", async () => {
		const hooks: BoundHooks = new Map([
			["tool_call" as never, [(() => ({ args: { msg: "mutated" } })) as ExtensionHandler]],
			["tool_result" as never, [(() => ({ isError: true })) as ExtensionHandler]],
		]);
		const wrapped = wrapToolsWithHooks(echoTool(), hooks, CTX);
		const r = await wrapped.get("echo")!.execute({ msg: "original" });
		expect(firstText(r)).toBe("mutated"); // tool_call rewrote args
		expect(r.isError).toBe(true); // tool_result patched isError
	});
});

describe("freezeUserToolDescriptors", () => {
	const mk = (name: string): ToolDefinition => ({
		name,
		description: name,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => "x",
	});

	it("freezes registered tools as kind:user descriptors", () => {
		const r = freezeUserToolDescriptors([mk("a"), mk("b")], new Set(), () => true);
		expect(r.descriptors.map((d) => d.name)).toEqual(["a", "b"]);
		expect(r.descriptors.every((d) => d.kind === "user")).toBe(true);
		expect(r.skipped).toEqual([]);
		expect(r.collisions).toEqual([]);
	});

	it("skips tools not recoverable from the registry (inline-in-initialize)", () => {
		const r = freezeUserToolDescriptors([mk("a"), mk("b")], new Set(), (n) => n === "a");
		expect(r.descriptors.map((d) => d.name)).toEqual(["a"]);
		expect(r.skipped).toEqual(["b"]);
		expect(r.collisions).toEqual([]);
	});

	it("reports collisions with existing names without freezing them", () => {
		const r = freezeUserToolDescriptors([mk("read")], new Set(["read"]), () => true);
		expect(r.descriptors).toEqual([]);
		expect(r.collisions).toEqual(["read"]);
		expect(r.skipped).toEqual([]);
	});
});
