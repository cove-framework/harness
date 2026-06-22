// Ported from flue · @flue/opentelemetry · packages/opentelemetry/src/index.ts → @cove/observability (test).
// Node env, pure (no convex-test): a recorded CoveEvent[] is folded through
// createCoveOpenTelemetryObserver with an in-memory Tracer and the resulting span forest is asserted.
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import type { CoveEvent } from "../../../src/runtime/types.ts";
import { buildSpanTree, type SerializableSpan } from "../read.ts";

const RUN_ID = "run_1";
const INSTANCE_ID = "inst_1";
const OPERATION_ID = "op_1";
const TURN_ID = "turn_1";

let eventIndex = 0;

/** Decorate a variant with the common CoveEvent envelope (consistent ids so spans nest). */
function ev(variant: Partial<CoveEvent> & { type: CoveEvent["type"] }): CoveEvent {
	return {
		v: 1,
		eventIndex: eventIndex++,
		timestamp: new Date(1_700_000_000_000 + eventIndex * 1000).toISOString(),
		runId: RUN_ID,
		instanceId: INSTANCE_ID,
		session: "default",
		harness: "default",
		...variant,
	} as CoveEvent;
}

/** A full run → operation → turn(+text) → tool(error) → compaction sequence. */
function recordedEvents(): CoveEvent[] {
	eventIndex = 0;
	return [
		ev({ type: "run_start", runId: RUN_ID, workflowName: "codeReviewer", startedAt: new Date(1_700_000_000_000).toISOString(), payload: { prompt: "review" } }),
		ev({ type: "operation_start", operationId: OPERATION_ID, operationKind: "prompt" }),
		ev({
			type: "turn_request",
			operationId: OPERATION_ID,
			turnId: TURN_ID,
			purpose: "agent",
			model: "anthropic/claude-haiku-4-5",
			provider: "anthropic",
			api: "messages",
			input: { systemPrompt: "you review code", messages: [{ role: "user", content: "review my PR" }] },
		}),
		ev({ type: "text_delta", operationId: OPERATION_ID, turnId: TURN_ID, text: "Looking" }),
		ev({ type: "text_delta", operationId: OPERATION_ID, turnId: TURN_ID, text: " at the diff" }),
		ev({ type: "tool_start", operationId: OPERATION_ID, turnId: TURN_ID, toolName: "postReview", toolCallId: "call_1", args: { verdict: "approve" } }),
		ev({ type: "tool", operationId: OPERATION_ID, turnId: TURN_ID, toolName: "postReview", toolCallId: "call_1", isError: true, result: "boom: rejected by gate", durationMs: 12 }),
		ev({
			type: "turn",
			operationId: OPERATION_ID,
			turnId: TURN_ID,
			purpose: "agent",
			durationMs: 250,
			model: "anthropic/claude-haiku-4-5",
			provider: "anthropic",
			api: "messages",
			stopReason: "tool_use",
			isError: false,
			usage: {
				input: 100,
				output: 40,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 140,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
		}),
		ev({ type: "compaction_start", operationId: OPERATION_ID, reason: "threshold", estimatedTokens: 9000 }),
		ev({ type: "compaction", operationId: OPERATION_ID, messagesBefore: 20, messagesAfter: 4, durationMs: 80, isError: false }),
		ev({ type: "operation", operationId: OPERATION_ID, operationKind: "prompt", durationMs: 400, isError: false, result: "done" }),
		ev({ type: "run_end", runId: RUN_ID, durationMs: 500, isError: false, result: "ok" }),
	];
}

function find(spans: SerializableSpan[], predicate: (s: SerializableSpan) => boolean): SerializableSpan | undefined {
	for (const span of spans) {
		if (predicate(span)) return span;
		const nested = find(span.children, predicate);
		if (nested) return nested;
	}
	return undefined;
}

function flatten(spans: SerializableSpan[]): SerializableSpan[] {
	return spans.flatMap((s) => [s, ...flatten(s.children)]);
}

describe("createCoveOpenTelemetryObserver", () => {
	it("(a) builds a run root span with nested operation/turn/tool/compaction spans", () => {
		const tree = buildSpanTree(recordedEvents());

		expect(tree).toHaveLength(1);
		const run = tree[0]!;
		expect(run.name).toBe("cove.run codeReviewer");
		expect(run.attributes["cove.run.id"]).toBe(RUN_ID);

		// operation nests under run
		const operation = run.children.find((c) => c.name === "cove.operation prompt");
		expect(operation, "operation under run").toBeDefined();

		// turn (chat span) nests under operation, with GenAI semconv attributes
		const turn = operation!.children.find((c) => c.name === "chat anthropic/claude-haiku-4-5");
		expect(turn, "turn under operation").toBeDefined();
		expect(turn!.kind).toBe(SpanKind.CLIENT);
		expect(turn!.attributes["gen_ai.operation.name"]).toBe("chat");
		expect(turn!.attributes["gen_ai.request.model"]).toBe("anthropic/claude-haiku-4-5");
		expect(turn!.attributes["gen_ai.usage.input_tokens"]).toBe(100);
		expect(turn!.attributes["gen_ai.usage.output_tokens"]).toBe(40);
		expect(turn!.attributes["gen_ai.response.finish_reasons"]).toEqual(["tool_use"]);

		// text_delta recorded as span events on the turn
		const deltaEvents = turn!.events.filter((e) => e.name === "cove.text_delta");
		expect(deltaEvents.length).toBe(2);

		// tool nests under turn
		const tool = turn!.children.find((c) => c.name === "cove.tool postReview");
		expect(tool, "tool under turn").toBeDefined();
		expect(tool!.attributes["cove.tool.call_id"]).toBe("call_1");

		// compaction nests under the operation
		const compaction = find([run], (s) => s.name === "cove.compaction");
		expect(compaction, "compaction span present").toBeDefined();
		expect(compaction!.attributes["cove.compaction.reason"]).toBe("threshold");
		expect(compaction!.attributes["cove.compaction.messages_before"]).toBe(20);
	});

	it("(b) marks the failed-tool span with SpanStatusCode.ERROR", () => {
		const tree = buildSpanTree(recordedEvents());
		const tool = find(tree, (s) => s.name === "cove.tool postReview");
		expect(tool).toBeDefined();
		expect(tool!.status?.code).toBe(SpanStatusCode.ERROR);
		// the error result is recorded as an exception
		expect(tool!.exceptions.length).toBeGreaterThan(0);
	});

	it("(c) does not leak content attributes when exportContent strips result/input", () => {
		// A redactor that drops `result`/`input` so no content attribute is attached.
		const tree = buildSpanTree(recordedEvents(), (event) => {
			const copy = { ...event } as Record<string, unknown>;
			delete copy.result;
			delete copy.input;
			return copy as unknown as CoveEvent;
		});

		const all = flatten(tree);
		for (const span of all) {
			expect(span.attributes["cove.tool.result"]).toBeUndefined();
			expect(span.attributes["cove.turn.input"]).toBeUndefined();
		}
		// The non-content structural attributes still flow through.
		const tool = find(tree, (s) => s.name === "cove.tool postReview");
		expect(tool!.attributes["cove.tool.name"]).toBe("postReview");
	});

	it("attaches content attributes when no redactor is provided", () => {
		const tree = buildSpanTree(recordedEvents());
		const turn = find(tree, (s) => s.name === "chat anthropic/claude-haiku-4-5");
		const tool = find(tree, (s) => s.name === "cove.tool postReview");
		expect(turn!.attributes["cove.turn.input"]).toBeDefined();
		expect(tool!.attributes["cove.tool.result"]).toBeDefined();
	});

	it("ignores idle/submission_settled markers (no spurious spans)", () => {
		eventIndex = 0;
		const tree = buildSpanTree([
			ev({ type: "run_start", runId: RUN_ID, workflowName: "wf", startedAt: new Date().toISOString(), payload: {} }),
			ev({ type: "idle" }),
			ev({ type: "submission_settled", submissionId: "s1", outcome: "completed" }),
			ev({ type: "run_end", runId: RUN_ID, durationMs: 1, isError: false }),
		]);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.children).toHaveLength(0);
	});
});
