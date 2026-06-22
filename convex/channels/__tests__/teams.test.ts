// New · @cove/runtime — G2.3: Teams adapter (the JWT shared-contract proof). Uses an injected local RS256 key
// (jose generateKeyPair) so the Bot Framework token verifier runs offline.
import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setTeamsKeyForTests } from "../teams/auth.ts";
import { teamsAdapter } from "../teams/index.ts";

const ISSUER = "https://api.botframework.com";
const APP_ID = "app-123";

let privateKey: CryptoKey;

beforeEach(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey as CryptoKey;
	__setTeamsKeyForTests(pair.publicKey);
	process.env.TEAMS_APP_ID = APP_ID;
});
afterEach(() => {
	__setTeamsKeyForTests(undefined);
});

async function token(audience: string): Promise<string> {
	return new SignJWT({ serviceurl: "https://smba.trafficmanager.net/teams/" })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer(ISSUER)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);
}

function bearer(jwt: string): Request {
	return new Request("https://x.convex.site/channels/teams", {
		method: "POST",
		headers: { authorization: `Bearer ${jwt}` },
	});
}

describe("teamsAdapter.verify (JWT)", () => {
	it("accepts a token with the correct issuer + audience", async () => {
		const r = await teamsAdapter.verify(bearer(await token(APP_ID)), "{}");
		expect(r).toEqual({ ok: true });
	});
	it("rejects a token with the wrong audience", async () => {
		const r = await teamsAdapter.verify(bearer(await token("someone-else")), "{}");
		expect(r.ok).toBe(false);
	});
	it("rejects a request with no bearer token", async () => {
		const r = await teamsAdapter.verify(new Request("https://x/channels/teams", { method: "POST" }), "{}");
		expect(r.ok).toBe(false);
	});
});

describe("teamsAdapter.mapPayload", () => {
	it("maps a message activity to a submit and ignores non-message activities", () => {
		const submit = teamsAdapter.mapPayload(
			{
				type: "message",
				id: "a1",
				text: "hello",
				conversation: { id: "conv-1" },
				serviceUrl: "https://smba/",
				channelId: "msteams",
			},
			new Request("https://x/channels/teams", { method: "POST" }),
		);
		expect(submit.kind).toBe("submit");
		if (submit.kind !== "submit") throw new Error("unreachable");
		expect(submit.spec.message).toBe("hello");
		expect(submit.spec.replyContext).toMatchObject({ provider: "teams", responseUrl: "https://smba/" });

		const ignore = teamsAdapter.mapPayload(
			{ type: "conversationUpdate" },
			new Request("https://x/channels/teams", { method: "POST" }),
		);
		expect(ignore.kind).toBe("ignore");
	});
});
