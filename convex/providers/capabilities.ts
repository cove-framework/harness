// New (Convex backend) · @cove/runtime
// Pattern source: pi · @earendil-works/pi-ai · packages/ai/src/models.generated.ts (distilled
// hand-maintained subset; the 453 KB generated blob is NOT ported per plan 03 / 08 §5) and
// pi · packages/ai/src/models.ts (EXTENDED_THINKING_LEVELS).
//
// V8-safe default capability constants. Plain object literals only — NO AI SDK import — so this
// module is reachable from both the "use node" provider boundary and pure helpers. The gateway
// (gateway.ts) hydrates a `ModelHandle` from these; registrations (registry.ts) layer over them.

import type { ThinkingLevel } from "../../src/runtime/messages.ts";
import { getProviderPlugin } from "./plugin.ts";

/**
 * The thinking levels cove understands, ordered least→most. Mirrors pi's
 * `EXTENDED_THINKING_LEVELS`. `clampThinkingLevel` walks this order to snap an
 * unsupported requested level to the nearest supported one.
 */
export const EXTENDED_THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

/**
 * Capability metadata for a single model, distilled from pi's generated catalog.
 * A `null` entry in `thinkingLevelMap` marks a level as explicitly unsupported; a
 * `string` is the provider-native effort token (e.g. google `"HIGH"`, openai
 * `"max"`). Absent `thinkingLevelMap` means all `EXTENDED_THINKING_LEVELS` except
 * `xhigh` are available when `supportsReasoning` is true (pi semantics).
 */
export interface ModelCaps {
	contextWindow: number;
	maxOutputTokens: number;
	supportsVision: boolean;
	supportsReasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

/**
 * Hand-maintained provider → modelId → caps table. Costs are USD per 1M tokens
 * (matching pi's catalog units). Only a representative subset of each provider's
 * catalog is carried; unknown ids fall back to {@link zeroMetadataCaps}.
 */
export const CAPABILITIES: Record<string, Record<string, ModelCaps>> = {
	anthropic: {
		"claude-sonnet-4-6": {
			contextWindow: 1_000_000,
			maxOutputTokens: 64_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		},
		"claude-sonnet-4-5": {
			contextWindow: 200_000,
			maxOutputTokens: 64_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		},
		"claude-haiku-4-5": {
			contextWindow: 200_000,
			maxOutputTokens: 64_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		},
		"claude-opus-4-5": {
			contextWindow: 200_000,
			maxOutputTokens: 64_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		},
		"claude-opus-4-1": {
			contextWindow: 200_000,
			maxOutputTokens: 32_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		},
	},
	openai: {
		"gpt-5": {
			contextWindow: 400_000,
			maxOutputTokens: 128_000,
			supportsVision: true,
			supportsReasoning: true,
			thinkingLevelMap: { off: null, xhigh: null },
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		},
		"gpt-5.1": {
			contextWindow: 400_000,
			maxOutputTokens: 128_000,
			supportsVision: true,
			supportsReasoning: true,
			thinkingLevelMap: { off: null, xhigh: null },
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		},
		"gpt-5-mini": {
			contextWindow: 400_000,
			maxOutputTokens: 128_000,
			supportsVision: true,
			supportsReasoning: true,
			thinkingLevelMap: { off: null, xhigh: null },
			cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
		},
		"gpt-4o": {
			contextWindow: 128_000,
			maxOutputTokens: 16_384,
			supportsVision: true,
			supportsReasoning: false,
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
		},
		"gpt-4.1-mini": {
			contextWindow: 1_047_576,
			maxOutputTokens: 32_768,
			supportsVision: true,
			supportsReasoning: false,
			cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
		},
	},
	google: {
		"gemini-2.5-pro": {
			contextWindow: 1_048_576,
			maxOutputTokens: 65_536,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		},
		"gemini-2.5-flash": {
			contextWindow: 1_048_576,
			maxOutputTokens: 65_536,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		},
		"gemini-3-pro-preview": {
			contextWindow: 1_048_576,
			maxOutputTokens: 65_536,
			supportsVision: true,
			supportsReasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" },
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
		},
		"gemini-2.0-flash": {
			contextWindow: 1_048_576,
			maxOutputTokens: 8_192,
			supportsVision: true,
			supportsReasoning: false,
			cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
		},
	},
	bedrock: {
		"anthropic.claude-sonnet-4-6": {
			contextWindow: 1_000_000,
			maxOutputTokens: 64_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		},
		"anthropic.claude-haiku-4-5-20251001-v1:0": {
			contextWindow: 200_000,
			maxOutputTokens: 64_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		},
		"anthropic.claude-opus-4-5-20251101-v1:0": {
			contextWindow: 200_000,
			maxOutputTokens: 64_000,
			supportsVision: true,
			supportsReasoning: true,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		},
		"amazon.nova-pro-v1:0": {
			contextWindow: 300_000,
			maxOutputTokens: 8_192,
			supportsVision: true,
			supportsReasoning: false,
			cost: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
		},
	},
};

/**
 * Per-provider zero-metadata fallback for ids the table doesn't know. Returns a
 * `contextWindow: 0` caps record — compaction treats `contextWindow <= 0` as
 * "unknown" (pi's `zeroMetadataModel` parity). `supportsVision`/`supportsReasoning`
 * default to `false` (the conservative, downgrade-safe choice for an unknown id).
 */
export function zeroMetadataCaps(): ModelCaps {
	return {
		contextWindow: 0,
		maxOutputTokens: 0,
		supportsVision: false,
		supportsReasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/**
 * Look up caps for `providerId/modelId`. Returns the catalog entry when known, or
 * `undefined` when neither the provider nor the model is in the table — callers
 * decide whether to fall back to {@link zeroMetadataCaps} (resolveModel) or treat
 * the id as unknown (registry, where a registration already established the id).
 */
export function lookupCaps(providerId: string, modelId: string): ModelCaps | undefined {
	// Plugin first (pragmatic-refactor Phase 2); CAPABILITIES is the built-in fallback. Built-in
	// plugins read the same table, so results are identical for catalog providers.
	return getProviderPlugin(providerId)?.caps(modelId) ?? CAPABILITIES[providerId]?.[modelId];
}
