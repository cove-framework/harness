"use node";
// Ported-pattern from flue · @flue/runtime · packages/runtime/src/session.ts (runModelTurnWithRecovery) → @cove/runtime
// One LLM decode, streamed. flue's in-process "recovery" becomes the workflow journal + the idempotent
// step row. The REPLAY GUARD (doc 08 §4.1) is non-negotiable: on a workflow replay this code re-runs, so
// before touching the AI SDK it consults the persisted step row — a finalized row reconstructs the
// decision WITHOUT calling the model. Precisely: the model is called at most once per *finalized* step. A
// hard crash/kill AFTER insertStreaming but BEFORE finalizeStep leaves a non-finalized row, and the re-run
// re-attempts the decode — re-streaming a complete turn is preferable to force-finalizing a partial, and
// the persisted state stays consistent because the re-run overwrites the streaming row.
//
// This is the pure decode core: the persistence side-effects (load/insert/patch/finalize the step row)
// are injected as a DecodeDeps port, so it unit-tests against the in-process MockLanguageModelV2 with no
// Convex runtime. The thin "use node" llmStep internalAction wires DecodeDeps to ctx mutations/queries.
//
// "use node": imports the AI SDK (`ai` streamText/tool/jsonSchema). Reached only from the llmStep action.

import type { JSONSchema7, LanguageModelV2 } from "@ai-sdk/provider";
import { jsonSchema, type ModelMessage, streamText, tool } from "ai";
import type { AgentMessage, ModelHandle } from "../../src/runtime/messages.ts";
import {
	type CompactionSettings,
	shouldCompact as evalShouldCompact,
} from "../../src/runtime/compaction.ts";
import type { CoveEventInput, PromptUsage } from "../../src/runtime/types.ts";
import { DeltaBatcher, type DeltaBatcherOptions, type DeltaPatch } from "./deltaBatcher.ts";
import type { ModelToolView, StepDecision, ToolCallRecord } from "./types.ts";
import { type AiSdkUsage, usageFromAiSdk } from "./usage.ts";

/** llmStep stream deadline (doc 08 §4.2): force-finalize the partial rather than let the action be killed. */
export const STREAM_DEADLINE_MS = 240_000;

/** A verbatim provider response message replayed on the next step (signatures preserved). */
export interface ResponseMessageRecord {
	role: string;
	content: unknown;
	providerMetadata?: unknown;
}

/** The finalized step payload written atomically with isFinalized:true. */
export interface FinalizedStep {
	finishReason: string;
	text: string;
	reasoning: string;
	toolCalls: ToolCallRecord[];
	responseMessages: ResponseMessageRecord[];
	usage: PromptUsage;
	model: string;
	durationMs: number;
}

/** Minimal view of an existing step row the replay guard reads. */
export interface ExistingStep {
	isFinalized: boolean;
	finishReason?: string;
	text?: string;
	toolCalls?: ToolCallRecord[];
	/** Persisted per-step usage — the replay path computes the same shouldCompact from it (G2.5). */
	usage?: PromptUsage;
}

/** Injected persistence port — wired to Convex mutations/queries by the llmStep action. */
export interface DecodeDeps {
	/** Replay guard source: the existing (requestId, stepNumber) step row, or null. */
	loadStep(): Promise<ExistingStep | null>;
	/** Upsert the streaming step row (isFinalized:false). Idempotent (a retry re-inserts safely). */
	insertStreaming(): Promise<void>;
	/** Delta-batcher sink: append coalesced deltas onto the step row in place. */
	patch(patch: DeltaPatch): Promise<void>;
	/** Persist the finalized step (toolCalls/usage/responseMessages, isFinalized:true). */
	finalizeStep(step: FinalizedStep): Promise<void>;
	now?: () => number;
	batchOptions?: DeltaBatcherOptions;
	/** Force-finalize deadline (ms); default {@link STREAM_DEADLINE_MS}. */
	streamDeadlineMs?: number;
	/** Approval-gated tool names — marks decoded toolCalls isHitl (P7). */
	hitlToolNames?: ReadonlySet<string>;
	/**
	 * Reactive-event emitter (G2.1). Wired by llmStep to `internal.events.append.append`, pre-decorating
	 * each event with the request's instanceId/submissionId/session. Optional so the pure decode unit
	 * tests run without it (no events emitted). decode emits the turn's message_start/text/thinking/
	 * tool_start/message_end/turn events off the AI SDK fullStream + the finalized step.
	 */
	emit?: (event: CoveEventInput) => Promise<void>;
	/**
	 * Frozen compaction settings + the model context window (G2.5). When present + enabled, the step decision's
	 * `shouldCompact` is computed from the finalized step's persisted usage vs `contextWindow - reserveTokens`.
	 * Absent (or disabled / contextWindow 0) → `shouldCompact` stays false (overflow + explicit still run).
	 */
	compaction?: { settings: CompactionSettings; contextWindow: number };
}

