// Tests for the transient-error predicate ported into llmStep error handling (engine/retry.ts).
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../../src/runtime/messages.ts";
import {
	isCompletedAssistantResponse,
	isContextOverflow,
	isRetryableErrorMessage,
	isRetryableModelError,
	isRetryableThrown,
} from "../retry.ts";

describe("isContextOverflow (G2.5 seam)", () => {
	it("matches provider context-overflow signatures", () => {
		for (const m of [
			"This model's maximum context length is 200000 tokens",
			"prompt is too long: 250000 tokens > 200000 maximum",
			"input is too long for the requested model",
			"too many tokens in the request",
			"Please reduce the length of the messages",
		]) {
			expect(isContextOverflow(m)).toBe(true);
		}
	});
	it("does NOT match a transient/other error (distinct from isRetryableModelError)", () => {
		expect(isContextOverflow("rate limit exceeded (429)")).toBe(false);
		expect(isContextOverflow("service unavailable")).toBe(false);
		expect(isContextOverflow(new Error("invalid api key"))).toBe(false);
		expect(isContextOverflow(undefined)).toBe(false);
	});
});

describe("isRetryableErrorMessage", () => {
	it("matches transient provider-failure families", () => {
		for (const m of [
			"Overloaded",
			"rate limit exceeded",
			"rate-limit",
			"too many requests",
			"HTTP 429",
			"500 internal",
			"502 Bad Gateway",
			"503 service unavailable",
			"server error",
			"network error",
			"connection reset",
			"socket hang up",
			"fetch failed",
			"request timed out",
			"timeout",
			"terminated",
		]) {
			expect(isRetryableErrorMessage(m)).toBe(true);
		}
	});
	it("does not match hard failures", () => {
		for (const m of ["invalid api key", "401 unauthorized", "bad request", "model not found", ""]) {
			expect(isRetryableErrorMessage(m)).toBe(false);
		}
		expect(isRetryableErrorMessage(undefined)).toBe(false);
	});
});

describe("isRetryableThrown", () => {
	it("classifies Error instances and raw values by message", () => {
		expect(isRetryableThrown(new Error("upstream overloaded"))).toBe(true);
		expect(isRetryableThrown("503 service unavailable")).toBe(true);
		expect(isRetryableThrown(new Error("invalid request"))).toBe(false);
	});
});

describe("isRetryableModelError", () => {
	const base: Omit<AssistantMessage, "stopReason" | "errorMessage"> = {
		role: "assistant",
		content: [],
		api: "x",
		provider: "p",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
	it("requires stopReason error AND a matching message", () => {
		expect(isRetryableModelError({ ...base, stopReason: "error", errorMessage: "overloaded" })).toBe(true);
		expect(isRetryableModelError({ ...base, stopReason: "error", errorMessage: "bad request" })).toBe(false);
		expect(isRetryableModelError({ ...base, stopReason: "error" })).toBe(false);
		expect(isRetryableModelError({ ...base, stopReason: "stop", errorMessage: "overloaded" })).toBe(false);
	});
});

describe("isCompletedAssistantResponse", () => {
	it("is true for stop/length only", () => {
		const mk = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
			role: "assistant",
			content: [],
			api: "x",
			provider: "p",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 0,
		});
		expect(isCompletedAssistantResponse(mk("stop"))).toBe(true);
		expect(isCompletedAssistantResponse(mk("length"))).toBe(true);
		expect(isCompletedAssistantResponse(mk("toolUse"))).toBe(false);
		expect(isCompletedAssistantResponse(mk("error"))).toBe(false);
		expect(isCompletedAssistantResponse(mk("aborted"))).toBe(false);
	});
});
