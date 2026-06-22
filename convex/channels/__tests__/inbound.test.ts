// New · @cove/runtime — G2.3: the shared inbound pipeline (verify → authorize → dedup → admit) on a fake
// adapter + fake ActionCtx. Proves: forged verify → no admission; replay → no second admission; authorize
// reject → no admission; handshake/ignore → no admission; valid → submit with the mapped spec + replyContext.
import { afterEach, describe, expect, it } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import { configureAuthorize } from "../../auth.ts";
import { verifyThenAdmit } from "../inbound.ts";
import type { ChannelAdapter, MapResult } from "../types.ts";

function fakeCtx(opts: { dedupNew?: boolean } = {}) {
	const calls: { kind: "dedup" | "submit"; args: Record<string, unknown> }[] = [];
	const ctx = {
		runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
			if (args && "key" in args) {
				calls.push({ kind: "dedup", args });
				return { isNew: opts.dedupNew ?? true };
			}
			calls.push({ kind: "submit", args });
			return { sessionId: "s", requestId: "r", submissionId: "sub", workflowId: "w" };
		},
		runQuery: async () => null,
		runAction: async () => null,
	} as unknown as ActionCtx;
	return { ctx, calls, submit: () => calls.find((c) => c.kind === "submit") };
}

const validMap: MapResult = {
	kind: "submit",
	spec: {
		message: "hi",
		instanceId: "i",
		sessionName: "s",
		eventId: "e1",
		replyContext: { provider: "fake", target: "t" },
	},
};

function adapter(over: Partial<ChannelAdapter> = {}): ChannelAdapter {
	return {
		name: "fake",
		verify: async () => ({ ok: true }),
		mapPayload: () => validMap,
		postReply: async () => {},
		...over,
	};
}

function postReq(body: unknown): Request {
	return new Request("https://x.convex.site/channels/fake", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => configureAuthorize(undefined));

describe("verifyThenAdmit", () => {
	it("admits a valid event with the mapped spec + replyContext", async () => {
		const f = fakeCtx();
		const res = await verifyThenAdmit(f.ctx, adapter(), postReq({ any: 1 }));
		expect(res.status).toBe(200);
		expect(f.submit()?.args).toMatchObject({
			prompt: "hi",
			instanceId: "i",
			sessionName: "s",
			replyContext: { provider: "fake" },
		});
	});

	it("rejects a forged signature with 401 and NO admission", async () => {
		const f = fakeCtx();
		const res = await verifyThenAdmit(
			f.ctx,
			adapter({ verify: async () => ({ ok: false, status: 401 }) }),
			postReq({}),
		);
		expect(res.status).toBe(401);
		expect(f.submit()).toBeUndefined();
	});

	it("treats a replayed delivery as a no-op — exactly one run", async () => {
		const f = fakeCtx({ dedupNew: false });
		const res = await verifyThenAdmit(f.ctx, adapter(), postReq({}));
		expect(res.status).toBe(200);
		expect(f.submit()).toBeUndefined();
	});

	it("does NOT admit when the authorize hook rejects", async () => {
		configureAuthorize(() => {
			throw new Error("denied");
		});
		const f = fakeCtx();
		const res = await verifyThenAdmit(f.ctx, adapter(), postReq({}));
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(f.submit()).toBeUndefined();
	});

	it("echoes a handshake without admission", async () => {
		const f = fakeCtx();
		const res = await verifyThenAdmit(
			f.ctx,
			adapter({ mapPayload: () => ({ kind: "handshake", body: { challenge: "c" } }) }),
			postReq({}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ challenge: "c" });
		expect(f.calls.length).toBe(0);
	});

	it("ignores a non-message event without admission", async () => {
		const f = fakeCtx();
		const res = await verifyThenAdmit(
			f.ctx,
			adapter({ mapPayload: () => ({ kind: "ignore" }) }),
			postReq({}),
		);
		expect(res.status).toBe(200);
		expect(f.calls.length).toBe(0);
	});
});
