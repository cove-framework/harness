// New (Convex backend) · @cove/runtime — the pluggable authorize hook (doc 05 "Auth"). Cove ships the hook
// but NO default provider: a user-supplied authorize(ctx, req) runs at admission and returns an identity or
// throws (→ 401). Module-scoped + last-write-wins; the generated app entry (P8.5) re-applies it per cold
// boot. None configured ⇒ open (the engine is otherwise gated by the deployment's Convex auth identity for
// native callers). No "use node".

import type { ActionCtx } from "./_generated/server";

export type AuthorizeHook = (ctx: ActionCtx, req: Request) => unknown | Promise<unknown>;

let authorizeHook: AuthorizeHook | undefined;

/** Install the authorize hook (or clear it with `undefined`). */
export function configureAuthorize(hook: AuthorizeHook | undefined): void {
	authorizeHook = hook;
}

/** Run the configured authorize hook at admission; a no-op (open) when none is installed. */
export async function runAuthorize(ctx: ActionCtx, req: Request): Promise<unknown> {
	if (!authorizeHook) return undefined;
	return authorizeHook(ctx, req);
}