export interface DecodeInput {
	handle: ModelHandle;
	systemPrompt?: string;
	messages: ModelMessage[];
	tools: ModelToolView[];
	/** Opaque per-turn correlation id (llmStep mints `${requestId}:${stepNumber}`); stamped on emitted events. */
	turnId?: string;
}

/**
 * Run one decode. Returns the step decision. On a finalized step row it reconstructs the decision
 * without calling the model (replay guard, doc 08 §4.1); otherwise it streams from the AI SDK,
 * delta-batches text/reasoning into the row, and finalizes the step atomically.
 */
export async function runDecode(input: DecodeInput, deps: DecodeDeps): Promise<StepDecision> {
	const existing = await deps.loadStep();
	if (existing?.isFinalized) return reconstructDecision(existing, deps);

	await deps.insertStreaming();

	const now = deps.now ?? Date.now;
	const start = now();
	const deadlineMs = deps.streamDeadlineMs ?? STREAM_DEADLINE_MS;

	// Reactive-event emission (G2.1). Active only when an emitter + turnId are wired (production llmStep);
	// the pure unit tests leave both undefined and emit nothing.
	const emit = deps.emit;
	const turnId = input.turnId;
	const canEmit = emit !== undefined && turnId !== undefined;
	let thinkingStarted = false;
	if (canEmit) await emit!({ type: "message_start", turnId: turnId!, message: assistantMessageEvent([]) });

	// The delta-batcher sink both patches the step row AND emits append-only text_delta/thinking_delta
	// events (one per flush, ~10-20/turn — NOT per token), keeping event volume bounded. These deltas are
	// distinct from the cumulative step-row text (doc 08 §4.6 / G2.1 Risks).
	const sink = async (patch: DeltaPatch): Promise<void> => {
		await deps.patch(patch);
		if (!canEmit) return;
		if (patch.reasoning) {
			if (!thinkingStarted) {
				thinkingStarted = true;
				await emit!({ type: "thinking_start", turnId: turnId! });
			}
			await emit!({ type: "thinking_delta", delta: patch.reasoning, turnId: turnId! });
		}
		if (patch.text) await emit!({ type: "text_delta", text: patch.text, turnId: turnId! });
	};
	const batcher = new DeltaBatcher(sink, { ...deps.batchOptions, now });

	const result = streamText({
		model: input.handle.model as LanguageModelV2,
		system: input.systemPrompt,
		messages: input.messages,
		tools: toAiTools(input.tools),
	});

	let accText = "";
	let accReasoning = "";
	const toolCalls: ToolCallRecord[] = [];
	let finishReason = "stop";
	let usageRaw: AiSdkUsage | undefined;
	let modelId: string | undefined;
	let streamError: unknown;
	let forced = false;

	for await (const part of result.fullStream) {
		switch (part.type) {
			case "text-delta":
				accText += part.text;
				await batcher.text(part.text);
				break;
			case "reasoning-delta":
				accReasoning += part.text;
				await batcher.reasoning(part.text);
				break;
			case "tool-call":
				toolCalls.push({
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					args: asRecord(part.input),
					isHitl: deps.hitlToolNames?.has(part.toolName) || undefined,
				});
				if (canEmit) {
					await emit!({
						type: "tool_start",
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						args: asRecord(part.input),
						turnId: turnId!,
					});
				}
				break;
			case "finish-step":
				modelId = part.response.modelId ?? modelId;
				break;
			case "finish":
				finishReason = part.finishReason;
				usageRaw = part.totalUsage as AiSdkUsage;
				break;
			case "error":
				streamError = part.error;
				break;
			default:
				break;
		}
		if (now() - start >= deadlineMs) {
			forced = true;
			break;
		}
	}

	await batcher.flush();
	if (streamError) throw toError(streamError);

	let responseMessages: ResponseMessageRecord[];
	if (forced) {
		responseMessages = synthesizeResponse(accText, accReasoning, toolCalls);
	} else {
		try {
			const resp = await result.response;
			modelId = modelId ?? resp.modelId;
			responseMessages = resp.messages.map((m) => ({
				role: m.role,
				content: (m as { content: unknown }).content,
				providerMetadata: (m as { providerOptions?: unknown }).providerOptions,
			}));
		} catch {
			responseMessages = synthesizeResponse(accText, accReasoning, toolCalls);
		}
	}

	const finalized: FinalizedStep = {
		finishReason,
		text: accText,
		reasoning: accReasoning,
		toolCalls,
		responseMessages,
		usage: usageFromAiSdk(usageRaw, input.handle),
		model: modelId ?? input.handle.modelString,
		durationMs: now() - start,
	};
	await deps.finalizeStep(finalized);

	// Close the turn (G2.1): the message_end carries the FULL assembled assistant message so the consumer
	// reducer reconciles its provisional streaming parts (replay-idempotent, doc 08 §4.6) even if a
	// crash-replay double-emitted deltas; the turn event carries usage/model for the message metadata.
	if (canEmit) {
		if (thinkingStarted) await emit!({ type: "thinking_end", content: accReasoning, turnId: turnId! });
		await emit!({
			type: "message_end",
			turnId: turnId!,
			message: assistantMessageEvent(assistantContentBlocks(accText, accReasoning, toolCalls)),
		});
		await emit!({
			type: "turn",
			turnId: turnId!,
			purpose: "agent",
			durationMs: finalized.durationMs,
			model: finalized.model,
			provider: input.handle.provider,
			usage: finalized.usage,
			isError: false,
		});
	}

	return decisionFromFinalized(finalized, deps);
}

