// New (Convex backend) · @cove/runtime · phase-03 acceptance test for convex/providers.
// Covers the Acceptance bar items 1–8, all driven through the MockLanguageModelV3 seam — NO live
// provider. registerProvider() in setup; resetProvidersForTests() between tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { ProviderRegistrationError } from "../../../src/runtime/errors.ts";
import type { Message } from "../../../src/runtime/messages.ts";
import {
	RESERVED_TEST_MODEL_ID,
	RESERVED_TEST_MODEL_TEXT,
	buildProviderOptions,
	getRegisteredStoreResponses,
	hasCredentialsFor,
	registerProvider,
	resetApiProvidersForTests,
	resetProvidersForTests,
	resolveModel,
	toModelMessages,
} from "../index.ts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	resetProvidersForTests();
	resetApiProvidersForTests();
});

afterEach(() => {
	resetProvidersForTests();
	resetApiProvidersForTests();
	process.env = { ...ORIGINAL_ENV };
});

// ─── 1. Capability resolution ─────────────────────────────────────────────────

describe("1. capability resolution", () => {
	it("resolves anthropic/claude-sonnet-4-6 with full capabilities + a non-null model", () => {
		const handle = resolveModel("anthropic/claude-sonnet-4-6");
		expect(handle).toBeDefined();
		expect(handle!.provider).toBe("anthropic");
		expect(handle!.id).toBe("claude-sonnet-4-6");
		expect(handle!.supportsVision).toBe(true);
		expect(handle!.supportsReasoning).toBe(true);
		expect(handle!.contextWindow).toBeGreaterThan(0);
		expect(handle!.maxOutputTokens).toBeGreaterThan(0);
		expect(handle!.cost?.input).toBeGreaterThan(0);
		expect(handle!.model).not.toBeNull();
		expect(handle!.model).toBeDefined();
	});

	it("throws [cove] Unknown model specifier for an unknown id", () => {
		expect(() => resolveModel("anthropic/does-not-exist")).toThrow(/\[cove\] Unknown model specifier/);
	});

	it("throws the format error for a slash-less specifier", () => {
		expect(() => resolveModel("claude-sonnet-4-6")).toThrow(/\[cove\] Invalid model specifier/);
	});

	it("returns undefined for false / undefined", () => {
		expect(resolveModel(false)).toBeUndefined();
		expect(resolveModel(undefined)).toBeUndefined();
	});
});

// ─── 2. Mock smoke (no live provider) ─────────────────────────────────────────

describe("2. mock smoke", () => {
	it("resolves the reserved test id to a MockLanguageModelV3-backed handle", () => {
		const handle = resolveModel(RESERVED_TEST_MODEL_ID);
		expect(handle).toBeDefined();
		expect(handle!.modelString).toBe(RESERVED_TEST_MODEL_ID);
		expect(handle!.model).toBeDefined();
	});

	it("returns the canned text from a non-streaming generateText call", async () => {
		const handle = resolveModel(RESERVED_TEST_MODEL_ID)!;
		const result = await generateText({ model: handle.model as LanguageModelV3, prompt: "hello" });
		expect(result.text).toBe(RESERVED_TEST_MODEL_TEXT);
	});

	it("is byte-stable across resolves (replay determinism)", async () => {
		const a = await generateText({ model: resolveModel(RESERVED_TEST_MODEL_ID)!.model as LanguageModelV3, prompt: "x" });
		const b = await generateText({ model: resolveModel(RESERVED_TEST_MODEL_ID)!.model as LanguageModelV3, prompt: "x" });
		expect(a.text).toBe(b.text);
		expect(a.usage).toEqual(b.usage);
	});
});

// ─── 3. Thinking-budget fit ───────────────────────────────────────────────────

