// @vitest-environment happy-dom
// New · @cove/react — G2.1 acceptance 5/10: useRunEvents (under happy-dom) renders a growing UIMessage[]
// whose assistant text part accretes across text_delta and finalizes (state:'done') on message_end.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CoveEvent } from "../../runtime/types.ts";
import type { CoveEventsListener, CoveReactiveClient } from "../client-types.ts";
import { useRunEvents } from "../use-run-events.ts";

function makeFakeClient() {
	let listener: CoveEventsListener | undefined;
	const client: CoveReactiveClient = {
		agents: {
			async send() {
				return { sessionId: "s1", requestId: "r1", submissionId: "sub1" };
			},
		},
		subscribeEvents(_streamKey, l) {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
	};
	return { client, deliver: (events: CoveEvent[]) => listener?.(events) };
}

let idx = 0;
function ev(partial: Partial<CoveEvent> & { type: string }): CoveEvent {
	return {
		instanceId: "i1",
		turnId: "t1",
		v: 1,
		eventIndex: idx++,
		timestamp: `2026-01-01T00:00:00.${String(idx).padStart(3, "0")}Z`,
		...partial,
	} as unknown as CoveEvent;
}

describe("useRunEvents (happy-dom)", () => {
	it("renders an assistant UIMessage whose text grows in place and finalizes on message_end", () => {
		const { client, deliver } = makeFakeClient();
		const { result } = renderHook(() => useRunEvents("i1", { client }));

		expect(result.current.messages).toEqual([]);
		expect(result.current.status).toBe("idle");

		act(() => {
			deliver([
				ev({ type: "message_start", message: { role: "assistant", content: [] } } as never),
				ev({ type: "text_delta", text: "Hello" } as never),
				ev({ type: "text_delta", text: " world" } as never),
			]);
		});

		expect(result.current.messages).toHaveLength(1);
		const streaming = result.current.messages[0];
		expect(streaming.role).toBe("assistant");
		expect(streaming.parts).toEqual([{ type: "text", text: "Hello world", state: "streaming" }]);

		act(() => {
			deliver([
				ev({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
				} as never),
			]);
		});

		expect(result.current.messages).toHaveLength(1);
		const done = result.current.messages[0];
		expect(done.parts).toEqual([{ type: "text", text: "Hello world", state: "done" }]);
	});

	it("dedups a re-delivered batch (idempotent on Convex onUpdate re-emit)", () => {
		const { client, deliver } = makeFakeClient();
		const batch = [
			ev({ type: "message_start", message: { role: "assistant", content: [] } } as never),
			ev({ type: "text_delta", text: "hi" } as never),
		];
		const { result } = renderHook(() => useRunEvents("i1", { client }));
		act(() => deliver(batch));
		const first = result.current.messages;
		act(() => deliver(batch)); // identical re-delivery → no change
		expect(result.current.messages).toEqual(first);
		expect(result.current.messages[0].parts).toEqual([
			{ type: "text", text: "hi", state: "streaming" },
		]);
	});
});
