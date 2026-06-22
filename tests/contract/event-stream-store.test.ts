// Ported from flue · @flue/runtime · test-utils/define-event-stream-store-contract-tests.ts → @cove/runtime.
// Reshaped to the Convex EventStreamStore (convex/events/*): flue's opaque offset string becomes the cove
// monotonic per-streamKey `seq`; appendEvent/readEvents map to internal.events.append + api.events.read
// .listForStream. DROPPED (08 §5): the closeStream/`closed` and subscribe/notify assertions — cove has no
// stream-close concept (Convex reactivity replaces explicit subscribe; the DS close/notify model is obsolete).
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema.ts";

const modules = import.meta.glob("../../convex/**/*.ts");

const ev = (n: number) => ({ type: "text_delta", text: `d${n}`, instanceId: "i1" });
async function appendN(t: ReturnType<typeof convexTest>, streamKey: string, n: number) {
	for (let i = 0; i < n; i++) {
		await t.mutation(internal.events.append.append, { event: ev(i), streamKeys: [streamKey] });
	}
}

describe("Convex EventStreamStore contract (G2.6)", () => {
	it("assigns a monotonic per-stream seq and reads them back in order", async () => {
		const t = convexTest(schema, modules);
		await appendN(t, "s1", 3);
		const page = await t.query(api.events.read.listForStream, { streamKey: "s1" });
		expect(page.events.map((e: { seq: number }) => e.seq)).toEqual([0, 1, 2]);
		expect(page.events.map((e: { text: string }) => e.text)).toEqual(["d0", "d1", "d2"]);
		expect(page.nextSeq).toBe(3);
	});

	it("pages by seq (sinceSeq is exclusive)", async () => {
		const t = convexTest(schema, modules);
		await appendN(t, "s1", 4);
		const tail = await t.query(api.events.read.listForStream, { streamKey: "s1", sinceSeq: 1 });
		expect(tail.events.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
		expect(tail.nextSeq).toBe(4);
	});

	it("respects a limit (tail paging)", async () => {
		const t = convexTest(schema, modules);
		await appendN(t, "s1", 5);
		const first = await t.query(api.events.read.listForStream, { streamKey: "s1", limit: 2 });
		expect(first.events.map((e: { seq: number }) => e.seq)).toEqual([0, 1]);
		expect(first.nextSeq).toBe(2);
	});

	it("tolerates a missing stream (empty result, no throw)", async () => {
		const t = convexTest(schema, modules);
		const page = await t.query(api.events.read.listForStream, { streamKey: "never-written" });
		expect(page.events).toEqual([]);
		expect(page.nextSeq).toBe(0);
	});

	it("fans out to multiple stream keys with independent monotonic seq", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.events.append.append, {
			event: { type: "text_delta", text: "x", instanceId: "i1", session: "default" },
			streamKeys: ["i1", "i1:default"],
		});
		const a = await t.query(api.events.read.listForStream, { streamKey: "i1" });
		const b = await t.query(api.events.read.listForStream, { streamKey: "i1:default" });
		expect(a.events).toHaveLength(1);
		expect(b.events).toHaveLength(1);
		expect(a.events[0].seq).toBe(0);
		expect(b.events[0].seq).toBe(0);
	});
});
