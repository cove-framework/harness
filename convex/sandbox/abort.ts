// Ported from flue · @flue/runtime · packages/runtime/src/abort.ts → @cove/runtime
// Re-export of the canonical cancellation primitives (now in src/runtime/abort.ts, alongside the
// P6 createCallHandle). The sandbox only needs abortErrorFor + composeTimeoutSignal; keeping a single
// implementation avoids drift. Pure — no Convex/box/node import.

export { abortErrorFor, composeTimeoutSignal } from "../../src/runtime/abort.ts";
