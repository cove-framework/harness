// Ported from flue · @flue/teams · packages/teams/src/auth.ts → @cove/channels (teams). Bot Framework JWT
// verification via jose (Web-Crypto based — runs in the V8 httpAction; no "use node"). Enforces issuer +
// audience (the bot appId) + RS256, and surfaces the `serviceurl` claim for the reply address. The JWKS is
// discovered from the Bot Framework OpenID config and cached PER-PROCESS (re-discovered on a cold action —
// not durable, mirrors the MCP pool caveat). A test seam injects a local key so the verifier runs offline.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** A verification key accepted by jose v6 (Web Crypto key, raw secret, or a JWKS resolver). */
type TeamsKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";

let cachedJwks: JWTVerifyGetKey | undefined; // per-process JWKS resolver
let testKey: TeamsKey | undefined; // test seam

/** Test seam: verify against a local key/keyset instead of the remote JWKS (offline tests). */
export function __setTeamsKeyForTests(key: TeamsKey | undefined): void {
	testKey = key;
}

export interface TeamsVerifyResult {
	ok: boolean;
	serviceUrl?: string;
	reason?: string;
}

async function getKey(): Promise<TeamsKey> {
	if (testKey) return testKey;
	if (!cachedJwks) {
		const res = await fetch(OPENID_CONFIG_URL);
		const cfg = (await res.json()) as { jwks_uri: string };
		cachedJwks = createRemoteJWKSet(new URL(cfg.jwks_uri));
	}
	return cachedJwks;
}

/** Verify a Bot Framework token: issuer + audience(appId) + RS256. Returns the serviceUrl on success. */
export async function verifyTeamsToken(token: string, appId: string): Promise<TeamsVerifyResult> {
	try {
		const key = await getKey();
		const { payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], {
			issuer: BOT_FRAMEWORK_ISSUER,
			audience: appId,
			algorithms: ["RS256"],
		});
		return {
			ok: true,
			serviceUrl: typeof payload.serviceurl === "string" ? payload.serviceurl : undefined,
		};
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
}
