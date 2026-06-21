// Tests for the content-addressed image pipeline (sessions/images.ts).
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../src/runtime/types.ts";
import {
	assertImagesWithinLimit,
	defaultImageHash,
	extractEntryImages,
	hydrateEntryImages,
	IMAGE_DATA_OMITTED,
	MAX_IMAGE_DATA_LENGTH,
	redactImageBlocks,
} from "../images.ts";

function imageEntry(data: string, mimeType = "image/png"): SessionEntry {
	return {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "2026-06-21T00:00:00Z",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data, mimeType },
			],
			timestamp: 0,
		},
	} as SessionEntry;
}

const imageData = (entry: SessionEntry): string => {
	const msg = (entry as { message: { content: Array<{ type: string; data?: string }> } }).message;
	return msg.content.find((b) => b.type === "image")?.data ?? "";
};

describe("extractEntryImages", () => {
	it("hoists image bytes to a content-hash marker and returns the attachment", () => {
		const { entry, attachments, imageAttachmentIds } = extractEntryImages(imageEntry("BYTES"));
		expect(attachments).toHaveLength(1);
		expect(attachments[0]).toMatchObject({ mediaType: "image/png", data: "BYTES" });
		expect(imageAttachmentIds).toEqual([attachments[0]!.hash]);
		expect(imageData(entry)).toBe(`__cove_image_chunks__:${attachments[0]!.hash}`);
	});

	it("dedups identical images within one entry by hash", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "e2",
			parentId: null,
			timestamp: "t",
			message: {
				role: "user",
				content: [
					{ type: "image", data: "SAME", mimeType: "image/png" },
					{ type: "image", data: "SAME", mimeType: "image/png" },
				],
				timestamp: 0,
			},
		} as SessionEntry;
		const { attachments, imageAttachmentIds } = extractEntryImages(entry);
		expect(attachments).toHaveLength(1);
		expect(imageAttachmentIds).toHaveLength(1);
	});

	it("round-trips through hydrateEntryImages", () => {
		const original = imageEntry("ORIGINAL-BYTES");
		const { entry: stripped, attachments } = extractEntryImages(original);
		const dataByHash = new Map(attachments.map((a) => [a.hash, a.data]));
		const hydrated = hydrateEntryImages(stripped, dataByHash);
		expect(hydrated).toEqual(original);
	});

	it("hydrate fails loud when a referenced hash is missing", () => {
		const { entry: stripped } = extractEntryImages(imageEntry("X"));
		expect(() => hydrateEntryImages(stripped, new Map())).toThrow(/missing/);
	});

	it("passes non-image entries through unchanged", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "e3",
			parentId: null,
			timestamp: "t",
			message: { role: "user", content: [{ type: "text", text: "no image" }], timestamp: 0 },
		} as SessionEntry;
		const { entry: out, attachments } = extractEntryImages(entry);
		expect(out).toBe(entry);
		expect(attachments).toHaveLength(0);
	});
});

describe("assertImagesWithinLimit", () => {
	it("rejects oversized images", () => {
		expect(() => assertImagesWithinLimit([{ type: "image", data: "x".repeat(MAX_IMAGE_DATA_LENGTH + 1), mimeType: "image/png" }])).toThrow(
			/exceeds/,
		);
	});
	it("accepts within-limit / empty", () => {
		expect(() => assertImagesWithinLimit([{ type: "image", data: "ok", mimeType: "image/png" }])).not.toThrow();
		expect(() => assertImagesWithinLimit(undefined)).not.toThrow();
	});
});

describe("defaultImageHash", () => {
	it("is deterministic and distinguishes different content", () => {
		expect(defaultImageHash("abc")).toBe(defaultImageHash("abc"));
		expect(defaultImageHash("abc")).not.toBe(defaultImageHash("abd"));
		expect(defaultImageHash("abc")).not.toBe(defaultImageHash("abcd"));
	});
});

describe("redactImageBlocks", () => {
	it("replaces image bytes with the omitted sentinel (copy-on-write)", () => {
		const content = [
			{ type: "text", text: "t" },
			{ type: "image", data: "BYTES", mimeType: "image/png" },
		];
		const out = redactImageBlocks(content);
		expect(out).not.toBe(content);
		expect((out[1] as { data: string }).data).toBe(IMAGE_DATA_OMITTED);
	});
	it("returns the same reference when there is nothing to redact", () => {
		const content = [{ type: "text", text: "t" }];
		expect(redactImageBlocks(content)).toBe(content);
	});
});
