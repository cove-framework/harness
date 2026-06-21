// Ported from flue · @flue/runtime · packages/runtime/src/runtime/providers.ts → @cove/runtime
//   (HttpProviderRegistration, providersById, registerProvider, hasRegisteredProvider,
//    getRegisteredApiKey, getRegisteredStoreResponses, resolveRegisteredModel,
//    buildModelFromRegistration, zeroMetadataModel). ALL Cloudflare-binding symbols DROPPED
//    (CloudflareAIBindingRegistration, isCloudflareBindingRegistration, attachModelBinding,
//    getModelBinding, getModelGateway, cloudflare-model import) per plan 03 / 08 §5.
// registerApiProvider mirrors pi · @earendil-works/pi-ai · packages/ai/src/api-registry.ts
//   (module-scoped, last-write-wins map).
//
// Pure / V8-safe: NO AI SDK import. Builds `ModelHandle` capability data hydrated from
// capabilities.ts; the AI SDK `LanguageModelV2` is attached later by gateway.ts.

import type { ModelHandle } from "../../src/runtime/messages.ts";
import { ProviderRegistrationError } from "../../src/runtime/errors.ts";
import { type ModelCaps, lookupCaps, zeroMetadataCaps } from "./capabilities.ts";

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Register an HTTP-backed provider ID with {@link registerProvider}. Cove drops
 * flue's Cloudflare-binding registration variant, so `ProviderRegistration`
 * collapses to just this shape.
 */
export interface HttpProviderRegistration {
	/**
	 * Wire protocol used for requests. Required for provider IDs the catalog
	 * doesn't know; defaults to the catalog protocol for catalog provider IDs.
	 */
	api?: string;
	/**
	 * Endpoint root, e.g. `'https://api.anthropic.com/v1'`. Required for provider
	 * IDs the catalog doesn't know; defaults to the catalog endpoint for catalog
	 * provider IDs.
	 */
	baseUrl?: string;
	/**
	 * Optional API key. Read back via {@link getRegisteredApiKey} and threaded to
	 * the AI SDK provider factory by gateway.ts. Falls back to ambient env when unset.
	 */
	apiKey?: string;
	/**
	 * Headers sent on every outgoing request. Merged per key over the catalog
	 * caps when the provider ID hydrates from the catalog; this registration's
	 * values win on conflict.
	 */
	headers?: Record<string, string>;
	/**
	 * Default `contextWindow` (tokens) for every model resolved through this
	 * registration. Overridden per-model via {@link models}. Unset falls back to
	 * the catalog value, then `0` ("unknown").
	 */
	contextWindow?: number;
	/**
	 * Default `maxTokens` for every model resolved through this registration.
	 * Overridden per-model via {@link models}. Unset falls back to the catalog
	 * value, then `0`.
	 */
	maxTokens?: number;
	/** Per-model overrides for {@link contextWindow} and {@link maxTokens}, keyed by model ID. */
	models?: Record<string, { contextWindow?: number; maxTokens?: number }>;
	/**
	 * Sends `store: true` for OpenAI Responses API providers. Only enable when you
	 * need OpenAI-hosted item persistence and accept its retention policy.
	 */
	storeResponses?: boolean;
}

/** Cove's provider registration collapses to the HTTP shape (Cloudflare dropped). */
export type ProviderRegistration = HttpProviderRegistration;

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Provider registry, module-scoped and last-write-wins. EMPTY on every cold
 * action boot (the module is re-imported per isolate); the generated app entry
 * (P8.5) re-applies registrations, and tests register explicitly in setup. Do
 * NOT assume registrations persist across actions. Mirrors flue's `providersById`.
 */
const providersById = new Map<string, ProviderRegistration>();

/**
 * Register a model provider keyed by the provider ID used in model specifiers.
 *
 * When the provider ID is a catalog provider (capabilities.ts), models resolve
 * from the catalog — preserving cost/contextWindow metadata — with this call's
 * options layered on top. Provider IDs the catalog doesn't know are registered
 * from scratch and MUST supply `api` and `baseUrl`.
 *
 * Each call REPLACES the provider ID's previous registration; calls do not
 * accumulate. Throws {@link ProviderRegistrationError} when a non-catalog ID
 * omits `api`/`baseUrl`.
 */
export function registerProvider(providerId: string, registration: ProviderRegistration): void {
	const isCatalogProvider = hasCatalogProvider(providerId);
	if ((registration.api === undefined || registration.baseUrl === undefined) && !isCatalogProvider) {
		throw new ProviderRegistrationError(
			`[cove] provider "${providerId}" is not a known catalog provider; ` +
				`registerProvider() requires both "api" and "baseUrl".`,
		);
	}
	providersById.set(providerId, registration);
}

