// Ported from flue · @flue/opentelemetry · packages/opentelemetry/src/index.ts → @cove/observability
// (depends on @opentelemetry/api). A PURE read-side fold over the cove `events` table: it turns a
// stream of decorated `CoveEvent`s into OpenTelemetry run/operation/turn/tool/compaction/task spans.
//
// Transforms vs flue (doc 08 §5):
//   - FlueEvent → CoveEvent (../../src/runtime/types.ts).
//   - Dropped flue's `FlueContext` second arg + `resolveRootContext(event, ctx)`: cove's observer is a
//     plain `(event: CoveEvent) => void` with NO live context object. The run root is resolved off the
//     event's correlation ids (runId/instanceId) just like flue, but there is no host-supplied root ctx.
//   - Every flue-namespaced attribute + identifier is renamed to the cove namespace; GenAI semconv
//     (`gen_ai.*`) names are kept verbatim (cross-vendor standard, not flue-owned).
//   - flue's `run_start`/`run_resume` carried a `workflowName`; cove keeps it (CoveEvent run variants).
//
// Query-side / pure: NO "use node", no Convex imports, no sandbox/box. The read-side query that drives
// this fold lives in ./read.ts.

import {
	type Attributes,
	type Context,
	context,
	type Span,
	SpanKind,
	type SpanOptions,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { CoveEvent } from "../../src/runtime/types.ts";

export interface CoveOpenTelemetryObserverOptions {
	/** Tracer to record into. Defaults to `trace.getTracer("cove")`. Tests inject an in-memory recorder. */
	tracer?: Tracer;
	/**
	 * Redaction hook. Receives a shallow copy of the event; return a (possibly redacted) event or
	 * `undefined` to suppress ALL content attributes for that event. When a returned event strips a
	 * field (e.g. `result`/`input`), the corresponding `cove.*` content attribute is not attached.
	 */
	exportContent?: (event: CoveEvent) => CoveEvent | undefined;
}

/**
 * Build a pure `(event: CoveEvent) => void` fold that maps cove events onto OpenTelemetry spans.
 *
 * Span shape:
 *   - `run_start`/`run_resume` → a run root span (`cove.run <workflowName>`).
 *   - `operation_start`/`operation` → an operation span under the run.
 *   - `turn_request`/`turn` → a `chat <model>` CLIENT span with GenAI semconv usage attributes.
 *   - `tool_start`/`tool` → a tool span (status ERROR when `event.isError`).
 *   - `compaction_start`/`compaction` → a compaction span.
 *   - `task_start`/`task` → a task span.
 *   - `text_delta`/`thinking_*`/`log` → span events on the current span.
 *   - `run_end` → ends the run + any dangling descendants.
 *   - `idle`/`submission_settled` and the `*_start`-less lifecycle markers are ignored.
 */
export function createCoveOpenTelemetryObserver(
	options: CoveOpenTelemetryObserverOptions = {},
): (event: CoveEvent) => void {
	const tracer = options.tracer ?? trace.getTracer("cove");
	const exportContent = options.exportContent;

	// Per-kind open-span registries, keyed by the event's correlation ids (flue parity).
	const runs = new Map<string, Span>();
	const operations = new Map<string, Span>();
	const turns = new Map<string, Span>();
	const tools = new Map<string, Span>();
	const tasks = new Map<string, Span>();
	const compactions = new Map<string, Span>();
	// Span → owning run/operation, for interruption cleanup (flue's spanRunIds/spanOperationIds).
	const spanRunIds = new WeakMap<Span, string>();
	const spanOperationIds = new WeakMap<Span, string>();

	return (event: CoveEvent) => {
		const time = timestamp(event);

		if (event.type === "run_start") {
			const exported = exportEvent(exportContent, event);
			if (!event.runId) return;
			runs.set(
				event.runId,
				startSpan(tracer, `cove.run ${event.workflowName}`, undefined, event, {
					kind: SpanKind.INTERNAL,
					startTime: new Date(event.startedAt),
					attributes: {
						...identifiers(event),
						"cove.run.name": event.workflowName,
						...contentAttribute("cove.run.payload", exported?.payload),
					},
				}),
			);
			return;
		}

		if (event.type === "run_resume") {
			if (!event.runId) return;
			endRunDescendants(
				event.runId,
				time,
				"Run was interrupted before this span received its terminal event.",
				spanRunIds,
				operations,
				turns,
				tools,
				tasks,
				compactions,
			);
			const interrupted = runs.get(event.runId);
			if (interrupted) {
				interrupted.setStatus({
					code: SpanStatusCode.ERROR,
					message: "Run was interrupted before recovery continued run handling.",
				});
				interrupted.end(time);
			}
			runs.set(
				event.runId,
				startSpan(tracer, `cove.run ${event.workflowName}`, undefined, event, {
					kind: SpanKind.INTERNAL,
					startTime: time,
					...(interrupted ? { links: [{ context: interrupted.spanContext() }] } : {}),
					attributes: {
						...identifiers(event),
						"cove.run.name": event.workflowName,
						"cove.run.recovery_handling": true,
						"cove.run.started_at": event.startedAt,
					},
				}),
			);
			return;
		}

		if (event.type === "operation_start") {
			const parent = workflowSpan(event, runs);
			operations.set(
				event.operationId,
				trackSpan(
					startSpan(tracer, `cove.operation ${event.operationKind}`, parent, event, {
						startTime: time,
						attributes: { ...identifiers(event), "cove.operation.kind": event.operationKind },
					}),
					event,
					spanRunIds,
					spanOperationIds,
				),
			);
			return;
		}

		if (event.type === "task_start") {
			const exported = exportEvent(exportContent, event);
			const parent =
				(event.turnId ? turns.get(event.turnId) : undefined) ??
				operationSpan(event, operations) ??
				workflowSpan(event, runs);
			tasks.set(
				event.taskId,
				trackSpan(
					startSpan(tracer, event.agent ? `cove.task ${event.agent}` : "cove.task", parent, event, {
						startTime: time,
						attributes: {
							...identifiers(event),
							...(event.agent ? { "cove.task.agent": event.agent } : {}),
							...(event.cwd ? { "cove.task.cwd": event.cwd } : {}),
							...contentAttribute("cove.task.prompt", exported?.prompt),
						},
					}),
					event,
					spanRunIds,
					spanOperationIds,
				),
			);
			return;
		}

		if (event.type === "compaction_start") {
			const parent = operationSpan(event, operations) ?? workflowSpan(event, runs);
			compactions.set(
				compactionKey(event),
				trackSpan(
					startSpan(tracer, "cove.compaction", parent, event, {
						startTime: time,
						attributes: {
							...identifiers(event),
							"cove.compaction.reason": event.reason,
							"cove.compaction.estimated_tokens": event.estimatedTokens,
						},
					}),
					event,
					spanRunIds,
					spanOperationIds,
				),
			);
			return;
		}

		if (event.type === "turn_request") {
			const exported = exportEvent(exportContent, event);
			const parent =
				event.purpose === "agent"
					? (operationSpan(event, operations) ?? workflowSpan(event, runs))
					: (compactions.get(compactionKey(event)) ??
						operationSpan(event, operations) ??
						workflowSpan(event, runs));
			turns.set(
				event.turnId,
				trackSpan(
					startSpan(tracer, `chat ${event.model}`, parent, event, {
						kind: SpanKind.CLIENT,
						startTime: time,
						attributes: {
							...identifiers(event),
							"cove.turn.purpose": event.purpose,
							"gen_ai.operation.name": "chat",
							"gen_ai.provider.name": event.provider,
							"gen_ai.request.model": event.model,
							"cove.turn.provider_api": event.api,
							...(event.reasoning ? { "cove.turn.reasoning": event.reasoning } : {}),
							...contentAttribute("cove.turn.input", exported?.input),
						},
					}),
					event,
					spanRunIds,
					spanOperationIds,
				),
			);
			return;
		}

		if (event.type === "tool_start") {
			const exported = exportEvent(exportContent, event);
			const parent =
				(event.turnId ? turns.get(event.turnId) : undefined) ??
				operationSpan(event, operations) ??
				workflowSpan(event, runs);
			tools.set(
				toolKey(event),
				trackSpan(
					startSpan(tracer, `cove.tool ${event.toolName}`, parent, event, {
						startTime: time,
						attributes: {
							...identifiers(event),
							"cove.tool.name": event.toolName,
							"cove.tool.call_id": event.toolCallId,
							...contentAttribute("cove.tool.arguments", exported?.args),
						},
					}),
					event,
					spanRunIds,
					spanOperationIds,
				),
			);
			return;
		}

		if (event.type === "tool") {
			const span = tools.get(toolKey(event));
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.setAttributes({
				"cove.duration_ms": event.durationMs,
				...eventIndexAttribute("end", event),
			});
			setContentAttribute(span, "cove.tool.result", exported?.result);
			complete(span, event.isError, exported?.result, "Tool call failed.", time);
			tools.delete(toolKey(event));
			return;
		}

		if (event.type === "turn") {
			const span = turns.get(event.turnId);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.setAttributes({
				"cove.duration_ms": event.durationMs,
				...eventIndexAttribute("end", event),
				...(event.model ? { "gen_ai.response.model": event.model } : {}),
				...(event.provider ? { "gen_ai.provider.name": event.provider } : {}),
				...(event.api ? { "cove.turn.provider_api": event.api } : {}),
				...(event.stopReason ? { "gen_ai.response.finish_reasons": [event.stopReason] } : {}),
				...usageAttributes(event.usage),
			});
			setContentAttribute(span, "cove.turn.output", exported?.output);
			complete(span, event.isError, exported?.error, "Model turn failed.", time);
			turns.delete(event.turnId);
			return;
		}

		if (event.type === "compaction") {
			const key = compactionKey(event);
			const span = compactions.get(key);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.setAttributes({
				"cove.duration_ms": event.durationMs,
				...eventIndexAttribute("end", event),
				"cove.compaction.messages_before": event.messagesBefore,
				"cove.compaction.messages_after": event.messagesAfter,
				...usageAttributes(event.usage, "cove.compaction.usage"),
			});
			complete(span, event.isError, exported?.error, "Compaction failed.", time);
			compactions.delete(key);
			return;
		}

		if (event.type === "task") {
			const span = tasks.get(event.taskId);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.setAttributes({
				"cove.duration_ms": event.durationMs,
				...eventIndexAttribute("end", event),
			});
			setContentAttribute(span, "cove.task.result", exported?.result);
			complete(span, event.isError, exported?.result, "Task failed.", time);
			tasks.delete(event.taskId);
			return;
		}

		if (event.type === "text_delta") {
			const span = currentSpan(event, turns, operations, runs);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.addEvent(
				"cove.text_delta",
				{ ...contentAttribute("cove.text_delta.text", exported?.text), ...eventIndexAttribute("index", event) },
				time,
			);
			return;
		}

		if (
			event.type === "thinking_start" ||
			event.type === "thinking_delta" ||
			event.type === "thinking_end"
		) {
			const span = currentSpan(event, turns, operations, runs);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			const detail =
				event.type === "thinking_delta"
					? contentAttribute("cove.thinking.delta", exported && "delta" in exported ? exported.delta : undefined)
					: event.type === "thinking_end"
						? contentAttribute("cove.thinking.content", exported && "content" in exported ? exported.content : undefined)
						: {};
			span.addEvent(`cove.${event.type}`, { ...detail, ...eventIndexAttribute("index", event) }, time);
			return;
		}

		if (event.type === "log") {
			const span = currentSpan(event, turns, operations, runs);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.addEvent(
				"cove.log",
				{
					"cove.log.level": event.level,
					...eventIndexAttribute("index", event),
					...contentAttribute("cove.log.message", exported?.message),
					...contentAttribute("cove.log.attributes", exported?.attributes),
				},
				time,
			);
			return;
		}

		if (event.type === "operation") {
			endOperationDescendants(
				event.operationId,
				time,
				"Operation ended before this span received its terminal event.",
				spanOperationIds,
				turns,
				tools,
				tasks,
				compactions,
			);
			const span = operations.get(event.operationId);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.setAttributes({
				"cove.duration_ms": event.durationMs,
				...eventIndexAttribute("end", event),
				...usageAttributes(event.usage, "cove.operation.usage"),
			});
			setContentAttribute(span, "cove.operation.result", exported?.result);
			complete(span, event.isError, exported?.error, "Operation failed.", time);
			operations.delete(event.operationId);
			return;
		}

		if (event.type === "run_end") {
			if (!event.runId) return;
			endRunDescendants(
				event.runId,
				time,
				"Run ended before this span received its terminal event.",
				spanRunIds,
				operations,
				turns,
				tools,
				tasks,
				compactions,
			);
			const span = runs.get(event.runId);
			if (!span) return;
			const exported = exportEvent(exportContent, event);
			span.setAttributes({
				"cove.run.duration_ms": event.durationMs,
				...eventIndexAttribute("end", event),
			});
			setContentAttribute(span, "cove.run.result", exported?.result);
			complete(span, event.isError, exported?.error, "Run failed.", time);
			runs.delete(event.runId);
			return;
		}

		// agent_start/agent_end/turn_start/turn_messages/message_start/message_end/idle/submission_settled:
		// no span mapping (lifecycle markers without a distinct span lifetime).
	};
}

function trackSpan(
	span: Span,
	event: CoveEvent,
	spanRunIds: WeakMap<Span, string>,
	spanOperationIds: WeakMap<Span, string>,
): Span {
	if (event.runId) spanRunIds.set(span, event.runId);
	if (event.operationId) spanOperationIds.set(span, event.operationId);
	return span;
}

function endRunDescendants(
	runId: string,
	time: Date,
	message: string,
	spanRunIds: WeakMap<Span, string>,
	operations: Map<string, Span>,
	turns: Map<string, Span>,
	tools: Map<string, Span>,
	tasks: Map<string, Span>,
	compactions: Map<string, Span>,
): void {
	for (const spans of [tools, turns, compactions, tasks, operations]) {
		for (const [key, span] of spans) {
			if (spanRunIds.get(span) !== runId) continue;
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			span.end(time);
			spans.delete(key);
		}
	}
}

function endOperationDescendants(
	operationId: string,
	time: Date,
	message: string,
	spanOperationIds: WeakMap<Span, string>,
	turns: Map<string, Span>,
	tools: Map<string, Span>,
	tasks: Map<string, Span>,
	compactions: Map<string, Span>,
): void {
	for (const spans of [tools, turns, compactions, tasks]) {
		for (const [key, span] of spans) {
			if (spanOperationIds.get(span) !== operationId) continue;
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			span.end(time);
			spans.delete(key);
		}
	}
}

function startSpan(
	tracer: Tracer,
	name: string,
	parent: Span | undefined,
	event: CoveEvent,
	options: SpanOptions,
): Span {
	// flue resolved a host-supplied root context here; cove has none, so a parentless span is a root.
	const parentContext: Context | undefined = parent
		? trace.setSpan(context.active(), parent)
		: undefined;
	return tracer.startSpan(
		name,
		{
			...options,
			root: parentContext === undefined,
			attributes: { ...options.attributes, ...eventIndexAttribute("start", event) },
		},
		parentContext,
	);
}

function workflowSpan(event: CoveEvent, runs: Map<string, Span>): Span | undefined {
	return event.runId ? runs.get(event.runId) : undefined;
}

function operationSpan(event: CoveEvent, operations: Map<string, Span>): Span | undefined {
	return event.operationId ? operations.get(event.operationId) : undefined;
}

/** Best-effort "span this loose event belongs to": turn → operation → run. */
function currentSpan(
	event: CoveEvent,
	turns: Map<string, Span>,
	operations: Map<string, Span>,
	runs: Map<string, Span>,
): Span | undefined {
	return (
		(event.turnId ? turns.get(event.turnId) : undefined) ??
		operationSpan(event, operations) ??
		workflowSpan(event, runs)
	);
}

function compactionKey(event: CoveEvent): string {
	return `${event.runId ?? event.instanceId ?? ""}:${event.session ?? ""}:${event.operationId ?? ""}`;
}

function toolKey(event: CoveEvent & { toolCallId: string }): string {
	return `${event.turnId ?? event.operationId ?? event.taskId ?? event.runId ?? event.instanceId ?? ""}:${event.toolCallId}`;
}

function identifiers(event: CoveEvent): Attributes {
	return Object.fromEntries(
		Object.entries({
			"cove.run.id": event.runId,
			"cove.instance.id": event.instanceId,
			"cove.dispatch.id": event.dispatchId,
			"cove.harness.name": event.harness,
			"cove.session.name": event.session,
			"cove.parent_session.name": event.parentSession,
			"cove.operation.id": event.operationId,
			"cove.task.id": event.taskId,
			"cove.turn.id": event.turnId,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function eventIndexAttribute(scope: "start" | "end" | "index", event: CoveEvent): Attributes {
	return {
		[scope === "index" ? "cove.event.index" : `cove.event.${scope}_index`]: event.eventIndex,
	};
}

type TurnUsage = Extract<CoveEvent, { type: "turn" }>["usage"];

function usageAttributes(usage: TurnUsage, prefix?: string): Attributes {
	if (!usage) return {};
	if (!prefix) {
		// Model-turn leaf spans use GenAI semconv names where the spec defines them; total/cost have no
		// semconv equivalent and stay in the cove namespace.
		return {
			"gen_ai.usage.input_tokens": usage.input,
			"gen_ai.usage.output_tokens": usage.output,
			"gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
			"gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
			"cove.usage.total_tokens": usage.totalTokens,
			"cove.usage.cost_total": usage.cost.total,
		};
	}
	return {
		[`${prefix}.input_tokens`]: usage.input,
		[`${prefix}.output_tokens`]: usage.output,
		[`${prefix}.cache_read_tokens`]: usage.cacheRead,
		[`${prefix}.cache_write_tokens`]: usage.cacheWrite,
		[`${prefix}.total_tokens`]: usage.totalTokens,
		[`${prefix}.cost_total`]: usage.cost.total,
	};
}

function exportEvent<TEvent extends CoveEvent>(
	exportContent: CoveOpenTelemetryObserverOptions["exportContent"],
	event: TEvent,
): TEvent | undefined {
	if (!exportContent) return event;
	try {
		return exportContent({ ...event }) as TEvent | undefined;
	} catch (error) {
		console.error("[cove] opentelemetry exportContent callback failed:", error);
		return undefined;
	}
}

function contentAttribute(name: string, value: unknown): Attributes {
	if (value === undefined) return {};
	return { [name]: typeof value === "string" ? value : safeJson(value) };
}

function setContentAttribute(span: Span, name: string, value: unknown): void {
	const attributes = contentAttribute(name, value);
	if (Object.keys(attributes).length > 0) span.setAttributes(attributes);
}

function complete(
	span: Span,
	isError: boolean,
	exportedError: unknown,
	defaultMessage: string,
	time: Date,
): void {
	if (isError) {
		const message = exportedError === undefined ? defaultMessage : errorMessage(exportedError);
		span.setStatus({ code: SpanStatusCode.ERROR, message });
		if (message) span.recordException(message);
	}
	span.end(time);
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
		return error.message;
	return error === undefined ? undefined : safeJson(error);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function timestamp(event: CoveEvent): Date {
	return new Date(event.timestamp);
}
