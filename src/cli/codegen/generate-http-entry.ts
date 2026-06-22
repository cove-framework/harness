// New (Convex backend) · @cove/cli — http entry codegen.
// Mirrors flue · @flue/cli · build-plugin-node.ts's app.ts-wins branch (lines 248–264), re-targeted at the
// Convex `httpRouter`. The Hono `serve()`/coordinator/IPC template is DROPPED wholesale — Convex owns the
// server; here we only PATCH the already-shipped `convex/http.ts` (P8) to install the seams + bind the
// workflow route.
//
// Two modes:
//   1. validate-don't-overwrite — when `convex/app.ts` exists OR `convex/http.ts` carries a
//      `// cove:user-authored` marker, the user owns the router. We only ASSERT (and, when safe, ADD) the
//      two sidecar resolver side-effect imports so the seams still install; we never rewrite their routes.
//   2. patch/emit — otherwise: prepend the two resolver imports and replace the `POST /workflows/:name`
//      404 stub (http.ts:124–134) with a getRegisteredWorkflow lookup + submitWorkflow (kind:"workflow").
//
// Content-compared before writing (idempotent). The emitted/patched file stays PURE: no "use node".

import * as fs from "node:fs";
import * as path from "node:path";
import { writeIfChanged } from "./write-if-changed.ts";

export const USER_AUTHORED_MARKER = "// cove:user-authored";

const AGENT_RESOLVER_IMPORT = `import "./_cove/agentResolver.ts";`;
const WORKFLOW_RESOLVER_IMPORT = `import "./_cove/workflowResolver.ts";`;
const RESOLVER_IMPORTS_BLOCK = `${AGENT_RESOLVER_IMPORT}\n${WORKFLOW_RESOLVER_IMPORT}`;

export interface GenerateHttpEntryResult {
	path: string;
	changed: boolean;
	/** "patched" (cove owns the route) or "validated" (user-authored, imports ensured). */
	mode: "patched" | "validated";
}

export interface GenerateHttpEntryOptions {
	/** Absolute Convex app dir. */
	convexDir: string;
}

/**
 * Patch (or validate) `convex/http.ts` so the seams install + the workflow route
 * binds. Returns the path + whether the file changed + which mode ran.
 */
export function generateHttpEntry(opts: GenerateHttpEntryOptions): GenerateHttpEntryResult {
	const httpPath = path.join(opts.convexDir, "http.ts");
	const appPath = path.join(opts.convexDir, "app.ts");
	if (!fs.existsSync(httpPath)) {
		throw new Error(`[cove] failed to patch ${httpPath}: convex/http.ts not found.`);
	}
	const original = fs.readFileSync(httpPath, "utf-8");
	const userAuthored = fs.existsSync(appPath) || original.includes(USER_AUTHORED_MARKER);

	if (userAuthored) {
		// validate-don't-overwrite: only ensure the resolver side-effect imports are
		// present (so the seams install) — never touch the user's routes.
		const patched = ensureResolverImports(original);
		const changed = writeIfChanged(httpPath, patched);
		return { path: httpPath, changed, mode: "validated" };
	}

	const withImports = ensureResolverImports(original);
	// The patched route calls getRegisteredWorkflow, so promote the workflow
	// side-effect import to a named import (the module still loads → seam installs).
	const withNamedImport = ensureNamedWorkflowImport(withImports);
	const withRoute = patchWorkflowRoute(withNamedImport);
	const changed = writeIfChanged(httpPath, withRoute);
	return { path: httpPath, changed, mode: "patched" };
}

/** Prepend the two resolver side-effect imports if absent (idempotent, byte-stable). */
export function ensureResolverImports(source: string): string {
	const hasAgent = source.includes(AGENT_RESOLVER_IMPORT);
	// The workflow resolver may already have been promoted to the NAMED import form by a prior
	// ensureNamedWorkflowImport pass — treat that as present too, or a re-run double-adds it (non-idempotent).
	const hasWorkflow = source.includes(WORKFLOW_RESOLVER_IMPORT) || hasNamedWorkflowImport(source);
	if (hasAgent && hasWorkflow) return source;

	// Insert the block immediately after the file's leading reference-header comment
	// block (the run of `//` lines at the top), before the first import — so the
	// seams install at the very top of module load.
	const lines = source.split("\n");
	let insertAt = 0;
	while (insertAt < lines.length) {
		const line = lines[insertAt] ?? "";
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed === "") {
			insertAt++;
			continue;
		}
		break;
	}
	const block: string[] = [];
	if (!hasAgent) block.push(AGENT_RESOLVER_IMPORT);
	if (!hasWorkflow) block.push(WORKFLOW_RESOLVER_IMPORT);
	lines.splice(insertAt, 0, ...block);
	return lines.join("\n");
}

