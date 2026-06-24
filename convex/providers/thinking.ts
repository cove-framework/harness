// Ported from pi · @earendil-works/pi-ai · packages/ai/src/providers/simple-options.ts
//   (adjustMaxTokensForThinking, clampReasoning — VERBATIM math) → @cove/runtime
// Mirrors pi · @earendil-works/pi-ai · packages/ai/src/models.ts
//   (clampThinkingLevel, getSupportedThinkingLevels) → @cove/runtime
// Provider-option shapes reference pi · packages/ai/src/providers/{anthropic,openai-responses,google}.ts
//   (intent only — emits AI SDK providerOptions key names, NOT raw provider-SDK shapes).
//
// V8-safe: imports nothing from the AI SDK (only the option-KEY names are emitted, not provider-SDK
// shapes), so this is reachable from the V8 isolate too. ProviderPlugin.buildProviderOptions
// (plugin.ts) is built on these pure helpers (pragmatic-refactor Phase 2).

import type { ModelHandle, ThinkingLevel } from "../../src/runtime/messages.ts";
import { EXTENDED_THINKING_LEVELS } from "./capabilities.ts";
import { getProviderPlugin } from "./plugin.ts";

/** Per-level thinking-token budgets (pi's `ThinkingBudgets`). */
export type ThinkingBudgets = Partial<Record<Exclude<ThinkingLevel, "off" | "xhigh">, number>>;

// ─── pi simple-options.ts (VERBATIM) ──────────────────────────────────────────

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined {
	return effort === "xhigh" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level as Exclude<ThinkingLevel, "off" | "xhigh">]!;
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}

// ─── pi models.ts (clamp helpers, operating on ModelHandle.thinkingLevelMap) ───

/**
 * Levels the model actually supports, given its `supportsReasoning` flag and
 * `thinkingLevelMap`. Mirrors pi's `getSupportedThinkingLevels` but reads off a
 * `ModelHandle` instead of a pi `Model`.
 */
export function getSupportedThinkingLevels(handle: ModelHandle): ThinkingLevel[] {
	if (!handle.supportsReasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = handle.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

/**
 * Snap a requested `ThinkingLevel` to the nearest level the model supports.
 * Mirrors pi's `clampThinkingLevel`: prefer walking up toward stronger reasoning,
 * then fall back downward, then to the first supported level (`off`).
 */
export function clampThinkingLevel(handle: ModelHandle, level: ThinkingLevel): ThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(handle);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

// ─── buildProviderOptions (AI SDK shapes) ─────────────────────────────────────

/** Options that influence the emitted provider options. */
export interface BuildProviderOptionsOpts {
	/** Caller `maxTokens` cap. Undefined → fit thinking inside the model cap. */
	maxTokens?: number;
	/** Threads to `providerOptions.openai.store` (independent of reasoning). */
	storeResponses?: boolean;
	/** Override the per-level thinking budgets (anthropic/bedrock). */
	customBudgets?: ThinkingBudgets;
}

/** AI SDK `providerOptions` value: a per-family record of opaque option objects. */
export type ProviderOptions = Record<string, Record<string, unknown>>;

export interface BuiltProviderOptions {
	providerOptions: ProviderOptions;
	/** The fitted `maxTokens` the caller (P4) sets on the request, or `undefined`. */
	maxTokens: number | undefined;
}

/** Provider families that carve a reasoning budget out of `maxTokens` (Anthropic SDK shape). */
function isAnthropicFamily(provider: string): boolean {
	return provider === "anthropic" || provider === "bedrock" || provider === "amazon-bedrock";
}

/**
 * Map a `ThinkingLevel` + caller options to the AI SDK `providerOptions` for the
 * handle's provider family, plus the fitted `maxTokens`. Always `clampThinkingLevel`
 * first so an unsupported requested level snaps to the nearest supported one before
 * any budget math.
 *
 * - **anthropic / bedrock** → `providerOptions.anthropic.thinking = { type:'enabled',
 *   budgetTokens }`, with `budgetTokens` carved from `maxTokens` via
 *   `adjustMaxTokensForThinking`. `off` → no thinking, `maxTokens` passes through.
 * - **openai** → `providerOptions.openai = { reasoningEffort?, store }`. `off` omits
 *   `reasoningEffort` but still threads `store`.
 * - **google** → `providerOptions.google.thinkingConfig = { thinkingBudget,
 *   includeThoughts:true }`; `off` → `{ thinkingBudget: 0 }`.
 */
export function buildProviderOptions(
	handle: ModelHandle,
	level: ThinkingLevel,
	opts: BuildProviderOptionsOpts = {},
): BuiltProviderOptions {
	// Plugin first (pragmatic-refactor Phase 2); the built-in family logic below is the fallback for
	// isolates/providers without a registered plugin. Built-in plugins delegate back to it, so results
	// are identical either way.
	const plugin = getProviderPlugin(handle.provider);
	if (plugin?.buildProviderOptions) return plugin.buildProviderOptions(handle, level, opts);
	return buildBuiltinProviderOptions(handle, level, opts);
}

/**
 * The built-in provider-family option logic (anthropic/bedrock, openai, google, else none). Pure;
 * does NOT consult the plugin map (callers do). Used by both the dispatcher fallback and the
 * built-in ProviderPlugins (builtins.ts).
 */
export function buildBuiltinProviderOptions(
	handle: ModelHandle,
	level: ThinkingLevel,
	opts: BuildProviderOptionsOpts = {},
): BuiltProviderOptions {
	const clamped = clampThinkingLevel(handle, level);
	const provider = handle.provider;

	if (isAnthropicFamily(provider)) {
		if (clamped === "off") {
			return { providerOptions: {}, maxTokens: opts.maxTokens };
		}
		const modelMaxTokens = handle.maxOutputTokens ?? 0;
		const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(
			opts.maxTokens,
			modelMaxTokens,
			clamped,
			opts.customBudgets,
		);
		return {
			providerOptions: {
				anthropic: { thinking: { type: "enabled", budgetTokens: thinkingBudget } },
			},
			maxTokens,
		};
	}

	if (provider === "openai") {
		const openai: Record<string, unknown> = { store: !!opts.storeResponses };
		if (clamped !== "off") {
			// Prefer a provider-native token from the level map; else the clamped level
			// (xhigh already snapped to high by clampThinkingLevel via the level map).
			const mapped = handle.thinkingLevelMap?.[clamped];
			openai.reasoningEffort = typeof mapped === "string" ? mapped : clamped;
		}
		return { providerOptions: { openai }, maxTokens: opts.maxTokens };
	}

	if (provider === "google") {
		if (clamped === "off") {
			return {
				providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
				maxTokens: opts.maxTokens,
			};
		}
		const modelMaxTokens = handle.maxOutputTokens ?? 0;
		const { thinkingBudget } = adjustMaxTokensForThinking(
			opts.maxTokens,
			modelMaxTokens,
			clamped,
			opts.customBudgets,
		);
		return {
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget, includeThoughts: true } },
			},
			maxTokens: opts.maxTokens,
		};
	}

	// Unknown provider family: no provider-specific reasoning options.
	return { providerOptions: {}, maxTokens: opts.maxTokens };
}
