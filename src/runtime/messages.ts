// Mirrors pi · @earendil-works/pi-ai · packages/ai/src/types.ts + packages/agent/src/types.ts.
// Replaces flue's pi imports in packages/runtime/src/types.ts.
/**
 * Canonical message + tool + model model, decoupled from pi.
 *
 * flue inherited its message model from `@earendil-works/pi-ai` /
 * `@earendil-works/pi-agent-core`. cove-harness drops pi, but KEEPS pi's message
 * shape as the internal canonical model: `SessionData`/`SessionEntry` (the
 * preserved version-6 wire contract) store these messages, and the pure tree
 * logic in `session-history.ts` + the compaction helpers operate on them. Only
 * the provider boundary (convex/providers, convex/engine/llmStep) maps between
 * these and the AI SDK's `ModelMessage`.
 *
 * Shapes mirror pi-ai/types.ts exactly, except `api`/`provider` are widened to
 * `string` so nothing pulls a provider enum into the V8-safe core.
 */

/** Reasoning effort. Mirrors flue/pi's `ThinkingLevel`. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Widened from pi's `Api`/`Provider` string-literal unions to decouple. */
export type Api = string;
export type Provider = string;

export interface TextContent {
	type: "text";
	text: string;
	/** Provider message metadata (e.g. OpenAI responses signature). */
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	/** When true, content was redacted by safety filters; opaque payload in `thinkingSignature`. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	/** base64-encoded bytes */
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	/** Google-specific: opaque signature for reusing thought context. */
	thoughtSignature?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of `cacheWrite` with 1h retention (Anthropic only). */
	cacheWrite1h?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	/** Concrete responding model when different from the requested one. */
	responseModel?: string;
	responseId?: string;
	/** Redacted provider/runtime diagnostics for failures and recoveries. */
	diagnostics?: any[];
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

/** LLM-convertible message union (pi-ai `Message`). */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * Custom message flue injects to render dispatched-input / identity / lifecycle
 * markers into the transcript (flue augmented pi's `CustomAgentMessages`). The
 * `type` discriminates subtypes such as `stream_interrupted`, `stream_continued`,
 * and `context_summary` that `session-history.ts` reasons about.
 */
export interface SignalMessage {
	role: "signal";
	type: string;
	tagName?: string;
	content: string;
	attributes?: Record<string, string>;
	timestamp: number;
}

/** A stored transcript message: LLM messages + custom messages (pi `AgentMessage`). */
export type AgentMessage = Message | SignalMessage;

/**
 * Model-facing tool shape produced by a `SandboxFactory`'s tool factory
 * (`SessionToolFactory`). The replacement for pi's `AgentTool`.
 */
export interface AgentTool<TArgs = any> {
	name: string;
	description: string;
	/** JSON Schema for the tool arguments. */
	parameters: unknown;
	execute?: (args: TArgs, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Opaque resolved-model handle. flue used pi-ai's `Model<any>`; cove-harness
 * resolves a `ModelConfig` string to one of these via the provider registry
 * (convex/providers). Carries the gateway model id, provider, and capability
 * metadata used by compaction + vision/reasoning gating.
 *
 * The `model` field carries the resolved Vercel AI SDK `LanguageModelV3`, but is
 * typed `unknown` here so the V8-safe `src/runtime` core NEVER imports the AI
 * SDK (`ai` / `@ai-sdk/*`). Only `convex/providers/*` and `convex/engine/*`
 * (both `"use node"` modules) cast it back to `LanguageModelV3`. This preserves
 * the execution boundary (doc 08 §3): the core stays import-clean of the AI SDK.
 */
export interface ModelHandle {
	id: string;
	provider: string;
	/** Provider-prefixed gateway shorthand, e.g. "anthropic/claude-sonnet-4-6". */
	modelString: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	/**
	 * When false, `toModelMessages` REPLACES image blocks in user/toolResult messages
	 * with a text placeholder (consecutive placeholders de-duped) rather than passing
	 * raw image bytes to a non-vision model — which would 400. Ported from pi's
	 * transform-messages downgrade. See doc 04 / 08 §4.8.
	 */
	supportsVision?: boolean;
	supportsReasoning?: boolean;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	/**
	 * Per-`ThinkingLevel` provider-specific reasoning-effort mapping. A `null`
	 * value marks the level as unsupported (snapped away by `clampThinkingLevel`);
	 * a `string` is the provider-native effort token. Hydrated from the capability
	 * catalog (convex/providers/capabilities.ts). Optional — absent for models with
	 * no reasoning metadata.
	 */
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	/**
	 * The resolved Vercel AI SDK `LanguageModelV3`, typed `unknown` to keep the AI
	 * SDK out of the V8-safe core. `convex/providers/*` / `convex/engine/*` cast it
	 * back to `LanguageModelV3` before calling `streamText`/`generateText`. The
	 * test seam (convex/providers/testModel.ts) puts an in-process `LanguageModelV3`
	 * mock here.
	 */
	model?: unknown;
}
