// Tests for the name-keyed tool registry sidecar (src/runtime/tool-registry.ts).
import { afterEach, describe, expect, it } from "vitest";
import { defineTool } from "../tool.ts";
import {
	defineToolRegistry,
	getRegisteredTool,
	listRegisteredTools,
	registerToolRegistry,
	resetToolRegistryForTests,
} from "../tool-registry.ts";

const echo = defineTool({
	name: "echo",
	description: "Echo the input text back.",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	},
	execute: async (args) => String((args as { text: string }).text),
});

afterEach(resetToolRegistryForTests);

describe("defineToolRegistry", () => {
	it("round-trips a name → tool map", () => {
		const reg = defineToolRegistry({ echo });
		expect(reg.has("echo")).toBe(true);
		expect(reg.has("missing")).toBe(false);
		expect(reg.get("echo")).toBe(echo);
		expect(reg.names).toEqual(["echo"]);
		expect(reg.listTools()).toEqual([{ name: "echo" }]);
	});

	it("rejects a non-map argument", () => {
		expect(() => defineToolRegistry(null as never)).toThrow(/name → tool definition map/);
		expect(() => defineToolRegistry([] as never)).toThrow(/name → tool definition map/);
	});

	it("rejects a key that does not match the tool's own name", () => {
		expect(() => defineToolRegistry({ wrong: { ...echo, name: "echo" } })).toThrow(
			/does not match tool name/,
		);
	});

	it("rejects values missing the tool shape", () => {
		expect(() => defineToolRegistry({ bad: { name: "bad" } as never })).toThrow(/description/);
	});
});

describe("module-scoped active registry", () => {
	it("is empty until installed, recovers closures by name, then clears", async () => {
		expect(getRegisteredTool("echo")).toBeUndefined();
		expect(listRegisteredTools()).toEqual([]);

		registerToolRegistry(defineToolRegistry({ echo }));
		const recovered = getRegisteredTool("echo");
		expect(recovered).toBe(echo);
		expect(await recovered?.execute({ text: "hi" } as never)).toBe("hi");
		expect(listRegisteredTools()).toEqual([{ name: "echo" }]);

		resetToolRegistryForTests();
		expect(getRegisteredTool("echo")).toBeUndefined();
	});
});
