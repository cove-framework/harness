// Tests for the ProviderPlugin abstraction (pragmatic-refactor Phase 2): caps/options routing
// through the plugin map, catalog-membership integration with registerProvider, and built-in parity.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelHandle } from "../../../src/runtime/messages.ts";
import { lookupCaps } from "../capabilities.ts";
import {
	getProviderPlugin,
	hasProviderPlugin,
	registerProviderPlugin,
	resetProviderPluginsForTests,
} from "../plugin.ts";
import { registerBuiltInProviders } from "../builtins.ts";
import { buildBuiltinProviderOptions, buildProviderOptions } from "../thinking.ts";
import { registerProvider, resetProvidersForTests } from "../registry.ts";

const handle = (provider: string): ModelHandle => ({
	id: "m",
	provider,
	modelString: `${provider}/m`,
	contextWindow: 200_000,
	maxOutputTokens: 64_000,
	supportsVision: true,
	supportsReasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

beforeEach(() => {
	resetProviderPluginsForTests();
	resetProvidersForTests();
});
afterEach(() => {
	resetProviderPluginsForTests();
	resetProvidersForTests();
});

describe("registerProviderPlugin", () => {
	it("round-trips and reports membership", () => {
		expect(hasProviderPlugin("synthetic")).toBe(false);
		const plugin = { id: "synthetic", caps: () => undefined };
		registerProviderPlugin(plugin);
		expect(getProviderPlugin("synthetic")).toBe(plugin);
		expect(hasProviderPlugin("synthetic")).toBe(true);
	});
});

describe("lookupCaps routes through the plugin map first", () => {
	it("returns plugin caps for a provider the legacy table doesn't know", () => {
		expect(lookupCaps("synthetic", "m1")).toBeUndefined();
		registerProviderPlugin({
			id: "synthetic",
			caps: (modelId) =>
				modelId === "m1"
					? {
							contextWindow: 123,
							maxOutputTokens: 9,
							supportsVision: false,
							supportsReasoning: false,
							cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						}
					: undefined,
		});
		expect(lookupCaps("synthetic", "m1")?.contextWindow).toBe(123);
		expect(lookupCaps("synthetic", "other")).toBeUndefined();
	});
});

describe("buildProviderOptions routes through the plugin, falls back to built-in family logic", () => {
	it("uses the plugin's buildProviderOptions when present", () => {
		registerProviderPlugin({
			id: "synthetic",
			caps: () => undefined,
			buildProviderOptions: () => ({ providerOptions: { synthetic: { ok: true } }, maxTokens: 42 }),
		});
		expect(buildProviderOptions(handle("synthetic"), "high")).toEqual({
			providerOptions: { synthetic: { ok: true } },
			maxTokens: 42,
		});
	});

	it("falls back to built-in family logic with no plugin (identical result)", () => {
		const h = handle("anthropic");
		expect(buildProviderOptions(h, "high")).toEqual(buildBuiltinProviderOptions(h, "high"));
	});
});

describe("catalog membership integrates with registerProvider", () => {
	it("a registered plugin lets registerProvider skip the api/baseUrl requirement", () => {
		expect(() => registerProvider("groq", {})).toThrow(/requires both "api" and "baseUrl"/);
		registerProviderPlugin({ id: "groq", caps: () => undefined });
		expect(() => registerProvider("groq", {})).not.toThrow();
	});
});

describe("built-in parity", () => {
	it("built-in plugins return the same caps as the legacy catalog", () => {
		registerBuiltInProviders();
		expect(lookupCaps("anthropic", "claude-sonnet-4-6")?.contextWindow).toBe(1_000_000);
		expect(getProviderPlugin("anthropic")?.caps("claude-sonnet-4-6")?.contextWindow).toBe(1_000_000);
		expect(lookupCaps("openai", "gpt-5")?.maxOutputTokens).toBe(128_000);
	});
});
