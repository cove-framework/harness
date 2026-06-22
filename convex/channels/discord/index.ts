// Ported from flue · @flue/discord · packages/discord/src/routes.ts → @cove/channels (discord). Hono dropped;
// verify runs Ed25519 over `timestamp + rawBody` (raw-bytes, not a re-stringified parse) via Web Crypto, with
// the ed25519 public key from process.env. The PING interaction (type 1) is a handshake answered with
// `{ type: 1 }`; non-message interaction types and bot authors are ignored to avoid reply loops. The interaction
// id is the dedup eventId. No "use node" (Web Crypto + fetch run in the V8 httpAction).

import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";

/** Decode a fixed-length lowercase/uppercase hex string to bytes; returns undefined if malformed. */
function hexToBytes(value: string, byteLength: number): Uint8Array<ArrayBuffer> | undefined {
	const expr = new RegExp(`^[0-9a-fA-F]{${byteLength * 2}}$`);
	if (!expr.test(value)) return undefined;
	const bytes = new Uint8Array(byteLength);
	for (let i = 0; i < byteLength; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

/** Verify an Ed25519 signature over `timestamp + rawBody` against the application's hex public key. */
async function verifyEd25519(publicKeyHex: string, timestamp: string, rawBody: string, sigHex: string): Promise<boolean> {
	const pub = hexToBytes(publicKeyHex, 32);
	const sig = hexToBytes(sigHex, 64);
	if (!pub || !sig) return false;
	try {
		const enc = new TextEncoder();
		const data = enc.encode(timestamp + rawBody);
		const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify("Ed25519", key, sig, data);
	} catch {
		return false;
	}
}

export const discordAdapter: ChannelAdapter = {
	name: "discord",

	async verify(req, rawBody): Promise<VerifyResult> {
		const publicKey = process.env.DISCORD_PUBLIC_KEY;
		if (!publicKey) {
			return { ok: false, status: 401, message: "[cove] Discord public key not configured." };
		}
		const signature = req.headers.get("x-signature-ed25519") ?? "";
		const timestamp = req.headers.get("x-signature-timestamp") ?? "";
		if (!signature || !timestamp) {
			return { ok: false, status: 401, message: "[cove] missing Discord signature headers." };
		}
		const ok = await verifyEd25519(publicKey, timestamp, rawBody, signature);
		return ok ? { ok: true } : { ok: false, status: 401, message: "[cove] invalid Discord signature." };
	},

	mapPayload(parsed): MapResult {
		const p = parsed as Record<string, any>;
		if (!p || typeof p !== "object") return { kind: "ignore" };

		// Interaction type 1 = PING → answer the verification handshake with type 1 (PONG).
		const type = p.type;
		if (type === 1) return { kind: "handshake", body: { type: 1 } };

		// Only message-creating interactions become a run:
		//   2 = APPLICATION_COMMAND (slash command), 3 = MESSAGE_COMPONENT, 5 = MODAL_SUBMIT.
		// Component clicks/modals carry no user prompt for us; we drive runs off slash commands (type 2).
		if (type !== 2) return { kind: "ignore" };

		// Author resolution: guild interactions carry `member.user`, DMs carry top-level `user`.
		const author = p.member?.user ?? p.user;
		// Self/bot-echo guard: skip interactions authored by a bot account (avoids reply loops).
		if (author?.bot === true) return { kind: "ignore" };

		// Extract the prompt: command name + the joined string option values (best-effort).
		const data = p.data ?? {};
		const commandName = typeof data.name === "string" ? data.name : "";
		const optionText = Array.isArray(data.options)
			? data.options
					.map((o: any) => (typeof o?.value === "string" ? o.value : o?.value != null ? String(o.value) : ""))
					.filter((s: string) => s.length > 0)
					.join(" ")
			: "";
		const message = [commandName, optionText].filter((s) => s.length > 0).join(" ").trim();
		if (message.length === 0) return { kind: "ignore" };

		const guildId = typeof p.guild_id === "string" ? p.guild_id : "dm";
		const channelId = typeof p.channel_id === "string" ? p.channel_id : (typeof p.channel?.id === "string" ? p.channel.id : "unknown");
		const interactionId = typeof p.id === "string" ? p.id : `${channelId}:${p.token ?? ""}`;
		const appId = typeof p.application_id === "string" ? p.application_id : "";

		return {
			kind: "submit",
			spec: {
				message,
				instanceId: `discord:${guildId}`,
				sessionName: `discord:${channelId}`,
				eventId: interactionId,
				replyContext: {
					provider: "discord",
					target: channelId,
					// Discord interaction followup webhook: needs application_id + the interaction token.
					responseUrl: appId && p.token ? `https://discord.com/api/v10/webhooks/${appId}/${p.token}` : undefined,
					addressing: { guildId, applicationId: appId, interactionToken: p.token },
				},
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const text = replyText(terminal);
		// Preferred: the interaction followup webhook (no bot token required, valid ~15 min after the interaction).
		if (replyContext.responseUrl) {
			await fetch(replyContext.responseUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: text }),
			});
			return;
		}
		// Fallback: post via the bot REST API into the channel. Best-effort if no token is configured.
		const token = process.env.DISCORD_BOT_TOKEN;
		if (!token || !replyContext.target) return;
		await fetch(`https://discord.com/api/v10/channels/${replyContext.target}/messages`, {
			method: "POST",
			headers: { authorization: `Bot ${token}`, "content-type": "application/json", "user-agent": "cove" },
			body: JSON.stringify({ content: text }),
		});
	},
};
