// Tests for the extension foundation (registry + pure runner) — pragmatic-refactor Phase 5a.
import { afterEach, describe, expect, it } from "vitest";
import { defineTool } from "../../tool.ts";
import {
	defineExtensionRegistry,
	getRegisteredExtension,
	registerExtensionRegistry,
	resetExtensionRegistryForTests,
} from "../registry.ts";
import { eventClass } from "../types.ts";
import type { ExtensionFactory } from "../types.ts";
import {
	loadExtensions,
	resolveExtensionSpecs,
	runExtensionFactory,
	toManifestEntry,
} from "../runner.ts";
import {
	applyBeforeAgentStartHooks,
	applyContextHooks,
	applySessionBeforeCompactHooks,
	applyToolCallHooks,
	applyToolResultHooks,
	bindManifest,
	type BoundHooks,
	makeBufferedContext,
	runNotifyHooks,
} from "../apply.ts";
import type { ExtensionContext, ExtensionHandler } from "../types.ts";

const CTX: ExtensionContext = { appendEntry: () => {}, getContextUsage: () => undefined };
const hooksOf = (event: string, ...handlers: ExtensionHandler[]): BoundHooks =>
	new Map([[event as never, handlers]]);

const noopTool = defineTool({
	name: "audit",
	description: "Audit tool contributed by an extension.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	execute: async () => "ok",
});

afterEach(resetExtensionRegistryForTests);

describe("eventClass", () => {
	it("partitions events into determinism classes", () => {
		expect(eventClass("setup")).toBe("registration");
		expect(eventClass("agent_start")).toBe("notify");
		expect(eventClass("session_compact")).toBe("notify");
		expect(eventClass("context")).toBe("content-mutation");
		expect(eventClass("tool_call")).toBe("content-mutation");
		expect(eventClass("session_before_compact")).toBe("content-mutation");
	});
});

describe("defineExtensionRegistry", () => {
	it("round-trips a name → factory map and installs the active registry", () => {
		const fac: ExtensionFactory = () => {};
		expect(getRegisteredExtension("audit-log")).toBeUndefined();
		const reg = defineExtensionRegistry({ "audit-log": fac });
		expect(reg.has("audit-log")).toBe(true);
		expect(reg.names).toEqual(["audit-log"]);
		registerExtensionRegistry(reg);
		expect(getRegisteredExtension("audit-log")).toBe(fac);
		resetExtensionRegistryForTests();
		expect(getRegisteredExtension("audit-log")).toBeUndefined();
	});

	it("rejects invalid names and non-factory values", () => {
		expect(() => defineExtensionRegistry({ "1bad": () => {} })).toThrow(/must start with a letter/);
		expect(() => defineExtensionRegistry({ ok: 5 as never })).toThrow(/not an extension factory/);
	});
});

describe("runExtensionFactory", () => {
	it("collects tools, prompt fragments, and ordered handlers", async () => {
		const factory: ExtensionFactory = (cove) => {
			cove.registerSystemPromptFragment("Follow the audit policy.");
			cove.registerTool(noopTool);
			cove.on("agent_start", () => {});
			cove.on("tool_call", () => {});
			cove.on("agent_start", () => {}); // second handler on the same event
		};
		const { registration, error } = await runExtensionFactory("audit-log", factory);
		expect(error).toBeUndefined();
		expect(registration.tools.map((t) => t.name)).toEqual(["audit"]);
		expect(registration.systemPromptFragments).toEqual(["Follow the audit policy."]);
		expect(registration.handlers.get("agent_start")).toHaveLength(2);
		expect(registration.handlers.get("tool_call")).toHaveLength(1);

		const manifest = toManifestEntry("audit-log", registration);
		expect(manifest).toEqual({
			name: "audit-log",
			tools: ["audit"],
			systemPromptFragments: ["Follow the audit policy."],
			events: ["agent_start", "tool_call"], // registration order, deduped by first-subscribe
		});
	});

	it("isolates a throwing factory (records the error, keeps partial registration)", async () => {
		const factory: ExtensionFactory = (cove) => {
			cove.registerSystemPromptFragment("before throw");
			throw new Error("boom");
		};
		const { registration, error } = await runExtensionFactory("bad", factory);
		expect(error).toMatch(/boom/);
		expect(registration.systemPromptFragments).toEqual(["before throw"]);
	});
});

describe("resolveExtensionSpecs", () => {
	it("resolves names from the registry, names inline factories, and reports missing", () => {
		const registered: ExtensionFactory = () => {};
		const inline: ExtensionFactory = () => {};
		const { resolved, missing } = resolveExtensionSpecs(
			["known", inline, "unknown"],
			(name) => (name === "known" ? registered : undefined),
		);
		expect(resolved).toEqual([
			{ name: "known", factory: registered },
			{ name: "inline:0", factory: inline },
		]);
		expect(missing).toEqual(["unknown"]);
	});
});

