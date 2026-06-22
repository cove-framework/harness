// Ported from flue · @flue/notion · packages/notion/src/webhook.ts → @cove/channels (notion). Hono dropped.
// Two-mode verify: (1) one-time subscription handshake — `x-notion-signature` ABSENT and the body carries a
// `verification_token` → verify ok, and mapPayload echoes `{ verification_token }` back; (2) signed events —
// `x-notion-signature` present → HMAC-SHA256 over the RAW body (`sha256=<hex>`) keyed by the verification token
// (NOTION_WEBHOOK_SECRET / NOTION_VERIFICATION_TOKEN). mapPayload admits comment-creation events (others / bot
// actors ignored); the dedup eventId is the body event id. postReply posts via the Notion comments API. No
// "use node" (Web Crypto + fetch). Caveat: the secret comes from process.env (no per-process token cache here).

import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";

const NOTION_VERSION = "2022-06-28";

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

function verificationSecret(): string | undefined {
	return process.env.NOTION_WEBHOOK_SECRET ?? process.env.NOTION_VERIFICATION_TOKEN;
}

function readVerificationToken(rawBody: string): string | undefined {
	try {
		const v = (JSON.parse(rawBody) as Record<string, unknown>)?.verification_token;
		return typeof v === "string" && v.length > 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

export const notionAdapter: ChannelAdapter = {
	name: "notion",

	async verify(req, rawBody): Promise<VerifyResult> {
		const signatureHeader = req.headers.get("x-notion-signature");

		// Mode 1: handshake — no signature header but the body offers a verification_token. Admit it; the actual
		// echo happens in mapPayload (so we don't double-parse). Notion sends this once to confirm the endpoint.
		if (!signatureHeader) {
			if (readVerificationToken(rawBody)) return { ok: true };
			return { ok: false, status: 401, message: "[cove] missing Notion signature." };
		}

		// Mode 2: signed event — HMAC over the raw body keyed by the verification token / configured secret.
		const secret = verificationSecret();
		if (!secret) {
			return { ok: false, status: 503, message: "[cove] Notion verification token not configured." };
		}
		const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
		return timingSafeEqual(expected, signatureHeader)
			? { ok: true }
			: { ok: false, status: 401, message: "[cove] invalid Notion signature." };
	},

	mapPayload(parsed, req): MapResult {
		const p = parsed as Record<string, any>;
		if (!p || typeof p !== "object") return { kind: "ignore" };

		// Handshake echo: when there is no signature and the body carries a verification_token, reply with it
		// verbatim so Notion can confirm endpoint ownership.
		if (!req.headers.get("x-notion-signature")) {
			const token = typeof p.verification_token === "string" ? p.verification_token : undefined;
			if (token) return { kind: "handshake", body: { verification_token: token } };
			return { kind: "ignore" };
		}

		// Events. We drive runs off newly-created comments; other event types are ignored.
		const eventType: string = typeof p.type === "string" ? p.type : "";
		if (!eventType.startsWith("comment.")) return { kind: "ignore" };
		if (eventType !== "comment.created") return { kind: "ignore" };

		// Self/bot-echo guard: skip comments authored by a bot integration.
		const authors = Array.isArray(p.authors) ? p.authors : [];
		if (authors.some((a: any) => a?.type === "bot")) return { kind: "ignore" };

		const entity = p.entity ?? {};
		const data = p.data ?? {};
		// Comment id and text. Notion comment text is a rich_text array; we join its plain_text segments.
		const commentId = typeof entity.id === "string" ? entity.id : (typeof data.id === "string" ? data.id : "");
		const richText = Array.isArray(data.rich_text) ? data.rich_text : [];
		const message = richText
			.map((rt: any) => (typeof rt?.plain_text === "string" ? rt.plain_text : (typeof rt?.text?.content === "string" ? rt.text.content : "")))
			.join("")
			.trim();
		if (message.length === 0) return { kind: "ignore" };

		// Reply target: the parent the comment hangs off (page / block / discussion).
		const parent = data.parent ?? {};
		const parentId =
			typeof parent.page_id === "string" ? parent.page_id :
			typeof parent.block_id === "string" ? parent.block_id :
			typeof parent.id === "string" ? parent.id : "";
		const discussionId = typeof data.discussion_id === "string" ? data.discussion_id : undefined;
		const workspaceId = typeof p.workspace_id === "string" ? p.workspace_id : "unknown";
		const eventId = req.headers.get("x-notion-request-id") ?? (typeof p.id === "string" ? p.id : `${commentId}:${p.timestamp ?? ""}`);

		return {
			kind: "submit",
			spec: {
				message,
				instanceId: `notion:${workspaceId}`,
				sessionName: `notion:${discussionId ?? parentId ?? commentId}`,
				eventId,
				replyContext: {
					provider: "notion",
					target: parentId, // page/block the comment lives under
					threadId: discussionId,
					addressing: { workspaceId, commentId, discussionId },
				},
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const apiKey = process.env.NOTION_API_KEY;
		if (!apiKey || (!replyContext.threadId && !replyContext.target)) return; // best-effort no-op
		// Reply into the existing discussion thread when known; otherwise create a new page comment.
		const body: Record<string, unknown> = {
			rich_text: [{ text: { content: replyText(terminal) } }],
		};
		if (replyContext.threadId) body.discussion_id = replyContext.threadId;
		else body.parent = { page_id: replyContext.target };
		await fetch("https://api.notion.com/v1/comments", {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				"Notion-Version": NOTION_VERSION,
			},
			body: JSON.stringify(body),
		});
	},
};
