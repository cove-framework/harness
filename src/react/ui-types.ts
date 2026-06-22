// Ported from flue · @flue/react · packages/react/src/types.ts → @cove/react
// UIMessage/UIMessagePart mirror `ai@5.x` packages/ai/src/ui/ui-messages.ts (verbatim).
// `AgentPromptImage` is folded in here (flue had it in @flue/sdk public/invoke.ts) to keep
// the react layer decoupled from the SDK package — it is structurally identical to the
// runtime's `ImageContent`/`PromptImage` (`{ type:'image'; data; mimeType }`).

import type { PromptUsage } from "../runtime/types.ts";

export type UIMessagePart =
	| { type: "text"; text: string; state?: "streaming" | "done" }
	| { type: "reasoning"; text: string; state?: "streaming" | "done" }
	| ({ type: "dynamic-tool"; toolName: string; toolCallId: string } & (
			| { state: "input-available"; input: unknown; output?: never; errorText?: never }
			| { state: "output-available"; input: unknown; output: unknown; errorText?: never }
			| { state: "output-error"; input: unknown; output?: never; errorText: string }
	  ))
	| { type: "file"; mediaType: string; url: string };

// Mirrors UIMessage from ai@5.0.201 packages/ai/src/ui/ui-messages.ts.
export interface UIMessage {
	id: string;
	role: "user" | "assistant" | "system";
	metadata?: {
		usage?: PromptUsage;
		model?: { provider: string; id: string };
		[key: string]: unknown;
	};
	parts: UIMessagePart[];
}

/**
 * Inline image attached to one optimistic agent send. Structurally identical to the
 * runtime `ImageContent`/`PromptImage` (`{ type:'image'; data: base64; mimeType }`).
 * Kept local so `@cove/react` does not depend on `@cove/sdk`'s `AgentPromptImage`.
 */
export interface AgentPromptImage {
	type: "image";
	data: string;
	mimeType: string;
}
