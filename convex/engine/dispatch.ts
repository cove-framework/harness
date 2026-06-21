// Ported-pattern from flue · @flue/runtime · packages/runtime/src/session.ts (the tool-execution batch) → @cove/runtime
// dispatchTools: run a step's tool calls in parallel, idempotently, cancel-aware (doc 04 / 08 §4.2-4.3).
//   - Promise.all over the batch (parallel; ToolExecutionMode sequential is deferred, doc 08 §5).
//   - Per-tool deadline (~30s): a hung tool yields an error tool-result, never a starved action.
//   - Cancel short-circuit: re-read status before each tool AND after execute (discard late results).
//   - A failed tool does NOT fail the request — it returns an error tool-result the model self-corrects on.
//   - appendToolResult is idempotent by toolCallId (replace-in-place), so a replay never double-writes.
//
// Pure decode/dispatch core: persistence + cancel checks are injected (DispatchDeps), so it unit-tests
// without Convex. The thin "use node" dispatchTools action resolves the sandbox, rebuilds the executable
// tools from frozen descriptors, and wires DispatchDeps to ctx.
//
// Pure / V8-safe: no Convex, no AI SDK, no box import.

import type { EngineTool, EngineToolResult, ToolCallRecord, ToolResultRecord } from "./types.ts";

/** Per-tool execution deadline (doc 08 §4.2). The box exec's own timeoutMs is the inner floor. */
export const PER_TOOL_TIMEOUT_MS = 30_000;

export interface DispatchDeps {
	/** Re-read agentRequests.status === "cancelled" (doc 08 §4.3). Checked before and after each tool. */
	isCancelled(): Promise<boolean>;
	/** Persist a tool result, idempotent by toolCallId (replace-in-place). */
	appendToolResult(record: ToolResultRecord): Promise<void>;
	/** Per-tool deadline; defaults to {@link PER_TOOL_TIMEOUT_MS}. */
	perToolTimeoutMs?: number;
	/** Host/cancel signal forwarded into each tool's execute. */
	signal?: AbortSignal;
}

/**
 * Run a decoded step's tool calls. Each call runs concurrently and writes its result idempotently;
 * a cancelled request skips remaining tools and discards any late results.
 */
export async function runDispatch(
	toolCalls: ToolCallRecord[],
	executable: Map<string, EngineTool>,
	deps: DispatchDeps,
): Promise<void> {
	await Promise.all(toolCalls.map((call) => dispatchOne(call, executable, deps)));
}

async function dispatchOne(
	call: ToolCallRecord,
	executable: Map<string, EngineTool>,
	deps: DispatchDeps,
): Promise<void> {
	// Cancel short-circuit BEFORE running (doc 08 §4.3).
	if (await deps.isCancelled()) return;

	const tool = executable.get(call.toolName);
	let result: EngineToolResult;
	if (!tool) {
		result = errorResult(`unknown tool "${call.toolName}".`);
	} else {
		try {
			result = await withTimeout(
				tool.execute(call.args, deps.signal),
				deps.perToolTimeoutMs ?? PER_TOOL_TIMEOUT_MS,
				call.toolName,
			);
		} catch (err) {
			// A failed tool becomes an error tool-result, never a step crash (flue semantics).
			result = errorResult(getErrorMessage(err));
		}
	}

	// Discard a late result if the request was cancelled while this tool ran (doc 08 §4.3).
	if (await deps.isCancelled()) return;

	await deps.appendToolResult({
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		result,
		isError: result.isError || undefined,
	});
}

function errorResult(message: string): EngineToolResult {
	return { content: [{ type: "text", text: `[cove] ${message}` }], isError: true };
}

/** Race a tool's execute against a deadline; the loser is abandoned (the box timeoutMs is the real bound). */
function withTimeout<T>(p: Promise<T>, ms: number, toolName: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`tool "${toolName}" timed out after ${ms}ms.`)),
			ms,
		);
	});
	return Promise.race([p, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	}) as Promise<T>;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
