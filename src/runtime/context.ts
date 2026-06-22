// Ported-shape from flue · @flue/runtime · packages/runtime/src/context.ts + session.ts → @cove/runtime
// The CoveContext → CoveHarness → CoveSession facade (the preserved authoring API, doc 05). It is
// transport-agnostic: session.prompt() submits through an injected CoveTransport and returns a CallHandle
// that resolves on terminal request status. The native Convex-client transport (createCoveClient) lands in
// P9; this module is pure so it unit-tests against a fake transport.
//
// COVE NOTE (result-schema, completes §4.10): the caller's valibot result schema can't cross the workflow
// journal, so the facade converts it to JSON Schema for the server (which captures the structurally-valid
// value) and RE-VALIDATES the captured value here with valibot before resolving PromptResultResponse<T> —
// a give-up / exhausted / re-validation failure rejects with ResultUnavailableError, never unvalidated data.
//
// Pure / V8-safe: valibot + @valibot/to-json-schema + the runtime primitives; no Convex, no AI SDK.

import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { abortErrorFor, createCallHandle } from "./abort.ts";
import { resolveAgentProfile } from "./agent-definition.ts";
import {
	CoveError,
	ModelNotConfiguredError,
	OperationFailedError,
	ResultUnavailableError,
	SessionAlreadyExistsError,
	SessionNotFoundError,
} from "./errors.ts";
import { assertPublicSessionName } from "./session-identity.ts";
import { stripJsonSchemaMeta } from "./tool-schema.ts";
import type {
	AgentHarnessOptions,
	CallHandle,
	CoveContext,
	CoveFs,
	CoveHarness,
	CoveLogger,
	CoveSession,
	CoveSessions,
	CreatedAgent,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	ShellOptions,
	ShellResult,
	SkillOptions,
	SkillReference,
	TaskOptions,
} from "./types.ts";

const ZERO_USAGE: PromptUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface SessionRef {
	instanceId: string;
	harnessName: string;
	sessionName: string;
}

/** A submitted request's terminal snapshot (the transport resolves this once status is terminal). */
export interface RequestSnapshot {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	finalText?: string;
	result?: unknown;
	error?: string;
	cancelReason?: string;
	usage?: PromptUsage;
}

export interface PromptSubmission extends SessionRef {
	prompt: string;
	model?: string;
	/** JSON Schema for a result-shaped run (server captures the structurally-valid value). */
	resultSchema?: unknown;
}

/**
 * The seam the facade drives. The native implementation (P9) wraps a ConvexReactClient/ConvexHttpClient:
 * submitPrompt → api.invoke.submitPrompt; awaitTerminal → subscribe/poll api.requests.get to terminal.
 */
/** A skill activation submission (G2.5): the catalog skill name + optional args/model, addressed to a session. */
export interface SkillSubmission extends SessionRef {
	skill: string;
	args?: Record<string, unknown>;
	model?: string;
}

export interface CoveTransport {
	submitPrompt(submission: PromptSubmission, signal: AbortSignal): Promise<{ requestId: string }>;
	awaitTerminal(requestId: string, signal: AbortSignal): Promise<RequestSnapshot>;
	stopActive(ref: SessionRef): Promise<void>;
	sessionExists(ref: SessionRef): Promise<boolean>;
	deleteSession(ref: SessionRef): Promise<void>;
	/** Activate a catalog skill as a prompt (G2.5). Resolves a kind:"skill" run; unknown skill → typed error. */
	submitSkill(submission: SkillSubmission, signal: AbortSignal): Promise<{ requestId: string }>;
	/** Compact the session's history (G2.5). Resolves a kind:"compact" run that appends a CompactionEntry. */
	submitCompact(ref: SessionRef, signal: AbortSignal): Promise<{ requestId: string }>;
}

export interface CoveContextInit<TPayload, TEnv> {
	id: string;
	payload?: TPayload;
	env?: TEnv;
	req?: Request;
	log?: CoveLogger;
}

const NOOP_LOGGER: CoveLogger = { info() {}, warn() {}, error() {} };

/** Construct a CoveContext over a transport (the createFlueContext analog, doc 05 / 08 §1). */
export function createCoveContext<TPayload = unknown, TEnv = Record<string, any>>(
	transport: CoveTransport,
	init: CoveContextInit<TPayload, TEnv>,
): CoveContext<TPayload, TEnv> {
	return {
		id: init.id,
		payload: (init.payload as TPayload) ?? (undefined as TPayload),
		env: (init.env as TEnv) ?? ({} as TEnv),
		req: init.req,
		log: init.log ?? NOOP_LOGGER,
		async init(agent: CreatedAgent<TPayload, TEnv>, options?: AgentHarnessOptions): Promise<CoveHarness> {
			const config = await agent.initialize({ id: init.id, env: this.env, payload: this.payload });
			const profile = resolveAgentProfile(config);
			const defaultModel = typeof profile.model === "string" ? profile.model : undefined;
			return makeHarness(transport, init.id, options?.name ?? "default", defaultModel);
		},
	};
}

function makeHarness(
	transport: CoveTransport,
	instanceId: string,
	harnessName: string,
	defaultModel: string | undefined,
): CoveHarness {
	const sessions: CoveSessions = {
		async get(name = "default"): Promise<CoveSession> {
			assertPublicSessionName(name);
			const ref = { instanceId, harnessName, sessionName: name };
			if (!(await transport.sessionExists(ref))) throw new SessionNotFoundError(name);
			return makeSession(transport, ref, defaultModel);
		},
		async create(name = "default"): Promise<CoveSession> {
			assertPublicSessionName(name);
			const ref = { instanceId, harnessName, sessionName: name };
			if (await transport.sessionExists(ref)) throw new SessionAlreadyExistsError(name);
			return makeSession(transport, ref, defaultModel);
		},
		async delete(name = "default"): Promise<void> {
			await transport.deleteSession({ instanceId, harnessName, sessionName: name });
		},
	};

	return {
		name: harnessName,
		async session(name = "default"): Promise<CoveSession> {
			assertPublicSessionName(name);
			return makeSession(transport, { instanceId, harnessName, sessionName: name }, defaultModel);
		},
		sessions,
		shell(_command: string, options?: ShellOptions): CallHandle<ShellResult> {
			return deferredCall(options?.signal, "harness.shell() lands with the sandbox facade (P6)");
		},
		fs: deferredFs(),
	};
}

