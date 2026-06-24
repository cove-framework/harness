"use node";
// New (Convex backend) · @cove/runtime
// Pattern source: flue · @flue/runtime · packages/runtime/src/index.ts (barrel) — the single import
// surface convex/engine/* (P4) uses for provider resolution + the outbound transform + the mock seam.
//
// "use node": re-exports gateway.ts / thinking.ts / messages.ts / testModel.ts, which import the AI
// SDK. Pure modules (sanitize.ts, capabilities.ts, registry.ts) are pulled in here too.

export { resolveModel, hasCredentialsFor } from "./gateway.ts";

export {
	registerProvider,
	registerApiProvider,
	hasRegisteredProvider,
	getRegisteredApiKey,
	getRegisteredStoreResponses,
	getRegistration,
	getApiProvider,
	resolveRegisteredModel,
	buildModelFromRegistration,
	zeroMetadataModel,
	resetProvidersForTests,
	resetApiProvidersForTests,
} from "./registry.ts";
export type {
	HttpProviderRegistration,
	ProviderRegistration,
	ApiProviderRegistration,
} from "./registry.ts";

export {
	buildProviderOptions,
	adjustMaxTokensForThinking,
	clampReasoning,
	clampThinkingLevel,
	getSupportedThinkingLevels,
} from "./thinking.ts";
export type {
	BuildProviderOptionsOpts,
	BuiltProviderOptions,
	ProviderOptions,
	ThinkingBudgets,
} from "./thinking.ts";

export { toModelMessages } from "./messages.ts";

export { sanitizeSurrogates } from "./sanitize.ts";

export {
	RESERVED_TEST_MODEL_ID,
	RESERVED_TEST_MODEL_TEXT,
	isTestModelId,
	makeTestModelHandle,
	makeDefaultMockModel,
} from "./testModel.ts";
export type { MakeTestModelHandleOptions } from "./testModel.ts";

export {
	CAPABILITIES,
	EXTENDED_THINKING_LEVELS,
	lookupCaps,
	zeroMetadataCaps,
} from "./capabilities.ts";
export type { ModelCaps } from "./capabilities.ts";

export {
	getProviderPlugin,
	hasProviderPlugin,
	listProviderPlugins,
	registerProviderPlugin,
	resetProviderPluginsForTests,
} from "./plugin.ts";
export type { ProviderPlugin } from "./plugin.ts";
export { BUILTIN_PROVIDER_PLUGINS, registerBuiltInProviders } from "./builtins.ts";
