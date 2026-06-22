// Ported from flue · @flue/google-chat · packages/google-chat/src/routes.ts → @cove/channels (google-chat).
// Hono dropped. verify reads the `Authorization: Bearer` token and validates it with verifyGoogleChatToken
// (jose via dynamic import — keeps the static V8 bundle jose-free; see ./auth.ts). mapPayload turns a MESSAGE
// interaction into a prompt (ADDED_TO_SPACE / CARD_CLICKED / bot authors are ignored to avoid reply loops); the
// dedup eventId is the inbound message resource name. postReply posts via the Chat spaces.messages REST API.
// No "use node" (Web Crypto + fetch; jose dynamically imported only inside verify).

import { verifyGoogleChatToken } from "./auth.ts";
import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";

export const googleChatAdapter: ChannelAdapter = {
	name: "google-chat",

	async verify(req, _rawBody): Promise<VerifyResult> {
		const authorization = req.headers.get("authorization") ?? "";
		if (!authorization.startsWith("Bearer ")) {
			return { ok: false, status: 401, message: "[cove] missing Google Chat bearer token." };
		}
		const token = authorization.slice("Bearer ".length).trim();
		const result = await verifyGoogleChatToken(token);
		return result.ok
			? { ok: true }
			: { ok: false, status: 401, message: `[cove] invalid Google Chat token: ${result.reason}` };
	},

	mapPayload(parsed): MapResult {
		const p = parsed as Record<string, any>;
		if (!p || typeof p !== "object") return { kind: "ignore" };

		// Only MESSAGE interactions carry a user prompt. ADDED_TO_SPACE / REMOVED_FROM_SPACE / CARD_CLICKED /
		// APP_COMMAND etc. are ignored so we never trigger a run (or a reply loop) off a non-message event.
		if (p.type !== "MESSAGE") return { kind: "ignore" };

		const msg = p.message ?? {};
		// Self/bot-echo guard: skip messages authored by a bot account.
		const sender = msg.sender ?? p.user ?? {};
		if (sender?.type === "BOT") return { kind: "ignore" };

		// Prefer argumentText (text with the @mention stripped) and fall back to the full text.
		const text = typeof msg.argumentText === "string" && msg.argumentText.length > 0
			? msg.argumentText
			: (typeof msg.text === "string" ? msg.text : "");
		const message = text.trim();
		if (message.length === 0) return { kind: "ignore" };

		// Space + thread resource names: `spaces/<id>` and `spaces/<id>/threads/<id>`.
		const space = msg.space ?? p.space ?? {};
		const spaceName = typeof space.name === "string" ? space.name : "unknown";
		const thread = msg.thread ?? {};
		const threadName = typeof thread.name === "string" ? thread.name : undefined;
		const messageName = typeof msg.name === "string" ? msg.name : `${spaceName}:${p.eventTime ?? ""}`;

		return {
			kind: "submit",
			spec: {
				message,
				instanceId: `google-chat:${spaceName}`,
				sessionName: `google-chat:${threadName ?? spaceName}`,
				eventId: messageName,
				replyContext: {
					provider: "google-chat",
					target: spaceName, // post the reply into this space
					threadId: threadName,
					addressing: { space: spaceName, thread: threadName },
				},
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const token = process.env.GOOGLE_CHAT_BOT_TOKEN;
		if (!token || !replyContext.target) return; // best-effort no-op when unconfigured
		const body: Record<string, unknown> = { text: replyText(terminal) };
		// Reply into the originating thread when known (THREAD reply threading key).
		if (replyContext.threadId) body.thread = { name: replyContext.threadId };
		const url = new URL(`https://chat.googleapis.com/v1/${replyContext.target}/messages`);
		if (replyContext.threadId) url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
		await fetch(url.toString(), {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	},
};
