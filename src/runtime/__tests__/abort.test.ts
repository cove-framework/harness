// Tests for the cancellation primitives (src/runtime/abort.ts).
import { describe, expect, it } from "vitest";
import { abortErrorFor, createCallHandle } from "../abort.ts";

describe("createCallHandle", () => {
	it("resolves like a promise and exposes a live signal", async () => {
		const handle = createCallHandle(undefined, async (signal) => {
			expect(signal.aborted).toBe(false);
			return 42;
		});
		expect(handle.signal).toBeInstanceOf(AbortSignal);
		await expect(handle).resolves.toBe(42);
	});

	it("rejects propagate to awaiters", async () => {
		const handle = createCallHandle(undefined, async () => {
			throw new Error("boom");
		});
		await expect(handle).rejects.toThrow("boom");
	});

	it("abort() fires the internal signal", async () => {
		let observed: AbortSignal | undefined;
		const handle = createCallHandle(undefined, (signal) => {
			observed = signal;
			return new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => resolve("aborted"), { once: true });
			});
		});
		handle.abort("stop it");
		await expect(handle).resolves.toBe("aborted");
		expect(observed?.aborted).toBe(true);
	});

	it("an external signal aborts the handle's signal", async () => {
		const external = new AbortController();
		const handle = createCallHandle(external.signal, (signal) =>
			new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => resolve("ext"), { once: true });
			}),
		);
		external.abort();
		await expect(handle).resolves.toBe("ext");
		expect(handle.signal.aborted).toBe(true);
	});

	it("a pre-aborted external signal aborts immediately", () => {
		const handle = createCallHandle(AbortSignal.abort("nope"), async (signal) => signal.aborted);
		expect(handle.signal.aborted).toBe(true);
	});
});

describe("abortErrorFor", () => {
	it("builds an AbortError carrying the reason", () => {
		const c = new AbortController();
		c.abort("because");
		const err = abortErrorFor(c.signal);
		expect(err.name).toBe("AbortError");
		expect(err.message).toBe("because");
	});
});
