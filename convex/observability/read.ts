// Ported from flue · @flue/opentelemetry · packages/opentelemetry/src/index.ts → @cove/observability
// (the read-side driver). flue's observer was fed a LIVE in-process event stream; cove's events are
// durable rows in the `events` table (G2.1 substrate), so the observer is driven by a READ instead.
//
//   - `replayEventsToObserver(events, observer)` — a pure array fold (the unit-test + offline seam).
//   - `exportSpans({ streamKey })` — a QUERY that reads `events` `by_stream_and_seq`, maps each row's
//     `data` to a `CoveEvent`, folds them through `createCoveOpenTelemetryObserver` backed by an
//     in-module SERIALIZABLE span-tree recorder, and returns the tree. This proves the read-side fold
//     without standing up an external OTLP collector (a deployment concern, out of scope).
//
// Query-only: NO "use node", no sandbox/box.

import {
	type Context,
	context as otelContext,
	type Span,
	type SpanContext,
	type SpanOptions,
	type SpanStatusCode,
	trace,
	type Tracer,
} from "@opentelemetry/api";
import { v } from "convex/values";
import { query } from "../_generated/server";
import type { CoveEvent } from "../../src/runtime/types.ts";
import { createCoveOpenTelemetryObserver } from "./otel.ts";

/** A serializable span node — the JSON the query returns + the test asserts against. */
export interface SerializableSpan {
	name: string;
	kind?: number;
	attributes: Record<string, unknown>;
	status?: { code: number; message?: string };
	events: { name: string; attributes: Record<string, unknown>; time?: string }[];
	exceptions: unknown[];
	startTime?: string;
	endTime?: string;
	children: SerializableSpan[];
}

/** Pure helper: fold an array of events through an observer (the read-side replay seam). */
export function replayEventsToObserver(
	events: CoveEvent[],
	observer: (event: CoveEvent) => void,
): void {
	for (const event of events) observer(event);
}

/**
 * Fold a recorded `CoveEvent[]` into a serializable span tree using an in-module recorder. Shared by
 * the `exportSpans` query and the OTel test so both exercise the same code path. An optional
 * `exportContent` redactor is forwarded to the observer (the offline export may strip content).
 */
export function buildSpanTree(
	events: CoveEvent[],
	exportContent?: (event: CoveEvent) => CoveEvent | undefined,
): SerializableSpan[] {
	const recorder = new SpanTreeRecorder();
	const observer = createCoveOpenTelemetryObserver({ tracer: recorder.tracer(), exportContent });
	replayEventsToObserver(events, observer);
	return recorder.roots();
}

/**
 * A minimal in-memory `Tracer`/`Span` recorder that builds a `SerializableSpan[]` forest. Parent
 * linkage is read from the OTel `Context` the observer threads through `tracer.startSpan(...)`: when a
 * parent span is active in the passed context, the new span is appended to that parent's `children`,
 * otherwise it becomes a root. This mirrors how a real SDK tracer derives parentage, so the observer
 * code under test is unmodified.
 */
class SpanTreeRecorder {
	private readonly rootNodes: RecordedNode[] = [];
	private readonly tracerImpl: Tracer;

	constructor() {
		const recorder = this;
		this.tracerImpl = {
			startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
				const parent = ctx ? (trace.getSpan(ctx) as RecordedSpan | undefined) : undefined;
				const span = new RecordedSpan(name, options);
				if (parent && !options?.root) parent.node.children.push(span.node);
				else recorder.rootNodes.push(span.node);
				return span;
			},
			startActiveSpan(...args: unknown[]): unknown {
				// The observer never uses startActiveSpan; provide a passthrough for type-completeness.
				const fn = args[args.length - 1] as (span: Span) => unknown;
				const span = this.startSpan(args[0] as string);
				try {
					return fn(span);
				} finally {
					span.end();
				}
			},
		} as Tracer;
	}

	tracer(): Tracer {
		return this.tracerImpl;
	}

	roots(): SerializableSpan[] {
		return this.rootNodes.map(toSerializable);
	}
}

