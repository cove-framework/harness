// Ported from flue · @flue/runtime · packages/runtime/src/shell.ts → @cove/runtime
// Shared shell-exec envelope for harness.shell() and session.shell() — the same operation with and without
// transcript recording. One place owns the event contract (doc 08 §4.11): a `tool_start` emit, then a
// terminal `tool` emit (toolName:'bash', shared toolCallId, durationMs). ShellOptions.env values are
// recorded keys-only (`<redacted>`) in events + the transcript, while env.exec receives the real values; a
// failure records `details:{command, exitCode:-1}`. The optional `record` hook lets session.shell() append
// its redacted transcript triple at the same point on both branches.
//
// Pure / V8-safe: takes a SessionEnv + an emit callback; the box-ness lives in env. No Convex, no AI SDK.
// (Full facade.shell → server action → events wiring lands with the reactive events substrate, P9.)

import { formatShellOutput, type ShellToolResult } from "./bash-output.ts";
import type { CoveEventInput, SessionEnv, ShellOptions, ShellResult } from "./types.ts";

export async function execShellWithEvents(
	env: SessionEnv,
	emit: (event: CoveEventInput) => void,
	command: string,
	options: ShellOptions | undefined,
	signal: AbortSignal | undefined,
	record?: (
		toolCallId: string,
		args: Record<string, unknown>,
		result: ShellToolResult,
		isError: boolean,
	) => Promise<void>,
): Promise<ShellResult> {
	const toolCallId = crypto.randomUUID();
	const startedAt = Date.now();

	// Per-call cwd/env names are part of the call's identity and must be visible in the transcript. Env
	// values often carry credentials, so events/transcript record only the keys while env.exec gets the
	// real values (doc 08 §4.11 — a secret passed via env never lands in an event or a row).
	const args: Record<string, unknown> = { command };
	if (options?.cwd !== undefined) args.cwd = options.cwd;
	if (options?.env !== undefined) args.env = redactEnvValues(options.env);

	emit({ type: "tool_start", toolName: "bash", toolCallId, args });

	try {
		const result = await env.exec(command, {
			env: options?.env,
			cwd: options?.cwd,
			timeoutMs: options?.timeoutMs,
			signal,
		});
		const shellResult: ShellResult = {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
		const toolResult = formatShellOutput(shellResult, command);
		await record?.(toolCallId, args, toolResult, false);
		emit({
			type: "tool",
			toolName: "bash",
			toolCallId,
			isError: false,
			result: toolResult,
			durationMs: Date.now() - startedAt,
		});
		return shellResult;
	} catch (error) {
		// `exitCode:-1` is the sentinel for "no exit recorded" (same one env.exec uses for sandbox-level
		// failures), so consumers reading result.details.exitCode see a number on both branches.
		const errResult: ShellToolResult = {
			content: [{ type: "text", text: getErrorMessage(error) }],
			details: { command, exitCode: -1 },
		};
		await record?.(toolCallId, args, errResult, true);
		emit({
			type: "tool",
			toolName: "bash",
			toolCallId,
			isError: true,
			result: errResult,
			durationMs: Date.now() - startedAt,
		});
		throw error;
	}
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Replace every env VALUE with `<redacted>`, preserving keys (doc 08 §4.11). */
export function redactEnvValues(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.keys(env).map((key) => [key, "<redacted>"]));
}
