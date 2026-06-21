// Tests for the shell tool-event envelope (src/runtime/shell.ts), doc 08 §4.11.
import { describe, expect, it } from "vitest";
import { execShellWithEvents, redactEnvValues } from "../shell.ts";
import type { CoveEventInput, SessionEnv, ShellResult } from "../types.ts";

function fakeEnv(exec: (cmd: string, opts?: unknown) => Promise<ShellResult>): SessionEnv {
	return {
		cwd: "/work",
		resolvePath: (p) => p,
		exec: exec as SessionEnv["exec"],
		readFile: async () => "",
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: true, isDirectory: false }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
	};
}

describe("execShellWithEvents", () => {
	it("emits a tool_start + terminal tool pair with a shared toolCallId and durationMs", async () => {
		const events: CoveEventInput[] = [];
		const env = fakeEnv(async () => ({ stdout: "hi", stderr: "", exitCode: 0 }));
		const result = await execShellWithEvents(env, (e) => events.push(e), "echo hi", undefined, undefined);

		expect(result).toEqual({ stdout: "hi", stderr: "", exitCode: 0 });
		expect(events.map((e) => e.type)).toEqual(["tool_start", "tool"]);
		const start = events[0] as Extract<CoveEventInput, { type: "tool_start" }>;
		const term = events[1] as Extract<CoveEventInput, { type: "tool" }>;
		expect(start.toolName).toBe("bash");
		expect(term.toolName).toBe("bash");
		expect(term.toolCallId).toBe(start.toolCallId);
		expect(term.isError).toBe(false);
		expect(typeof term.durationMs).toBe("number");
		expect((term.result as { content: { text: string }[] }).content[0]?.text).toBe("hi");
	});

	it("redacts env values keys-only in the event args, while env.exec gets the real values", async () => {
		const events: CoveEventInput[] = [];
		let received: Record<string, string> | undefined;
		const env = fakeEnv(async (_cmd, opts) => {
			received = (opts as { env?: Record<string, string> }).env;
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		await execShellWithEvents(env, (e) => events.push(e), "run", { env: { SECRET: "shh" } }, undefined);
		const start = events[0] as Extract<CoveEventInput, { type: "tool_start" }>;
		expect((start.args as { env: Record<string, string> }).env).toEqual({ SECRET: "<redacted>" });
		expect(received).toEqual({ SECRET: "shh" }); // real value reached env.exec
	});

	it("records details.exitCode -1 and rethrows on failure", async () => {
		const events: CoveEventInput[] = [];
		const env = fakeEnv(async () => {
			throw new Error("spawn failed");
		});
		await expect(
			execShellWithEvents(env, (e) => events.push(e), "boom", undefined, undefined),
		).rejects.toThrow("spawn failed");
		const term = events[1] as Extract<CoveEventInput, { type: "tool" }>;
		expect(term.isError).toBe(true);
		expect((term.result as { details: { exitCode: number } }).details.exitCode).toBe(-1);
	});

	it("invokes the record hook before the terminal emit on both branches", async () => {
		const okRecords: boolean[] = [];
		const env = fakeEnv(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
		await execShellWithEvents(env, () => {}, "echo ok", undefined, undefined, async (_id, _a, _r, isError) => {
			okRecords.push(isError);
		});
		expect(okRecords).toEqual([false]);

		const errRecords: boolean[] = [];
		const badEnv = fakeEnv(async () => {
			throw new Error("nope");
		});
		await expect(
			execShellWithEvents(badEnv, () => {}, "x", undefined, undefined, async (_id, _a, _r, isError) => {
				errRecords.push(isError);
			}),
		).rejects.toThrow();
		expect(errRecords).toEqual([true]);
	});
});

describe("redactEnvValues", () => {
	it("replaces every value with <redacted>, keeping keys", () => {
		expect(redactEnvValues({ A: "1", B: "2" })).toEqual({ A: "<redacted>", B: "<redacted>" });
	});
});
