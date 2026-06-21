// Tests for the decode core (engine/decode.ts), driven through the in-process MockLanguageModelV2
// (no live provider) so step decisions are deterministic and replay-equality is exact (doc 06 P4).
import { describe, expect, it } from "vitest";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { makeMockLanguageModel, makeTestModelHandle } from "../../providers/testModel.ts";
import { type DecodeDeps, type DecodeInput, type FinalizedStep, runDecode } from "../decode.ts";
import type { DeltaPatch } from "../deltaBatcher.ts";
import type { ModelToolView } from "../types.ts";

function streamOf(parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
	return new ReadableStream<LanguageModelV2StreamPart>({
		start(controller) {
			for (const p of parts) controller.enqueue(p);
			controller.close();
		},
	});
}

function textStream(text: string, finishReason = "stop"): LanguageModelV2StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "0" },
		{ type: "text-delta", id: "0", delta: text },
		{ type: "text-end", id: "0" },
		{
			type: "finish",
			finishReason: finishReason as "stop",
			usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
		},
	];
}

interface Harnessed {
	deps: DecodeDeps;
	patches: DeltaPatch[];
	finalized: { value?: FinalizedStep };
	inserts: { count: number };
}

function harness(over?: Partial<DecodeDeps>): Harnessed {
	const patches: DeltaPatch[] = [];
	const finalized: { value?: FinalizedStep } = {};
	const inserts = { count: 0 };
	const deps: DecodeDeps = {
		loadStep: async () => null,
		insertStreaming: async () => {
			inserts.count++;
		},
		patch: async (p) => void patches.push(p),
		finalizeStep: async (s) => {
			finalized.value = s;
		},
		now: () => 0,
		...over,
	};
	return { deps, patches, finalized, inserts };
}

describe("replay guard (doc 08 §4.1)", () => {
	it("calls the model once; a finalized row replays the decision with NO second model call", async () => {
		let doStreamCalls = 0;
		const mock = makeMockLanguageModel({
			doStream: async () => {
				doStreamCalls++;
				return { stream: streamOf(textStream("hi")) };
			},
		});
		const handle = makeTestModelHandle(mock);
		const input: DecodeInput = { handle, messages: [{ role: "user", content: "hi" }], tools: [] };

		const h = harness();
		const d1 = await runDecode(input, h.deps);
		expect(doStreamCalls).toBe(1);
		expect(d1.text).toBe("hi");
		expect(h.finalized.value?.text).toBe("hi");
		expect(h.inserts.count).toBe(1);

		// Replay: the finalized row exists → reconstruct, never insert, never call the model again.
		const final = h.finalized.value!;
		const replay = harness({
			loadStep: async () => ({
				isFinalized: true,
				finishReason: final.finishReason,
				text: final.text,
				toolCalls: final.toolCalls,
			}),
			insertStreaming: async () => {
				throw new Error("replay must not insert a streaming row");
			},
		});
		const d2 = await runDecode(input, replay.deps);
		expect(doStreamCalls).toBe(1);
		expect(d2).toEqual({ finishReason: "stop", toolCalls: [], text: "hi", shouldCompact: false });
	});
});

describe("delta batching throughput (doc 08 §4.6)", () => {
	it("coalesces many small deltas into far fewer batched patches", async () => {
		const parts: LanguageModelV2StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "text-start", id: "0" },
		];
		for (let i = 0; i < 20; i++) parts.push({ type: "text-delta", id: "0", delta: "abcde" });
		parts.push({ type: "text-end", id: "0" });
		parts.push({
			type: "finish",
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		const mock = makeMockLanguageModel({ doStream: async () => ({ stream: streamOf(parts) }) });
		const handle = makeTestModelHandle(mock);
		const h = harness({ batchOptions: { maxChars: 30, maxMs: 1_000_000 } });
		const dec = await runDecode({ handle, messages: [{ role: "user", content: "hi" }], tools: [] }, h.deps);

		const expected = "abcde".repeat(20);
		expect(dec.text).toBe(expected);
		expect(h.patches.map((p) => p.text ?? "").join("")).toBe(expected);
		expect(h.patches.length).toBeGreaterThan(1);
		expect(h.patches.length).toBeLessThan(20); // coalesced, not one mutation per delta
	});
});

describe("responseMessages round-trip (doc 04 context-rebuild parity)", () => {
	it("captures verbatim response messages that JSON round-trip exactly", async () => {
		const mock = makeMockLanguageModel({ doStream: async () => ({ stream: streamOf(textStream("round trip")) }) });
		const handle = makeTestModelHandle(mock);
		const h = harness();
		await runDecode({ handle, messages: [{ role: "user", content: "hi" }], tools: [] }, h.deps);

		const msgs = h.finalized.value!.responseMessages;
		expect(msgs.length).toBeGreaterThan(0);
		const assistant = msgs.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(JSON.stringify(assistant!.content)).toContain("round trip");
		// Byte-faithful round-trip (no functions/Dates/undefined-laden structures persist).
		expect(JSON.parse(JSON.stringify(msgs))).toEqual(msgs);
	});
});

describe("tool-call decode", () => {
	it("decodes a tool call (parsed args) and surfaces it on the decision", async () => {
		const parts: LanguageModelV2StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-call", toolCallId: "t1", toolName: "read", input: JSON.stringify({ path: "/a" }) },
			{
				type: "finish",
				finishReason: "tool-calls",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			},
		];
		const mock = makeMockLanguageModel({ doStream: async () => ({ stream: streamOf(parts) }) });
		const handle = makeTestModelHandle(mock);
		const tools: ModelToolView[] = [
			{
				name: "read",
				description: "read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		];
		const h = harness();
		const dec = await runDecode({ handle, messages: [{ role: "user", content: "hi" }], tools }, h.deps);
		expect(dec.finishReason).toBe("tool-calls");
		expect(dec.toolCalls).toMatchObject([{ toolCallId: "t1", toolName: "read", args: { path: "/a" } }]);
	});
});
