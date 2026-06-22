// New · @cove/runtime — G2.3: Slack adapter verify (HMAC + window) / mapPayload (handshake/message/ignore) /
// postReply (mocked fetch), exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackAdapter } from "../slack/index.ts";

async function slackSig(secret: string, ts: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${body}`));
	return `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function reqWith(headers: Record<string, string>): Request {
	return new Request("https://x.convex.site/channels/slack", { method: "POST", headers });
}

const SECRET = "shhh";

beforeEach(() => {
	process.env.SLACK_SIGNING_SECRET = SECRET;
});
afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.SLACK_BOT_TOKEN;
});

describe("slackAdapter.verify", () => {
	it("accepts a correctly signed request and rejects a forged one", async () => {
		const ts = String(Math.floor(Date.now() / 1000));
		const body = JSON.stringify({ type: "event_callback" });
		const good = await slackSig(SECRET, ts, body);
		expect(
			await slackAdapter.verify(
				reqWith({ "x-slack-request-timestamp": ts, "x-slack-signature": good }),
				body,
			),
		).toEqual({ ok: true });
		const forged = await slackAdapter.verify(
			reqWith({ "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" }),
			body,
		);
		expect(forged.ok).toBe(false);
	});

	it("rejects when the signing secret is unconfigured", async () => {
		delete process.env.SLACK_SIGNING_SECRET;
		const r = await slackAdapter.verify(reqWith({}), "{}");
		expect(r.ok).toBe(false);
	});
});

describe("slackAdapter.mapPayload", () => {
	const req = reqWith({});
	it("answers url_verification with a handshake (no admission)", () => {
		const m = slackAdapter.mapPayload({ type: "url_verification", challenge: "abc" }, req);
		expect(m).toEqual({ kind: "handshake", body: { challenge: "abc" } });
	});
	it("maps a user message to a submit with a slack replyContext", () => {
		const m = slackAdapter.mapPayload(
			{
				type: "event_callback",
				event_id: "Ev1",
				team_id: "T1",
				event: { type: "message", text: "hello", channel: "C1", user: "U1" },
			},
			req,
		);
		expect(m.kind).toBe("submit");
		if (m.kind !== "submit") throw new Error("unreachable");
		expect(m.spec.message).toBe("hello");
		expect(m.spec.eventId).toBe("Ev1");
		expect(m.spec.replyContext).toMatchObject({ provider: "slack", target: "C1" });
	});
	it("ignores bot-echo messages (loop guard)", () => {
		const m = slackAdapter.mapPayload(
			{ type: "event_callback", event: { type: "message", text: "x", bot_id: "B1" } },
			req,
		);
		expect(m.kind).toBe("ignore");
	});
});

describe("slackAdapter.postReply", () => {
	it("posts the final text via response_url when present", async () => {
		const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await slackAdapter.postReply(
			{ provider: "slack", target: "C1", responseUrl: "https://hooks.slack/r" },
			{ status: "completed", finalText: "done" },
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.slack/r");
	});
	it("posts via chat.postMessage with the bot token", async () => {
		process.env.SLACK_BOT_TOKEN = "xoxb-1";
		const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await slackAdapter.postReply(
			{ provider: "slack", target: "C1" },
			{ status: "completed", finalText: "done" },
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain("chat.postMessage");
	});
	it("is a no-op with no token + no response_url", async () => {
		const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await slackAdapter.postReply({ provider: "slack", target: "C1" }, { status: "completed" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
