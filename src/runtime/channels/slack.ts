// Ported-shape from flue · @flue/* channel adapters → @cove/runtime — Slack inbound (doc 06 P11). The pure,
// transport-agnostic half of the channel: verify the webhook signature, parse the event, and map it onto a
// submit (instanceId/sessionName + message). The httpAction wiring (dedup + submitPrompt + outbound reply)
// lives in convex/; outbound posting + a real Slack app are the live-verification remainder.
//
// Pure / V8-safe: only Web Crypto (HMAC). No Convex, no AI SDK.

/**
 * Verify a Slack request signature: `v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{rawBody}")`, with a
 * replay window on the timestamp (default ±300s). Constant-time hex compare.
 */
export async function verifySlackSignature(opts: {
	signingSecret: string;
	timestamp: string;
	rawBody: string;
	signature: string;
	now?: number;
	toleranceSec?: number;
}): Promise<boolean> {
	const ts = Number(opts.timestamp);
	if (!Number.isFinite(ts)) return false;
	const nowSec = (opts.now ?? Date.now()) / 1000;
	if (Math.abs(nowSec - ts) > (opts.toleranceSec ?? 300)) return false;

	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(opts.signingSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${opts.timestamp}:${opts.rawBody}`));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return timingSafeEqual(`v0=${hex}`, opts.signature);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

export type SlackInbound =
	| { kind: "challenge"; challenge: string }
	| { kind: "event"; eventId: string; message: string; channel: string; team: string; user: string }
	| { kind: "ignore" };

/**
 * Parse a Slack webhook payload into the action to take: answer the url_verification handshake, drive a run
 * for a user message/app_mention, or ignore (bot echoes, other event types). Bot/self messages are dropped
 * to avoid loops.
 */
export function parseSlackPayload(payload: unknown): SlackInbound {
	if (!payload || typeof payload !== "object") return { kind: "ignore" };
	const p = payload as Record<string, any>;

	if (p.type === "url_verification" && typeof p.challenge === "string") {
		return { kind: "challenge", challenge: p.challenge };
	}
	if (p.type !== "event_callback" || !p.event || typeof p.event !== "object") {
		return { kind: "ignore" };
	}
	const e = p.event as Record<string, any>;
	const isUserMessage =
		(e.type === "message" || e.type === "app_mention") &&
		typeof e.text === "string" &&
		e.text.length > 0 &&
		!e.bot_id &&
		e.subtype === undefined; // skip edits/joins/bot subtypes
	if (!isUserMessage) return { kind: "ignore" };

	return {
		kind: "event",
		eventId: typeof p.event_id === "string" ? p.event_id : `${e.channel}:${e.ts}`,
		message: e.text,
		channel: typeof e.channel === "string" ? e.channel : "unknown",
		team: typeof p.team_id === "string" ? p.team_id : "unknown",
		user: typeof e.user === "string" ? e.user : "unknown",
	};
}

/** Map a Slack event onto the (instanceId, sessionName) addressing tuple — one session per channel. */
export function slackSessionRef(team: string, channel: string): { instanceId: string; sessionName: string } {
	return { instanceId: `slack:${team}`, sessionName: `slack:${channel}` };
}

/** The provider-scoped dedup key for an inbound event (idempotent webhook handling, doc 06 P11). */
export function slackDedupKey(eventId: string): string {
	return `webhook:slack:${eventId}`;
}
