// Ported from flue · @flue/runtime · packages/runtime/src/submission-state.ts → @cove/runtime
//   (isRetryableModelError regex + isCompletedAssistantResponse). The reconciliation classifier
//   (classifySubmissionState / findTrailingPartialToolBatch / countConsecutiveRetryableModelErrors) is
//   NOT ported: flue's lease / attempt-marker / turn-journal reconciliation is dropped (D5) and subsumed
//   by @convex-dev/workflow replay (doc 08 §5). Only the transient-error predicate survives — it threads
//   into llmStep's error handling so a transient model error retries the step without failing the request.
//
// Pure / V8-safe: type-only import of the canonical message; no AI SDK, no Convex.

import type { AssistantMessage } from "../../src/runtime/messages.ts";

/**
 * Transient/retryable provider-failure signature. Verbatim from flue's
 * `isRetryableModelError`: overloaded / rate-limit / 5xx / network / timeout
 * families. A non-matching message (e.g. an auth or bad-request error) is a hard
 * failure and must NOT be retried.
 */
const RETRYABLE_ERROR_PATTERN =
	/overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|network.?error|connection.?(?:reset|refused|lost)|socket hang up|fetch failed|timed? out|timeout|terminated/i;

/** Whether an error MESSAGE looks like a transient/retryable provider failure. */
export function isRetryableErrorMessage(message: string | undefined): boolean {
	if (!message) return false;
	return RETRYABLE_ERROR_PATTERN.test(message);
}

/**
 * Whether a canonical assistant message is a transient/retryable model error
 * (flue parity: requires `stopReason === "error"` and a matching `errorMessage`).
 */
export function isRetryableModelError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return RETRYABLE_ERROR_PATTERN.test(message.errorMessage);
}

/** Whether a value thrown by `streamText`/`generateText` is transient/retryable. */
export function isRetryableThrown(error: unknown): boolean {
	return isRetryableErrorMessage(getErrorMessage(error));
}

/** A canonical assistant response that terminalized normally (flue parity). */
export function isCompletedAssistantResponse(message: AssistantMessage): boolean {
	return message.stopReason === "stop" || message.stopReason === "length";
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
