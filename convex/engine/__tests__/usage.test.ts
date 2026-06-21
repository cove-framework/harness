// Tests for the usage aggregation + AI SDK bridge (engine/usage.ts).
import { describe, expect, it } from "vitest";
import type { ModelHandle, Usage } from "../../../src/runtime/messages.ts";
import { addUsage, emptyUsage, fromProviderUsage, usageFromAiSdk } from "../usage.ts";

describe("emptyUsage", () => {
	it("is all zeros and is the identity element for addUsage", () => {
		const e = emptyUsage();
		expect(e).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const u = usageFromAiSdk({ inputTokens: 3, outputTokens: 7, totalTokens: 10 }, undefined);
		expect(addUsage(e, u)).toEqual(u);
		expect(addUsage(u, e)).toEqual(u);
	});
});

describe("addUsage", () => {
	it("sums every field including nested cost, mutating neither argument", () => {
		const a: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const b: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const sum = addUsage(a, b);
		expect(sum).toEqual({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 110,
			cost: { input: 1.1, output: 2.2, cacheRead: 3.3, cacheWrite: 4.4, total: 11 },
		});
		expect(a.input).toBe(1);
		expect(b.input).toBe(10);
	});
});

describe("fromProviderUsage", () => {
	it("returns undefined for undefined", () => {
		expect(fromProviderUsage(undefined)).toBeUndefined();
	});
	it("copies the canonical usage into a fresh PromptUsage", () => {
		const usage: Usage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			cacheWrite1h: 2,
			totalTokens: 26,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
		};
		const p = fromProviderUsage(usage);
		expect(p).toEqual({
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			cacheWrite1h: 2,
			totalTokens: 26,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
		});
	});
});

describe("usageFromAiSdk", () => {
	it("returns empty usage for undefined", () => {
		expect(usageFromAiSdk(undefined, undefined)).toEqual(emptyUsage());
	});
	it("maps AI SDK token fields and derives totalTokens when absent", () => {
		const p = usageFromAiSdk({ inputTokens: 4, outputTokens: 5, cachedInputTokens: 2 }, undefined);
		expect(p.input).toBe(4);
		expect(p.output).toBe(5);
		expect(p.cacheRead).toBe(2);
		expect(p.cacheWrite).toBe(0);
		expect(p.totalTokens).toBe(9);
		expect(p.cost.total).toBe(0);
	});
	it("computes cost from the resolved ModelHandle rates", () => {
		const handle: ModelHandle = {
			id: "m",
			provider: "p",
			modelString: "p/m",
			cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 5 },
		};
		const p = usageFromAiSdk({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }, handle);
		expect(p.cost.input).toBe(20);
		expect(p.cost.output).toBe(60);
		expect(p.cost.cacheRead).toBe(0);
		expect(p.cost.total).toBe(80);
	});
});
