// New (Convex backend) · @cove/runtime
// Pattern source: doc 03 "Diff-sync" — SessionStore.save appends only NEW entries (the tree is
// append-only except setLeaf rewinds the active leaf), keeping writes O(new entries), not O(history).
// flue rewrote the whole SessionData blob; cove diffs entry ids against the persisted rows.
//
// Pure / V8-safe: no Convex.

import type { SessionEntry } from "../../src/runtime/types.ts";

export interface EntryInsert {
	entry: SessionEntry;
	/** Monotonic position assigned for a stable, indexed ordered rebuild (doc 03). */
	position: number;
}

/**
 * Entries in `entries` not already persisted (by entryId), assigned monotonic positions starting at
 * `nextPosition`. A leaf rewind (setLeaf) never removes entries, so this stays a pure id diff — the
 * header's leafId carries the active-leaf change separately.
 */
export function computeEntryInserts(
	existingEntryIds: ReadonlySet<string>,
	entries: readonly SessionEntry[],
	nextPosition: number,
): EntryInsert[] {
	const inserts: EntryInsert[] = [];
	let pos = nextPosition;
	for (const entry of entries) {
		if (existingEntryIds.has(entry.id)) continue;
		inserts.push({ entry, position: pos });
		pos += 1;
	}
	return inserts;
}
