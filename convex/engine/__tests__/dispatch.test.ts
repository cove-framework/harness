// Tests for the dispatch core (engine/dispatch.ts): parallel, idempotent, cancel-aware, fail-soft.
import { describe, expect, it } from "vitest";
import { type DispatchDeps, runDispatch } from "../dispatch.ts";
import type { EngineTool, EngineToolResult, ToolCallRecord, ToolResultRecord } from "../types.ts";

function tool(name: string, execute: EngineTool["execute"]): EngineTool {
	return { name, description: name, parameters: { type: "object" }, execute };
}

function ok(text: string): EngineToolResult {
	return { content: [{ type: "text", text }] };
}

/** A persistence fake keyed by toolCallId (mirrors replace-in-place idempotency). */
function sink(opts?: { cancelled?: boolean }) {
	const byId = new Map<string, ToolResultRecord>();
	const deps: DispatchDeps = {
		isCancelled: async () => opts?.cancelled ?? false,
		appendToolResult: async (r) => void byId.set(r.toolCallId, r),
	};
	return { deps, byId };
}

const call = (id: string, toolName: string, args: Record<string, unknown> = {}): ToolCallRecord => ({
	toolCallId: id,
	toolName,
	args,
});

describe("runDispatch", () => {
	it("runs tools in parallel and writes each result", async () => {
		const exec = new Map<string, EngineTool>([
			["a", tool("a", async () => ok("A"))],
			["b", tool("b", async (args) => ok(`B:${(args as { x: number }).x}`))],
		]);
		const { deps, byId } = sink();
		await runDispatch([call("1", "a"), call("2", "b", { x: 5 })], exec, deps);
		expect(byId.get("1")?.result).toEqual(ok("A"));
		expect((byId.get("2")?.result as EngineToolResult).content).toEqual([{ type: "text", text: "B:5" }]);
		expect(byId.size).toBe(2);
	});

	it("a throwing tool becomes an error tool-result and does not fail the batch", async () => {
		const exec = new Map<string, EngineTool>([
			["boom", tool("boom", async () => {
				throw new Error("kaboom");
			})],
			["fine", tool("fine", async () => ok("ok"))],
		]);
		const { deps, byId } = sink();
		await runDispatch([call("1", "boom"), call("2", "fine")], exec, deps);
		expect(byId.get("1")?.isError).toBe(true);
		expect((byId.get("1")?.result as EngineToolResult).content[0]).toMatchObject({ text: expect.stringContaining("kaboom") });
		expect(byId.get("2")?.isError).toBeUndefined();
	});

	it("an unknown tool becomes an error tool-result", async () => {
		const { deps, byId } = sink();
		await runDispatch([call("1", "ghost")], new Map(), deps);
		expect(byId.get("1")?.isError).toBe(true);
		expect((byId.get("1")?.result as EngineToolResult).content[0]).toMatchObject({ text: expect.stringContaining("unknown tool") });
	});

	it("cancel short-circuits before running — no results written", async () => {
		let ran = false;
		const exec = new Map<string, EngineTool>([
			["a", tool("a", async () => {
				ran = true;
				return ok("A");
			})],
		]);
		const { deps, byId } = sink({ cancelled: true });
		await runDispatch([call("1", "a")], exec, deps);
		expect(ran).toBe(false);
		expect(byId.size).toBe(0);
	});

	it("discards a late result when cancelled mid-execute", async () => {
		let cancelled = false;
		const exec = new Map<string, EngineTool>([
			["slow", tool("slow", async () => {
				cancelled = true; // flip cancel during execution
				return ok("late");
			})],
		]);
		const byId = new Map<string, ToolResultRecord>();
		const deps: DispatchDeps = {
			isCancelled: async () => cancelled,
			appendToolResult: async (r) => void byId.set(r.toolCallId, r),
		};
		await runDispatch([call("1", "slow")], exec, deps);
		expect(byId.size).toBe(0); // late result discarded
	});

	it("enforces a per-tool deadline → error tool-result", async () => {
		const exec = new Map<string, EngineTool>([
			["hang", tool("hang", () => new Promise<EngineToolResult>(() => {}))], // never resolves
		]);
		const { deps, byId } = sink();
		await runDispatch([call("1", "hang")], exec, { ...deps, perToolTimeoutMs: 15 });
		expect(byId.get("1")?.isError).toBe(true);
		expect((byId.get("1")?.result as EngineToolResult).content[0]).toMatchObject({ text: expect.stringContaining("timed out") });
	});

	it("is idempotent by toolCallId across a replay (replace-in-place)", async () => {
		const exec = new Map<string, EngineTool>([["a", tool("a", async () => ok("A"))]]);
		const { deps, byId } = sink();
		await runDispatch([call("1", "a")], exec, deps);
		await runDispatch([call("1", "a")], exec, deps); // replay
		expect(byId.size).toBe(1);
	});
});
