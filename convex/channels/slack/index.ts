// Ported from flue · @flue/slack · packages/slack/src/{routes,index}.ts → @cove/channels (slack). The inline
// http.ts:144-191 route refactored to a ChannelAdapter. verify reuses the pure verifySlackSignature (HMAC over
// `v0:{ts}:{body}`, ±300s window); mapPayload reuses parseSlackPayload (url_verification handshake / message /
// ignore bot-echo); postReply posts the terminal result via response_url or chat.postMessage. Hono dropped.
// No "use node" (Web Crypto + fetch run in the V8 httpAction).

import {
	parseSlackPayload,
	slackSessionRef,
	verifySlackSignature,
} from "../../../src/runtime/channels/slack.ts";
import { replyText } from "../format.ts";
import type { ChannelAdapter, MapResult, ReplyContext, TerminalResult, VerifyResult } from "../types.ts";

export const slackAdapter: ChannelAdapter = {
	name: "slack",

	async verify(req, rawBody): Promise<VerifyResult> {
		const secret = process.env.SLACK_SIGNING_SECRET;
		if (!secret) {
			return { ok: false, status: 401, message: "[cove] Slack signing secret not configured." };
		}
		const ok = await verifySlackSignature({
			signingSecret: secret,
			timestamp: req.headers.get("x-slack-request-timestamp") ?? "",
			rawBody,
			signature: req.headers.get("x-slack-signature") ?? "",
		});
		return ok ? { ok: true } : { ok: false, status: 401, message: "[cove] invalid Slack signature." };
	},

	mapPayload(parsed): MapResult {
		const p = parseSlackPayload(parsed);
		if (p.kind === "challenge") return { kind: "handshake", body: { challenge: p.challenge } };
		if (p.kind === "ignore") return { kind: "ignore" };
		const ref = slackSessionRef(p.team, p.channel);
		return {
			kind: "submit",
			spec: {
				message: p.message,
				instanceId: ref.instanceId,
				sessionName: ref.sessionName,
				eventId: p.eventId,
				replyContext: {
					provider: "slack",
					target: p.channel,
					addressing: { team: p.team, user: p.user },
				},
			},
		};
	},

	async postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void> {
		const text = replyText(terminal);
		if (replyContext.responseUrl) {
			await fetch(replyContext.responseUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text, thread_ts: replyContext.threadId }),
			});
			return;
		}
		const token = process.env.SLACK_BOT_TOKEN;
		if (!token) return; // no token configured — best-effort (offline/dev)
		await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ channel: replyContext.target, text, thread_ts: replyContext.threadId }),
		});
	},
};
