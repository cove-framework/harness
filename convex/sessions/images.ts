// Ported from flue · @flue/runtime · packages/runtime/src/persisted-images.ts + persisted-image-placement.ts
//   + event-redaction.ts → @cove/runtime. ('[flue]' → '[cove]'.)
//
// COVE ADAPTATION: flue keyed chunks per-entry imageId ("0","1") and sliced bytes into 256KB pieces for SQL
// row limits. Cove's imageChunks table is CONTENT-ADDRESSED by hash with a refCount (dedup across entries),
// and stores each image inline (≤ ~100KB) or in Convex _storage (doc 03 / 08 §4.8) — so the per-256KB
// chunking is dropped. extractEntryImages hoists each image block's base64 out of the entry, replacing it
// in place with a `__cove_image_chunks__:<hash>` marker; the entry references the hashes via
// imageAttachmentIds (distinct, for the cascade-decrement). The hasher is injected so this stays a pure,
// sync, dependency-free module (the Convex save passes the real content hash).
//
// Pure / V8-safe: no Convex, no AI SDK.

import type { PromptImage, SessionEntry } from "../../src/runtime/types.ts";

/** Max base64 length for a single image (fail-loud persistence invariant, doc 08 §4.8). */
export const MAX_IMAGE_DATA_LENGTH = 5 * 1024 * 1024;
/** Images at/below this base64 length live inline in imageChunks.data; larger spill to _storage. */
export const INLINE_IMAGE_THRESHOLD = 100 * 1024;
/** Sentinel that replaces raw image bytes in outgoing events (events never carry bytes). */
export const IMAGE_DATA_OMITTED = "[image data omitted from event]";

const MARKER_PREFIX = "__cove_image_chunks__:";

export interface ImageAttachment {
	hash: string;
	mediaType: string;
	data: string;
}

export interface ExtractedEntryImages {
	/** The entry with each image block's base64 replaced by a content-hash marker. */
	entry: SessionEntry;
	/** Distinct image bytes hoisted out (dedup by hash), for the imageChunks upsert + refCount. */
	attachments: ImageAttachment[];
	/** Distinct hashes this entry references — drives the cascade-decrement on delete. */
	imageAttachmentIds: string[];
}

type ImageBlock = { type: "image"; data: string; mimeType: string };

/**
 * Reject any image whose base64 exceeds {@link MAX_IMAGE_DATA_LENGTH}, at the operation entry points
 * (prompt/skill/task) so an oversized image never lands an unsaveable entry in history (doc 03 write path).
 */
export function assertImagesWithinLimit(
	images: readonly PromptImage[] | undefined,
	max = MAX_IMAGE_DATA_LENGTH,
): void {
	for (const image of images ?? []) {
		if (image.data.length > max) {
			throw new Error(`[cove] Image data exceeds the ${max} character limit.`);
		}
	}
}

/**
 * Deterministic content hash for image dedup. FNV-1a over the base64 (two parallel basis values) plus the
 * byte length — dependency-free and sync. Collision-resistant enough for content-addressed dedup; the
 * Convex layer may substitute a cryptographic hash without changing the marker contract.
 */
export function defaultImageHash(data: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < data.length; i++) {
		const c = data.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x85ebca77);
	}
	const a = (h1 >>> 0).toString(16).padStart(8, "0");
	const b = (h2 >>> 0).toString(16).padStart(8, "0");
	return `img_${a}${b}_${data.length.toString(16)}`;
}

/**
 * Hoist image bytes out of a message entry. Returns the entry with image data replaced by content-hash
 * markers, the distinct hoisted images (by hash), and the distinct referenced hashes. Non-message entries
 * and entries without array content pass through unchanged.
 */
export function extractEntryImages(
	entry: SessionEntry,
	hash: (data: string) => string = defaultImageHash,
): ExtractedEntryImages {
	if (entry.type !== "message" || !isImageBearingMessage(entry.message)) {
		return { entry, attachments: [], imageAttachmentIds: [] };
	}
	const content = (entry.message as { content: unknown }).content;
	if (!Array.isArray(content)) {
		return { entry, attachments: [], imageAttachmentIds: [] };
	}

	const attachmentsByHash = new Map<string, ImageAttachment>();
	const ids: string[] = [];
	const newContent = content.map((block) => {
		if (!isImageBlock(block)) return block;
		if (block.data.startsWith(MARKER_PREFIX)) return block; // already hoisted
		if (block.data.length > MAX_IMAGE_DATA_LENGTH) {
			throw new Error(`[cove] Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`);
		}
		const h = hash(block.data);
		if (!attachmentsByHash.has(h)) {
			attachmentsByHash.set(h, { hash: h, mediaType: block.mimeType, data: block.data });
			ids.push(h);
		}
		return { ...block, data: `${MARKER_PREFIX}${h}` };
	});

	// Copy-on-write: a message with no (un-hoisted) images passes through unchanged.
	if (ids.length === 0) return { entry, attachments: [], imageAttachmentIds: [] };

	return {
		entry: { ...entry, message: { ...entry.message, content: newContent } } as SessionEntry,
		attachments: [...attachmentsByHash.values()],
		imageAttachmentIds: ids,
	};
}

/**
 * Rehydrate a stored entry: replace each `__cove_image_chunks__:<hash>` marker with its bytes from
 * `dataByHash`. Fail-loud when a referenced hash is missing. Non-image entries pass through.
 */
export function hydrateEntryImages(
	entry: SessionEntry,
	dataByHash: ReadonlyMap<string, string>,
): SessionEntry {
	if (entry.type !== "message" || !isImageBearingMessage(entry.message)) return entry;
	const content = (entry.message as { content: unknown }).content;
	if (!Array.isArray(content)) return entry;

	const newContent = content.map((block) => {
		if (!isImageBlock(block) || !block.data.startsWith(MARKER_PREFIX)) return block;
		const h = block.data.slice(MARKER_PREFIX.length);
		const data = dataByHash.get(h);
		if (data === undefined) throw new Error(`[cove] Persisted image chunk "${h}" is missing.`);
		return { ...block, data };
	});

	return { ...entry, message: { ...entry.message, content: newContent } } as SessionEntry;
}

/**
 * Copy-on-write redaction of image bytes in a content-block array → {@link IMAGE_DATA_OMITTED}. Returns
 * the same array reference when nothing changed (so callers can skip rewriting unchanged events).
 */
export function redactImageBlocks<T>(content: T[]): T[] {
	let changed = false;
	const redacted = content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const { type, data } = block as { type?: unknown; data?: unknown };
		if (type === "image" && typeof data === "string" && data !== IMAGE_DATA_OMITTED) {
			changed = true;
			return { ...block, data: IMAGE_DATA_OMITTED };
		}
		return block;
	});
	return changed ? redacted : content;
}

function isImageBearingMessage(message: unknown): boolean {
	const role = (message as { role?: unknown })?.role;
	return role === "user" || role === "toolResult";
}

function isImageBlock(value: unknown): value is ImageBlock {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const block = value as { type?: unknown; data?: unknown; mimeType?: unknown };
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}
