// New (Convex backend) · @cove/runtime — the inspect surface for top-level runs (SDK `runs.get`/`listRuns`).
// get() mirrors the `runs` row as a RunRecord, falling back to the agentRequests point-in-time view (parity
// with requests.get + GET /runs/:runId, which treats runId as a requestId) when no runs row exists, and null
// when neither. NOTE: nothing writes the `runs` table yet — the run-row lifecycle writer is G2.4/D18. Until
// then get() serves the agentRequests fallback and listRuns() returns []. Documented, not silently broken
// (G2.1 Risks). No "use node".

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

type RunStatus = "running" | "completed" | "failed" | "cancelled";

interface RunRecord {
	runId: string;
	agentName: string;
	instanceId: string;
	status: RunStatus;
	payload?: unknown;
	result?: unknown;
	error?: string;
	startedAt: number;
	updatedAt: number;
}

function fromRunRow(row: Doc<"runs">): RunRecord {
	return {
		runId: row.runId,
		agentName: row.agentName,
		instanceId: row.instanceId,
		status: row.status,
		payload: row.payload,
		result: row.result,
		error: row.error,
		startedAt: row.startedAt,
		updatedAt: row.updatedAt,
	};
}

/** agentRequests `pending` has no run-level equivalent — surface it as `running`. */
function mapRequestStatus(status: Doc<"agentRequests">["status"]): RunStatus {
	return status === "pending" ? "running" : status;
}

export const get = query({
	args: { runId: v.string() },
	handler: async (ctx, { runId }): Promise<RunRecord | null> => {
		const row = await ctx.db
			.query("runs")
			.withIndex("by_run", (q) => q.eq("runId", runId))
			.first();
		if (row) return fromRunRow(row);

		// Fallback: treat runId as a requestId (parity with GET /runs/:runId). An invalid id throws → null.
		let req: Doc<"agentRequests"> | null;
		try {
			req = await ctx.db.get(runId as Id<"agentRequests">);
		} catch {
			req = null;
		}
		if (!req) return null;
		return {
			runId,
			agentName: "",
			instanceId: req.instanceId,
			status: mapRequestStatus(req.status),
			payload: req.input ?? undefined,
			result: req.result,
			error: req.error,
			startedAt: req.createdAt,
			updatedAt: req.updatedAt,
		};
	},
});

export const listRuns = query({
	args: {
		agentName: v.optional(v.string()),
		instanceId: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { agentName, instanceId, limit }): Promise<RunRecord[]> => {
		const take = limit ?? 50;
		let rows: Doc<"runs">[];
		if (agentName !== undefined) {
			rows = await ctx.db
				.query("runs")
				.withIndex("by_agent", (q) => q.eq("agentName", agentName))
				.order("desc")
				.take(take);
		} else if (instanceId !== undefined) {
			rows = await ctx.db
				.query("runs")
				.withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
				.order("desc")
				.take(take);
		} else {
			rows = await ctx.db.query("runs").order("desc").take(take);
		}
		return rows.map(fromRunRow);
	},
});
