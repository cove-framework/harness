// cli-smoke fixture (G2.4 acceptance) — the PRE-PATCH convex/http.ts (a P8-shaped router carrying the
// `POST /workflows/:name` 404 stub). `cove build` codegen patches this file in place: it prepends the two
// _cove resolver imports and replaces the workflow 404 stub with a getRegisteredWorkflow lookup +
// submitWorkflow (kind:"workflow"). NOTE: `./_generated/*` is produced by `convex dev`/`convex codegen`;
// this file type-checks only inside a generated Convex project (the live acceptance path).
import "./_cove/agentResolver.ts";
import { getRegisteredWorkflow } from "./_cove/workflowResolver.ts";
import { httpRouter } from "convex/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, httpAction } from "./_generated/server";
import {
	InvalidRequestError,
	renderHttpError,
	RunNotFoundError,
	WorkflowNotFoundError,
} from "../../../../src/runtime/http.ts";
import { runAuthorize } from "../../../../convex/auth.ts";

const http = httpRouter();

function pathSegments(req: Request): string[] {
	return new URL(req.url).pathname.split("/").filter(Boolean);
}

// GET /runs/:runId
http.route({
	pathPrefix: "/runs/",
	method: "GET",
	handler: httpAction(async (ctx: ActionCtx, req) => {
		try {
			const runId = pathSegments(req)[1];
			if (!runId) throw new InvalidRequestError("expected /runs/:runId");
			await runAuthorize(ctx, req);
			const snap = await ctx.runQuery(api.requests.get, { requestId: runId as Id<"agentRequests"> });
			if (!snap) throw new RunNotFoundError(runId);
			return Response.json(snap);
		} catch (err) {
			const { status, body } = renderHttpError(err);
			return Response.json(body, { status });
		}
	}),
});

// POST /workflows/:name — 404 stub (replaced by cove codegen).
// cove:workflow-route (auto-generated)
// POST /workflows/:name — resolve the declared workflow handler (getRegisteredWorkflow, installed by the
// agent/workflow resolvers imported at module top) and admit a distinct kind:"workflow" run (D18). An
// unknown workflow still returns WorkflowNotFoundError (the live envelope). Patched by cove codegen.
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

export default http;
