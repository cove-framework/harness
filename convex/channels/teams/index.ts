// Ported from flue · @flue/teams · packages/teams/src/routes.ts → @cove/channels (teams). Bot Framework
// activity webhook: verify the bearer JWT (auth.ts), map a "message" activity to a prompt, reply via the Bot
// Framework serviceUrl. Hono dropped. No "use node" (jose runs in V8).

import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";
import { verifyTeamsToken } from "./auth.ts";

export const teamsAdapter: ChannelAdapter = {
	name: "teams",

	async verify(req): Promise<VerifyResult> {
		const auth = req.headers.get("authorization") ?? "";
		const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
		if (!token) return { ok: false, status: 401, message: "[cove] missing Teams bearer token." };
		const appId = process.env.TEAMS_APP_ID ?? "";
		const r = await verifyTeamsToken(token, appId);
		return r.ok
			? { ok: true }
			: { ok: false, status: 401, message: `[cove] Teams token rejected: ${r.reason ?? "invalid"}` };
	},

	mapPayload(parsed): MapResult {
		const a = parsed as Record<string, any>;
		// Bot Framework "message" activity with text; ignore other activity types + bot-authored messages.
		if (a.type !== "message" || typeof a.text !== "string" || a.text.length === 0) {
			return { kind: "ignore" };
		}
		const convId = String(a.conversation?.id ?? "unknown");
		const serviceUrl = typeof a.serviceUrl === "string" ? a.serviceUrl : undefined;
		const eventId = typeof a.id === "string" ? a.id : `${convId}:${a.timestamp ?? ""}`;
		return {
			kind: "submit",
			spec: {
				message: a.text,
				instanceId: `teams:${a.channelId ?? "msteams"}`,
				sessionName: `teams:${convId}`,
				eventId,
				replyContext: {
					provider: "teams",
					target: convId,
					responseUrl: serviceUrl,
					addressing: { activityId: a.id },
				},
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const token = process.env.TEAMS_BOT_TOKEN;
		if (!token || !replyContext.responseUrl) return; // best-effort (offline/dev)
		const base = replyContext.responseUrl.replace(/\/$/, "");
		const url = `${base}/v3/conversations/${encodeURIComponent(replyContext.target)}/activities`;
		await fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ type: "message", text: replyText(terminal) }),
		});
	},
};
