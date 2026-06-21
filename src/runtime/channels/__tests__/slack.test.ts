// Tests for the pure Slack channel logic (src/runtime/channels/slack.ts).
import { describe, expect, it } from "vitest";
import { parseSlackPayload, slackDedupKey, slackSessionRef, verifySlackSignature } from "../slack.ts";

const SECRET = "test-signing-secret";

/** Compute a valid Slack signature for a (timestamp, body) the way Slack does. */
async function sign(timestamp: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`));
	return `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("verifySlackSignature", () => {
	it("accepts a correctly signed, fresh request", async () => {
		const ts = "1700000000";
		const body = '{"type":"event_callback"}';
		const signature = await sign(ts, body);
		const ok = await verifySlackSignature({
			signingSecret: SECRET,
			timestamp: ts,
			rawBody: body,
			signature,
			now: 1700000000_000,
		});
		expect(ok).toBe(true);
	});

	it("rejects a tampered signature, wrong body, and a stale timestamp", async () => {
		const ts = "1700000000";
		const body = '{"a":1}';
		const good = await sign(ts, body);
		expect(
			await verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: body, signature: `v0=${"0".repeat(64)}`, now: 1700000000_000 }),
		).toBe(false);
		expect(
			await verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: '{"a":2}', signature: good, now: 1700000000_000 }),
		).toBe(false);
		// stale: now is 1 hour later than the signed timestamp
		expect(
			await verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: body, signature: good, now: 1700003600_000 }),
		).toBe(false);
	});
});

describe("parseSlackPayload", () => {
	it("returns the challenge for url_verification", () => {
		expect(parseSlackPayload({ type: "url_verification", challenge: "abc" })).toEqual({
			kind: "challenge",
			challenge: "abc",
		});
	});

	it("maps a user message event_callback to an event", () => {
		const out = parseSlackPayload({
			type: "event_callback",
			event_id: "Ev123",
			team_id: "T1",
			event: { type: "message", text: "hi cove", channel: "C1", user: "U1" },
		});
		expect(out).toEqual({ kind: "event", eventId: "Ev123", message: "hi cove", channel: "C1", team: "T1", user: "U1" });
	});

	it("ignores bot echoes, subtypes, and non-event payloads", () => {
		expect(parseSlackPayload({ type: "event_callback", event: { type: "message", text: "x", bot_id: "B1" } }).kind).toBe("ignore");
		expect(parseSlackPayload({ type: "event_callback", event: { type: "message", text: "x", subtype: "message_changed" } }).kind).toBe("ignore");
		expect(parseSlackPayload({ type: "something_else" }).kind).toBe("ignore");
		expect(parseSlackPayload(null).kind).toBe("ignore");
	});
});

describe("addressing + dedup keys", () => {
	it("derives a per-channel session ref and a provider dedup key", () => {
		expect(slackSessionRef("T1", "C1")).toEqual({ instanceId: "slack:T1", sessionName: "slack:C1" });
		expect(slackDedupKey("Ev123")).toBe("webhook:slack:Ev123");
	});
});
