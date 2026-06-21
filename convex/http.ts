// New (Convex backend) · @cove/runtime — the HTTP submit/poll surface (doc 05 "Transport" / 06 P8). flue's
// Hono `flue()` app + Durable-Streams endpoints become a Convex httpRouter with NO streaming GET:
//   POST /agents/:name/:id            → { sessionId, requestId, submissionId }
//   POST /agents/:name/:id?wait=result→ poll to terminal, return the request snapshot
//   GET  /runs/:runId                 → the request record (point-in-time, not a stream)
//   POST /workflows/:name             → first-class workflow surface (D18); registry/codegen lands P8.5
// Each route runs the pluggable authorize hook and renders CoveHttpError onto the CoveApiError envelope.
// No "use node": httpActions only call mutations/queries (the box/AI work stays inside the engine actions).

import { httpRouter } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, httpAction } from "./_generated/server";
import {
	parseSlackPayload,
	slackDedupKey,
	slackSessionRef,
	verifySlackSignature,
} from "../src/runtime/channels/slack.ts";
import {
	InvalidJsonError,
	InvalidRequestError,
	renderHttpError,
	RunNotFoundError,
	UnauthorizedError,
	UnsupportedMediaTypeError,
	validateAgentRequest,
	WorkflowNotFoundError,
} from "../src/runtime/http.ts";
import { runAuthorize } from "./auth.ts";

const POLL_INTERVAL_MS = 400;
const POLL_DEADLINE_MS = 60_000;

const http = httpRouter();

function pathSegments(req: Request): string[] {
	return new URL(req.url).pathname.split("/").filter(Boolean);
}

async function pollTerminal(ctx: ActionCtx, requestId: Id<"agentRequests">) {
	const deadline = Date.now() + POLL_DEADLINE_MS;
	let snap = await ctx.runQuery(api.requests.get, { requestId });
	while (
		snap &&
		snap.status !== "completed" &&
		snap.status !== "failed" &&
		snap.status !== "cancelled" &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		snap = await ctx.runQuery(api.requests.get, { requestId });
	}
	return snap;
}

// POST /agents/:name/:id  (+ ?wait=result)
http.route({
	pathPrefix: "/agents/",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		try {
			const segs = pathSegments(req); // ["agents", name, id]
			const id = segs[2];
			if (!segs[1] || !id) throw new InvalidRequestError("expected /agents/:name/:id");
			if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
				throw new UnsupportedMediaTypeError();
			}
			let raw: unknown;
			try {
				raw = await req.json();
			} catch {
				throw new InvalidJsonError();
			}
			await runAuthorize(ctx, req);
			const { message, model, sessionName, resultSchema } = validateAgentRequest(raw);
			const admitted = await ctx.runMutation(api.invoke.submit.submitPrompt, {
				prompt: message,
				model,
				instanceId: id,
				sessionName: sessionName ?? "default",
				resultSchema,
			});
			if (new URL(req.url).searchParams.get("wait") === "result") {
				const snap = await pollTerminal(ctx, admitted.requestId);
				return Response.json({
					sessionId: admitted.sessionId,
					requestId: admitted.requestId,
					submissionId: admitted.submissionId,
					...snap,
				});
			}
			return Response.json({
				sessionId: admitted.sessionId,
				requestId: admitted.requestId,
				submissionId: admitted.submissionId,
			});
		} catch (err) {
			const { status, body } = renderHttpError(err);
			return Response.json(body, { status });
		}
	}),
});

// GET /runs/:runId
http.route({
	pathPrefix: "/runs/",
	method: "GET",
	handler: httpAction(async (ctx, req) => {
		try {
			const runId = pathSegments(req)[1];
			if (!runId) throw new InvalidRequestError("expected /runs/:runId");
			await runAuthorize(ctx, req);
			let snap: Awaited<ReturnType<typeof pollTerminal>> | null;
			try {
				snap = await ctx.runQuery(api.requests.get, { requestId: runId as Id<"agentRequests"> });
			} catch {
				throw new RunNotFoundError(runId);
			}
			if (!snap) throw new RunNotFoundError(runId);
			return Response.json(snap);
		} catch (err) {
			const { status, body } = renderHttpError(err);
			return Response.json(body, { status });
		}
	}),
});

// POST /workflows/:name — first-class (D18); the defineWorkflow registry + codegen land in P8.5, so until
// then an invoke resolves to WorkflowNotFoundError (the route + error envelope are live now).
http.route({
	pathPrefix: "/workflows/",
	method: "POST",
	handler: httpAction(async (_ctx, req) => {
		const name = pathSegments(req)[1] ?? "";
		const { status, body } = renderHttpError(new WorkflowNotFoundError(name));
		return Response.json(body, { status });
	}),
});

// POST /channels/slack — inbound webhook (doc 06 P11): answer the url_verification handshake, verify the
// signature, dedup the event, then map it onto a submit. Outbound reply (posting the run result back) needs
// the Slack bot token + a run-completion hook — the P11 remainder. Other channels follow this same shape.
http.route({
	path: "/channels/slack",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		try {
			const rawBody = await req.text();
			let payload: unknown;
			try {
				payload = JSON.parse(rawBody);
			} catch {
				throw new InvalidJsonError();
			}
			const parsed = parseSlackPayload(payload);
			if (parsed.kind === "challenge") {
				return Response.json({ challenge: parsed.challenge });
			}

			const secret = process.env.SLACK_SIGNING_SECRET;
			if (!secret) throw new UnauthorizedError("[cove] Slack signing secret not configured.");
			const verified = await verifySlackSignature({
				signingSecret: secret,
				timestamp: req.headers.get("x-slack-request-timestamp") ?? "",
				rawBody,
				signature: req.headers.get("x-slack-signature") ?? "",
			});
			if (!verified) throw new UnauthorizedError("[cove] invalid Slack signature.");

			if (parsed.kind === "ignore") return new Response("ok");

			// Idempotent dedup (replayed deliveries are no-ops).
			const { isNew } = await ctx.runMutation(internal.channels.markWebhookSeen, {
				key: slackDedupKey(parsed.eventId),
			});
			if (!isNew) return new Response("ok (duplicate)");

			const ref = slackSessionRef(parsed.team, parsed.channel);
			await ctx.runMutation(api.invoke.submit.submitPrompt, {
				prompt: parsed.message,
				instanceId: ref.instanceId,
				sessionName: ref.sessionName,
			});
			return new Response("ok");
		} catch (err) {
			const { status, body } = renderHttpError(err);
			return Response.json(body, { status });
		}
	}),
});

export default http;
