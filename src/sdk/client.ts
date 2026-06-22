// Ported from flue · @flue/sdk · packages/sdk/src/client.ts → @cove/sdk
//
// The reactive consumer client. Distinct from the runtime-facade transport
// (`createCoveClient`/`createCoveTransport` in index.ts). Events flow over Convex reactivity:
// `agents.send` → submit mutation; `agents.prompt` → submit then watch the request query to
// terminal; `runs.get` → run query; `runs.events` → a reactive CoveEventStream. The legacy
// Durable-Streams engine and its stream/events loop are dropped entirely (no SSE in the path).
// `workflows` is a typed-but-throwing slot until G2.4 (D18).

import { createCoveEventStream } from "./event-stream.ts";
import {
	type AgentPromptOptions,
	type AgentPromptResult,
	type AgentSendResult,
	type CoveConvexClient,
	type CoveEventStream,
	CoveApiError,
	type CoveReactiveApiRefs,
	type CoveReactiveClient,
	type CoveStreamOptions,
	type CreateCoveReactiveClientOptions,
	type PromptResponse,
	type RunRecord,
	type WorkflowInvokeOptions,
} from "./types.ts";

/** Terminal request statuses (mirrors RequestSnapshot's terminal set). */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Snapshot shape returned by `refs.getRequest` (mirrors convex/requests.ts `get`). */
interface RequestSnapshot {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	finalText?: string;
	result?: unknown;
	error?: string;
	cancelReason?: string;
	usage?: PromptResponse["usage"];
}

/** Admission envelope returned by `refs.submitPrompt`. */
interface AdmitResult {
	sessionId: string;
	requestId: string;
	submissionId: string;
}

/**
 * Creates the reactive consumer client over a Convex client + the app's function references.
 * `options.convex` is any value satisfying {@link CoveConvexClient} (a `convex/browser`
 * `ConvexClient`, or `@cove/react`'s adapter).
 */
export function createCoveReactiveClient(
	options: CreateCoveReactiveClientOptions,
): CoveReactiveClient {
	const convex: CoveConvexClient = options.convex;
	const refs: CoveReactiveApiRefs = options.refs;

	const submit = async (
		_name: string,
		id: string,
		opts: AgentPromptOptions,
	): Promise<AdmitResult> => {
		// `_name` (agent) has no slot in the cove submitPrompt mutation — a deployment binds its
		// agent set, and the instance is keyed by `instanceId`. `id` maps to `instanceId`.
		// `opts.images` is dropped here: submitPrompt takes a plain `prompt` string with no image
		// arg yet (see the integration note in the manifest).
		const args: Record<string, unknown> = {
			instanceId: id,
			prompt: opts.message,
		};
		const r = (await convex.mutation(refs.submitPrompt, args)) as AdmitResult;
		return { sessionId: r.sessionId, requestId: r.requestId, submissionId: r.submissionId };
	};

	return {
		agents: {
			async send(name, id, opts): Promise<AgentSendResult> {
				return submit(name, id, opts);
			},
			async prompt(name, id, opts): Promise<AgentPromptResult> {
				const admit = await submit(name, id, opts);
				const snapshot = await watchRequestToTerminal(
					convex,
					refs,
					admit.requestId,
					opts.signal,
				);
				if (snapshot.status === "failed") {
					throw new CoveApiError(`agent prompt failed: ${snapshot.error ?? "unknown error"}`, {
						type: "prompt_failed",
						details: snapshot.error,
					});
				}
				if (snapshot.status === "cancelled") {
					throw new CoveApiError(`agent prompt cancelled: ${snapshot.cancelReason ?? "cancelled"}`, {
						type: "prompt_cancelled",
						details: snapshot.cancelReason,
					});
				}
				const result: PromptResponse = {
					text: snapshot.finalText ?? "",
					usage: snapshot.usage ?? ZERO_USAGE,
					// requests.get does not surface the selected model yet — empty placeholder.
					model: { provider: "", id: "" },
				};
				return { ...admit, result };
			},
		},
		runs: {
			async get(runId): Promise<RunRecord | null> {
				const record = (await convex.query(refs.getRun, { runId })) as RunRecord | null;
				return record ?? null;
			},
			events(streamKey, streamOpts?: CoveStreamOptions): CoveEventStream {
				return createCoveEventStream({
					convex,
					listForStreamRef: refs.listForStream,
					streamKey,
					sinceSeq: streamOpts?.sinceSeq,
					signal: streamOpts?.signal,
				});
			},
		},
		workflows: {
			invoke(_name: string, _options?: WorkflowInvokeOptions): Promise<never> {
				throw new CoveApiError("workflows: not available until G2.4", {
					type: "not_implemented",
				});
			},
		},
	};
}

/**
 * Subscribes `refs.getRequest` and resolves once the request reaches a terminal status. Uses the
 * reactive query — no polling. Honors an abort signal.
 */
function watchRequestToTerminal(
	convex: CoveConvexClient,
	refs: CoveReactiveApiRefs,
	requestId: string,
	signal?: AbortSignal,
): Promise<RequestSnapshot> {
	return new Promise<RequestSnapshot>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		let unsubscribe: (() => void) | undefined;
		let onAbort: (() => void) | undefined;
		const cleanup = () => {
			unsubscribe?.();
			unsubscribe = undefined;
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
		};
		if (signal) {
			onAbort = () => {
				cleanup();
				reject(abortError(signal));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
		unsubscribe = convex.onUpdate(
			refs.getRequest,
			{ requestId },
			(snapshot: RequestSnapshot | null) => {
				if (snapshot && TERMINAL.has(snapshot.status)) {
					cleanup();
					resolve(snapshot);
				}
			},
			(error: Error) => {
				cleanup();
				reject(new CoveApiError(`request subscription failed: ${error.message}`, { cause: error }));
			},
		);
	});
}

const ZERO_USAGE: PromptResponse["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
}
