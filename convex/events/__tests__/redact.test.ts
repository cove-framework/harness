// New · @cove/runtime — redactEventImages covers every image-carrying CoveEvent variant (G2.1 acceptance 3).
import { describe, expect, it } from "vitest";
import type { CoveEventInput } from "../../../src/runtime/types.ts";
import { IMAGE_DATA_OMITTED } from "../../../src/runtime/event-image.ts";
import { redactEventImages } from "../redact.ts";

const RAW = "iVBORw0KGgoAAAANS-base64-bytes";
const PNG = "image/png";

function imageBlock() {
	return { type: "image" as const, data: RAW, mimeType: PNG };
}
function userMsg() {
	return { role: "user" as const, content: [{ type: "text", text: "hi" }, imageBlock()], timestamp: 0 };
}
function toolResultMsg() {
	return {
		role: "toolResult" as const,
		toolCallId: "c1",
		toolName: "shot",
		content: [imageBlock()],
		isError: false,
		timestamp: 0,
	};
}

/** Assert: every image block in the (deep) value has data === sentinel and mimeType intact, and RAW is gone. */
function assertRedacted(value: unknown): void {
	const json = JSON.stringify(value);
	expect(json).not.toContain(RAW);
	expect(json).toContain(IMAGE_DATA_OMITTED);
	expect(json).toContain(PNG);
}

describe("redactEventImages", () => {
	it("redacts message_start / message_end message content", () => {
		for (const type of ["message_start", "message_end"] as const) {
			const e = { type, turnId: "t1", message: userMsg() } as unknown as CoveEventInput;
			assertRedacted(redactEventImages(e));
		}
	});

	it("redacts turn_messages message + toolResults", () => {
		const e = {
			type: "turn_messages",
			turnId: "t1",
			purpose: "agent",
			message: userMsg(),
			toolResults: [toolResultMsg()],
		} as unknown as CoveEventInput;
		assertRedacted(redactEventImages(e));
	});

	it("redacts agent_end messages[]", () => {
		const e = { type: "agent_end", messages: [userMsg(), toolResultMsg()] } as unknown as CoveEventInput;
		assertRedacted(redactEventImages(e));
	});

	it("redacts tool / task / operation result content", () => {
		for (const type of ["tool", "task", "operation"] as const) {
			const e = {
				type,
				toolName: "x",
				toolCallId: "c1",
				isError: false,
				durationMs: 1,
				result: { content: [imageBlock()] },
			} as unknown as CoveEventInput;
			assertRedacted(redactEventImages(e));
		}
	});

	it("redacts turn_request input.messages", () => {
		const e = {
			type: "turn_request",
			turnId: "t1",
			purpose: "agent",
			model: "m",
			provider: "p",
			api: "a",
			input: { messages: [userMsg(), toolResultMsg()] },
		} as unknown as CoveEventInput;
		assertRedacted(redactEventImages(e));
	});

	it("is copy-on-write: an event with no images returns the same reference", () => {
		const e = { type: "message_end", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as unknown as CoveEventInput;
		expect(redactEventImages(e)).toBe(e);
	});

	it("passes non-image variants through unchanged", () => {
		const e = { type: "text_delta", text: "hello" } as unknown as CoveEventInput;
		expect(redactEventImages(e)).toBe(e);
		const idle = { type: "idle" } as unknown as CoveEventInput;
		expect(redactEventImages(idle)).toBe(idle);
	});

	it("does not mutate the input message in place", () => {
		const msg = userMsg();
		const e = { type: "message_start", turnId: "t1", message: msg } as unknown as CoveEventInput;
		redactEventImages(e);
		// the original block still holds raw bytes — redaction is copy-on-write
		expect((msg.content[1] as { data: string }).data).toBe(RAW);
	});
});
