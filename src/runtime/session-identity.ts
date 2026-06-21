// Ported from flue · @flue/runtime · packages/runtime/src/session-identity.ts → @cove/runtime
// Task-session naming + reservation, plus the subagent-delegation guards. Cove addresses sessions by the
// (instanceId, harnessName, sessionName) tuple in the `sessions` table, so flue's storage-key string
// helpers (createSessionStorageKey / childTaskSessionStorageKey) are NOT ported — the cascade walks the
// taskSessions refs by tuple instead (doc 04 "Subagents / task delegation"). '[flue]' → '[cove]'.
//
// Pure / V8-safe.

import { SubagentNotDeclaredError, TaskDepthExceededError } from "./errors.ts";

const TASK_SESSION_PREFIX = "task:";

/** Defense-in-depth ceiling on nested task delegation (doc 04). */
export const MAX_TASK_DEPTH = 8;

/** A `task:`-prefixed name is a reserved delegated-task session, not a user session. */
export function isTaskSessionName(name: string): boolean {
	return name.startsWith(TASK_SESSION_PREFIX);
}

/** Reject user session names that collide with the reserved delegated-task namespace. */
export function assertPublicSessionName(name: string): void {
	if (isTaskSessionName(name)) {
		throw new Error('[cove] Session names beginning with "task:" are reserved for delegated tasks.');
	}
}

/** Reserved child-session name for a delegated task: `task:<parentSession>:<taskId>`. */
export function createTaskSessionName(parentSession: string, taskId: string): string {
	return `${TASK_SESSION_PREFIX}${parentSession}:${taskId}`;
}

/** Throw {@link TaskDepthExceededError} when nesting would exceed the ceiling (doc 04). */
export function assertTaskDepth(depth: number, max = MAX_TASK_DEPTH): void {
	if (depth >= max) throw new TaskDepthExceededError(max);
}

/** Throw {@link SubagentNotDeclaredError} when a task targets a subagent the profile never declared. */
export function assertSubagentDeclared(
	name: string | undefined,
	declared: readonly string[],
): void {
	if (name === undefined) return; // the default (unnamed) subagent is always allowed
	if (!declared.includes(name)) throw new SubagentNotDeclaredError(name);
}