describe("loadExtensions", () => {
	it("loads an ordered list into a manifest + per-name registrations, collecting errors", async () => {
		const a: ExtensionFactory = (cove) => cove.registerSystemPromptFragment("A");
		const b: ExtensionFactory = () => {
			throw new Error("b failed");
		};
		const out = await loadExtensions([
			{ name: "a", factory: a },
			{ name: "b", factory: b },
		]);
		expect(out.manifest.map((m) => m.name)).toEqual(["a", "b"]); // order preserved
		expect(out.registrations.get("a")?.systemPromptFragments).toEqual(["A"]);
		expect(out.errors).toEqual([{ name: "b", error: "b failed" }]);
	});
});

describe("bindManifest", () => {
	it("recovers handler closures + tools for named extensions, skipping inline ones", async () => {
		const fac: ExtensionFactory = (cove) => {
			cove.on("context", () => {});
			cove.on("agent_start", () => {});
			cove.registerTool(noopTool);
		};
		const manifest = [
			{ name: "a", tools: ["audit"], systemPromptFragments: [], events: ["context", "agent_start"] as never },
			{ name: "inline:0", tools: [], systemPromptFragments: [], events: ["context"] as never },
		];
		const { hooks, tools } = await bindManifest(manifest, (name) => (name === "a" ? fac : undefined));
		expect(hooks.get("context")).toHaveLength(1); // only the named extension's handler
		expect(hooks.get("agent_start")).toHaveLength(1);
		expect(tools.get("audit")).toBe(noopTool); // contributed tool recovered
	});
});

describe("hook application (pure folds)", () => {
	it("runNotifyHooks fires handlers and swallows errors", async () => {
		let calls = 0;
		const hooks = hooksOf(
			"agent_start",
			() => void calls++,
			() => {
				throw new Error("observer boom");
			},
			() => void calls++,
		);
		await runNotifyHooks(hooks, { type: "agent_start" }, CTX);
		expect(calls).toBe(2); // both non-throwing handlers ran; the throw was isolated
	});

	it("applyContextHooks replaces the working messages, last-writer-wins", async () => {
		const hooks = hooksOf(
			"context",
			() => ({ messages: ["a", "b"] }),
			(ev) => ({ messages: [...(ev.messages as string[]), "c"] }),
		);
		expect(await applyContextHooks(hooks, ["x"], CTX)).toEqual(["a", "b", "c"]);
	});

	it("applyBeforeAgentStartHooks chains system-prompt overrides", async () => {
		const hooks = hooksOf("before_agent_start", (ev) => ({
			systemPrompt: `${ev.systemPrompt as string}\n+extra`,
		}));
		expect(await applyBeforeAgentStartHooks(hooks, "base", CTX)).toBe("base\n+extra");
	});

	it("applyToolCallHooks mutates args and can block", async () => {
		const mutate = hooksOf("tool_call", () => ({ args: { path: "/safe" } }));
		expect((await applyToolCallHooks(mutate, "read", { path: "/x" }, CTX)).args).toEqual({ path: "/safe" });

		const block = hooksOf("tool_call", () => ({ block: true, reason: "denied" }));
		const decision = await applyToolCallHooks(block, "rm", {}, CTX);
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("denied");
	});

	it("applyToolResultHooks patches content + isError", async () => {
		const hooks = hooksOf("tool_result", () => ({ content: "redacted", isError: true }));
		const out = await applyToolResultHooks(hooks, "read", { content: "secret" }, CTX);
		expect(out).toEqual({ content: "redacted", isError: true });
	});

	it("applySessionBeforeCompactHooks cancels (sticky) or replaces the summary (last-wins)", async () => {
		const ev = { messagesToSummarize: 5, tokensBefore: 100 };
		const cancel = hooksOf("session_before_compact", () => ({ cancel: true }));
		expect((await applySessionBeforeCompactHooks(cancel, ev, CTX)).cancel).toBe(true);

		const replace = hooksOf("session_before_compact", () => ({ compaction: { summary: "custom summary" } }));
		const d = await applySessionBeforeCompactHooks(replace, ev, CTX);
		expect(d.cancel).toBe(false);
		expect(d.replacementSummary).toBe("custom summary");
	});

	it("makeBufferedContext buffers appendEntry calls and drains them", async () => {
		const { ctx, drain } = makeBufferedContext({ totalTokens: 7 });
		const hooks = hooksOf("agent_start", (_ev, c) => {
			c.appendEntry("audit-log", { ok: true });
			expect((c.getContextUsage() as { totalTokens: number }).totalTokens).toBe(7);
		});
		await runNotifyHooks(hooks, { type: "agent_start" }, ctx);
		expect(drain()).toEqual([{ customType: "audit-log", data: { ok: true } }]);
		expect(drain()).toEqual([]); // drained
	});
});
