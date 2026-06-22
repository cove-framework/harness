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
// Side-effect + lookup: installs the workflow registry into this isolate so the /workflows route resolves a
// handler by name (G2.4). In a user project, cove codegen emits _cove/workflowResolver.ts.
import { getRegisteredWorkflow } from "./_cove/workflowResolver.ts";
import { channelRegistry } from "./channels/index.ts";
import { verifyThenAdmit } from "./channels/inbound.ts";
import {
	InvalidJsonError,
	InvalidRequestError,
	renderHttpError,
	RunNotFoundError,
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
				agent: segs[1], // the :name segment — setup resolves it via getRegisteredAgent (G2.4)
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

// POST /workflows/:name — first-class workflow surface (D18). Resolves the registered handler by name and
// admits a DISTINCT kind:"workflow" run (G2.4). An unknown workflow still returns WorkflowNotFoundError. The
// workflow registry is installed by the _cove/workflowResolver side-effect import above; cove codegen emits
// that resolver in a user project. The rich workflow-handler execution lands in G2.5.
http.route({
	pathPrefix: "/workflows/",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		try {
			const name = pathSegments(req)[1];
			if (!name) throw new InvalidRequestError("expected /workflows/:name");
			await runAuthorize(ctx, req);
			if (!getRegisteredWorkflow(name)) throw new WorkflowNotFoundError(name);
			let input: unknown;
			try {
				input = await req.json();
			} catch {
				input = undefined; // an empty/absent body is allowed
			}
			const admitted = await ctx.runMutation(api.invoke.submit.submitWorkflow, { name, input });
			return Response.json({
				sessionId: admitted.sessionId,
				requestId: admitted.requestId,
				submissionId: admitted.submissionId,
				runId: admitted.requestId,
			});
		} catch (err) {
			const { status, body } = renderHttpError(err);
			return Response.json(body, { status });
		}
	}),
});

// POST /channels/:name — inbound webhook (doc 06 P11). One generic route resolves the ChannelAdapter from the
// path segment and runs the shared pipeline (authorize → verify → dedup → submit → ack). The outbound reply
// is posted after the run terminalizes (convex/channels/reply.ts), never inside this ack window. An unknown
// channel → 404. The eight ship-first adapters live in convex/channels/<name>/.
http.route({
	pathPrefix: "/channels/",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		const name = pathSegments(req)[1];
		const adapter = name ? channelRegistry[name] : undefined;
		if (!adapter) {
			return Response.json(
				{ error: { code: "channel_not_found", message: `[cove] unknown channel "${name ?? ""}"` } },
				{ status: 404 },
			);
		}
		return verifyThenAdmit(ctx, adapter, req);
	}),
});

export default http;
