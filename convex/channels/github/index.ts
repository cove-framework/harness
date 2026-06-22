// Ported from flue · @flue/github · packages/github/src/webhook.ts → @cove/channels (github). verify is the
// `X-Hub-Signature-256` HMAC over the raw body; the `ping` event is a handshake; issue/PR-comment "created"
// events (non-bot) map to a prompt keyed by repo+issue; postReply posts via the issue comments REST API. The
// `x-github-delivery` header is the dedup id. Event type comes from the `x-github-event` header (hence req in
// mapPayload). Hono + @octokit types dropped. No "use node" (Web Crypto + fetch).

import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const githubAdapter: ChannelAdapter = {
	name: "github",

	async verify(req, rawBody): Promise<VerifyResult> {
		const secret = process.env.GITHUB_WEBHOOK_SECRET;
		if (!secret) {
			return { ok: false, status: 401, message: "[cove] GitHub webhook secret not configured." };
		}
		const signature = req.headers.get("x-hub-signature-256") ?? "";
		const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
		return timingSafeEqual(expected, signature)
			? { ok: true }
			: { ok: false, status: 401, message: "[cove] invalid GitHub signature." };
	},

	mapPayload(parsed, req): MapResult {
		const event = req.headers.get("x-github-event");
		const delivery = req.headers.get("x-github-delivery") ?? "";
		if (event === "ping") return { kind: "handshake", body: { ok: true } };

		const p = parsed as Record<string, any>;
		const isComment = event === "issue_comment" || event === "pull_request_review_comment";
		if (!isComment || p.action !== "created") return { kind: "ignore" };
		// Self/bot-echo guard: skip comments authored by a bot account.
		if (p.comment?.user?.type === "Bot") return { kind: "ignore" };
		const body = p.comment?.body;
		if (typeof body !== "string" || body.length === 0) return { kind: "ignore" };

		const repo = p.repository?.full_name ?? "unknown";
		const number = p.issue?.number ?? p.pull_request?.number ?? 0;
		const commentsUrl = p.issue?.comments_url ?? p.pull_request?.comments_url ?? "";
		return {
			kind: "submit",
			spec: {
				message: body,
				instanceId: `github:${repo}`,
				sessionName: `github:${number}`,
				eventId: delivery,
				replyContext: { provider: "github", target: commentsUrl, addressing: { repo, number } },
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const token = process.env.GITHUB_TOKEN;
		if (!token || !replyContext.target) return;
		await fetch(replyContext.target, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
				"user-agent": "cove",
			},
			body: JSON.stringify({ body: replyText(terminal) }),
		});
	},
};
