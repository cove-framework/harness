// New (Convex backend) · @cove/runtime
// Shared SessionStore persistence helpers (ctx-taking, not Convex functions themselves) so the engine's
// step finalize and the sessions mutations write the entry tree through ONE implementation. Realizes
// flue's SessionStore.save/load over Convex rows: load rebuilds + hydrates a SessionData; append is the
// O(new) diff-sync of canonical AgentMessage entries with content-addressed image hoisting + refCount.
//
// V8-safe: no "use node" (no box/AI SDK); uses Web Crypto getRandomValues (available in Convex mutations).

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { AgentMessage } from "../../src/runtime/messages.ts";
import type { SessionData, SessionEntry } from "../../src/runtime/types.ts";
import { defaultImageHash, extractEntryImages, hydrateEntryImages } from "./images.ts";

/** Generate a valid SessionData affinityKey (`aff_` + Crockford base32, first char 0-7). */
export function generateAffinityKey(): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	const bytes = new Uint8Array(26);
	crypto.getRandomValues(bytes);
	let s = alphabet[(bytes[0] as number) % 8] as string;
	for (let i = 1; i < 26; i++) s += alphabet[(bytes[i] as number) % 32];
	return `aff_${s}`;
}

/** Rebuild a hydrated SessionData v6 from the header + entry rows (image bytes reassembled). */
export async function loadSessionData(
	ctx: QueryCtx,
	sessionId: Id<"sessions">,
): Promise<SessionData | null> {
	const session = await ctx.db.get(sessionId);
	if (!session) return null;

	const rows = await ctx.db
		.query("sessionEntries")
		.withIndex("by_session_and_position", (q) => q.eq("sessionId", sessionId))
		.collect();
	rows.sort((a, b) => a.position - b.position);

	const hashes = new Set<string>();
	for (const r of rows) for (const h of r.imageAttachmentIds ?? []) hashes.add(h);
	const dataByHash = new Map<string, string>();
	for (const h of hashes) {
		const chunk = await ctx.db
			.query("imageChunks")
			.withIndex("by_hash", (q) => q.eq("hash", h))
			.unique();
		if (chunk?.data != null) dataByHash.set(h, chunk.data);
	}

	const entries = rows.map((r) => hydrateEntryImages(r.data as SessionEntry, dataByHash));
	return {
		version: 6,
		affinityKey: session.affinityKey,
		entries,
		leafId: session.leafId,
		taskSessions: session.taskSessions,
		metadata: (session.metadata ?? {}) as Record<string, unknown>,
		createdAt: new Date(session.createdAt).toISOString(),
		updatedAt: new Date(session.updatedAt).toISOString(),
	};
}

/**
 * Append a canonical AgentMessage as a session entry, idempotent by `entryId` (a deterministic id keyed
 * on the request/step/toolCall, so a workflow replay never double-appends). Hoists image bytes into
 * content-addressed imageChunks (refCount++ for each hash this entry references) and advances the leaf.
 */
/**
 * Persist extension-written `custom` side-state entries (pragmatic-refactor Phase 5b `appendEntry`). Shared by
 * the `appendCustomEntries` mutation and the engine's notify-firing sites (setup/finalize). Idempotent by the
 * caller-supplied deterministic `entryId`; does NOT advance `leafId` (side-state, excluded from LLM context).
 */
export async function persistCustomEntries(
	ctx: MutationCtx,
	sessionId: Id<"sessions">,
	entries: ReadonlyArray<{ entryId: string; customType: string; data?: unknown }>,
): Promise<void> {
	if (entries.length === 0) return;
	const session = await ctx.db.get(sessionId);
	if (!session) return;
	const last = await ctx.db
		.query("sessionEntries")
		.withIndex("by_session_and_position", (q) => q.eq("sessionId", sessionId))
		.order("desc")
		.first();
	let position = (last?.position ?? -1) + 1;
	const now = Date.now();
	for (const e of entries) {
		const existing = await ctx.db
			.query("sessionEntries")
			.withIndex("by_session_and_entry", (q) => q.eq("sessionId", sessionId).eq("entryId", e.entryId))
			.unique();
		if (existing) continue; // idempotent — replay safe
		await ctx.db.insert("sessionEntries", {
			sessionId,
			entryId: e.entryId,
			parentId: session.leafId,
			position: position++,
			kind: "custom",
			data: {
				type: "custom",
				id: e.entryId,
				parentId: session.leafId,
				timestamp: new Date(now).toISOString(),
				customType: e.customType,
				data: e.data,
			},
			createdAt: now,
		});
	}
}

