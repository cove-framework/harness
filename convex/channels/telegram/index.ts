// Ported from flue · @flue/telegram · packages/telegram/src/webhook.ts → @cove/channels (telegram). Hono dropped.
// verify is a constant-time compare of the `x-telegram-bot-api-secret-token` header against the configured secret
// (flue SHA-256-digests both sides before comparing — equivalent; we compare the raw strings constant-time).
// mapPayload extracts `message.text` from a user update (edited/non-text/bot updates are ignored to avoid loops);
// the dedup eventId is `update_id`. postReply calls the Bot API sendMessage. No "use node" (Web Crypto + fetch).

import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";

/** Constant-time string compare (independent of where the first mismatch is). */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

export const telegramAdapter: ChannelAdapter = {
	name: "telegram",

	async verify(req, _rawBody): Promise<VerifyResult> {
		const expected = process.env.TELEGRAM_SECRET_TOKEN;
		if (!expected) {
			return { ok: false, status: 401, message: "[cove] Telegram secret token not configured." };
		}
		const provided = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
		return timingSafeEqual(expected, provided)
			? { ok: true }
			: { ok: false, status: 401, message: "[cove] invalid Telegram secret token." };
	},

	mapPayload(parsed): MapResult {
		const p = parsed as Record<string, any>;
		if (!p || typeof p !== "object" || typeof p.update_id !== "number") return { kind: "ignore" };

		// We only drive runs off fresh (non-edited) text messages. Edited messages, channel posts,
		// callbacks, and non-text content are ignored so we never reply to our own / system updates.
		const message = p.message;
		if (!message || typeof message !== "object") return { kind: "ignore" };
		const text = message.text;
		if (typeof text !== "string" || text.length === 0) return { kind: "ignore" };
		// Self/bot-echo guard: skip messages authored by a bot account.
		if (message.from?.is_bot === true) return { kind: "ignore" };

		const chat = message.chat ?? {};
		const chatId = chat.id != null ? String(chat.id) : "unknown";
		const userId = message.from?.id != null ? String(message.from.id) : "unknown";
		const messageId = message.message_id != null ? String(message.message_id) : undefined;
		const threadId = message.message_thread_id != null ? String(message.message_thread_id) : undefined;

		return {
			kind: "submit",
			spec: {
				message: text,
				instanceId: `telegram:${chatId}`,
				sessionName: `telegram:${chatId}`,
				eventId: String(p.update_id),
				replyContext: {
					provider: "telegram",
					target: chatId,
					threadId,
					addressing: { user: userId, messageId, messageThreadId: threadId },
				},
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const token = process.env.TELEGRAM_BOT_TOKEN;
		if (!token || !replyContext.target) return; // best-effort no-op when unconfigured
		const body: Record<string, unknown> = { chat_id: replyContext.target, text: replyText(terminal) };
		if (replyContext.threadId) body.message_thread_id = Number(replyContext.threadId);
		await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	},
};
