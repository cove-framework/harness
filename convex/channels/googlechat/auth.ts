// Ported from flue · @flue/google-chat · packages/google-chat/src/auth.ts → @cove/channels (google-chat). jose
// is loaded via a DYNAMIC import inside the verify path so the static V8 bundle stays jose-free. Verifies the
// Google-Chat-issued RS256 bearer JWT: issuer `chat@system.gserviceaccount.com` (overridable), audience = the
// numeric project number, signed by Google's chat service-account x509 certs (createRemoteJWKSet). A
// module-level `__testKey` seam lets tests inject a jose key/JWK so the verifier runs offline (no remote JWKS).
// Per-process caveat: each isolate builds its own remote JWKS cache; no cross-isolate sharing.

// Default issuer Google Chat stamps on interaction bearer tokens (the `project-number` auth mode in flue).
const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Chat service-account x509 cert endpoint (JWKS-compatible via createRemoteJWKSet's `jwk` toggle below).
const DEFAULT_CHAT_CERTS_URL =
	"https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";

// Test seam: a jose KeyLike / CryptoKey / JWK. When set, verify uses it instead of the remote JWKS.
let __testKey: unknown;
/** Inject a verification key (jose KeyLike/JWK) so token verification runs offline in tests. */
export function __setGoogleChatKeyForTests(k: unknown): void {
	__testKey = k;
}

export interface VerifyGoogleChatTokenOptions {
	/** Expected audience (numeric project number). Defaults to process.env.GOOGLE_CHAT_PROJECT_NUMBER. */
	audience?: string;
	/** Expected token issuer. Defaults to chat@system.gserviceaccount.com. */
	issuer?: string;
	/** Override the Google Chat certificate / JWKS URL (tests). */
	certsUrl?: string;
}

export type VerifyGoogleChatTokenResult = { ok: true } | { ok: false; reason: string };

// Lazily-built remote JWKS, keyed by URL, kept per isolate (jose caches HTTP + parsed keys internally).
let __remoteJwks: ((header: any, alg: any) => Promise<any>) | undefined;
let __remoteJwksUrl: string | undefined;

/**
 * Verify a Google Chat interaction bearer token (RS256). Returns `{ ok: true }` when the signature, issuer,
 * audience, and algorithm all check out, else `{ ok: false, reason }`. jose is dynamically imported here so it
 * never enters the static bundle. When `__setGoogleChatKeyForTests` has provided a key, that key is used in
 * place of the remote JWKS, making the verifier fully offline-testable.
 */
export async function verifyGoogleChatToken(
	token: string,
	opts: VerifyGoogleChatTokenOptions = {},
): Promise<VerifyGoogleChatTokenResult> {
	const audience = opts.audience ?? process.env.GOOGLE_CHAT_PROJECT_NUMBER;
	if (!audience) return { ok: false, reason: "missing audience (GOOGLE_CHAT_PROJECT_NUMBER unset)" };
	if (!token) return { ok: false, reason: "missing token" };
	const issuer = opts.issuer ?? GOOGLE_CHAT_ISSUER;

	try {
		const { jwtVerify, createRemoteJWKSet, importJWK } = await import("jose");

		const verifyOpts = { algorithms: ["RS256"], issuer, audience };

		// Offline test path: a caller-supplied key (KeyLike, CryptoKey, or a JWK object).
		if (__testKey !== undefined) {
			const key = isJwkObject(__testKey) ? await importJWK(__testKey as any, "RS256") : (__testKey as any);
			await jwtVerify(token, key as any, verifyOpts);
			return { ok: true };
		}

		// Live path: resolve Google Chat's signing keys from the remote cert endpoint.
		const url = opts.certsUrl ?? DEFAULT_CHAT_CERTS_URL;
		if (!__remoteJwks || __remoteJwksUrl !== url) {
			__remoteJwks = createRemoteJWKSet(new URL(url)) as any;
			__remoteJwksUrl = url;
		}
		await jwtVerify(token, __remoteJwks as any, verifyOpts);
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : "verification failed" };
	}
}

function isJwkObject(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>).kty === "string"
	);
}
