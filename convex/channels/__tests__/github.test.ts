// New · @cove/runtime — G2.3: GitHub adapter (the second-channel HMAC shared-contract proof).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubAdapter } from "../github/index.ts";

async function ghSig(secret: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
	return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function req(headers: Record<string, string>): Request {
	return new Request("https://x.convex.site/channels/github", { method: "POST", headers });
}

const SECRET = "ghsecret";
beforeEach(() => {
	process.env.GITHUB_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.GITHUB_TOKEN;
});

describe("githubAdapter.verify", () => {
	it("accepts a valid X-Hub-Signature-256 and rejects a forged one", async () => {
		const body = JSON.stringify({ action: "created" });
		const sig = await ghSig(SECRET, body);
		expect(await githubAdapter.verify(req({ "x-hub-signature-256": sig }), body)).toEqual({ ok: true });
		const bad = await githubAdapter.verify(req({ "x-hub-signature-256": "sha256=00" }), body);
		expect(bad.ok).toBe(false);
	});
});

describe("githubAdapter.mapPayload", () => {
	it("answers ping with a handshake", () => {
		const m = githubAdapter.mapPayload({}, req({ "x-github-event": "ping" }));
		expect(m.kind).toBe("handshake");
	});
	it("maps an issue_comment created to a submit", () => {
		const payload = {
			action: "created",
			comment: { body: "hey bot", user: { type: "User" } },
			issue: { number: 7, comments_url: "https://api.github.com/repos/o/r/issues/7/comments" },
			repository: { full_name: "o/r" },
		};
		const m = githubAdapter.mapPayload(
			payload,
			req({ "x-github-event": "issue_comment", "x-github-delivery": "d-1" }),
		);
		expect(m.kind).toBe("submit");
		if (m.kind !== "submit") throw new Error("unreachable");
		expect(m.spec.message).toBe("hey bot");
		expect(m.spec.eventId).toBe("d-1");
		expect(m.spec.replyContext).toMatchObject({ provider: "github" });
		expect(m.spec.replyContext.target).toContain("/issues/7/comments");
	});
	it("ignores bot-authored comments (loop guard)", () => {
		const m = githubAdapter.mapPayload(
			{ action: "created", comment: { body: "x", user: { type: "Bot" } } },
			req({ "x-github-event": "issue_comment", "x-github-delivery": "d-2" }),
		);
		expect(m.kind).toBe("ignore");
	});
});

describe("githubAdapter.postReply", () => {
	it("posts a comment via the comments REST API with the token", async () => {
		process.env.GITHUB_TOKEN = "ghp_1";
		const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await githubAdapter.postReply(
			{ provider: "github", target: "https://api.github.com/repos/o/r/issues/7/comments" },
			{ status: "completed", finalText: "done" },
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain("/issues/7/comments");
	});
});