/**
 * An assistant AgentMessage carried by a message_start/message_end event. Observational only — the consumer
 * reconciles on role + content, and the full AssistantMessage metadata (api/usage/timestamp) is both
 * unavailable at message_start and redundant for rendering — so we cast a minimal {role,content}.
 */
function assistantMessageEvent(content: unknown[]): AgentMessage {
	return { role: "assistant", content } as unknown as AgentMessage;
}

/** Assemble the streamed turn into content blocks the consumer reducer's snapshotMessage understands. */
function assistantContentBlocks(
	text: string,
	reasoning: string,
	toolCalls: ToolCallRecord[],
): unknown[] {
	const content: unknown[] = [];
	if (reasoning) content.push({ type: "thinking", thinking: reasoning });
	if (text) content.push({ type: "text", text });
	for (const c of toolCalls) {
		content.push({ type: "toolCall", id: c.toolCallId, name: c.toolName, arguments: c.args });
	}
	return content;
}

/** Threshold compaction (G2.5): fire when this step's persisted usage crosses contextWindow − reserveTokens. */
function compactionDecision(deps: DecodeDeps, usage: PromptUsage | undefined): boolean {
	if (!deps.compaction || !usage) return false;
	const contextTokens =
		usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return evalShouldCompact(contextTokens, deps.compaction.contextWindow, deps.compaction.settings);
}

/** Reconstruct the step decision from a finalized row — the replay path (no model call). */
export function reconstructDecision(existing: ExistingStep, deps: DecodeDeps): StepDecision {
	return {
		finishReason: existing.finishReason ?? "stop",
		toolCalls: existing.toolCalls ?? [],
		text: existing.text ?? "",
		// Replay-stable: computed from the SAME persisted usage as the live path, so the compact branch re-takes.
		shouldCompact: compactionDecision(deps, existing.usage),
	};
}

function decisionFromFinalized(step: FinalizedStep, deps: DecodeDeps): StepDecision {
	return {
		finishReason: step.finishReason,
		toolCalls: step.toolCalls,
		text: step.text,
		// Threshold compaction (G2.5): from this step's finalized usage vs the frozen window/reserve.
		shouldCompact: compactionDecision(deps, step.usage),
	};
}

/** Map the run's frozen model-view tools to AI SDK tools (no execute — cove dispatches them itself). */
function toAiTools(views: ModelToolView[]) {
	const out: Record<string, ReturnType<typeof tool>> = {};
	for (const v of views) {
		out[v.name] = tool({
			description: v.description,
			inputSchema: jsonSchema(v.parameters as JSONSchema7),
		});
	}
	return out;
}

function synthesizeResponse(
	text: string,
	reasoning: string,
	toolCalls: ToolCallRecord[],
): ResponseMessageRecord[] {
	const content: unknown[] = [];
	if (reasoning) content.push({ type: "reasoning", text: reasoning });
	if (text) content.push({ type: "text", text });
	for (const c of toolCalls) {
		content.push({ type: "tool-call", toolCallId: c.toolCallId, toolName: c.toolName, input: c.args });
	}
	return [{ role: "assistant", content }];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
