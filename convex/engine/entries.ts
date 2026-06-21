// New (Convex backend) · @cove/runtime
// The context-rebuild bridge (doc 04 "Context-rebuild parity", decision in task #11): a turn's output is
// the AI-SDK decode + persisted tool results, but the NEXT llmStep builds context from canonical
// AgentMessage entries (sessions.load → SessionHistory.buildContext). So per turn the loop appends a
// canonical assistant message (+ ordered toolResult messages) to sessionEntries. The verbatim provider
// `responseMessages` are kept on the step row (decode.ts) for later reasoning-signature / prompt-cache
// continuity; this converter produces the canonical entries that drive context now.
//
// Pure / V8-safe: type-only imports; no Convex, no AI SDK.

import type {
	AssistantMessage,
	ImageContent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../../src/runtime/messages.ts";
import type { PromptUsage } from "../../src/runtime/types.ts";
import type { ToolCallRecord, ToolResultRecord } from "./types.ts";

/** The decode output needed to build a canonical assistant message (subset of FinalizedStep). */
export interface AssistantStepData {
	finishReason: string;
	text: string;
	reasoning: string;
	toolCalls: ToolCallRecord[];
	usage: PromptUsage;
	model: string;
}

/** Map an AI-SDK finish reason to the canonical pi `StopReason`. */
export function mapFinishReason(finishReason: string): StopReason {
	switch (finishReason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "tool-calls":
		case "tool_calls":
		case "toolUse":
			return "toolUse";
		case "error":
			return "error";
		default:
			return "stop";
	}
}

/** PromptUsage (caller-facing) → canonical message `Usage` (the shapes line up field-for-field). */
export function usageToCanonical(p: PromptUsage): Usage {
	return {
		input: p.input,
		output: p.output,
		cacheRead: p.cacheRead,
		cacheWrite: p.cacheWrite,
		...(p.cacheWrite1h !== undefined ? { cacheWrite1h: p.cacheWrite1h } : {}),
		totalTokens: p.totalTokens,
		cost: { ...p.cost },
	};
}

/** Build the canonical assistant message appended to history after a decode. */
export function stepToAssistantMessage(step: AssistantStepData, timestamp: number): AssistantMessage {
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];
	if (step.reasoning) content.push({ type: "thinking", thinking: step.reasoning });
	if (step.text) content.push({ type: "text", text: step.text });
	for (const tc of step.toolCalls) {
		content.push({ type: "toolCall", id: tc.toolCallId, name: tc.toolName, arguments: tc.args });
	}
	const provider = step.model.includes("/") ? step.model.slice(0, step.model.indexOf("/")) : step.model;
	return {
		role: "assistant",
		content,
		api: provider,
		provider,
		model: step.model,
		usage: usageToCanonical(step.usage),
		stopReason: mapFinishReason(step.finishReason),
		timestamp,
	};
}

/** Build the canonical toolResult message appended to history after a tool runs. */
export function toolResultToMessage(record: ToolResultRecord, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		content: engineContentToCanonical(record.result),
		isError: Boolean(record.isError),
		timestamp,
	};
}

/** Order a step's persisted tool results to match the assistant's tool-call order (linear active path). */
export function orderToolResults(
	toolCalls: ToolCallRecord[],
	results: ToolResultRecord[],
): ToolResultRecord[] {
	const byId = new Map(results.map((r) => [r.toolCallId, r]));
	const ordered: ToolResultRecord[] = [];
	for (const call of toolCalls) {
		const r = byId.get(call.toolCallId);
		if (r) {
			ordered.push(r);
			byId.delete(call.toolCallId);
		}
	}
	// Any results without a matching call (shouldn't happen) keep their original order at the end.
	for (const r of results) if (byId.has(r.toolCallId)) ordered.push(r);
	return ordered;
}

/** Convert a persisted EngineToolResult's content into canonical tool-result content blocks. */
function engineContentToCanonical(result: unknown): (TextContent | ImageContent)[] {
	const content = (result as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) {
		const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
		return [{ type: "text", text }];
	}
	return content.map((block) => {
		const b = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
		if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
			return { type: "image", data: b.data, mimeType: b.mimeType };
		}
		return { type: "text", text: typeof b.text === "string" ? b.text : "" };
	});
}
