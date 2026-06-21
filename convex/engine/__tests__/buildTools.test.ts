// Tests for buildTools (engine/buildTools.ts): model view + executable rebind by frozen-descriptor kind.
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import type { SessionEnv, ToolDefinition } from "../../../src/runtime/types.ts";
import { buildExecutableTools, buildModelView } from "../buildTools.ts";
import { createResultTools, FINISH_TOOL_NAME } from "../resultTools.ts";
import type { EngineToolResult, FrozenToolDescriptor } from "../types.ts";

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

	it("an mcp descriptor degrades to an error tool-result (P10)", async () => {
		const desc: FrozenToolDescriptor = {
			name: "mcp_tool",
			description: "mcp",
			parameters: { type: "object" },
			kind: "mcp",
			mcp: { serverId: "s", transport: {} },
		};
		const tools = buildExecutableTools([desc], {});
		const r = await tools.get("mcp_tool")!.execute({});
		expect(r.isError).toBe(true);
	});
});
