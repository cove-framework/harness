"use node";
// Ported from flue · @flue/runtime · packages/runtime/src/internal.ts → @cove/runtime
//   (resolveModel: provider/model split + error messages, rebranded [flue]→[cove]; registry wins
//    over catalog). RETURNS a ModelHandle (AI SDK gateway), NOT pi `Model<Api>`.
// Credential detection references design 05 (keyless ambient creds: Google ADC, AWS chain — not
// only *_API_KEY); plain process.env reads, NO FS gcloud probe (D7).
//
// "use node": imports the AI SDK gateway (@ai-sdk/gateway). Reached only from "use node" engine
// actions (P4 llmStep/setup); never from queries/mutations or the V8-safe src/runtime core.

import { gateway } from "@ai-sdk/gateway";
import type { ModelConfig } from "../../src/runtime/types.ts";
import type { ModelHandle } from "../../src/runtime/messages.ts";
import { lookupCaps } from "./capabilities.ts";
import { getApiProvider, resolveRegisteredModel } from "./registry.ts";
import { isTestModelId, makeTestModelHandle } from "./testModel.ts";
import { getProviderPlugin } from "./plugin.ts";
import "./builtins.ts"; // side-effect: register the built-in ProviderPlugins in this (node) isolate

/**
 * Resolve a `provider-id/model-id` specifier to a {@link ModelHandle} carrying an
 * AI SDK `LanguageModelV2` (typed `unknown` on the handle) plus capability data.
 *
 * Order (mirrors flue's `resolveModel`, with the mock seam first):
 *   1. `isTestModelId` → the deterministic `MockLanguageModelV2` handle.
 *   2. `resolveRegisteredModel` → a registration wins over the built-in catalog.
 *   3. built-in capability catalog (capabilities.ts) + an AI SDK gateway model.
 *
 * Deterministic for a given `(ModelConfig, registry state)` (08 §4.1): the same
 * input yields the same handle capabilities, so a replayed `llmStep` re-resolves
 * identically. Returns `undefined` for `false`/`undefined` (no model configured).
 * Throws the `[cove]` format / unknown-specifier errors otherwise.
 */
