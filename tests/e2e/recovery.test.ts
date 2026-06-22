// New (Convex backend) · @cove/runtime — G2.6 crash-recovery DB invariants (08 §4.1 / §4.5). The edge VM
// can't execute the "use node" llmStep/dispatchTools actions, so the at-most-once-model-call replay guard is
// proven PURE in convex/engine/__tests__/decode.test.ts; here we prove the PERSISTENCE invariants the guard
// relies on, against the real step mutations under convex-test: a finalized step row (→ reconstructDecision,
// no re-decode) and idempotent appendToolResult (toolCallId de-dup → a replayed dispatch never double-writes).
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../../convex/_generated/api";
import schema from "../../convex/schema.ts";
import { getOrCreateSessionId } from "../../convex/invoke/admit.ts";

const modules = import.meta.glob("../../convex/**/*.ts");
const USAGE = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function setup(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => {
		const sessionId = await getOrCreateSessionId(ctx, {
			instanceId: "i1",
			harnessName: "default",
			sessionName: "default",
		});
		const now = Date.now();
		const requestId = await ctx.db.insert("agentRequests", {
			sessionId,
			instanceId: "i1",
			submissionId: "sub-rec",
			kind: "prompt",
			input: "hi",
			status: "running",
			createdAt: now,
			updatedAt: now,
		});
		return { sessionId, requestId };
	});
}

describe("crash-recovery persistence invariants (G2.6)", () => {
	it("finalizeStep marks the row finalized — the replay guard's reconstruct source (§4.1)", async () => {
		const t = convexTest(schema, modules);
		const { sessionId, requestId } = await setup(t);
		await t.mutation(internal.engine.steps.insertStreaming, { requestId, stepNumber: 0 });
		await t.mutation(internal.engine.steps.finalizeStep, {
			requestId,
			stepNumber: 0,
			sessionId,
			finishReason: "stop",
			text: "answer",
			reasoning: "",
			toolCalls: [],
			responseMessages: [{ role: "assistant", content: "answer" }],
			usage: USAGE,
			model: "cove-test/mock",
			durationMs: 1,
		});
		const row = await t.query(internal.engine.steps.byRequestStep, { requestId, stepNumber: 0 });
		expect(row?.isFinalized).toBe(true);
		expect(row?.usage?.totalTokens).toBe(15); // persisted usage → replay computes the same shouldCompact
		// A re-run sees isFinalized → reconstructDecision (no second model call). The no-call assertion is the
		// pure decode.test.ts unit; here the row state that drives it is proven against the live mutation.
	});

	it("appendToolResult is idempotent on toolCallId — a replayed dispatch never double-writes (§4.5)", async () => {
		const t = convexTest(schema, modules);
		const { requestId } = await setup(t);
		await t.mutation(internal.engine.steps.insertStreaming, { requestId, stepNumber: 0 });
		const result = { content: [{ type: "text", text: "tool ok" }] };
		// First dispatch + a replayed dispatch of the SAME toolCallId.
		await t.mutation(internal.engine.steps.appendToolResult, {
			requestId,
			stepNumber: 0,
			toolCallId: "call-1",
			toolName: "bash",
			result,
		});
		await t.mutation(internal.engine.steps.appendToolResult, {
			requestId,
			stepNumber: 0,
			toolCallId: "call-1",
			toolName: "bash",
			result,
		});
		const row = await t.query(internal.engine.steps.byRequestStep, { requestId, stepNumber: 0 });
		const forCall = (row?.toolResults ?? []).filter((r: { toolCallId: string }) => r.toolCallId === "call-1");
		expect(forCall).toHaveLength(1); // exactly one result per toolCallId
	});

	it("insertStreaming is idempotent — a re-run after a crash mid-stream re-attempts cleanly", async () => {
		const t = convexTest(schema, modules);
		const { requestId } = await setup(t);
		await t.mutation(internal.engine.steps.insertStreaming, { requestId, stepNumber: 0 });
		await t.mutation(internal.engine.steps.patchStreaming, { requestId, stepNumber: 0, text: "partial" });
		// crash → re-run re-inserts the streaming row (no duplicate row).
		await t.mutation(internal.engine.steps.insertStreaming, { requestId, stepNumber: 0 });
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("agentRequestSteps")
				.withIndex("by_request_and_step", (q) => q.eq("requestId", requestId).eq("stepNumber", 0))
				.collect(),
		);
		expect(rows).toHaveLength(1); // one row per (requestId, stepNumber), not two
	});
});
