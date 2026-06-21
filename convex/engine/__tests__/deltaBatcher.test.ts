// Tests for the streaming delta batcher (engine/deltaBatcher.ts). Drives the cadence with an
// injected clock so flush timing is deterministic (no real timers).
import { describe, expect, it } from "vitest";
import { DeltaBatcher, type DeltaPatch } from "../deltaBatcher.ts";

function collector() {
	const patches: DeltaPatch[] = [];
	return { patches, sink: async (p: DeltaPatch) => void patches.push(p) };
}

describe("DeltaBatcher", () => {
	it("flushes when the char threshold is crossed, emitting deltas-since-flush", async () => {
		const { patches, sink } = collector();
		const b = new DeltaBatcher(sink, { maxChars: 5, maxMs: 1_000_000, now: () => 0 });
		await b.text("ab"); // 2 buffered, no flush
		expect(patches).toHaveLength(0);
		await b.text("cde"); // 5 buffered → flush
		expect(patches).toEqual([{ text: "abcde" }]);
		await b.text("fg");
		await b.flush();
		expect(patches).toEqual([{ text: "abcde" }, { text: "fg" }]);
	});

	it("flushes on the time threshold even below the char threshold", async () => {
		const { patches, sink } = collector();
		let t = 0;
		const b = new DeltaBatcher(sink, { maxChars: 1000, maxMs: 400, now: () => t });
		await b.text("hi"); // below char threshold, no time elapsed
		expect(patches).toHaveLength(0);
		t = 400; // time threshold reached
		await b.reasoning("thinking");
		expect(patches).toEqual([{ text: "hi", reasoning: "thinking" }]);
	});

	it("coalesces text and reasoning into one patch", async () => {
		const { patches, sink } = collector();
		const b = new DeltaBatcher(sink, { maxChars: 1000, maxMs: 1_000_000, now: () => 0 });
		await b.text("a");
		await b.reasoning("r");
		await b.flush();
		expect(patches).toEqual([{ text: "a", reasoning: "r" }]);
	});

	it("a flush with nothing buffered does not call the sink", async () => {
		const { patches, sink } = collector();
		const b = new DeltaBatcher(sink, { now: () => 0 });
		await b.flush();
		expect(patches).toHaveLength(0);
	});

	it("only includes the channel that actually has buffered content", async () => {
		const { patches, sink } = collector();
		const b = new DeltaBatcher(sink, { maxChars: 1000, maxMs: 1_000_000, now: () => 0 });
		await b.reasoning("only-reasoning");
		await b.flush();
		expect(patches).toEqual([{ reasoning: "only-reasoning" }]);
	});
});
