"use node";
// engine/dispatchTools (doc 04) · @cove/runtime — run a step's tool calls, parallel/idempotent/cancel-aware.
// Wires the pure dispatch core (dispatch.ts) to Convex: resolve the session sandbox, rebuild the executable
// tools from the frozen descriptors (buildTools), run them. `task` tool-calls are partitioned out and
// delegated to a child agentRun (its own durable workflow), polled to terminal, and fed back as the parent's
// task tool-result (doc 04 "Subagents / task delegation") — the non-task path is unchanged. P4 default
// sandbox is the in-process local bash adapter (no external creds); the box swaps in via the SandboxFactory
// seam. "use node": resolves the sandbox (node child_process/fs) + starts the child workflow.

import { mkdir } from "node:fs/promises";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import type { SessionEnv, ToolDefinition } from "../../src/runtime/types.ts";
import { getRegisteredTool } from "../../src/runtime/tool-registry.ts";
// Side-effect: install the tool registry so getRegisteredTool(name) recovers user-tool execute closures in
// this isolate (pragmatic-refactor Phase 3). codegen emits this from convex/toolRegistry.ts.
import "../_cove/toolResolver.ts";
// Side-effect: install the extension registry so bindManifest can recover hook closures (Phase 5b).
import "../_cove/extensionResolver.ts";
import { getRegisteredExtension } from "../../src/runtime/extensions/registry.ts";
import { bindManifest } from "../../src/runtime/extensions/apply.ts";
import type { ExtensionContext } from "../../src/runtime/extensions/types.ts";
import { emitFromAction } from "../events/emit.ts";

/** Content-mutation hooks are PURE — a no-op appendEntry enforces that tool_call/tool_result don't persist. */
const PURE_HOOK_CONTEXT: ExtensionContext = { appendEntry: () => {}, getContextUsage: () => undefined };
import { resolveMcpTool } from "../mcp/pool.ts";
import { localBash } from "../sandbox/localBash.ts";
import { buildExecutableTools, wrapToolsWithHooks } from "./buildTools.ts";
import { runDispatch } from "./dispatch.ts";
import { createResultToolsFromJsonSchema } from "./resultTools.ts";
import { formatTaskResult } from "./task.ts";
import type { ToolCallRecord, ToolResultRecord } from "./types.ts";

const CHILD_POLL_INTERVAL_MS = 500;
// Bounded below the action stream budget (~240s); a child that outlives it yields a not-completed result.
const CHILD_POLL_DEADLINE_MS = 200_000;

async function resolveSandbox(sessionId: string, cwd: string | undefined): Promise<SessionEnv> {
	const workspace = cwd ?? `/tmp/cove-workspace/${sessionId}`;
	await mkdir(workspace, { recursive: true });
	const factory = localBash({ cwd: workspace });
	return factory.createSessionEnv({ id: sessionId });
}

/**
 * Delegate one task() call to a child agentRun (idempotent by the child's deterministic submissionId): create
 * the child request, start its workflow if not already started, poll it to terminal, and write its final
 * answer back as the parent's task tool-result. A depth/declaration guard failure becomes an error
 * tool-result, never a crash.
 */
async function runTaskDelegation(
	ctx: ActionCtx,
	parentRequestId: Id<"agentRequests">,
	stepNumber: number,
	call: ToolCallRecord,
	appendToolResult: (r: ToolResultRecord) => Promise<void>,
): Promise<void> {
	const prompt = typeof call.args.prompt === "string" ? call.args.prompt : "";
	const agent = typeof call.args.agent === "string" ? call.args.agent : undefined;

	let childRequestId: Id<"agentRequests">;
	let sessionName: string;
	try {
		// createChildRequest also starts the child's durable workflow (idempotent by submissionId).
		const created = await ctx.runMutation(internal.engine.task.createChildRequest, {
			parentRequestId,
			toolCallId: call.toolCallId,
			prompt,
			agent,
		});
		childRequestId = created.childRequestId;
		sessionName = created.sessionName;
	} catch (err) {
		await appendToolResult({
			toolCallId: call.toolCallId,
			toolName: "task",
			result: {
				content: [{ type: "text", text: `[cove] ${err instanceof Error ? err.message : String(err)}` }],
				isError: true,
			},
			isError: true,
		});
		return;
	}

	const deadline = Date.now() + CHILD_POLL_DEADLINE_MS;
	let snap = await ctx.runQuery(internal.engine.task.getChildResult, { requestId: childRequestId });
	while (
		snap &&
		snap.status !== "completed" &&
		snap.status !== "failed" &&
		snap.status !== "cancelled" &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, CHILD_POLL_INTERVAL_MS));
		snap = await ctx.runQuery(internal.engine.task.getChildResult, { requestId: childRequestId });
	}

	const result = formatTaskResult(snap, call.toolCallId, sessionName);
	await appendToolResult({ toolCallId: call.toolCallId, toolName: "task", result, isError: result.isError });
}

