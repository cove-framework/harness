// Ported from flue · @flue/runtime · packages/runtime/src/agent.ts (formatBashResult + truncateTail) → @cove/runtime
// Shared bash/shell output formatting + tail-truncation, used by BOTH the built-in bash tool
// (convex/engine/frameworkTools.ts) and the shell tool-event envelope (src/runtime/shell.ts), so the
// output shape (combined stdout/stderr, truncation, exit line) has one implementation. Pure / V8-safe.

export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** A bash/shell tool result: a single text block + the {command, exitCode} details consumers read. */
export interface ShellToolResult {
	content: { type: "text"; text: string }[];
	details: { command: string; exitCode: number };
}

/** Format a ShellResult into the bash tool-result shape (combined output, truncated, with an exit line). */
export function formatShellOutput(
	result: { stdout: string; stderr: string; exitCode: number },
	command: string,
): ShellToolResult {
	const combined = (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim();
	const { text: output } = truncateTail(combined, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
	const exitLine = `Command exited with code ${result.exitCode}`;
	const body =
		result.exitCode === 0 ? output || "(no output)" : `${output || "(no output)"}\n\n${exitLine}`;
	return { content: [{ type: "text", text: body }], details: { command, exitCode: result.exitCode } };
}

/** Keep the last `maxLines`/`maxBytes` of text (bash output: the tail is the most relevant). */
export function truncateTail(
	text: string,
	maxLines: number,
	maxBytes: number,
): { text: string; wasTruncated: boolean } {
	const lines = text.split("\n");
	if (lines.length <= maxLines && text.length <= maxBytes) {
		return { text, wasTruncated: false };
	}
	let result = lines.slice(-maxLines).join("\n");
	if (result.length > maxBytes) result = result.slice(-maxBytes);
	return { text: result, wasTruncated: true };
}
