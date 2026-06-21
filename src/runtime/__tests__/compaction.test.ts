// Tests for the pure compaction helpers (src/runtime/compaction.ts).
import { describe, expect, it } from "vitest";
import {
	deriveCompactionDefaults,
	estimateTokens,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "../compaction.ts";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "../messages.ts";

const ZERO: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "a",
	provider: "p",
	model: "m",
	usage: ZERO,
	stopReason: "stop",
	timestamp: 0,
});
const toolResult = (text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: "t",
	toolName: "x",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

describe("estimateTokens", () => {
	it("uses the chars/4 heuristic and ~4800 chars per image", () => {
		expect(estimateTokens(user("abcd"))).toBe(1);
		expect(estimateTokens(assistant("a".repeat(40)))).toBe(10);
		expect(
			estimateTokens({
				role: "toolResult",
				toolCallId: "t",
				toolName: "x",
				content: [{ type: "image", data: "", mimeType: "image/png" }],
				isError: false,
				timestamp: 0,
			}),
		).toBe(1200);
	});
});

describe("shouldCompact", () => {
	const settings = { enabled: true, reserveTokens: 2000, keepRecentTokens: 800 };
	it("fires only when tokens exceed window minus reserve", () => {
		expect(shouldCompact(9000, 10000, settings)).toBe(true); // > 8000
		expect(shouldCompact(7000, 10000, settings)).toBe(false);
		expect(shouldCompact(99999, 0, settings)).toBe(false); // unknown window
		expect(shouldCompact(9000, 10000, { ...settings, enabled: false })).toBe(false);
	});
});

describe("deriveCompactionDefaults", () => {
	it("caps reserve at maxTokens and clamps for tiny windows", () => {
		expect(deriveCompactionDefaults({ contextWindow: 200000, maxTokens: 8000 }).reserveTokens).toBe(8000);
		// tiny window: reserve*2 >= window → clamp to floor(window/3)
		expect(deriveCompactionDefaults({ contextWindow: 4000, maxTokens: 8000 }).reserveTokens).toBe(1333);
	});
});

describe("prepareCompaction", () => {
	it("cuts at a turn boundary, summarizing the older slice", () => {
		// 4 messages, ~10 tokens each; keepRecent=15 keeps the last ~2, summarizes the first 2.
		const messages = [user("x".repeat(40)), assistant("y".repeat(40)), user("z".repeat(40)), assistant("w".repeat(40))];
		const prep = prepareCompaction(messages, { enabled: true, reserveTokens: 2000, keepRecentTokens: 15 });
		expect(prep).toBeDefined();
		expect(prep?.firstKeptIndex).toBe(2);
		expect(prep?.messagesToSummarize).toHaveLength(2);
		expect(prep?.isSplitTurn).toBe(false);
	});

	it("returns undefined when nothing older than the tail exists", () => {
		expect(prepareCompaction([], { enabled: true, reserveTokens: 2000, keepRecentTokens: 15 })).toBeUndefined();
		// huge keepRecent → cut never advances past the start
		const prep = prepareCompaction([user("short"), assistant("short")], {
			enabled: true,
			reserveTokens: 2000,
			keepRecentTokens: 100000,
		});
		expect(prep).toBeUndefined();
	});
});

describe("serializeConversation", () => {
	it("renders roles as a flat transcript", () => {
		const text = serializeConversation([user("hello"), assistant("hi there"), toolResult("result data")]);
		expect(text).toContain("[User]: hello");
		expect(text).toContain("[Assistant]: hi there");
		expect(text).toContain("[Tool result]: result data");
	});
});
