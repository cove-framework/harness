// Ported from flue · @flue/runtime · packages/runtime/src/usage.ts → @cove/runtime
//   emptyUsage / addUsage / fromProviderUsage ported verbatim (pi `Usage` import → ../../src/runtime/messages.ts).
//   ADDED for cove: usageFromAiSdk — bridges the Vercel AI SDK token shape (LanguageModelV2Usage) into
//   PromptUsage and computes cost from the resolved ModelHandle rates. The provider/persisted side uses
//   inputTokens/outputTokens; the caller-facing PromptUsage uses input/output — this module is the single
//   bridge across that divergence (doc 08 §4.7).
//
// Pure / V8-safe: type-only imports, NO AI SDK runtime import (the AI usage shape is typed structurally),
// so this aggregation logic stays importable from anywhere and unit-tests without a provider.

import type { ModelHandle, Usage } from "../../src/runtime/messages.ts";
import type { PromptUsage } from "../../src/runtime/types.ts";

/** All-zero `PromptUsage`. Identity element for {@link addUsage}. */
export function emptyUsage(): PromptUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Field-wise sum of two `PromptUsage` values, including the nested `cost`
 * sub-object. Returns a fresh object; neither argument is mutated.
 */
export function addUsage(a: PromptUsage, b: PromptUsage): PromptUsage {
	// Preserve the optional 1h-retention cache-write breakdown (doc 08 §4.7) without emitting a 0 key
	// when neither side carries it.
	const cacheWrite1h =
		a.cacheWrite1h === undefined && b.cacheWrite1h === undefined
			? undefined
			: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0);
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/**
 * Convert cove's canonical `Usage` (the pi-shaped message-model usage) into the
 * public `PromptUsage`. The shapes are structurally identical today, but routing
 * through this normalizer keeps the public surface decoupled from the canonical
 * message model. Returns `undefined` when the input is `undefined`.
 */
export function fromProviderUsage(usage: Usage | undefined): PromptUsage | undefined {
	if (!usage) return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

/**
 * Structural subset of the Vercel AI SDK `LanguageModelV2Usage`, typed locally so
 * this module never imports the AI SDK. `streamText`/`generateText` resolve a
 * usage object of (at least) this shape; absent fields default to zero.
 */
export interface AiSdkUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
}

/**
 * Bridge the AI SDK per-call usage into `PromptUsage`, computing cost from the
 * resolved {@link ModelHandle.cost} rates (per-token; absent rates ⇒ zero cost).
 * `cachedInputTokens` maps to `cacheRead`; the AI SDK's generic usage carries no
 * cache-write count (it surfaces only in provider metadata), so `cacheWrite` is
 * `0` here and refined by provider-specific accounting later (doc 08 §4.7).
 */
export function usageFromAiSdk(
	usage: AiSdkUsage | undefined,
	handle: ModelHandle | undefined,
): PromptUsage {
	if (!usage) return emptyUsage();
	const input = usage.inputTokens ?? 0;
	const output = usage.outputTokens ?? 0;
	const cacheRead = usage.cachedInputTokens ?? 0;
	const cacheWrite = 0;
	const totalTokens = usage.totalTokens ?? input + output;
	const rates = handle?.cost;
	const cost = {
		input: (rates?.input ?? 0) * input,
		output: (rates?.output ?? 0) * output,
		cacheRead: (rates?.cacheRead ?? 0) * cacheRead,
		cacheWrite: (rates?.cacheWrite ?? 0) * cacheWrite,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}