export async function appendCanonicalEntry(
	ctx: MutationCtx,
	sessionId: Id<"sessions">,
	entryId: string,
	message: AgentMessage,
	now: number,
): Promise<void> {
	const session = await ctx.db.get(sessionId);
	if (!session) throw new Error(`[cove] session ${sessionId} not found`);

	const existing = await ctx.db
		.query("sessionEntries")
		.withIndex("by_session_and_entry", (q) => q.eq("sessionId", sessionId).eq("entryId", entryId))
		.unique();
	if (existing) return; // idempotent — replay safe

	const entry = {
		type: "message",
		id: entryId,
		parentId: session.leafId,
		timestamp: new Date(now).toISOString(),
		message,
	} as SessionEntry;
	const { entry: stripped, attachments, imageAttachmentIds } = extractEntryImages(entry, defaultImageHash);

	const last = await ctx.db
		.query("sessionEntries")
		.withIndex("by_session_and_position", (q) => q.eq("sessionId", sessionId))
		.order("desc")
		.first();
	const position = (last?.position ?? -1) + 1;

	await ctx.db.insert("sessionEntries", {
		sessionId,
		entryId,
		parentId: session.leafId,
		position,
		kind: "message",
		data: stripped,
		imageAttachmentIds: imageAttachmentIds.length > 0 ? imageAttachmentIds : undefined,
		createdAt: now,
	});

	// Upsert content-addressed image bytes; refCount tracks how many entries reference each hash.
	// (P4: inline only; >100KB → Convex _storage is a documented follow-up, doc 08 §4.8.)
	for (const att of attachments) {
		const chunk = await ctx.db
			.query("imageChunks")
			.withIndex("by_hash", (q) => q.eq("hash", att.hash))
			.unique();
		if (chunk) {
			await ctx.db.patch(chunk._id, { refCount: chunk.refCount + 1 });
		} else {
			await ctx.db.insert("imageChunks", {
				hash: att.hash,
				mediaType: att.mediaType,
				data: att.data,
				refCount: 1,
				createdAt: now,
			});
		}
	}

	await ctx.db.patch(sessionId, { leafId: entryId, updatedAt: now });
}

/**
 * Delete a session and cascade to its task-session descendants (BFS over taskSessions); refuse while any
 * descendant has a pending/running request (flue's delete guard). Releases image refs per deleted entry.
 * Shared by the internal deleteSession (by id) and the public remove (by tuple).
 */
export async function cascadeDeleteSession(ctx: MutationCtx, sessionId: Id<"sessions">): Promise<void> {
	const toDelete: Id<"sessions">[] = [];
	const queue: Id<"sessions">[] = [sessionId];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const id = queue.shift() as Id<"sessions">;
		if (seen.has(id)) continue;
		seen.add(id);
		const session = await ctx.db.get(id);
		if (!session) continue;
		toDelete.push(id);
		for (const child of session.taskSessions) {
			const childSession = await ctx.db
				.query("sessions")
				.withIndex("by_instance_harness_session", (q) =>
					q
						.eq("instanceId", session.instanceId)
						.eq("harnessName", session.harnessName)
						.eq("sessionName", child.session),
				)
				.unique();
			if (childSession) queue.push(childSession._id);
		}
	}

	for (const id of toDelete) {
		for (const status of ["pending", "running"] as const) {
			const active = await ctx.db
				.query("agentRequests")
				.withIndex("by_session_and_status", (q) => q.eq("sessionId", id).eq("status", status))
				.first();
			if (active) {
				throw new Error(`[cove] cannot delete session: a ${status} request is still active.`);
			}
		}
	}

	for (const id of toDelete) {
		const rows = await ctx.db
			.query("sessionEntries")
			.withIndex("by_session_and_position", (q) => q.eq("sessionId", id))
			.collect();
		for (const r of rows) {
			if (r.imageAttachmentIds?.length) await releaseImageRefs(ctx, r.imageAttachmentIds);
			await ctx.db.delete(r._id);
		}
		await ctx.db.delete(id);
	}
}

/** Decrement refCount for each referenced hash; reclaim the imageChunks row when it hits zero. */
export async function releaseImageRefs(
	ctx: MutationCtx,
	hashes: readonly string[],
): Promise<void> {
	for (const h of hashes) {
		const chunk = await ctx.db
			.query("imageChunks")
			.withIndex("by_hash", (q) => q.eq("hash", h))
			.unique();
		if (!chunk) continue;
		if (chunk.refCount <= 1) await ctx.db.delete(chunk._id);
		else await ctx.db.patch(chunk._id, { refCount: chunk.refCount - 1 });
	}
}
