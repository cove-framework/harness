// New · @cove/runtime — re-homed from convex/sessions/images.ts so the V8-safe
// consumer layers (src/react reducer, src/sdk client) can import the sentinel
// without crossing the convex/ dependency boundary. convex/sessions/images.ts
// re-exports it for back-compat.

/**
 * Sentinel that replaces raw base64 image bytes in event payloads. Events keep
 * an image's presence and `mimeType` visible without carrying the payload
 * itself, so observers and persisted run history never retain image bytes.
 * Session history (model context) is unaffected and retains the real bytes.
 */
export const IMAGE_DATA_OMITTED = "[image data omitted from event]";
