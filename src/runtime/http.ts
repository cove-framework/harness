// Ported-shape from flue · @flue/runtime · packages/runtime/src/app/* (the HTTP error hierarchy + render) → @cove/runtime
// The HTTP submit/poll surface's error + validation layer (doc 06 P8, doc 08 M4): CoveHttpError 4xx
// subclasses, request validation, and renderHttpError → the CoveApiError wire envelope. Dropped per 08 §5:
// StreamNotFoundError (no SSE) and PersistedSchemaVersionError (migrate() is a no-op). WorkflowNotFoundError
// is KEPT (workflows are first-class, D18). Pure / V8-safe: no Convex; the httpRouter (convex/http.ts) uses it.

import { CoveError } from "./errors.ts";

/** Base for 4xx HTTP errors rendered onto the CoveApiError wire envelope. */
export class CoveHttpError extends CoveError {
	readonly httpStatus: number;
	constructor(message: string, code: string, httpStatus: number) {
		super(message, code);
		this.httpStatus = httpStatus;
	}
}

export class MethodNotAllowedError extends CoveHttpError {
	constructor(method: string) {
		super(`[cove] method ${method} not allowed.`, "method_not_allowed", 405);
	}
}
export class UnsupportedMediaTypeError extends CoveHttpError {
	constructor() {
		super("[cove] unsupported media type; expected application/json.", "unsupported_media_type", 415);
	}
}
export class InvalidJsonError extends CoveHttpError {
	constructor() {
		super("[cove] request body is not valid JSON.", "invalid_json", 400);
	}
}
export class InvalidRequestError extends CoveHttpError {
	constructor(detail: string) {
		super(`[cove] invalid request: ${detail}.`, "invalid_request", 400);
	}
}
export class UnauthorizedError extends CoveHttpError {
	constructor(message = "[cove] unauthorized.") {
		super(message, "unauthorized", 401);
	}
}
export class AgentNotFoundError extends CoveHttpError {
	constructor(name: string) {
		super(`[cove] agent "${name}" not found.`, "agent_not_found", 404);
	}
}
export class WorkflowNotFoundError extends CoveHttpError {
	constructor(name: string) {
		super(`[cove] workflow "${name}" not found.`, "workflow_not_found", 404);
	}
}
export class RunNotFoundError extends CoveHttpError {
	constructor(runId: string) {
		super(`[cove] run "${runId}" not found.`, "run_not_found", 404);
	}
}

/** The on-the-wire error envelope (CoveApiError replaces flue's FlueApiError). */
export interface CoveApiError {
	error: { code: string; message: string; status: number };
}

let devMode = false;
/** Toggle whether non-CoveHttpError (500) details leak to the client. Default false (redacted). */
export function configureErrorRendering(opts: { devMode: boolean }): void {
	devMode = opts.devMode;
}

/** Map any thrown value onto an HTTP status + the CoveApiError envelope. */
export function renderHttpError(err: unknown): { status: number; body: CoveApiError } {
	if (err instanceof CoveHttpError) {
		return { status: err.httpStatus, body: { error: { code: err.code, message: err.message, status: err.httpStatus } } };
	}
	const message = devMode && err instanceof Error ? err.message : "[cove] internal server error.";
	return { status: 500, body: { error: { code: "internal_error", message, status: 500 } } };
}

export interface ValidatedAgentRequest {
	message: string;
	model?: string;
	sessionName?: string;
	resultSchema?: unknown;
}

/** Validate + normalize a POST /agents body. Throws InvalidRequestError on a malformed body. */
export function validateAgentRequest(raw: unknown): ValidatedAgentRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new InvalidRequestError("body must be a JSON object");
	}
	const b = raw as Record<string, unknown>;
	const message = b.message ?? b.prompt;
	if (typeof message !== "string" || message.length === 0) {
		throw new InvalidRequestError("`message` (non-empty string) is required");
	}
	const model = typeof b.model === "string" ? b.model : undefined;
	const sessionName = typeof b.sessionName === "string" ? b.sessionName : undefined;
	const resultSchema = b.result ?? b.resultSchema;
	return { message, model, sessionName, resultSchema };
}