/** Resolve an activate_skill call from the catalog (a Convex query, never the box — doc 08 §3 / D13). */
async function runActivateSkill(
	ctx: ActionCtx,
	call: ToolCallRecord,
	appendToolResult: (r: ToolResultRecord) => Promise<void>,
): Promise<void> {
	const name = typeof call.args.name === "string" ? call.args.name : "";
	const skill = await ctx.runQuery(api.skills.getSkill, { name });
	const result = skill
		? { content: [{ type: "text" as const, text: skill.instructions }], details: { skill: name } }
		: {
				content: [{ type: "text" as const, text: `[cove] skill "${name}" not found in the catalog.` }],
				isError: true,
			};
	await appendToolResult({
		toolCallId: call.toolCallId,
		toolName: "activate_skill",
		result,
		isError: !skill,
	});
}

export const run = internalAction({
	args: { requestId: v.id("agentRequests"), stepNumber: v.number() },
	handler: async (ctx, { requestId, stepNumber }): Promise<void> => {
		const plan = await ctx.runQuery(internal.engine.requests.getRunPlanContext, { requestId });
		const step = await ctx.runQuery(internal.engine.steps.byRequestStep, { requestId, stepNumber });
		// Skip calls that already have a result — HITL-rejected calls (result pre-written by applyApproval)
		// and any already-dispatched call on a replay (idempotency).
		const resultedIds = new Set(
			((step?.toolResults ?? []) as ToolResultRecord[]).map((r) => r.toolCallId),
		);
		const toolCalls = ((step?.toolCalls ?? []) as ToolCallRecord[]).filter(
			(c) => !resultedIds.has(c.toolCallId),
		);
		if (toolCalls.length === 0) return;

		const taskCalls = toolCalls.filter((c) => c.toolName === "task");
		const skillCalls = toolCalls.filter((c) => c.toolName === "activate_skill");
		const otherCalls = toolCalls.filter(
			(c) => c.toolName !== "task" && c.toolName !== "activate_skill",
		);

		const isCancelled = async (): Promise<boolean> =>
			(await ctx.runQuery(internal.engine.steps.requestStatus, { requestId })) === "cancelled";
		const appendToolResult = async (r: ToolResultRecord): Promise<void> => {
			await ctx.runMutation(internal.engine.steps.appendToolResult, {
				requestId,
				stepNumber,
				toolCallId: r.toolCallId,
				toolName: r.toolName,
				result: r.result,
				isError: r.isError,
			});
			// Emit the terminal tool event (G2.1) — redacted result, reconciled by toolCallId on the consumer.
			await emitFromAction(ctx, {
				type: "tool",
				toolName: r.toolName,
				toolCallId: r.toolCallId,
				isError: r.isError ?? false,
				result: r.result,
				durationMs: 0,
				instanceId: plan.instanceId,
				submissionId: plan.submissionId,
				session: plan.sessionName,
				turnId: `${requestId}:${stepNumber}`,
			});
		};

		// Non-task tools run against the sandbox (the original, unchanged dispatch path).
		if (otherCalls.length > 0) {
			const env = await resolveSandbox(plan.sessionId, plan.cwd);
			const resultBundle =
				plan.resultSchema !== undefined ? createResultToolsFromJsonSchema(plan.resultSchema) : undefined;
			// mcpResolve binds kind:"mcp" descriptors to a network client per beat (G2.2); supplied only here
			// (the "use node" action), so buildExecutableTools stays pure for llmStep's model view.
			// Recover user-tool execute closures by NAME from the tool registry (initialize-free; the closure
			// can't cross the journal). Unresolved names stay errorTool stubs (pragmatic-refactor Phase 3).
			const userTools = new Map<string, ToolDefinition>();
			for (const d of plan.tools) {
				if (d.kind !== "user") continue;
				const def = getRegisteredTool(d.name);
				if (def) userTools.set(d.name, def);
			}
			// Bind the frozen manifest's named extensions once (pragmatic-refactor Phase 5b): recovers hook
			// closures AND extension-contributed tool closures. Extension tools are added to userTools so the
			// frozen kind:"user" descriptors (frozen at setup) resolve to the extension's execute. Replay-safe
			// (dispatch action is journaled; bind/hooks run only on the live execution).
			let hooks: Awaited<ReturnType<typeof bindManifest>>["hooks"] | undefined;
			if (plan.extensions.length > 0) {
				const bound = await bindManifest(plan.extensions, getRegisteredExtension);
				hooks = bound.hooks;
				for (const [name, tool] of bound.tools) {
					if (!userTools.has(name)) userTools.set(name, tool);
				}
			}
			let executable = buildExecutableTools(plan.tools, {
				env,
				userTools,
				resultBundle,
				mcpResolve: resolveMcpTool,
			});
			if (hooks) executable = wrapToolsWithHooks(executable, hooks, PURE_HOOK_CONTEXT);
			await runDispatch(otherCalls, executable, { isCancelled, appendToolResult });
		}

		// task() calls spawn child agentRuns (nested workflows) and feed their answers back.
		for (const call of taskCalls) {
			if (await isCancelled()) break;
			await runTaskDelegation(ctx, requestId, stepNumber, call, appendToolResult);
		}

		// activate_skill calls resolve the skill's instructions from the catalog (a query, not the box).
		for (const call of skillCalls) {
			if (await isCancelled()) break;
			await runActivateSkill(ctx, call, appendToolResult);
		}

		// Append the ordered tool-result entries to the session (canonical history for the next decode).
		await ctx.runMutation(internal.sessions.store.appendToolResults, {
			sessionId: plan.sessionId,
			requestId,
			stepNumber,
		});
	},
});
