// Tests for the CoveContext→CoveHarness→CoveSession facade (src/runtime/context.ts) against a fake transport.
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { abortErrorFor } from "../abort.ts";
import { createAgent } from "../agent-definition.ts";
import {
	type CoveTransport,
	createCoveContext,
	type PromptSubmission,
	type RequestSnapshot,
} from "../context.ts";
import {
	ModelNotConfiguredError,
	OperationFailedError,
	ResultUnavailableError,
	SessionAlreadyExistsError,
	SessionNotFoundError,
} from "../errors.ts";
import type { PromptUsage } from "../types.ts";

const USAGE: PromptUsage = {
	input: 4,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeTransport(opts?: {
	snapshot?: RequestSnapshot;
	exists?: boolean;
	awaitImpl?: (signal: AbortSignal) => Promise<RequestSnapshot>;
}) {
	const calls = { submissions: [] as PromptSubmission[], stopActive: 0, deletes: 0 };
	const transport: CoveTransport = {
		submitPrompt: async (s) => {
			calls.submissions.push(s);
			return { requestId: "req-1" };
		},
		awaitTerminal: async (_id, signal) =>
			opts?.awaitImpl
				? opts.awaitImpl(signal)
				: (opts?.snapshot ?? { status: "completed", finalText: "ok", usage: USAGE }),
		stopActive: async () => {
			calls.stopActive++;
		},
		sessionExists: async () => opts?.exists ?? true,
		deleteSession: async () => {
			calls.deletes++;
		},
	};
	return { transport, calls };
}

const haiku = createAgent(() => ({ model: "anthropic/claude-haiku-4-5" }));

describe("CoveSession.prompt (free-form)", () => {
	it("submits and resolves a PromptResponse", async () => {
		const { transport, calls } = fakeTransport({
			snapshot: { status: "completed", finalText: "hello!", usage: USAGE },
		});
		const ctx = createCoveContext(transport, { id: "i1" });
		const session = await (await ctx.init(haiku)).session();
		const res = await session.prompt("hi");
		expect(res.text).toBe("hello!");
		expect(res.model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
		expect(res.usage.totalTokens).toBe(9);
		expect(calls.submissions[0]).toMatchObject({
			instanceId: "i1",
			harnessName: "default",
			sessionName: "default",
			prompt: "hi",
			model: "anthropic/claude-haiku-4-5",
		});
		expect(calls.submissions[0]?.resultSchema).toBeUndefined();
	});

	it("throws ModelNotConfiguredError when no model is resolvable", async () => {
		const { transport } = fakeTransport();
		const ctx = createCoveContext(transport, { id: "i1" });
		const session = await (await ctx.init(createAgent(() => ({ model: false })))).session();
		await expect(session.prompt("hi")).rejects.toBeInstanceOf(ModelNotConfiguredError);
	});

	it("maps a failed run to OperationFailedError", async () => {
		const { transport } = fakeTransport({ snapshot: { status: "failed", error: "step_limit_exceeded" } });
		const ctx = createCoveContext(transport, { id: "i1" });
		const session = await (await ctx.init(haiku)).session();
		await expect(session.prompt("hi")).rejects.toBeInstanceOf(OperationFailedError);
	});
});

describe("CoveSession.prompt (result schema)", () => {
	const schema = v.object({ answer: v.string() });

	it("re-validates the captured result and resolves PromptResultResponse", async () => {
		const { transport, calls } = fakeTransport({
			snapshot: { status: "completed", result: { answer: "42" }, usage: USAGE },
		});
		const ctx = createCoveContext(transport, { id: "i1" });
		const session = await (await ctx.init(haiku)).session();
		const res = await session.prompt("q", { result: schema });
		expect(res.data).toEqual({ answer: "42" });
		expect(calls.submissions[0]?.resultSchema).toBeDefined();
	});

	it("rejects with ResultUnavailableError when the captured value fails valibot re-validation", async () => {
		const { transport } = fakeTransport({
			snapshot: { status: "completed", result: { answer: 123 }, usage: USAGE },
		});
		const ctx = createCoveContext(transport, { id: "i1" });
		const session = await (await ctx.init(haiku)).session();
		await expect(session.prompt("q", { result: schema })).rejects.toBeInstanceOf(ResultUnavailableError);
	});

	it("rejects with ResultUnavailableError on a give-up / exhausted run", async () => {
		const { transport } = fakeTransport({
			snapshot: { status: "failed", error: "result_followups_exhausted" },
		});
		const ctx = createCoveContext(transport, { id: "i1" });
		const session = await (await ctx.init(haiku)).session();
		await expect(session.prompt("q", { result: schema })).rejects.toBeInstanceOf(ResultUnavailableError);
	});
});

describe("CoveSession abort", () => {
	it("aborting cancels the run and rejects", async () => {
		const { transport, calls } = fakeTransport({
			awaitImpl: (signal) =>
				new Promise<RequestSnapshot>((_resolve, reject) => {
					if (signal.aborted) {
						reject(abortErrorFor(signal));
						return;
					}
					signal.addEventListener("abort", () => reject(abortErrorFor(signal)), { once: true });
				}),
		});
		const ctx = createCoveContext(transport, { id: "i1" });
		const session = await (await ctx.init(haiku)).session();
		const handle = session.prompt("hi");
		handle.abort();
		await expect(handle).rejects.toThrow();
		expect(calls.stopActive).toBe(1);
	});
});

describe("CoveSessions get/create/delete", () => {
	it("get throws SessionNotFoundError when missing", async () => {
		const { transport } = fakeTransport({ exists: false });
		const harness = await createCoveContext(transport, { id: "i1" }).init(haiku);
		await expect(harness.sessions.get("nope")).rejects.toBeInstanceOf(SessionNotFoundError);
	});
	it("create throws SessionAlreadyExistsError when present", async () => {
		const { transport } = fakeTransport({ exists: true });
		const harness = await createCoveContext(transport, { id: "i1" }).init(haiku);
		await expect(harness.sessions.create("dup")).rejects.toBeInstanceOf(SessionAlreadyExistsError);
	});
	it("delete calls the transport", async () => {
		const { transport, calls } = fakeTransport();
		const harness = await createCoveContext(transport, { id: "i1" }).init(haiku);
		await harness.sessions.delete("s");
		expect(calls.deletes).toBe(1);
	});
});