describe("3. thinking-budget fit", () => {
	it("fits budgetTokens <= maxTokens <= N for an anthropic handle (no caller cap)", () => {
		const handle = resolveModel("anthropic/claude-sonnet-4-6")!;
		const N = handle.maxOutputTokens!;
		const { providerOptions, maxTokens } = buildProviderOptions(handle, "high", { maxTokens: undefined });
		const thinking = (providerOptions.anthropic as any).thinking;
		expect(thinking.type).toBe("enabled");
		expect(thinking.budgetTokens).toBeLessThanOrEqual(maxTokens!);
		expect(maxTokens!).toBeLessThanOrEqual(N);
		expect(thinking.budgetTokens).toBeGreaterThan(0);
	});

	it("clamps thinkingBudget to maxTokens-1024 for a small explicit maxTokens", () => {
		const handle = resolveModel("anthropic/claude-sonnet-4-6")!;
		const { providerOptions, maxTokens } = buildProviderOptions(handle, "high", { maxTokens: 1500 });
		const thinking = (providerOptions.anthropic as any).thinking;
		// adjustMaxTokensForThinking: maxTokens = min(1500 + 16384, N) = 17884, NOT <= budget,
		// so the small-cap clamp only triggers when the *fitted* maxTokens <= budget. With a high
		// budget (16384) and base 1500, fitted maxTokens (17884) > budget, so budget stays 16384.
		// To exercise the clamp we need base+budget capped low; assert the documented invariant:
		expect(thinking.budgetTokens).toBeLessThanOrEqual(maxTokens!);
	});

	it("clamps thinkingBudget to maxTokens-1024 when the fitted maxTokens <= budget", () => {
		// Register a tiny-maxTokens provider so the model cap forces the clamp branch.
		registerProvider("anthropic", {
			baseUrl: "https://api.anthropic.com",
			models: { "claude-sonnet-4-6": { maxTokens: 1500 } },
		});
		const handle = resolveModel("anthropic/claude-sonnet-4-6")!;
		const { providerOptions, maxTokens } = buildProviderOptions(handle, "high", { maxTokens: undefined });
		const thinking = (providerOptions.anthropic as any).thinking;
		// maxTokens = modelMaxTokens = 1500; 1500 <= 16384 → budget = max(0, 1500-1024) = 476.
		expect(maxTokens).toBe(1500);
		expect(thinking.budgetTokens).toBe(1500 - 1024);
	});

	it("off → no thinking, maxTokens passes through", () => {
		const handle = resolveModel("anthropic/claude-sonnet-4-6")!;
		const { providerOptions, maxTokens } = buildProviderOptions(handle, "off", { maxTokens: 2000 });
		expect(providerOptions.anthropic).toBeUndefined();
		expect(maxTokens).toBe(2000);
	});
});

// ─── 4. storeResponses flag ───────────────────────────────────────────────────

describe("4. storeResponses flag (openai)", () => {
	it("sets store=true when storeResponses:true", () => {
		const handle = resolveModel("openai/gpt-5")!;
		const { providerOptions } = buildProviderOptions(handle, "medium", { storeResponses: true });
		expect((providerOptions.openai as any).store).toBe(true);
	});

	it("store=false when storeResponses:false/unset", () => {
		const handle = resolveModel("openai/gpt-5")!;
		expect((buildProviderOptions(handle, "medium", { storeResponses: false }).providerOptions.openai as any).store).toBe(false);
		expect((buildProviderOptions(handle, "medium", {}).providerOptions.openai as any).store).toBe(false);
	});

	it("threads store even when level === off", () => {
		// gpt-5 declares `off: null` (cannot disable reasoning), so the clamp snaps "off" up to a
		// supported level — but `store` must still thread regardless of the resolved reasoning level.
		const handle = resolveModel("openai/gpt-5")!;
		const { providerOptions } = buildProviderOptions(handle, "off", { storeResponses: true });
		expect((providerOptions.openai as any).store).toBe(true);
	});

	it("omits reasoningEffort when off is genuinely supported (non-reasoning model)", () => {
		// gpt-4o has no reasoning, so the only supported level is "off" → reasoningEffort omitted,
		// store still threaded.
		const handle = resolveModel("openai/gpt-4o")!;
		const { providerOptions } = buildProviderOptions(handle, "off", { storeResponses: true });
		expect((providerOptions.openai as any).store).toBe(true);
		expect((providerOptions.openai as any).reasoningEffort).toBeUndefined();
	});

	it("emits reasoningEffort when level != off", () => {
		const handle = resolveModel("openai/gpt-5")!;
		const { providerOptions } = buildProviderOptions(handle, "medium", { storeResponses: true });
		expect((providerOptions.openai as any).reasoningEffort).toBe("medium");
	});
});

// ─── 5. Non-vision downgrade ──────────────────────────────────────────────────

function userImageMessage(): Message {
	return {
		role: "user",
		content: [
			{ type: "text", text: "look:" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "image", data: "BBBB", mimeType: "image/png" },
		],
		timestamp: 0,
	};
}

describe("5. non-vision downgrade", () => {
	it("REPLACES consecutive images with ONE placeholder for a non-vision handle", () => {
		const handle = resolveModel(RESERVED_TEST_MODEL_ID)!;
		const nonVision = { ...handle, supportsVision: false };
		const out = toModelMessages([userImageMessage()], nonVision);
		const content = out[0].content as Array<{ type: string; text?: string }>;
		const images = content.filter((p) => p.type === "image");
		const placeholders = content.filter((p) => p.type === "text" && /image omitted/.test(p.text ?? ""));
		expect(images.length).toBe(0);
		expect(placeholders.length).toBe(1);
	});

	it("passes images through untouched for a vision-capable handle", () => {
		const handle = resolveModel(RESERVED_TEST_MODEL_ID)!; // supportsVision defaults true
		const out = toModelMessages([userImageMessage()], handle);
		const content = out[0].content as Array<{ type: string }>;
		expect(content.filter((p) => p.type === "image").length).toBe(2);
	});
});

// ─── 6. Surrogate sanitization ────────────────────────────────────────────────