export function resolveModel(model: ModelConfig | undefined): ModelHandle | undefined {
	if (model === false || model === undefined) return undefined;

	const modelSpecifier = model;

	// Mock seam FIRST — bypasses the slash split so the reserved id always resolves.
	if (isTestModelId(modelSpecifier)) {
		return makeTestModelHandle();
	}

	const slash = modelSpecifier.indexOf("/");
	if (slash === -1) {
		throw new Error(
			`[cove] Invalid model specifier "${modelSpecifier}". ` +
				`Use the "provider-id/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const providerId = modelSpecifier.slice(0, slash);
	const modelId = modelSpecifier.slice(slash + 1);

	// Registry wins over the catalog.
	const registered = resolveRegisteredModel(providerId, modelId);
	if (registered) {
		if (modelId === "") {
			throw new Error(
				`[cove] Invalid model specifier "${modelSpecifier}". ` +
					`Provider ID "${providerId}" is registered via registerProvider(), but no model ID ` +
					`was given. Use "${providerId}/<model-id>".`,
			);
		}
		return { ...registered, model: buildLanguageModel(providerId, modelId) };
	}

	// Built-in capability catalog + gateway model.
	const caps = lookupCaps(providerId, modelId);
	if (!caps) {
		throw new Error(
			`[cove] Unknown model specifier "${modelSpecifier}". ` +
				`Provider ID "${providerId}" / model ID "${modelId}" ` +
				`is not in the built-in catalog or registered via registerProvider().`,
		);
	}

	return {
		id: modelId,
		provider: providerId,
		modelString: modelSpecifier,
		contextWindow: caps.contextWindow,
		maxOutputTokens: caps.maxOutputTokens,
		supportsVision: caps.supportsVision,
		supportsReasoning: caps.supportsReasoning,
		thinkingLevelMap: caps.thinkingLevelMap,
		cost: caps.cost,
		model: buildLanguageModel(providerId, modelId),
	};
}

/**
 * Construct the AI SDK `LanguageModelV2` for a `providerId/modelId`. A custom
 * `registerApiProvider` factory (an `api` slug the gateway doesn't ship) wins;
 * otherwise the Vercel AI SDK gateway resolves the provider-prefixed shorthand.
 * Returned as `unknown` — only call sites (P4) cast back to `LanguageModelV2`.
 *
 * Credential detection (design 05): the gateway reads ambient credentials at
 * call time. `hasCredentialsFor` records keyless ambient creds (Google ADC, AWS
 * chain) in addition to `*_API_KEY`, so a model still resolves when only ADC /
 * the AWS chain is configured — it never gates resolution on a literal API key.
 */
function buildLanguageModel(providerId: string, modelId: string): unknown {
	// Custom api-provider factory keyed by provider id (registerApiProvider).
	const apiProvider = getApiProvider(providerId);
	if (apiProvider) {
		return apiProvider.factory(modelId);
	}
	// The gateway uses provider-prefixed shorthand identical to our specifier.
	return gateway(`${providerId}/${modelId}`);
}

/**
 * Whether usable credentials are present for a provider, via plain `process.env`
 * reads (no FS probe). Recognizes literal API keys AND keyless ambient creds:
 *   - google: `GOOGLE_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`,
 *     or ADC via `GOOGLE_APPLICATION_CREDENTIALS`.
 *   - bedrock: `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`, or the AWS chain
 *     (`AWS_PROFILE`, `AWS_ROLE_ARN`/`AWS_WEB_IDENTITY_TOKEN_FILE`,
 *     `AWS_CONTAINER_CREDENTIALS_*`).
 *   - anthropic/openai: their `*_API_KEY`.
 *   - gateway: `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN`.
 * Exported for P4 setup diagnostics; `resolveModel` itself does not gate on it
 * (the gateway surfaces a credential error at request time).
 */
export function hasCredentialsFor(providerId: string): boolean {
	const env = process.env;
	// Plugin first (pragmatic-refactor Phase 2); the legacy per-provider switch is the fallback.
	// The gateway credential check is OR'd in for every provider (unchanged behavior).
	const plugin = getProviderPlugin(providerId);
	const providerSpecific = plugin?.hasCredentials
		? plugin.hasCredentials(env)
		: legacyProviderCredentials(providerId, env);
	return providerSpecific || hasGatewayCredentials();
}

/**
 * Legacy per-provider literal credential check (NO gateway fallback — the caller ORs that in).
 * Kept as the fallback for providers without a registered plugin; the built-in plugins encode the
 * same checks. Returns false for unknown providers.
 */
function legacyProviderCredentials(providerId: string, env: Record<string, string | undefined>): boolean {
	const has = (k: string) => typeof env[k] === "string" && env[k] !== "";
	switch (providerId) {
		case "anthropic":
			return has("ANTHROPIC_API_KEY");
		case "openai":
			return has("OPENAI_API_KEY");
		case "google":
			return (
				has("GOOGLE_API_KEY") ||
				has("GEMINI_API_KEY") ||
				has("GOOGLE_GENERATIVE_AI_API_KEY") ||
				// Keyless ambient ADC.
				has("GOOGLE_APPLICATION_CREDENTIALS")
			);
		case "bedrock":
		case "amazon-bedrock":
			return (
				(has("AWS_ACCESS_KEY_ID") && has("AWS_SECRET_ACCESS_KEY")) ||
				// Keyless ambient AWS chain.
				has("AWS_PROFILE") ||
				has("AWS_ROLE_ARN") ||
				has("AWS_WEB_IDENTITY_TOKEN_FILE") ||
				has("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
				has("AWS_CONTAINER_CREDENTIALS_FULL_URI")
			);
		default:
			return false;
	}
}

/** Whether the Vercel AI gateway has usable credentials. */
function hasGatewayCredentials(): boolean {
	const env = process.env;
	return (
		(typeof env.AI_GATEWAY_API_KEY === "string" && env.AI_GATEWAY_API_KEY !== "") ||
		(typeof env.VERCEL_OIDC_TOKEN === "string" && env.VERCEL_OIDC_TOKEN !== "")
	);
}
