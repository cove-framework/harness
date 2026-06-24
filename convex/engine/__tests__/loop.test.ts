// Tests for the agent-loop control flow (engine/loop.ts) against scripted journaled-op deps.
import { describe, expect, it } from "vitest";
import { ResultUnavailableError } from "../../../src/runtime/errors.ts";
import { type FinalizeInput, type LoopPlan, type RunLoopDeps, runAgentLoop } from "../loop.ts";
import type { ResultOutcome } from "../resultTools.ts";
import type { StepDecision, ToolCallRecord } from "../types.ts";

const stop = (text: string): StepDecision => ({ finishReason: "stop", toolCalls: [], text, shouldCompact: false });
const withTools = (text: string, toolCalls: ToolCallRecord[]): StepDecision => ({
	finishReason: "tool-calls",
	toolCalls,
	text,
	shouldCompact: false,
});
const call = (name: string): ToolCallRecord => ({ toolCallId: `c-${name}`, toolName: name, args: {} });
const overflow = (): StepDecision => ({
	finishReason: "context_overflow",
	toolCalls: [],
	text: "",
	shouldCompact: false,
	overflow: true,
});

function makeDeps(opts: { decisions: StepDecision[]; outcomes?: ResultOutcome[] }) {
	const finalizes: FinalizeInput[] = [];
	const dispatched: Array<{ stepNumber: number; toolCalls: ToolCallRecord[] }> = [];
	const followUps: string[] = [];
	const compacts: number[] = [];
	let d = 0;
	let o = 0;
	const deps: RunLoopDeps = {
		decode: async () => {
			const next = opts.decisions[d++];
			if (!next) throw new Error("loop decoded more steps than scripted");
			return next;
		},
		dispatch: async (stepNumber, toolCalls) => void dispatched.push({ stepNumber, toolCalls }),
		getOutcome: async () => opts.outcomes?.[o++] ?? { type: "pending" },
		appendFollowUp: async (p) => void followUps.push(p),
		finalize: async (f) => void finalizes.push(f),
		compact: async (stepNumber) => void compacts.push(stepNumber),
	};
	return { deps, finalizes, dispatched, followUps, compacts };
}

const plan = (over?: Partial<LoopPlan>): LoopPlan => ({
	maxSteps: 100,
	maxFollowUps: 32,
	hasResultSchema: false,
	...over,
});

describe("free-form run", () => {
	it("completes when the model stops with no tool calls", async () => {
		const h = makeDeps({ decisions: [stop("all done")] });
		await runAgentLoop(plan(), h.deps);
		expect(h.finalizes).toEqual([{ status: "completed", finalText: "all done" }]);
		expect(h.dispatched).toHaveLength(0);
	});

	it("dispatches tool calls, then completes on the next stop", async () => {
		const h = makeDeps({ decisions: [withTools("", [call("read")]), stop("done")] });
		await runAgentLoop(plan(), h.deps);
		expect(h.dispatched).toHaveLength(1);
		expect(h.dispatched[0]?.toolCalls.map((t) => t.toolName)).toEqual(["read"]);
		expect(h.finalizes).toEqual([{ status: "completed", finalText: "done" }]);
	});
});

describe("step cap (doc 08 §4.9)", () => {
	it("terminalizes failed/step_limit_exceeded when maxSteps is reached", async () => {
		const h = makeDeps({ decisions: [withTools("", [call("bash")]), withTools("", [call("bash")]), withTools("", [call("bash")])] });
		await runAgentLoop(plan({ maxSteps: 3 }), h.deps);
		expect(h.dispatched).toHaveLength(3);
		expect(h.finalizes).toEqual([{ status: "failed", reason: "step_limit_exceeded" }]);
	});
});

describe("context-overflow recovery (Phase 4b)", () => {
	it("compacts and advances to a fresh step after overflow, then completes", async () => {
		const h = makeDeps({ decisions: [overflow(), stop("recovered")] });
		await runAgentLoop(plan(), h.deps);
		expect(h.compacts).toEqual([0]); // compacted the overflow step
		expect(h.dispatched).toHaveLength(0);
		expect(h.finalizes).toEqual([{ status: "completed", finalText: "recovered" }]);
	});

	it("fails with context_overflow once the retry budget is exhausted", async () => {
		const h = makeDeps({ decisions: [overflow(), overflow()] });
		await runAgentLoop(plan({ overflowRetryBudget: 1 }), h.deps);
		expect(h.compacts).toEqual([0]); // one retry, then the second overflow exceeds the budget
		expect(h.finalizes).toEqual([{ status: "failed", reason: "context_overflow" }]);
	});

	it("fails immediately with a zero budget (no retry)", async () => {
		const h = makeDeps({ decisions: [overflow()] });
		await runAgentLoop(plan({ overflowRetryBudget: 0 }), h.deps);
		expect(h.compacts).toEqual([]);
		expect(h.finalizes).toEqual([{ status: "failed", reason: "context_overflow" }]);
	});
});

describe("result-schema run (doc 08 §4.10)", () => {
	it("completes with the validated result when finish fires", async () => {
		const h = makeDeps({
			decisions: [withTools("here", [call("finish")])],
			outcomes: [{ type: "finished", value: { answer: 42 } }],
		});
		await runAgentLoop(plan({ hasResultSchema: true }), h.deps);
		expect(h.finalizes).toEqual([
			{ status: "completed", result: { answer: 42 }, finalText: "here" },
		]);
	});

	it("re-nudges a pending stop, then completes when finish fires", async () => {
		const h = makeDeps({
			decisions: [stop("forgot to finish"), withTools("now finishing", [call("finish")])],
			outcomes: [{ type: "pending" }, { type: "finished", value: "ok" }],
		});
		await runAgentLoop(plan({ hasResultSchema: true }), h.deps);
		expect(h.followUps).toHaveLength(1);
		expect(h.finalizes).toEqual([{ status: "completed", result: "ok", finalText: "now finishing" }]);
	});

	it("rejects with ResultUnavailableError after exhausting maxFollowUps", async () => {
		const h = makeDeps({
			decisions: [stop("a"), stop("b"), stop("c")],
			outcomes: [{ type: "pending" }, { type: "pending" }, { type: "pending" }],
		});
		await expect(runAgentLoop(plan({ hasResultSchema: true, maxFollowUps: 2 }), h.deps)).rejects.toBeInstanceOf(
			ResultUnavailableError,
		);
		expect(h.followUps).toHaveLength(2);
		expect(h.finalizes).toEqual([{ status: "failed", reason: "result_followups_exhausted" }]);
	});

	it("rejects with ResultUnavailableError carrying the reason when give_up fires", async () => {
		const h = makeDeps({
			decisions: [withTools("cannot", [call("give_up")])],
			outcomes: [{ type: "gave_up", reason: "insufficient info" }],
		});
		await expect(runAgentLoop(plan({ hasResultSchema: true }), h.deps)).rejects.toMatchObject({
			reason: "insufficient info",
			assistantText: "cannot",
		});
		expect(h.finalizes).toEqual([{ status: "failed", reason: "gave_up", error: "insufficient info" }]);
	});
});