let spanIdCounter = 0;

/** A recording `Span` — captures everything the observer sets onto it into a `node`. */
class RecordedSpan implements Span {
	readonly node: RecordedNode;
	private readonly ctx: SpanContext;

	constructor(name: string, options: SpanOptions | undefined) {
		spanIdCounter += 1;
		this.node = {
			name,
			kind: options?.kind,
			attributes: { ...(toRecord(options?.attributes) ?? {}) },
			events: [],
			exceptions: [],
			startTime: toIso(options?.startTime),
			children: [],
		};
		this.ctx = {
			traceId: "00000000000000000000000000000001",
			spanId: spanIdCounter.toString(16).padStart(16, "0"),
			traceFlags: 1,
		};
	}

	spanContext(): SpanContext {
		return this.ctx;
	}

	setAttribute(key: string, value: unknown): this {
		this.node.attributes[key] = value;
		return this;
	}

	setAttributes(attributes: Record<string, unknown>): this {
		Object.assign(this.node.attributes, attributes);
		return this;
	}

	addEvent(name: string, attributesOrTime?: unknown, time?: unknown): this {
		const attributes =
			attributesOrTime && !isTimeInput(attributesOrTime)
				? (attributesOrTime as Record<string, unknown>)
				: {};
		const at = isTimeInput(attributesOrTime) ? attributesOrTime : time;
		this.node.events.push({ name, attributes: { ...attributes }, time: toIso(at) });
		return this;
	}

	addLink(): this {
		return this;
	}

	addLinks(): this {
		return this;
	}

	setStatus(status: { code: SpanStatusCode; message?: string }): this {
		this.node.status = { code: status.code as number, message: status.message };
		return this;
	}

	updateName(name: string): this {
		this.node.name = name;
		return this;
	}

	end(endTime?: unknown): void {
		this.node.endTime = toIso(endTime);
	}

	isRecording(): boolean {
		return true;
	}

	recordException(exception: unknown): void {
		this.node.exceptions.push(exception);
	}
}

interface RecordedNode {
	name: string;
	kind?: number;
	attributes: Record<string, unknown>;
	status?: { code: number; message?: string };
	events: { name: string; attributes: Record<string, unknown>; time?: string }[];
	exceptions: unknown[];
	startTime?: string;
	endTime?: string;
	children: RecordedNode[];
}

function toSerializable(node: RecordedNode): SerializableSpan {
	return {
		name: node.name,
		kind: node.kind,
		attributes: node.attributes,
		status: node.status,
		events: node.events,
		exceptions: node.exceptions,
		startTime: node.startTime,
		endTime: node.endTime,
		children: node.children.map(toSerializable),
	};
}

function toRecord(attributes: unknown): Record<string, unknown> | undefined {
	return attributes && typeof attributes === "object"
		? (attributes as Record<string, unknown>)
		: undefined;
}

function isTimeInput(value: unknown): value is Date | number {
	return value instanceof Date || typeof value === "number";
}

function toIso(time: unknown): string | undefined {
	if (time instanceof Date) return time.toISOString();
	if (typeof time === "number") return new Date(time).toISOString();
	return undefined;
}

// Referenced to keep the import surface explicit (the observer threads contexts through the recorder's
// tracer; we re-export the active-context accessor so callers building their own driver have it).
export const activeContext = (): Context => otelContext.active();

/**
 * Read a stream's events and fold them into a serializable span tree. Query-side: a subscriber re-runs
 * on every new matching row, so the exported spans stay live. For an external OTLP exporter, replace the
 * recorder with an SDK `NodeTracerProvider` in an app-deployment layer (out of framework scope).
 */
export const exportSpans = query({
	args: { streamKey: v.string() },
	handler: async (ctx, { streamKey }): Promise<SerializableSpan[]> => {
		const rows = await ctx.db
			.query("events")
			.withIndex("by_stream_and_seq", (q) => q.eq("streamKey", streamKey))
			.collect();
		const events = rows.map((r) => r.data as CoveEvent);
		return buildSpanTree(events);
	},
});
