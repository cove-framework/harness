// Ported from flue · @flue/linear · packages/linear/src/webhook.ts → @cove/channels (linear). Hono dropped;
// verify is the `linear-signature` HMAC-SHA256 over the RAW body (hex) plus a ±60s replay window on the body's
// `webhookTimestamp`. mapPayload admits Issue/Comment `create` events (other types / bot actors are ignored to
// avoid reply loops); the dedup eventId is the `linear-delivery` header (falling back to the body delivery id).
// postReply posts a comment via the Linear GraphQL `commentCreate` mutation. No "use node" (Web Crypto + fetch).

import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";

const TIMESTAMP_TOLERANCE_MS = 60_000;

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

export const linearAdapter: ChannelAdapter = {
	name: "linear",

	async verify(req, rawBody): Promise<VerifyResult> {
		const secret = process.env.LINEAR_WEBHOOK_SECRET;
		if (!secret) {
			return { ok: false, status: 401, message: "[cove] Linear webhook secret not configured." };
		}
		const signature = req.headers.get("linear-signature") ?? "";
		const expected = await hmacSha256Hex(secret, rawBody);
		if (!timingSafeEqual(expected, signature)) {
			return { ok: false, status: 401, message: "[cove] invalid Linear signature." };
		}
		// Replay window: the signed body carries `webhookTimestamp` (ms); reject if outside ±60s.
		let ts: unknown;
		try {
			ts = (JSON.parse(rawBody) as Record<string, unknown>)?.webhookTimestamp;
		} catch {
			return { ok: false, status: 400, message: "[cove] malformed Linear body." };
		}
		if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) {
			return { ok: false, status: 401, message: "[cove] Linear timestamp outside replay window." };
		}
		return { ok: true };
	},

	mapPayload(parsed, req): MapResult {
		const p = parsed as Record<string, any>;
		if (!p || typeof p !== "object") return { kind: "ignore" };

		// Only newly-created Issues/Comments drive a run; updates/removes and other entity types are ignored.
		if (p.action !== "create") return { kind: "ignore" };
		const entity = p.type; // "Issue" | "Comment" | ...
		if (entity !== "Issue" && entity !== "Comment") return { kind: "ignore" };

		const data = p.data ?? {};
		// Self/bot-echo guard: skip actions performed by an application/bot actor.
		const actor = p.actor ?? data.user;
		if (actor?.type === "bot" || actor?.type === "application") return { kind: "ignore" };

		// Message + reply target differ between issue and comment events.
		let message: string;
		let issueId: string;
		let issueIdentifier: string;
		let threadId: string | undefined;
		if (entity === "Issue") {
			const title = typeof data.title === "string" ? data.title : "";
			const desc = typeof data.description === "string" ? data.description : "";
			message = [title, desc].filter((s) => s.length > 0).join("\n\n").trim();
			issueId = typeof data.id === "string" ? data.id : "";
			issueIdentifier = typeof data.identifier === "string" ? data.identifier : issueId;
		} else {
			const cbody = typeof data.body === "string" ? data.body : "";
			message = cbody.trim();
			const issue = data.issue ?? {};
			issueId = typeof issue.id === "string" ? issue.id : (typeof data.issueId === "string" ? data.issueId : "");
			issueIdentifier = typeof issue.identifier === "string" ? issue.identifier : issueId;
			// Reply in the same comment thread when this is a top-level comment.
			threadId = typeof data.id === "string" ? data.id : undefined;
		}
		if (message.length === 0 || issueId.length === 0) return { kind: "ignore" };

		const org = typeof p.organizationId === "string" ? p.organizationId : "unknown";
		const teamId = typeof data.team?.id === "string" ? data.team.id : (typeof data.teamId === "string" ? data.teamId : "unknown");
		const delivery = req.headers.get("linear-delivery") ?? (typeof p.webhookId === "string" ? p.webhookId : `${entity}:${issueId}:${p.webhookTimestamp ?? ""}`);

		return {
			kind: "submit",
			spec: {
				message,
				instanceId: `linear:${org}`,
				sessionName: `linear:${issueIdentifier || issueId}`,
				eventId: delivery,
				replyContext: {
					provider: "linear",
					target: issueId, // the issue we comment back on
					threadId,
					addressing: { org, teamId, issueIdentifier },
				},
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const apiKey = process.env.LINEAR_API_KEY;
		if (!apiKey || !replyContext.target) return; // best-effort no-op when unconfigured
		const mutation =
			"mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }";
		const input: Record<string, unknown> = { issueId: replyContext.target, body: replyText(terminal) };
		if (replyContext.threadId) input.parentId = replyContext.threadId;
		await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: { authorization: apiKey, "content-type": "application/json" },
			body: JSON.stringify({ query: mutation, variables: { input } }),
		});
	},
};