function makeSession(
	transport: CoveTransport,
	ref: SessionRef,
	defaultModel: string | undefined,
): CoveSession {
	function runPrompt<S extends v.GenericSchema>(
		text: string,
		options?: (PromptOptions<S> & { result?: S }) | undefined,
	): CallHandle<PromptResponse | PromptResultResponse<v.InferOutput<S>>> {
		const model = options?.model ?? defaultModel;
		const resultSchema = options?.result;
		return createCallHandle(options?.signal, async (signal) => {
			if (!model) throw new ModelNotConfiguredError();
			const submission: PromptSubmission = {
				...ref,
				prompt: text,
				model,
				resultSchema: resultSchema
					? stripJsonSchemaMeta(toJsonSchema(resultSchema, { errorMode: "ignore" }) as Record<string, unknown>)
					: undefined,
			};
			const { requestId } = await transport.submitPrompt(submission, signal);
			let snap: RequestSnapshot;
			try {
				snap = await transport.awaitTerminal(requestId, signal);
			} catch (err) {
				if (signal.aborted) await transport.stopActive(ref).catch(() => {});
				throw err;
			}
			return mapSnapshot(snap, model, resultSchema, signal);
		});
	}

	return {
		name: ref.sessionName,
		// Overload-compatible: result option narrows the resolved type at the call site.
		prompt: runPrompt as CoveSession["prompt"],
		skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse> {
			const name = typeof skill === "string" ? skill : skill.name;
			const model = options?.model ?? defaultModel;
			return createCallHandle(options?.signal, async (signal) => {
				const { requestId } = await transport.submitSkill(
					{ ...ref, skill: name, args: options?.args, model },
					signal,
				);
				let snap: RequestSnapshot;
				try {
					snap = await transport.awaitTerminal(requestId, signal);
				} catch (err) {
					if (signal.aborted) await transport.stopActive(ref).catch(() => {});
					throw err;
				}
				return mapSnapshot(snap, model ?? "", undefined, signal) as PromptResponse;
			});
		},
		task(_text: string, options?: TaskOptions): CallHandle<PromptResponse> {
			return deferredCall(options?.signal, "session.task() lands with subagent delegation (P6)");
		},
		shell(_command: string, options?: ShellOptions): CallHandle<ShellResult> {
			return deferredCall(options?.signal, "session.shell() lands with the sandbox facade (P6)");
		},
		fs: deferredFs(),
		async compact(): Promise<void> {
			const signal = new AbortController().signal;
			const { requestId } = await transport.submitCompact(ref, signal);
			await transport.awaitTerminal(requestId, signal);
		},
		async delete(): Promise<void> {
			await transport.deleteSession(ref);
		},
	} as CoveSession;
}

/** Map a terminal snapshot to the public response, applying valibot result re-validation (doc 08 §4.10). */
function mapSnapshot<S extends v.GenericSchema>(
	snap: RequestSnapshot,
	model: string,
	resultSchema: S | undefined,
	signal: AbortSignal,
): PromptResponse | PromptResultResponse<v.InferOutput<S>> {
	const usage = snap.usage ?? ZERO_USAGE;
	const promptModel = parseModel(model);

	if (snap.status === "completed") {
		if (resultSchema) {
			const parsed = v.safeParse(resultSchema, snap.result);
			if (!parsed.success) {
				throw new ResultUnavailableError({
					reason: `result failed schema re-validation: ${parsed.issues.map((i) => i.message).join("; ")}`,
				});
			}
			return { data: parsed.output, usage, model: promptModel };
		}
		return { text: snap.finalText ?? "", usage, model: promptModel };
	}

	if (snap.status === "cancelled") {
		if (signal.aborted) throw abortErrorFor(signal);
		throw new OperationFailedError(`[cove] run cancelled (${snap.cancelReason ?? "unknown"}).`);
	}

	// failed
	if (snap.error === "result_followups_exhausted" || snap.cancelReason === "result_followups_exhausted") {
		throw new ResultUnavailableError({ reason: "result_followups_exhausted" });
	}
	if (resultSchema) {
		throw new ResultUnavailableError({ reason: snap.error ?? "gave_up", assistantText: snap.finalText });
	}
	throw new OperationFailedError(`[cove] run failed: ${snap.error ?? "unknown error"}`);
}

function parseModel(model: string): PromptModel {
	const slash = model.indexOf("/");
	return slash === -1 ? { provider: "", id: model } : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** A CallHandle that rejects with a clear deferred-feature error (for not-yet-wired surfaces). */
function deferredCall<T>(signal: AbortSignal | undefined, message: string): CallHandle<T> {
	return createCallHandle<T>(signal, async () => {
		throw new CoveError(`[cove] ${message}.`, "not_implemented");
	});
}

function deferredFs(): CoveFs {
	const fail = async (): Promise<never> => {
		throw new CoveError("[cove] fs access lands with the sandbox facade (P6).", "not_implemented");
	};
	return {
		readFile: fail,
		readFileBuffer: fail,
		writeFile: fail,
		stat: fail,
		readdir: fail,
		exists: fail,
		mkdir: fail,
		rm: fail,
	};
}