/** Clear all registrations. Test-only — restores the cold-boot empty state. */
export function resetProvidersForTests(): void {
	providersById.clear();
}

/** Whether a provider ID has already been registered. */
export function hasRegisteredProvider(providerId: string): boolean {
	return providersById.has(providerId);
}

/** Look up an API key registered for a provider ID. */
export function getRegisteredApiKey(providerId: string): string | undefined {
	return providersById.get(providerId)?.apiKey;
}

/** Whether a registered provider opted into OpenAI-hosted response storage. */
export function getRegisteredStoreResponses(providerId: string): boolean {
	return providersById.get(providerId)?.storeResponses === true;
}

/** Read back the full registration for a provider ID (gateway.ts uses headers/baseUrl). */
export function getRegistration(providerId: string): ProviderRegistration | undefined {
	return providersById.get(providerId);
}

/**
 * Mirror of pi-ai's `registerApiProvider`: a brand-new wire-protocol handler for
 * an `api` slug the gateway doesn't ship, keyed by `api`. Module-scoped and
 * last-write-wins — re-register on every isolate boot without dedupe bookkeeping.
 *
 * In cove this records a custom AI SDK provider factory: `(modelId) =>
 * LanguageModelV2`. The factory is opaque here (`unknown`) to keep this module
 * AI-SDK-free; gateway.ts casts it back when resolving an `api` slug.
 */
export interface ApiProviderRegistration {
	api: string;
	/** `(modelId: string) => LanguageModelV2`, typed opaque to stay AI-SDK-free. */
	factory: (modelId: string) => unknown;
}

const apiProvidersByApi = new Map<string, ApiProviderRegistration>();

export function registerApiProvider(provider: ApiProviderRegistration): void {
	apiProvidersByApi.set(provider.api, provider);
}

export function getApiProvider(api: string): ApiProviderRegistration | undefined {
	return apiProvidersByApi.get(api);
}

export function resetApiProvidersForTests(): void {
	apiProvidersByApi.clear();
}

// ─── Internal helpers ───────────────────────────────────────────────────────

// Built-in catalog provider ids (mirror capabilities.ts top-level keys).
const CATALOG_PROVIDERS: Record<string, true> = {
	anthropic: true,
	openai: true,
	google: true,
	bedrock: true,
};

/** Whether the capability catalog knows this provider ID at all. */
function hasCatalogProvider(providerId: string): boolean {
	return CATALOG_PROVIDERS[providerId] === true;
}

/**
 * Resolve `'provider-id/model-id'` against the provider registry. Returns
 * `ModelHandle` capability data (no AI SDK `model` field — gateway.ts attaches
 * the resolved `LanguageModelV2`). `undefined` when the provider ID has no
 * registration. Mirrors flue's `resolveRegisteredModel`.
 */
export function resolveRegisteredModel(providerId: string, modelId: string): ModelHandle | undefined {
	const registration = providersById.get(providerId);
	if (!registration) return undefined;
	return buildModelFromRegistration(providerId, registration, modelId);
}

/**
 * Construct a `ModelHandle` (capability data only) from a registered provider
 * template. Hydrates from the capability catalog (capabilities.ts) when the
 * provider+model is known, with the registration's overrides layered on top and
 * any still-unset metadata defaulting to zero. Mirrors flue's
 * `buildModelFromRegistration`, returning ModelHandle data instead of pi `Model`.
 */
export function buildModelFromRegistration(
	providerId: string,
	registration: ProviderRegistration,
	modelId: string,
): ModelHandle {
	const catalog: ModelCaps = lookupCaps(providerId, modelId) ?? zeroMetadataCaps();

	const contextWindow =
		registration.models?.[modelId]?.contextWindow ?? registration.contextWindow ?? catalog.contextWindow;
	const maxOutputTokens =
		registration.models?.[modelId]?.maxTokens ?? registration.maxTokens ?? catalog.maxOutputTokens;

	return {
		id: modelId,
		provider: providerId,
		modelString: `${providerId}/${modelId}`,
		contextWindow,
		maxOutputTokens,
		supportsVision: catalog.supportsVision,
		supportsReasoning: catalog.supportsReasoning,
		thinkingLevelMap: catalog.thinkingLevelMap,
		cost: catalog.cost,
	};
}

/** Zero-metadata `ModelHandle` data for ids no catalog knows. Mirrors flue's `zeroMetadataModel`. */
export function zeroMetadataModel(providerId: string, modelId: string): ModelHandle {
	const caps = zeroMetadataCaps();
	return {
		id: modelId,
		provider: providerId,
		modelString: `${providerId}/${modelId}`,
		contextWindow: caps.contextWindow,
		maxOutputTokens: caps.maxOutputTokens,
		supportsVision: caps.supportsVision,
		supportsReasoning: caps.supportsReasoning,
		cost: caps.cost,
	};
}
