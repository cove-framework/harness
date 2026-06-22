// New · @cove/runtime — G2.2: the injectable connect seam (paginated discovery, repeated-cursor guard) and
// the per-beat resolver (success / drift "no-longer-offered" / connect-failure degrade) via a Pick<Client> stub.
import { afterEach, describe, expect, it } from "vitest";
import { connectMcpServerWithClient } from "../connect.ts";
import {
	__resetMcpPoolForTests,
	__setMcpOpenerForTests,
	resolveMcpTool,
} from "../pool.ts";
import type { FrozenToolDescriptor } from "../../engine/types.ts";
import type {
	McpCallToolResult,
	McpClient,
	McpToolInfo,
} from "../../../src/runtime/mcp-types.ts";

const t = (name: string): McpToolInfo => ({ name, inputSchema: { type: "object" } });

/** A Pick<Client>-shaped stub whose listTools paginates through the given pages. */
function pagedClient(pages: { tools: McpToolInfo[]; nextCursor?: string }[]): McpClient & { closed: boolean } {
	let i = 0;
	const stub = {
		closed: false,
		async connect() {},
		async listTools() {
			return pages[i++] ?? { tools: [] };
		},
		async callTool(): Promise<McpCallToolResult> {
			return { content: [] };
		},
		async close() {
			stub.closed = true;
		},
	};
	return stub;
}

describe("connectMcpServerWithClient", () => {
	it("aggregates paginated tools/list", async () => {
		const client = pagedClient([
			{ tools: [t("a")], nextCursor: "c1" },
			{ tools: [t("b")], nextCursor: "c2" },
			{ tools: [t("c")] },
		]);
		const conn = await connectMcpServerWithClient("srv", client, {});
		expect(conn.tools.map((x) => x.name)).toEqual(["a", "b", "c"]);
		await conn.close();
		expect(client.closed).toBe(true);
	});

	it("rejects a repeated tools/list cursor and closes the client", async () => {
		const client = pagedClient([
			{ tools: [t("a")], nextCursor: "c1" },
			{ tools: [t("b")], nextCursor: "c1" },
		]);
		await expect(connectMcpServerWithClient("srv", client, {})).rejects.toThrow(/repeated tools\/list cursor/);
		expect(client.closed).toBe(true);
	});
});

const frozen = (toolName: string, error?: string): FrozenToolDescriptor => ({
	name: `mcp__srv__${toolName}`,
	description: "d",
	parameters: { type: "object" },
	kind: "mcp",
	mcp: {
		serverId: "srv",
		transport: "streamable-http",
		url: "https://example.test/mcp",
		toolName,
		name: `mcp__srv__${toolName}`,
		description: "d",
		parameters: { type: "object" },
		error,
	},
});

function callToolClient(canned: McpCallToolResult): McpClient {
	return {
		async connect() {},
		async listTools() {
			return { tools: [] };
		},
		async callTool() {
			return canned;
		},
		async close() {},
	};
}

describe("resolveMcpTool (per-beat resolver via the pool seam)", () => {
	afterEach(() => {
		__setMcpOpenerForTests(null);
		__resetMcpPoolForTests();
	});

	it("binds and calls the tool when the server offers it", async () => {
		__setMcpOpenerForTests(async () => ({
			client: callToolClient({ content: [{ type: "text", text: "ok" }] }),
			toolNames: new Set(["search"]),
		}));
		const r = await resolveMcpTool(frozen("search")).execute({});
		expect(r.isError).toBeFalsy();
		expect(r.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("degrades to no-longer-offered when the live tool list drifts (frozen wins)", async () => {
		__setMcpOpenerForTests(async () => ({
			client: callToolClient({ content: [] }),
			toolNames: new Set(["other"]), // "search" no longer offered
		}));
		const r = await resolveMcpTool(frozen("search")).execute({});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("no longer offered");
	});

	it("degrades to an error tool-result on a connect failure (never a crash)", async () => {
		__setMcpOpenerForTests(async () => {
			throw new Error("connection refused");
		});
		const r = await resolveMcpTool(frozen("search")).execute({});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("connection refused");
	});

	it("a diagnostic descriptor degrades immediately without opening a connection", async () => {
		let opened = false;
		__setMcpOpenerForTests(async () => {
			opened = true;
			return { client: callToolClient({ content: [] }), toolNames: new Set<string>() };
		});
		const r = await resolveMcpTool(frozen("error", "discovery failed")).execute({});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("discovery failed");
		expect(opened).toBe(false);
	});
});
