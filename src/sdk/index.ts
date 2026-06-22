// New · @cove/sdk — the native consumer client (doc 05 "The Convex-native SDK"). Backs the CoveContext
// facade (src/runtime/context.ts) with a real Convex client: submit via the invoke mutation, await via the
// reactive requests query (no SSE). Decoupled from convex/_generated — the caller passes the function
// references (e.g. `api.invoke.submit.submitPrompt`), so this package stays independent of the backend build.
// (@cove/react hooks + the events-table async-iterator are the UI layer atop this; not in this cut.)

import {
	createCoveContext,
	type CoveContextInit,
	type CoveTransport,
	type RequestSnapshot,
} from "../runtime/context.ts";
import type { CoveContext } from "../runtime/types.ts";

/** Minimal Convex client surface — both ConvexHttpClient and ConvexReactClient satisfy it. */
export interface ConvexLike {
	mutation(reference: any, args: Record<string, unknown>): Promise<any>;
	query(reference: any, args: Record<string, unknown>): Promise<any>;
}

/** Deployed function references the transport calls (pass them from the app's generated `api`). */
export interface CoveApiRefs {
	submitPrompt: unknown;
	stopActive: unknown;
	getRequest: unknown;
	sessionExists: unknown;
	deleteSession: unknown;
	/** api.invoke.submit.submitSkill (G2.5). */
	submitSkill: unknown;
	/** api.invoke.submit.submitCompact (G2.5). */
	submitCompact: unknown;
}

export interface CreateCoveTransportOptions {
	pollIntervalMs?: number;
	pollDeadlineMs?: number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Build a CoveTransport over a Convex client + the app's function references. */
export function createCoveTransport(
	client: ConvexLike,
	refs: CoveApiRefs,
	opts?: CreateCoveTransportOptions,
): CoveTransport {
	const intervalMs = opts?.pollIntervalMs ?? 400;
	const deadlineMs = opts?.pollDeadlineMs ?? 600_000;

	return {
		async submitPrompt(submission) {
			const r = (await client.mutation(refs.submitPrompt, {
				prompt: submission.prompt,
				model: submission.model,
				instanceId: submission.instanceId,
				harnessName: submission.harnessName,
				sessionName: submission.sessionName,
				resultSchema: submission.resultSchema,
			})) as { requestId: string };
			return { requestId: r.requestId };
		},
		async submitSkill(submission) {
			const r = (await client.mutation(refs.submitSkill, {
				skill: submission.skill,
				args: submission.args,
				model: submission.model,
				instanceId: submission.instanceId,
				harnessName: submission.harnessName,
				sessionName: submission.sessionName,
			})) as { requestId: string };
			return { requestId: r.requestId };
		},
		async submitCompact(ref) {
			const r = (await client.mutation(refs.submitCompact, {
				instanceId: ref.instanceId,
				harnessName: ref.harnessName,
				sessionName: ref.sessionName,
			})) as { requestId: string };
			return { requestId: r.requestId };
		},
		async awaitTerminal(requestId, signal) {
			const deadline = Date.now() + deadlineMs;
			for (;;) {
				if (signal.aborted) throw abortError(signal);
				const snap = (await client.query(refs.getRequest, { requestId })) as RequestSnapshot | null;
				if (snap && TERMINAL.has(snap.status)) return snap;
				if (Date.now() >= deadline) {
					return snap ?? { status: "failed", error: "poll deadline exceeded" };
				}
				await delay(intervalMs, signal);
			}
		},
		async stopActive(ref) {
			await client.mutation(refs.stopActive, {
				instanceId: ref.instanceId,
				harnessName: ref.harnessName,
				sessionName: ref.sessionName,
			});
		},
		async sessionExists(ref) {
			return Boolean(
				await client.query(refs.sessionExists, {
					instanceId: ref.instanceId,
					harnessName: ref.harnessName,
					sessionName: ref.sessionName,
				}),
			);
		},
		async deleteSession(ref) {
			await client.mutation(refs.deleteSession, {
				instanceId: ref.instanceId,
				harnessName: ref.harnessName,
				sessionName: ref.sessionName,
			});
		},
	};
}

export interface CoveClient {
	/** Construct a CoveContext for an invocation (then `.init(agent).session().prompt(...)`). */
	context<TPayload = unknown, TEnv = Record<string, any>>(
		init: CoveContextInit<TPayload, TEnv>,
	): CoveContext<TPayload, TEnv>;
	readonly transport: CoveTransport;
}

/** Wrap a Convex client into a CoveClient bound to the CoveContext facade. */
export function createCoveClient(
	client: ConvexLike,
	refs: CoveApiRefs,
	opts?: CreateCoveTransportOptions,
): CoveClient {
	const transport = createCoveTransport(client, refs, opts);
	return {
		transport,
		context: (init) => createCoveContext(transport, init),
	};
}

// ─── Reactive consumer client (createCoveReactiveClient) ─────────────────────
// Distinct from the runtime-facade transport above: this is the Convex-reactive consumer
// surface (agents.send/prompt, runs.get/events) ported from @flue/sdk. No SSE / Durable Streams.
export { createCoveReactiveClient } from "./client.ts";
export {
	createCoveEventStream,
	type CreateCoveEventStreamOptions,
} from "./event-stream.ts";
export {
	CoveApiError,
	type AgentPromptImage,
	type AgentPromptOptions,
	type AgentPromptResult,
	type AgentSendResult,
	type AttachedAgentEvent,
	type CoveConvexClient,
	type CoveEvent,
	type CoveEventStream,
	type CoveReactiveApiRefs,
	type CoveReactiveClient,
	type CoveStreamOptions,
	type CreateCoveReactiveClientOptions,
	type PromptResponse,
	type PromptUsage,
	type RunRecord,
	type RunStatus,
	type WorkflowInvokeOptions,
} from "./types.ts";
export { IMAGE_DATA_OMITTED } from "./types.ts";

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(abortError(signal));
			},
			{ once: true },
		);
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
}