/**
 * Replace the `POST /workflows/:name` 404 stub with a getRegisteredWorkflow lookup
 * + submitWorkflow (kind:"workflow"). Idempotent: if the patched route is already
 * present (detected by the marker), returns the source unchanged.
 */
export function patchWorkflowRoute(source: string): string {
	if (source.includes(PATCHED_ROUTE_MARKER)) return source;

	const stubStart = source.indexOf('pathPrefix: "/workflows/"');
	if (stubStart === -1) {
		// No workflow route present at all — leave the file as-is (the seams import
		// still installs the registry; a user-authored router would own routing).
		return source;
	}
	// Find the enclosing `http.route({ ... });` block. Walk back to the
	// `http.route({` that owns this pathPrefix, then forward to its matching `});`.
	const routeStart = source.lastIndexOf("http.route({", stubStart);
	if (routeStart === -1) return source;
	const routeEnd = findRouteEnd(source, routeStart);
	if (routeEnd === -1) return source;

	// Preserve the leading line comment(s) immediately above the route, if any, by
	// replacing from `routeStart` only (the P8 comment above the stub is left in
	// place — it documents the route's history).
	const before = source.slice(0, routeStart);
	const after = source.slice(routeEnd);
	return `${before}${PATCHED_ROUTE_SOURCE}${after}`;
}

const PATCHED_ROUTE_MARKER = "// cove:workflow-route (auto-generated)";

// The replacement route — mirrors the proven cove-harness convex/http.ts workflow route. Type-checks against
// P8's http.ts: `pathSegments`, `runAuthorize`, `renderHttpError`, `WorkflowNotFoundError`,
// `InvalidRequestError` are already imported there; `getRegisteredWorkflow` comes from the named import added
// when patching; `api.invoke.submit.submitWorkflow` is the consumption-half mutation that admits a distinct
// kind:"workflow" run (D18). An empty/absent body is allowed; an unknown workflow → WorkflowNotFoundError.
const PATCHED_ROUTE_SOURCE = `${PATCHED_ROUTE_MARKER}
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
`;

/**
 * Whether `convex/http.ts` already imports `getRegisteredWorkflow` from the
 * sidecar resolver. The patch needs it; we add the named import alongside the
 * side-effect import when patching the route.
 */
function hasNamedWorkflowImport(source: string): boolean {
	return /import\s*\{[^}]*getRegisteredWorkflow[^}]*\}\s*from\s*["']\.\/_cove\/workflowResolver\.ts["']/.test(
		source,
	);
}

/** Add `import { getRegisteredWorkflow } from "./_cove/workflowResolver.ts";` if absent. */
export function ensureNamedWorkflowImport(source: string): string {
	if (hasNamedWorkflowImport(source)) return source;
	// Replace the side-effect workflow import with the named form (keeps a single
	// import statement; the side effect still runs because the module is loaded).
	if (source.includes(WORKFLOW_RESOLVER_IMPORT)) {
		return source.replace(
			WORKFLOW_RESOLVER_IMPORT,
			`import { getRegisteredWorkflow } from "./_cove/workflowResolver.ts";`,
		);
	}
	return source;
}

/** Find the index just past the `});` that closes the `http.route({` at `start`. */
function findRouteEnd(source: string, start: number): number {
	let depth = 0;
	let inString: '"' | "'" | "`" | null = null;
	let i = source.indexOf("{", start);
	if (i === -1) return -1;
	for (; i < source.length; i++) {
		const ch = source[i];
		const prev = source[i - 1];
		if (inString) {
			if (ch === inString && prev !== "\\") inString = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				// consume the trailing `)` `;` and a newline if present.
				let j = i + 1;
				while (j < source.length && (source[j] === ")" || source[j] === ";")) j++;
				if (source[j] === "\n") j++;
				return j;
			}
		}
	}
	return -1;
}
