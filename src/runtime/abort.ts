// Ported from flue · @flue/runtime · packages/runtime/src/abort.ts → @cove/runtime
// Cancellation primitives shared by prompt/skill/task/shell calls. This is the canonical home;
// convex/sandbox/abort.ts re-exports composeTimeoutSignal/abortErrorFor from here. `createCallHandle`
// is the await primitive the CoveSession facade returns — a `Promise<T>` that also carries `.signal` +
// `.abort()` (doc 05). It stays an internal helper (not on the @cove/runtime barrel), at parity with flue.
//
// Pure / V8-safe: only AbortController / AbortSignal / DOMException.

import type { CallHandle } from "./types.ts";

/** Build a standard `AbortError` (`DOMException`) carrying the signal's reason as `cause`. */
export function abortErrorFor(signal: AbortSignal): Error {
	const reason = signal.reason;
	const message =
		reason instanceof Error && reason.message
			? reason.message
			: typeof reason === "string" && reason
				? reason
				: "The operation was aborted.";
	const error = new DOMException(message, "AbortError");
	// `cause` is read-only on DOMException in some runtimes.
	try {
		Object.defineProperty(error, "cause", { value: reason, configurable: true });
	} catch {
		/* leave cause unset */
	}
	return error;
}

/**
 * Translate a millisecond deadline into an `AbortSignal` and compose it with the caller's signal. Single
 * implementation shared by the LLM bash tool and the signal-translating SessionEnv adapters. Returns both
 * signals: callers that distinguish a recoverable timeout from a host abort need `timeoutSignal` alone;
 * everything downstream gets `mergedSignal`.
 */
export function composeTimeoutSignal(
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): { timeoutSignal: AbortSignal | undefined; mergedSignal: AbortSignal | undefined } {
	const timeoutSignal = typeof timeoutMs === "number" ? AbortSignal.timeout(timeoutMs) : undefined;
	const mergedSignal =
		signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);
	return { timeoutSignal, mergedSignal };
}

/**
 * Wrap an async `run` in a {@link CallHandle}. The handle's internal signal fires when `externalSignal`
 * aborts or when `handle.abort()` is called. The returned object implements the full Promise interface by
 * delegating to the internal promise, so callers can `await` it or chain without subclassing Promise.
 */
export function createCallHandle<T>(
	externalSignal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): CallHandle<T> {
	const controller = new AbortController();

	let externalListener: (() => void) | undefined;
	if (externalSignal) {
		if (externalSignal.aborted) {
			controller.abort(externalSignal.reason);
		} else {
			externalListener = () => controller.abort(externalSignal.reason);
			externalSignal.addEventListener("abort", externalListener, { once: true });
		}
	}

	const promise = run(controller.signal).finally(() => {
		if (externalListener && externalSignal) {
			externalSignal.removeEventListener("abort", externalListener);
		}
	});
	// Callers may never await the handle (fire-and-forget, or abort-and-drop) — keep a rejection from
	// surfacing as an unhandled-rejection crash. `then()` below still returns the rejecting promise.
	promise.catch(() => {});

	return {
		signal: controller.signal,
		abort(reason?: unknown) {
			controller.abort(reason);
		},
		// biome-ignore lint/suspicious/noThenProperty: intentional thenable
		then(onFulfilled, onRejected) {
			return promise.then(onFulfilled, onRejected);
		},
		catch(onRejected) {
			return promise.catch(onRejected);
		},
		finally(onFinally) {
			return promise.finally(onFinally);
		},
		[Symbol.toStringTag]: "Promise",
	};
}
