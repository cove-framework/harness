// Tests for the context-rebuild bridge converter (engine/entries.ts).
import { describe, expect, it } from "vitest";
import type { PromptUsage } from "../../../src/runtime/types.ts";
import {
	type AssistantStepData,
	mapFinishReason,
	orderToolResults,
	stepToAssistantMessage,
	toolResultToMessage,
	usageToCanonical,
} from "../entries.ts";
import type { ToolCallRecord, ToolResultRecord } from "../types.ts";

const usage: PromptUsage = {
	input: 4,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("mapFinishReason", () => {
	it("maps AI-SDK reasons to canonical StopReason", () => {
		expect(mapFinishReason("stop")).toBe("stop");
		expect(mapFinishReason("length")).toBe("length");
		expect(mapFinishReason("tool-calls")).toBe("toolUse");
		expect(mapFinishReason("error")).toBe("error");
		expect(mapFinishReason("content-filter")).toBe("stop");
	});
});

describe("usageToCanonical", () => {
	it("copies fields into a canonical Usage", () => {
		expect(usageToCanonical(usage)).toEqual({
			input: 4,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 9,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});
});

describe("stepToAssistantMessage", () => {
	it("builds an assistant message with thinking, text, and tool calls in order", () => {
		const step: AssistantStepData = {
			finishReason: "tool-calls",
			text: "answer",
			reasoning: "thinking...",
			toolCalls: [{ toolCallId: "c1", toolName: "read", args: { path: "/a" } }],
			usage,
			model: "anthropic/claude-sonnet-4-6",
		};
		const msg = stepToAssistantMessage(step, 123);
		expect(msg.role).toBe("assistant");
		expect(msg.provider).toBe("anthropic");
		expect(msg.model).toBe("anthropic/claude-sonnet-4-6");
		expect(msg.stopReason).toBe("toolUse");
		expect(msg.timestamp).toBe(123);
		expect(msg.content).toEqual([
			{ type: "thinking", thinking: "thinking..." },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
		]);
	});

	it("omits empty text/reasoning", () => {
		const msg = stepToAssistantMessage(
			{ finishReason: "stop", text: "", reasoning: "", toolCalls: [], usage, model: "cove-test/mock" },
			0,
		);
		expect(msg.content).toEqual([]);
		expect(msg.stopReason).toBe("stop");
	});
});

describe("toolResultToMessage", () => {
	it("maps EngineToolResult content to canonical content blocks", () => {
		const record: ToolResultRecord = {
			toolCallId: "c1",
			toolName: "read",
			result: { content: [{ type: "text", text: "file body" }] },
		};
		const msg = toolResultToMessage(record, 7);
		expect(msg).toEqual({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 7,
		});
	});

	it("carries the error flag and tolerates a non-structured result", () => {
		const record: ToolResultRecord = { toolCallId: "c2", toolName: "bash", result: "raw", isError: true };
		const msg = toolResultToMessage(record, 0);
		expect(msg.isError).toBe(true);
		expect(msg.content).toEqual([{ type: "text", text: "raw" }]);
	});
});

describe("orderToolResults", () => {
	it("reorders results to match the tool-call order", () => {
		const calls: ToolCallRecord[] = [
			{ toolCallId: "a", toolName: "read", args: {} },
			{ toolCallId: "b", toolName: "bash", args: {} },
		];
		const results: ToolResultRecord[] = [
			{ toolCallId: "b", toolName: "bash", result: {} },
			{ toolCallId: "a", toolName: "read", result: {} },
		];
		expect(orderToolResults(calls, results).map((r) => r.toolCallId)).toEqual(["a", "b"]);
	});
});
