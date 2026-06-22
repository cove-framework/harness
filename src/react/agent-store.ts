// Ported from flue · @flue/react · packages/react/src/agent-session.ts → @cove/react
// TRANSFORM, not a verbatim port. Kept: the `useSyncExternalStore` shape
// (subscribe/getSnapshot + private dispatch/publish/publicSnapshot) and the
// `sendMessage → local_send_submitted → mutation → local_send_admitted/local_send_failed`
// sequence. DROPPED: the entire DS reconnect/offset/backoff machine
// (generation/dormantFresh/reconnectOffset/admittedOffset/reconnectAttempt/reconnectWake,
// connect/retry/isFatal/isStatus/404-replay) — Convex reactivity handles reconnection.
// Events are sourced from a reactive subscription the store is fed (`start(streamKey)`
// → `client.subscribeEvents`), and each delivered `CoveEvent` is dispatched into the
// reducer; the reducer's own `recentEventIds` handles re-delivery dedup.

import type { CoveEvent } from "../runtime/types.ts";
import {
	type AgentReducerEvent,
	type AgentSnapshot,
	type AgentState,
	emptyAgentState,
	reduceAgentEvent,
} from "./agent-reducer.ts";
import type { AgentPromptImage, CoveReactiveClient } from "./client-types.ts";

export interface SendMessageOptions {
	images?: AgentPromptImage[];
	instanceId?: string;
	harnessName?: string;
	sessionName?: string;
	model?: string;
}

export class AgentStore {
	private state: AgentState = { ...emptyAgentState };
	private snapshot: AgentSnapshot = publicSnapshot(this.state);
	private listeners = new Set<() => void>();
	private unsubscribe: (() => void) | undefined;
	private active = false;
	private localId = 0;

	constructor(
		private client: CoveReactiveClient,
		/** Reactive event-stream key (typically the agent `instanceId`). */
		private streamKey: string,
	) {}

	/** Begin the reactive event subscription. Idempotent. */
	start(): void {
		if (this.active) return;
		this.active = true;
		this.unsubscribe = this.client.subscribeEvents(this.streamKey, (events) => {
			for (const event of events) this.dispatch(event as AgentReducerEvent);
		});
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): AgentSnapshot => this.snapshot;

	/**
	 * Optimistically render a user message, admit it via the client mutation, then
	 * reconcile with `local_send_admitted` (carrying the `submissionId`) or
	 * `local_send_failed` on error. Mirrors flue's send sequence, sans DS offsets.
	 */
	async sendMessage(message: string, options: SendMessageOptions = {}): Promise<void> {
		const localId = `local:${this.streamKey}:${++this.localId}`;
		this.dispatch({
			type: "local_send_submitted",
			localId,
			message,
			images: options.images,
		});
		try {
			const receipt = await this.client.agents.send({
				message,
				images: options.images,
				instanceId: options.instanceId ?? this.streamKey,
				harnessName: options.harnessName,
				sessionName: options.sessionName,
				model: options.model,
			});
			this.dispatch({
				type: "local_send_admitted",
				localId,
				submissionId: receipt.submissionId,
			});
		} catch (error) {
			this.dispatch({ type: "local_send_failed", localId, error: toError(error) });
			throw error;
		}
	}

	/** Feed a single event in directly (used by tests + co-subscribed sources). */
	dispatchEvent(event: CoveEvent): void {
		this.dispatch(event as AgentReducerEvent);
	}

	dispose(): void {
		if (!this.active) return;
		this.active = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private dispatch(event: AgentReducerEvent): void {
		const next = reduceAgentEvent(this.state, event);
		if (next === this.state) return;
		this.state = next;
		this.publish();
	}

	private publish(): void {
		this.snapshot = publicSnapshot(this.state);
		for (const listener of this.listeners) listener();
	}
}

function publicSnapshot(state: AgentState): AgentSnapshot {
	return { messages: state.messages, status: state.status, error: state.error };
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
