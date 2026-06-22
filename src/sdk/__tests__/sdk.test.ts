// Tests for the SDK transport (src/sdk/index.ts) against a fake Convex client.
import { describe, expect, it } from "vitest";
import { createAgent } from "../../runtime/agent-definition.ts";
import type { PromptUsage } from "../../runtime/types.ts";
import { type ConvexLike, createCoveClient, createCoveTransport } from "../index.ts";

const ZERO: PromptUsage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const REFS = {
	submitPrompt: "submitPrompt",
	getRequest: "getRequest",
	stopActive: "stopActive",
	sessionExists: "sessionExists",
	deleteSession: "deleteSession",
	submitSkill: "submitSkill",
	submitCompact: "submitCompact",
};

function fakeClient(over?: { query?: (ref: unknown, args: Record<string, unknown>) => unknown }) {
	const calls = {
		mutations: [] as { ref: unknown; args: Record<string, unknown> }[],
		queries: [] as { ref: unknown; args: Record<string, unknown> }[],
	};
	const client: ConvexLike = {
		mutation: async (ref, args) => {
			calls.mutations.push({ ref, args });
			return { requestId: "req-1", submissionId: "sub-1", sessionId: "sess-1" };
		},
		query: async (ref, args) => {
			calls.queries.push({ ref, args });
			return over?.query
				? over.query(ref, args)
				: { status: "completed", finalText: "ok", usage: ZERO };
		},
	};
	return { client, calls };
}

describe("createCoveTransport", () => {
	it("submitPrompt forwards to the mutation ref and returns the requestId", async () => {
		const { client, calls } = fakeClient();
		const t = createCoveTransport(client, REFS);
		const r = await t.submitPrompt(
			{ instanceId: "i", harnessName: "default", sessionName: "default", prompt: "hi", model: "m" },
			new AbortController().signal,
		);
		expect(r.requestId).toBe("req-1");
		expect(calls.mutations[0]?.ref).toBe("submitPrompt");
		expect(calls.mutations[0]?.args).toMatchObject({ prompt: "hi", model: "m", instanceId: "i" });
	});

	it("awaitTerminal polls getRequest until a terminal status", async () => {
		let n = 0;
		const { client } = fakeClient({
			query: () => (++n < 3 ? { status: "running" } : { status: "completed", finalText: "done", usage: ZERO }),
		});
		const t = createCoveTransport(client, REFS, { pollIntervalMs: 1 });
		const snap = await t.awaitTerminal("req-1", new AbortController().signal);
		expect(snap.status).toBe("completed");
		expect(n).toBeGreaterThanOrEqual(3);
	});
});

describe("createCoveClient (facade over the transport)", () => {
	it("init → session → prompt resolves a PromptResponse via the client", async () => {
		const { client, calls } = fakeClient();
		const cove = createCoveClient(client, REFS, { pollIntervalMs: 1 });
		const ctx = cove.context({ id: "sdk" });
		const session = await (await ctx.init(createAgent(() => ({ model: "cove-test/mock" })))).session("s");
		const res = await session.prompt("hello from sdk");
		expect(res.text).toBe("ok");
		expect(calls.mutations[0]?.args).toMatchObject({ prompt: "hello from sdk", sessionName: "s" });
		expect(calls.queries[0]?.ref).toBe("getRequest");
	});
});
