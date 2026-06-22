// New (Convex backend) · @cove/runtime — the shared inbound pipeline (doc 06 P11 / D3 / D14). One V8
// httpAction body for every channel: read raw bytes ONCE → runAuthorize (the framework gate — the closed
// gap where /channels/slack skipped it) → adapter.verify (raw-bytes signature) → handshake/ignore
// short-circuits (no admission) → dedup (before submit) → submitPrompt → ack. No box, no LLM, no "use node":
// the route admits + acks; the run + reply happen elsewhere.

import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { InvalidJsonError, renderHttpError, UnauthorizedError } from "../../src/runtime/http.ts";
import { runAuthorize } from "../auth.ts";
import { dedupKey } from "./dedup.ts";
import type { ChannelAdapter } from "./types.ts";

/** Verify → authorize → dedup → admit a single channel webhook. Renders failures onto the CoveApiError envelope. */
export async function verifyThenAdmit(
	ctx: ActionCtx,
	adapter: ChannelAdapter,
	req: Request,
): Promise<Response> {
	try {
		// 1. Raw bytes once — HMAC/Ed25519/JWT verify over the exact bytes (re-serialized JSON breaks it).
		const rawBody = await req.text();

		// 2. Framework gate (D3): the authorize hook runs before any verification or admission.
		await runAuthorize(ctx, req);

		// 3. Channel signature/JWT verification over the raw bytes. Failure → 401, no admission.
		const verdict = await adapter.verify(req, rawBody);
		if (!verdict.ok) {
			throw new UnauthorizedError(verdict.message ?? `[cove] invalid ${adapter.name} request signature.`);
		}

		// 4. Map the payload. handshake → echo (no admission); ignore → 200 no-op (bot echo / non-message).
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			throw new InvalidJsonError();
		}
		const mapped = adapter.mapPayload(parsed, req);
		if (mapped.kind === "handshake") return Response.json(mapped.body);
		if (mapped.kind === "ignore") return new Response("ok");

		// 5. Dedup BEFORE admission — a replayed delivery never spawns a second run.
		const { isNew } = await ctx.runMutation(internal.channels.dedup.markWebhookSeen, {
			key: dedupKey(adapter.name, mapped.spec.eventId),
		});
		if (!isNew) return new Response("ok (duplicate)");

		// 6. Admit. The reply address rides on the request row (replyContext); the reply fires after terminal.
		await ctx.runMutation(api.invoke.submit.submitPrompt, {
			prompt: mapped.spec.message,
			instanceId: mapped.spec.instanceId,
			sessionName: mapped.spec.sessionName,
			model: mapped.spec.model,
			replyContext: mapped.spec.replyContext,
		});
		return new Response("ok");
	} catch (err) {
		const { status, body } = renderHttpError(err);
		return Response.json(body, { status });
	}
}
