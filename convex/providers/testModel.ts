"use node";
// New (Convex backend) · @cove/runtime
// Pattern source: Vercel AI SDK `MockLanguageModelV2` (ai/test) — supersedes pi · packages/ai/src/providers/faux.ts
//   (plan 03 / 08 §5: faux.ts is NOT ported).
//
// The single deterministic injection point P3 smoke + P4 replay/throughput tests drive:
// `resolveModel(RESERVED_TEST_MODEL_ID)` returns a ModelHandle whose `.model` is an in-process mock
// (no live provider) and whose default canned response is BYTE-STABLE (no Date.now / Math.random) so
// replay-equality is exact.
//
// We implement the AI SDK `LanguageModelV2` interface DIRECTLY as a plain object rather than wrapping
// `MockLanguageModelV2` from `ai/test`. That subpath is a single bundled module that statically pulls
// in `msw` (an unshipped *devDependency* of @ai-sdk/provider-utils, used only by `createTestServer`,
// which cove never calls), so importing it would require a phantom dependency the consumer install
// does not carry. A hand-rolled `LanguageModelV2` keeps the seam dependency-free and drives both
// `generateText` (doGenerate) and `streamText` (doStream).

import type {
	LanguageModelV2,
	LanguageModelV2Content,
	LanguageModelV2StreamPart,
	LanguageModelV2Usage,
} from "@ai-sdk/provider";
import type { ModelHandle } from "../../src/runtime/messages.ts";

/** Reserved model specifier that resolves to the in-process mock (no live provider). */
export const RESERVED_TEST_MODEL_ID = "cove-test/mock";

/** The canned text every default mock turn returns. Byte-stable for replay equality. */
export const RESERVED_TEST_MODEL_TEXT = "cove mock response";

/** Fixed usage every default mock turn reports. Byte-stable for replay equality. */
const DEFAULT_USAGE: LanguageModelV2Usage = { inputTokens: 4, outputTokens: 5, totalTokens: 9 };

/** Whether a model specifier targets the reserved in-process test model. */
export function isTestModelId(modelString: string): boolean {
	return modelString === RESERVED_TEST_MODEL_ID;
}

/** Options for {@link makeMockLanguageModel}: override either method (else the byte-stable default). */
export interface MockLanguageModelOptions {
	provider?: string;
	modelId?: string;
	doGenerate?: LanguageModelV2["doGenerate"];
	doStream?: LanguageModelV2["doStream"];
}

/**
 * Build a plain `LanguageModelV2` mock. The default `doGenerate`/`doStream` both
 * emit {@link RESERVED_TEST_MODEL_TEXT} with {@link DEFAULT_USAGE} and no time/random
 * sources, so two resolves produce byte-identical output. Pass `doGenerate`/`doStream`
 * to stub specific behavior (P4 replay/throughput).
 */
export function makeMockLanguageModel(options: MockLanguageModelOptions = {}): LanguageModelV2 {
	const text = RESERVED_TEST_MODEL_TEXT;
	return {
		specificationVersion: "v2",
		provider: options.provider ?? "cove-test",
		modelId: options.modelId ?? "mock",
		supportedUrls: {},
		doGenerate:
			options.doGenerate ??
			(async () => ({
				finishReason: "stop" as const,
				usage: { ...DEFAULT_USAGE },
				content: [{ type: "text", text } satisfies LanguageModelV2Content],
				warnings: [],
			})),
		doStream:
			options.doStream ??
			(async () => ({
				stream: new ReadableStream<LanguageModelV2StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "text-start", id: "0" });
						controller.enqueue({ type: "text-delta", id: "0", delta: text });
						controller.enqueue({ type: "text-end", id: "0" });
						controller.enqueue({ type: "finish", finishReason: "stop", usage: { ...DEFAULT_USAGE } });
						controller.close();
					},
				}),
			})),
	};
}

/** The byte-stable default mock language model. */
export function makeDefaultMockModel(): LanguageModelV2 {
	return makeMockLanguageModel();
}

/** Test-mock options: toggle the capability flags the handle reports. */
export interface MakeTestModelHandleOptions {
	supportsVision?: boolean;
	supportsReasoning?: boolean;
}

/**
 * Assemble a `ModelHandle` wrapping a mock `LanguageModelV2`. Pass a custom mock to
 * stub specific `doGenerate`/`doStream` behavior (P4 replay/throughput); omit it for
 * the byte-stable default. `supportsVision`/`supportsReasoning` are toggleable so the
 * downgrade + thinking paths can be exercised against the mock.
 */
export function makeTestModelHandle(
	mock?: LanguageModelV2,
	options: MakeTestModelHandleOptions = {},
): ModelHandle {
	const model = mock ?? makeDefaultMockModel();
	return {
		id: "mock",
		provider: "cove-test",
		modelString: RESERVED_TEST_MODEL_ID,
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		supportsVision: options.supportsVision ?? true,
		supportsReasoning: options.supportsReasoning ?? true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		model,
	};
}
