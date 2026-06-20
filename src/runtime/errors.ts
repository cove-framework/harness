// Recreated from flue · @flue/runtime · packages/runtime/src/errors.ts (parity, decoupled from pi).
/**
 * flue error hierarchy (parity with `@flue/runtime` errors). All public errors
 * extend {@link CoveError}, so callers can branch on `instanceof CoveError` and
 * on the stable `.code`. Recreated here decoupled from pi; semantics match flue.
 */

export interface ToolValidationIssue {
	message: string;
	path?: PropertyKey[];
}

export class CoveError extends Error {
	readonly code: string;
	constructor(message: string, code = "cove_error", options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

export class SessionNotFoundError extends CoveError {
	constructor(name: string) {
		super(`[cove] session "${name}" does not exist.`, "session_not_found");
	}
}

export class SessionAlreadyExistsError extends CoveError {
	constructor(name: string) {
		super(`[cove] session "${name}" already exists.`, "session_already_exists");
	}
}

export class SessionBusyError extends CoveError {
	constructor(name: string) {
		super(`[cove] session "${name}" has an operation in flight.`, "session_busy");
	}
}

export class SessionDeletedError extends CoveError {
	constructor(name: string) {
		super(`[cove] session "${name}" has been deleted.`, "session_deleted");
	}
}

export class ModelNotConfiguredError extends CoveError {
	constructor(message = "[cove] no model configured for this operation.") {
		super(message, "model_not_configured");
	}
}

export class SkillNotRegisteredError extends CoveError {
	constructor(skill: string) {
		super(`[cove] skill "${skill}" is not registered.`, "skill_not_registered");
	}
}

export class SubagentNotDeclaredError extends CoveError {
	constructor(name: string) {
		super(`[cove] subagent "${name}" is not declared.`, "subagent_not_declared");
	}
}

export class ToolNameConflictError extends CoveError {
	constructor(name: string) {
		super(`[cove] tool name "${name}" conflicts with another active tool.`, "tool_name_conflict");
	}
}

export class ToolInputValidationError extends CoveError {
	readonly tool: string;
	readonly issues: ToolValidationIssue[];
	constructor(args: { tool: string; issues: ToolValidationIssue[] }) {
		const detail = args.issues.map((i) => i.message).join("; ");
		super(`[cove] tool "${args.tool}" received invalid arguments: ${detail}`, "tool_input_invalid");
		this.tool = args.tool;
		this.issues = args.issues;
	}
}

export class ProviderRegistrationError extends CoveError {
	constructor(message: string) {
		super(message, "provider_registration");
	}
}

export class SandboxOperationUnsupportedError extends CoveError {
	constructor(operation: string) {
		super(`[cove] sandbox operation "${operation}" is not supported.`, "sandbox_unsupported");
	}
}

export class OperationFailedError extends CoveError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, "operation_failed", options);
	}
}

export class AttachmentNotAvailableError extends CoveError {
	readonly attachmentId: string;
	constructor(args: { attachmentId: string }) {
		super(`[cove] attachment "${args.attachmentId}" is not available.`, "attachment_not_available");
		this.attachmentId = args.attachmentId;
	}
}

export class TaskDepthExceededError extends CoveError {
	constructor(max: number) {
		super(`[cove] task delegation depth exceeded the limit of ${max}.`, "task_depth_exceeded");
	}
}

export class SubmissionInterruptedError extends CoveError {
	constructor(submissionId: string) {
		super(`[cove] submission "${submissionId}" was interrupted.`, "submission_interrupted");
	}
}

export class SubmissionRetryExhaustedError extends CoveError {
	constructor(submissionId: string) {
		super(`[cove] submission "${submissionId}" exhausted its retry budget.`, "submission_retry_exhausted");
	}
}

export class SubmissionTimeoutError extends CoveError {
	constructor(submissionId: string) {
		super(`[cove] submission "${submissionId}" exceeded its timeout.`, "submission_timeout");
	}
}