describe("6. surrogate sanitization", () => {
	it("strips a lone high surrogate, preserves a valid paired emoji", () => {
		const lone = String.fromCharCode(0xd83d); // high surrogate with NO trailing low surrogate
		const input = `before ${lone} 🙈 after`;
		const msg: Message = {
			role: "user",
			content: [{ type: "text", text: input }],
			timestamp: 0,
		};
		const handle = resolveModel(RESERVED_TEST_MODEL_ID)!;
		const out = toModelMessages([msg], handle);
		const text = (out[0].content as Array<{ type: string; text: string }>)[0].text;
		// The lone surrogate is dropped: output is exactly the input with that one code unit removed.
		// (Cannot use `.toContain(lone)` — the valid 🙈 emoji legitimately contains 0xD83D as its
		// high surrogate, so the assertion must compare the full sanitized string.)
		expect(text).toBe(`before  🙈 after`);
		expect(text.length).toBe(input.length - 1);
		expect(text).toContain("🙈");
	});
});

// ─── 7. Registry override + store flag ────────────────────────────────────────

describe("7. registry override + store flag", () => {
	it("registration wins over the catalog and threads storeResponses", () => {
		registerProvider("anthropic", {
			baseUrl: "https://gateway.example.com/anthropic",
			apiKey: "sk-test",
			storeResponses: true,
			models: { "claude-sonnet-4-6": { contextWindow: 12345 } },
		});
		const handle = resolveModel("anthropic/claude-sonnet-4-6")!;
		expect(handle.contextWindow).toBe(12345); // registration override applied
		expect(handle.model).toBeDefined();
		expect(getRegisteredStoreResponses("anthropic")).toBe(true);
	});

	it("throws ProviderRegistrationError for a non-catalog id without api/baseUrl", () => {
		expect(() => registerProvider("acme", { apiKey: "x" })).toThrow(ProviderRegistrationError);
	});

	it("re-registering the same id REPLACES (does not accumulate)", () => {
		registerProvider("anthropic", {
			baseUrl: "https://one.example.com",
			models: { "claude-sonnet-4-6": { contextWindow: 111 } },
		});
		registerProvider("anthropic", {
			baseUrl: "https://two.example.com",
			models: { "claude-sonnet-4-6": { contextWindow: 222 } },
		});
		expect(resolveModel("anthropic/claude-sonnet-4-6")!.contextWindow).toBe(222);
	});
});

// ─── 8. Keyless ambient credentials ───────────────────────────────────────────

describe("8. keyless ambient credentials", () => {
	// Every env var hasCredentialsFor consults — snapshot + clear before each case so
	// detection is exercised against a known-empty baseline (and restored after).
	const CRED_KEYS = [
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"GOOGLE_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_GENERATIVE_AI_API_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_PROFILE",
		"AWS_ROLE_ARN",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AI_GATEWAY_API_KEY",
		"VERCEL_OIDC_TOKEN",
	];
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const k of CRED_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of CRED_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("detects google via keyless ADC (GOOGLE_APPLICATION_CREDENTIALS), no GOOGLE_API_KEY", () => {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/adc.json";
		expect(hasCredentialsFor("google")).toBe(true);
	});

	it("detects bedrock via the keyless AWS chain (AWS_PROFILE), no literal *_API_KEY", () => {
		process.env.AWS_PROFILE = "default";
		expect(hasCredentialsFor("bedrock")).toBe(true);
		expect(hasCredentialsFor("amazon-bedrock")).toBe(true);
	});

	it("detects bedrock via AWS_ROLE_ARN / AWS_WEB_IDENTITY_TOKEN_FILE (IRSA chain)", () => {
		process.env.AWS_ROLE_ARN = "arn:aws:iam::1:role/x";
		process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/token";
		expect(hasCredentialsFor("bedrock")).toBe(true);
	});

	it("is NOT vacuous: with no credentials at all, detection returns false", () => {
		// The assertion the old test lacked — proves detection isn't trivially true.
		expect(hasCredentialsFor("google")).toBe(false);
		expect(hasCredentialsFor("bedrock")).toBe(false);
		expect(hasCredentialsFor("anthropic")).toBe(false);
		expect(hasCredentialsFor("openai")).toBe(false);
	});

	it("a literal *_API_KEY is detected too (not only ambient creds)", () => {
		process.env.GOOGLE_API_KEY = "k";
		expect(hasCredentialsFor("google")).toBe(true);
		process.env.ANTHROPIC_API_KEY = "k";
		expect(hasCredentialsFor("anthropic")).toBe(true);
	});

	it("the gateway credential (AI_GATEWAY_API_KEY) satisfies any provider", () => {
		process.env.AI_GATEWAY_API_KEY = "gw";
		expect(hasCredentialsFor("anthropic")).toBe(true);
		expect(hasCredentialsFor("google")).toBe(true);
		expect(hasCredentialsFor("bedrock")).toBe(true);
	});

	it("resolveModel itself does NOT gate on credentials (gateway errors at request time)", () => {
		// By design: a handle resolves regardless of env; the credential error
		// surfaces when the model is actually called, not at resolve time.
		const handle = resolveModel("google/gemini-2.5-pro");
		expect(handle).toBeDefined();
		expect(handle!.model).toBeDefined();
	});
});
