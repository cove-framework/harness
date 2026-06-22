// Tests for createCoveEventStream against a fake Convex client whose onUpdate(ref, args, cb) is
// driven by hand. Asserts: catch-up-by-seq → live tail → cancel(); and that a SECOND identical
// whole-result tick (same rows) yields nothing new (seq dedup). Pure (node env, no DOM).
import { describe, expect, it } from "vitest";
import { createCoveEventStream } from "../event-stream.ts";
import type { CoveConvexClient } from "../types.ts";

/** Minimal CoveEvent-ish row carrying a `seq` (the only field the stream diffs on). */
type Row = { seq: number; type: string; eventIndex: number };

function row(seq: number, type: string): Row {
	return { seq, type, eventIndex: seq };
}

/**
 * A fake Convex client exposing the single `onUpdate` surface the stream uses. `deliver(result)`
 * pushes a whole-result page to the active subscriber (mimicking Convex re-delivering the WHOLE
 * query result on every reactive tick). `fail(err)` drives the error path.
 */
function fakeConvex() {
	let cb: ((result: { events: Row[]; nextSeq: number }) => void) | undefined;
	let onError: ((error: Error) => void) | undefined;
	let lastArgs: Record<string, unknown> | undefined;
	let unsubscribed = false;

	const convex: CoveConvexClient = {
		mutation: async () => ({}),
		query: async () => ({}),
		onUpdate: (_ref, args, callback, errCallback) => {
			cb = callback as typeof cb;
			onError = errCallback;
			lastArgs = args;
			unsubscribed = false;
			return () => {
				unsubscribed = true;
			};
		},
	};

	return {
		convex,
		/** Push a whole-result page (the rows are the entire current query result). */
		deliver(rows: Row[]) {
			const nextSeq = rows.length > 0 ? rows[rows.length - 1]!.seq + 1 : 0;
			cb?.({ events: rows, nextSeq });
		},
		fail(error: Error) {
			onError?.(error);
		},
		get args() {
			return lastArgs;
		},
		get unsubscribed() {
			return unsubscribed;
		},
		get hasSubscriber() {
			return cb !== undefined;
		},
	};
}

/** Pull `count` events from the iterator, allowing microtask delivery to interleave. */
async function take(iter: AsyncIterator<Row>, count: number): Promise<Row[]> {
	const out: Row[] = [];
	for (let i = 0; i < count; i++) {
		const r = await iter.next();
		if (r.done) break;
		out.push(r.value);
	}
	return out;
}

describe("createCoveEventStream", () => {
	it("subscribes with the streamKey + initial sinceSeq", () => {
		const fake = fakeConvex();
		const stream = createCoveEventStream<Row>({
			convex: fake.convex,
			listForStreamRef: "listForStream",
			streamKey: "inst-1",
			sinceSeq: 4,
		});
		const iter = stream[Symbol.asyncIterator]();
		// Kick the iterator so it subscribes.
		void iter.next();
		expect(fake.args).toMatchObject({ streamKey: "inst-1", sinceSeq: 4 });
		stream.cancel();
	});

	it("catches up by seq, then live-tails, then cancels", async () => {
		const fake = fakeConvex();
		const stream = createCoveEventStream<Row>({
			convex: fake.convex,
			listForStreamRef: "listForStream",
			streamKey: "inst-1",
		});
		const iter = stream[Symbol.asyncIterator]();

		// First next() subscribes; deliver a catch-up page of 3 rows.
		const firstPull = iter.next();
		fake.deliver([row(0, "operation_start"), row(1, "message_start"), row(2, "text_delta")]);
		const first = await firstPull;
		expect(first.value).toEqual(row(0, "operation_start"));

		// Drain the rest of the catch-up batch.
		const rest = await take(iter, 2);
		expect(rest.map((r) => r.type)).toEqual(["message_start", "text_delta"]);
		// Cursor advanced past the whole catch-up batch.
		expect(stream.sinceSeq).toBe(2);

		// Live tail: a new whole-result tick (re-includes prior rows + a new one).
		const tailPull = iter.next();
		fake.deliver([
			row(0, "operation_start"),
			row(1, "message_start"),
			row(2, "text_delta"),
			row(3, "text_delta"),
		]);
		const tail = await tailPull;
		expect(tail.value).toEqual(row(3, "text_delta"));
		expect(stream.sinceSeq).toBe(3);

		// cancel() unsubscribes and ends the iterator.
		stream.cancel();
		expect(fake.unsubscribed).toBe(true);
		const done = await iter.next();
		expect(done.done).toBe(true);
	});

	it("dedups a second identical whole-result tick by seq (yields nothing new)", async () => {
		const fake = fakeConvex();
		const stream = createCoveEventStream<Row>({
			convex: fake.convex,
			listForStreamRef: "listForStream",
			streamKey: "inst-1",
		});
		const iter = stream[Symbol.asyncIterator]();

		// Deliver a batch and drain it fully.
		const pull = iter.next();
		fake.deliver([row(0, "a"), row(1, "b")]);
		await pull;
		await take(iter, 1);
		expect(stream.sinceSeq).toBe(1);

		// A SECOND identical tick (same rows) must yield nothing new: the next() should block on
		// the identical tick and only resolve when a genuinely new row arrives.
		const blocked = iter.next();
		fake.deliver([row(0, "a"), row(1, "b")]); // identical — all seq <= currentSeq
		let settled = false;
		void blocked.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);

		// Now a genuinely new row unblocks it.
		fake.deliver([row(0, "a"), row(1, "b"), row(2, "c")]);
		const next = await blocked;
		expect(next.value).toEqual(row(2, "c"));
		expect(stream.sinceSeq).toBe(2);
		stream.cancel();
	});

	it("for-await drains and return() unsubscribes on break", async () => {
		const fake = fakeConvex();
		const stream = createCoveEventStream<Row>({
			convex: fake.convex,
			listForStreamRef: "listForStream",
			streamKey: "inst-1",
		});

		const collected: Row[] = [];
		const loop = (async () => {
			for await (const ev of stream) {
				collected.push(ev);
				if (collected.length === 2) break; // triggers iterator.return() → cancel()
			}
		})();

		// Let the loop subscribe before delivering.
		await Promise.resolve();
		fake.deliver([row(0, "a"), row(1, "b"), row(2, "c")]);
		await loop;

		expect(collected.map((r) => r.seq)).toEqual([0, 1]);
		expect(fake.unsubscribed).toBe(true);
	});

	it("surfaces a subscription error", async () => {
		const fake = fakeConvex();
		const stream = createCoveEventStream<Row>({
			convex: fake.convex,
			listForStreamRef: "listForStream",
			streamKey: "inst-1",
		});
		const iter = stream[Symbol.asyncIterator]();
		const pull = iter.next();
		fake.fail(new Error("boom"));
		await expect(pull).rejects.toThrow("boom");
	});

	it("supports subscribing by submissionId", () => {
		const fake = fakeConvex();
		const stream = createCoveEventStream<Row>({
			convex: fake.convex,
			listForStreamRef: "listForStream",
			submissionId: "sub-9",
			sinceSeq: 0,
		});
		const iter = stream[Symbol.asyncIterator]();
		void iter.next();
		expect(fake.args).toMatchObject({ submissionId: "sub-9", sinceSeq: 0 });
		stream.cancel();
	});

	it("throws when neither streamKey nor submissionId is provided", () => {
		const fake = fakeConvex();
		expect(() =>
			createCoveEventStream<Row>({
				convex: fake.convex,
				listForStreamRef: "listForStream",
			}),
		).toThrow("[cove]");
	});
});
