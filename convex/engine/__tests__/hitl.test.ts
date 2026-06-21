// Tests for the pure HITL gate decision logic (engine/hitl.ts).
import { describe, expect, it } from "vitest";
import { applyApprovalDecision, partitionGatedToolCalls } from "../hitl.ts";
import type { ToolCallRecord } from "../types.ts";

const call = (id: string, isHitl?: boolean): ToolCallRecord => ({
	toolCallId: id,
	toolName: "bash",
	args: { command: "ls" },
	isHitl,
});

describe("partitionGatedToolCalls", () => {
	it("splits gated (isHitl) from ungated", () => {
		const { gated, ungated } = partitionGatedToolCalls([call("a", true), call("b"), call("c", true)]);
		expect(gated.map((c) => c.toolCallId)).toEqual(["a", "c"]);
		expect(ungated.map((c) => c.toolCallId)).toEqual(["b"]);
	});
});

describe("applyApprovalDecision", () => {
	it("approve → dispatch the original call", () => {
		const c = call("a", true);
		expect(applyApprovalDecision(c, { approved: true })).toEqual({ action: "dispatch", call: c });
	});

	it("approve with edited args → dispatch with the edited args", () => {
		const out = applyApprovalDecision(call("a", true), { approved: true, editedArgs: { command: "echo safe" } });
		expect(out.action).toBe("dispatch");
		if (out.action === "dispatch") expect(out.call.args).toEqual({ command: "echo safe" });
	});

	it("reject → an error tool-result carrying the reason", () => {
		const out = applyApprovalDecision(call("a", true), { approved: false, reason: "too risky" });
		expect(out.action).toBe("reject");
		if (out.action === "reject") {
			expect(out.result.isError).toBe(true);
			expect(out.result.content[0]).toMatchObject({ text: expect.stringContaining("too risky") });
		}
	});
});
