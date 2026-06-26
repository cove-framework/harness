"use node";
// Ported from pi · @earendil-works/pi-ai · packages/ai/src/providers/transform-messages.ts
//   (downgradeUnsupportedImages, replaceImagesWithPlaceholder, the two placeholder constants) → @cove/runtime
// Applies sanitizeSurrogates (./sanitize.ts) to every outbound text field.
// SKIPS pi's tool-call-id normalization + synthetic-tool-result passes (those are P4 context rebuild).
//
// This is the LAST outbound transform: canonical Message[] → AI SDK ModelMessage[]. It carries the
// "use node" directive because the barrel pulls it into the node module; the AI SDK is referenced
// type-only (`ModelMessage`), so no runtime AI SDK import is emitted (verbatimModuleSyntax + import type).

import type { ModelMessage } from "ai";
import type {
	ImageContent,
	Message,
	ModelHandle,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../../src/runtime/messages.ts";
import { sanitizeSurrogates } from "./sanitize.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "[image omitted: model has no vision]";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "[tool image omitted: model has no vision]";

/**
 * REPLACE image blocks with a single text placeholder, de-duping consecutive
 * placeholders via `previousWasPlaceholder` (pi parity). Replacing rather than
 * dropping preserves positional context for a non-vision model. 1:1 from pi's
 * `replaceImagesWithPlaceholder`.
 */
function replaceImagesWithPlaceholder(
	content: (TextContent | ImageContent)[],
	placeholder: string,
): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

/**
 * When the model has no vision, REPLACE image parts in `user`/`toolResult`
 * messages with a text placeholder. Gated on `supportsVision === false` — an
 * `undefined`/`true` capability passes images through untouched. Ported from
 * pi's `downgradeUnsupportedImages` (reading `ModelHandle` instead of pi `Model`).
 */
function downgradeUnsupportedImages(messages: Message[], handle: ModelHandle): Message[] {
	if (handle.supportsVision !== false) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/** AI SDK user/tool image part, base64 data URL form. */
function imagePart(block: ImageContent) {
	return {
		type: "image" as const,
		image: `data:${block.mimeType};base64,${block.data}`,
		mediaType: block.mimeType,
	};
}

/** Map canonical user content → AI SDK `UserContent`. */
function mapUserContent(content: string | (TextContent | ImageContent)[]) {
	if (typeof content === "string") {
		return sanitizeSurrogates(content);
	}
	return content.map((block) => {
		if (block.type === "image") return imagePart(block);
		return { type: "text" as const, text: sanitizeSurrogates(block.text) };
	});
}

/** Map canonical assistant content → AI SDK `AssistantContent` parts. */
function mapAssistantContent(content: (TextContent | ThinkingContent | ToolCall)[]) {
	const parts: Array<
		| { type: "text"; text: string }
		| { type: "reasoning"; text: string }
		| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	> = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push({ type: "text", text: sanitizeSurrogates(block.text) });
		} else if (block.type === "thinking") {
			// Reasoning text is sanitized too; redacted/empty reasoning is dropped here
			// (the outbound transform doesn't replay encrypted signatures — that's P4).
			if (block.thinking && block.thinking.trim() !== "") {
				parts.push({ type: "reasoning", text: sanitizeSurrogates(block.thinking) });
			}
		} else if (block.type === "toolCall") {
			parts.push({
				type: "tool-call",
				toolCallId: block.id,
				toolName: block.name,
				input: block.arguments,
			});
		}
	}
	return parts;
}

/** Map canonical tool-result content → an AI SDK tool-result `output` value. */
function mapToolResultOutput(content: (TextContent | ImageContent)[]) {
	const value = content.map((block) => {
		if (block.type === "image") {
			// AI SDK v7: base64 image data in a tool-result `content` output is `image-data`
			// (was `media` in v5). FileData-backed images would be `file`; Cove passes a base64 string.
			return { type: "image-data" as const, data: block.data, mediaType: block.mimeType };
		}
		return { type: "text" as const, text: sanitizeSurrogates(block.text) };
	});
	return { type: "content" as const, value };
}

/**
 * The last outbound transform. Applies the non-vision image downgrade
 * (REPLACE + de-dupe), runs `sanitizeSurrogates` over every text/reasoning/
 * tool-result-text field, and maps the canonical `Message[]` to the AI SDK
 * `ModelMessage[]` the durable engine (P4) feeds to `streamText`. SKIPS pi's
 * tool-call-id normalization + synthetic-tool-result passes (P4 concerns).
 */
export function toModelMessages(messages: Message[], handle: ModelHandle): ModelMessage[] {
	const downgraded = downgradeUnsupportedImages(messages, handle);
	const out: ModelMessage[] = [];

	for (const msg of downgraded) {
		if (msg.role === "user") {
			out.push({ role: "user", content: mapUserContent(msg.content) });
		} else if (msg.role === "assistant") {
			out.push({ role: "assistant", content: mapAssistantContent(msg.content) });
		} else if (msg.role === "toolResult") {
			out.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						output: mapToolResultOutput(msg.content),
					},
				],
			});
		}
	}

	return out;
}
