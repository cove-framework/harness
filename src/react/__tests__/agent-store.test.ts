// New · @cove/react — pure (no-DOM) AgentStore tests.
// Proves: (1) events delivered through the client subscription dispatch into the reducer
// and update the snapshot + notify subscribers; (2) `sendMessage` runs the optimistic
// `local_send_submitted` → mutation → `local_send_admitted` sequence; (3) re-delivered
// events are deduped by the reducer's `recentEventIds`.

import { describe, expect, it } from "vitest";
import type { CoveEvent } from "../../runtime/types.ts";
import { AgentStore } from "../agent-store.ts";
import type { AgentSendResult, CoveEventsListener, CoveReactiveClient } from "../client-types.ts";

const base = {
	v: 1 as const,
	instanceId: "instance-1",
	timestamp: "2026-06-12T00:00:00.000Z",
};

/** Fake client that captures the subscription listener so tests push events directly. */
class FakeClient implements CoveReactiveClient {
	listener: CoveEventsListener | undefined;
	sent: { message: string }[] = [];
	sendResult: AgentSendResult = {
		sessionId: "session-1",
		requestId: "request-1",
		submissionId: "submission-1",
	};
	sendError: Error | undefined;

	agents = {
		send: async (options: { message: string }): Promise<AgentSendResult> => {
			this.sent.push({ message: options.message });
			if (this.sendError) throw this.sendError;
			return this.sendResult;
		},
	};

	subscribeEvents(_streamKey: string, listener: CoveEventsListener): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	deliver(...events: CoveEvent[]): void {
		this.listener?.(events);
	}
}

function textDelta(text: string, eventIndex: number, turnId = "turn-1"): CoveEvent {
	return { ...base, type: "text_delta", text, eventIndex, turnId } as unknown as CoveEvent;
}

function messageStart(turnId = "turn-1", eventIndex = 1): CoveEvent {
	return {
		...base,
		type: "message_start",
		message: { role: "assistant", content: [] },
		turnId,
		eventIndex,
	} as unknown as CoveEvent;
}

describe("AgentStore", () => {
	it("dispatches delivered events into the reducer and notifies subscribers", () => {
		const client = new FakeClient();
		const store = new AgentStore(client, "instance-1");
		let notifications = 0;
		store.subscribe(() => {
			notifications++;
		});
		store.start();
		expect(client.listener).toBeDefined();

		client.deliver(messageStart(), textDelta("hello", 2), textDelta(" world", 3));

		const snapshot = store.getSnapshot();
		expect(snapshot.messages).toHaveLength(1);
		expect(snapshot.messages[0]?.id).toBe("turn:turn-1");
		expect(snapshot.messages[0]?.parts).toEqual([
			{ type: "text", text: "hello world", state: "streaming" },
		]);
		expect(notifications).toBeGreaterThan(0);
		store.dispose();
	});

	it("does not re-apply re-delivered events (reducer recentEventIds dedup)", () => {
		const client = new FakeClient();
		const store = new AgentStore(client, "instance-1");
		store.start();

		const events = [messageStart(), textDelta("hi", 2)];
		client.deliver(...events);
		const first = store.getSnapshot();
		client.deliver(...events); // whole-result re-delivery
		const second = store.getSnapshot();

		expect(second.messages).toEqual(first.messages);
		expect(second.messages[0]?.parts).toEqual([{ type: "text", text: "hi", state: "streaming" }]);
		store.dispose();
	});

	it("runs the optimistic send → admitted sequence", async () => {
		const client = new FakeClient();
		const store = new AgentStore(client, "instance-1");
		store.start();

		const promise = store.sendMessage("hello there");
		// Optimistic user message is rendered immediately, status submitted.
		const optimistic = store.getSnapshot();
		expect(optimistic.status).toBe("submitted");
		expect(optimistic.messages).toHaveLength(1);
		expect(optimistic.messages[0]?.role).toBe("user");

		await promise;
		expect(client.sent).toEqual([{ message: "hello there" }]);
		// Still one pending send (no idle yet), correlated to submission-1.
		expect(store.getSnapshot().status).toBe("submitted");

		// The echoed user message collapses the optimistic one onto the submission id.
		client.deliver({
			...base,
			type: "message_end",
			message: { role: "user", content: "hello there" },
			submissionId: "submission-1",
			eventIndex: 1,
		} as unknown as CoveEvent);
		const reconciled = store.getSnapshot();
		expect(reconciled.messages).toHaveLength(1);
		expect(reconciled.messages[0]?.id).toBe("submission:submission-1:user:0");
		store.dispose();
	});

	it("sets status error and removes the optimistic message when send fails", async () => {
		const client = new FakeClient();
		client.sendError = new Error("offline");
		const store = new AgentStore(client, "instance-1");
		store.start();

		await expect(store.sendMessage("hello")).rejects.toThrow("offline");
		const snapshot = store.getSnapshot();
		expect(snapshot.status).toBe("error");
		expect(snapshot.error?.message).toBe("offline");
		expect(snapshot.messages).toEqual([]);
		store.dispose();
	});

	it("stops delivering after dispose()", () => {
		const client = new FakeClient();
		const store = new AgentStore(client, "instance-1");
		store.start();
		store.dispose();
		expect(client.listener).toBeUndefined();
	});
});
