// Tests for the result tools + durable outcome derivation (engine/resultTools.ts).
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
	buildPromptText,
	buildResultFollowUpPrompt,
	computeResultOutcome,
	createResultTools,
	FINISH_TOOL_NAME,
	GIVE_UP_TOOL_NAME,
} from "../resultTools.ts";
import type { ToolResultRecord } from "../types.ts";

describe("createResultTools (object schema)", () => {
	const schema = v.object({ answer: v.string() });
	it("finish accepts a valid payload, captures the value, and terminates", async () => {
		const bundle = createResultTools(schema);
		const finish = bundle.tools.find((t) => t.name === FINISH_TOOL_NAME)!;
		const r = await finish.execute({ answer: "42" });
		expect(r.terminate).toBe(true);
		expect((r.details as { result: { answer: string } }).result).toEqual({ answer: "42" });
		expect(bundle.getOutcome()).toEqual({ type: "finished", value: { answer: "42" } });
	});
	it("finish throws on a schema-invalid payload (→ error tool-result)", async () => {
		const bundle = createResultTools(schema);
		const finish = bundle.tools.find((t) => t.name === FINISH_TOOL_NAME)!;
		await expect(finish.execute({ answer: 123 as unknown as string })).rejects.toThrow(
			/does not match the required schema/,
		);
		expect(bundle.getOutcome()).toEqual({ type: "pending" });
	});
	it("give_up records the reason and terminates", async () => {
		const bundle = createResultTools(schema);
		const giveUp = bundle.tools.find((t) => t.name === GIVE_UP_TOOL_NAME)!;
		const r = await giveUp.execute({ reason: "cannot determine" });
		expect(r.terminate).toBe(true);
		expect(bundle.getOutcome()).toEqual({ type: "gave_up", reason: "cannot determine" });
	});
	it("a second terminal call is a no-op error, not a throw", async () => {
		const bundle = createResultTools(schema);
		const finish = bundle.tools.find((t) => t.name === FINISH_TOOL_NAME)!;
		await finish.execute({ answer: "ok" });
		const again = await finish.execute({ answer: "ok2" });
		expect((again.details as { alreadyDone: boolean }).alreadyDone).toBe(true);
		expect(bundle.getOutcome()).toEqual({ type: "finished", value: { answer: "ok" } });
	});
});

describe("createResultTools (non-object schema is enveloped)", () => {
	it("wraps a bare schema in { result } and unwraps on execute", async () => {
		const bundle = createResultTools(v.string());
		const finish = bundle.tools.find((t) => t.name === FINISH_TOOL_NAME)!;
		const params = finish.parameters as { properties: Record<string, unknown> };
		expect(params.properties).toHaveProperty("result");
		const r = await finish.execute({ result: "hello" });
		expect((r.details as { result: string }).result).toBe("hello");
	});
});

describe("computeResultOutcome (durable, from persisted rows)", () => {
	it("derives finished from a persisted finish result", () => {
		const rows: ToolResultRecord[] = [
			{
				toolCallId: "c1",
				toolName: FINISH_TOOL_NAME,
				result: { content: [], details: { tool: FINISH_TOOL_NAME, result: { answer: "42" } } },
			},
		];
		expect(computeResultOutcome(rows)).toEqual({ type: "finished", value: { answer: "42" } });
	});
	it("derives gave_up from a persisted give_up result", () => {
		const rows: ToolResultRecord[] = [
			{
				toolCallId: "c1",
				toolName: GIVE_UP_TOOL_NAME,
				result: { content: [], details: { tool: GIVE_UP_TOOL_NAME, reason: "nope" } },
			},
		];
		expect(computeResultOutcome(rows)).toEqual({ type: "gave_up", reason: "nope" });
	});
	it("is pending when no terminal tool fired, and ignores error results", () => {
		const rows: ToolResultRecord[] = [
			{ toolCallId: "c0", toolName: "read", result: { content: [] } },
			{
				toolCallId: "c1",
				toolName: FINISH_TOOL_NAME,
				isError: true,
				result: { content: [], isError: true },
			},
		];
		expect(computeResultOutcome(rows)).toEqual({ type: "pending" });
	});
});

describe("prompt helpers", () => {
	it("buildPromptText appends the footer only when a schema is set", () => {
		expect(buildPromptText("do it", false)).toBe("do it");
		const withFooter = buildPromptText("do it", true);
		expect(withFooter).toContain("do it");
		expect(withFooter).toContain(FINISH_TOOL_NAME);
		expect(withFooter).toContain(GIVE_UP_TOOL_NAME);
	});
	it("buildResultFollowUpPrompt names both result tools", () => {
		const p = buildResultFollowUpPrompt();
		expect(p).toContain(FINISH_TOOL_NAME);
		expect(p).toContain(GIVE_UP_TOOL_NAME);
	});
});
