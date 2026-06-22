// Ported from flue · @flue/runtime · packages/runtime/src/event-redaction.ts → @cove/runtime
// Full-CoveEvent image redaction. Widened beyond flue's variant set (message_*/turn_messages/
// agent_end/tool) to the rest of the cove union that carries content: task/operation `result`
// and turn_request `input.messages` (user/toolResult LLM messages carry image content). The
// per-content-block work delegates to the already-ported `redactImageBlocks` (convex/sessions/
// images.ts, identical logic) instead of re-implementing.
//
// Copy-on-write: an event without image content passes through unchanged (same reference), and
// redaction never mutates the input — the message objects carried by these events are the live
// objects in agent state; mutating them in place would corrupt model context + session history.
//
// Pure / V8-safe-adjacent: imports only the pure redactor + types (no Convex runtime, no AI SDK).

import type { AgentMessage } from "../../src/runtime/messages.ts";
import type { CoveEventInput, LlmMessage } from "../../src/runtime/types.ts";
import { redactImageBlocks } from "../sessions/images.ts";

/** Return `event` with raw image bytes replaced by `IMAGE_DATA_OMITTED` in every content-bearing field. */
export function redactEventImages(event: CoveEventInput): CoveEventInput {
	switch (event.type) {
		case "message_start":
		case "message_end": {
			const message = redactMessageImages(event.message);
			return message === event.message ? event : { ...event, message };
		}
		case "turn_messages": {
			const message = redactMessageImages(event.message);
			const toolResults = redactEachMessage(event.toolResults);
			if (message === event.message && toolResults === event.toolResults) return event;
			return { ...event, message, toolResults };
		}
		case "agent_end": {
			const messages = redactEachMessage(event.messages);
			return messages === event.messages ? event : { ...event, messages };
		}
		case "tool":
		case "task":
		case "operation": {
			const result = redactResultImages(event.result);
			return result === event.result ? event : { ...event, result };
		}
		case "turn_request": {
			const messages = redactEachMessage(event.input.messages);
			return messages === event.input.messages
				? event
				: { ...event, input: { ...event.input, messages } };
		}
		default:
			// Variants with no image-bearing payload (text_delta/turn/idle/operation_start/…) pass through.
			// `turn.output` is an assistant message whose content (text/thinking/toolCall) never holds images.
			return event;
	}
}

/** Redact image blocks inside a message's `content` array (AgentMessage | LlmMessage). Non-array content passes through. */
function redactMessageImages<M extends AgentMessage | LlmMessage>(message: M): M {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return message;
	const redacted = redactImageBlocks(content);
	return redacted === content ? message : ({ ...message, content: redacted } as M);
}

function redactEachMessage<M extends AgentMessage | LlmMessage>(messages: M[]): M[] {
	let changed = false;
	const out = messages.map((m) => {
		const r = redactMessageImages(m);
		if (r !== m) changed = true;
		return r;
	});
	return changed ? out : messages;
}

/** Redact image blocks in an AgentToolResult-shaped `{ content: [...] }` payload. Arbitrary `details` pass through. */
function redactResultImages(result: unknown): unknown {
	if (result === null || typeof result !== "object") return result;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return result;
	const redacted = redactImageBlocks(content);
	return redacted === content ? result : { ...result, content: redacted };
}
