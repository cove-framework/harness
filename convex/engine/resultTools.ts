// Ported from flue · @flue/runtime · packages/runtime/src/result.ts → @cove/runtime
//   createResultTools (finish/give_up pair) reshaped from pi's AgentTool onto cove's EngineTool;
//   buildResultFooter / buildResultFollowUpPrompt / buildPromptText ported verbatim ('[flue]'→'[cove]').
//   ResultUnavailableError lives in src/runtime/errors.ts (a CoveError subclass), not here.
//
//   COVE DELTA (durability): flue derived the result outcome from an in-memory closure on the in-process
//   loop. Cove crosses a journaled llmStep→dispatchTools→next-llmStep split, so a cold action rebuilds a
//   fresh (pending) bundle — the closure can't carry the outcome. The DURABLE outcome is derived from the
//   persisted tool-result rows via {@link computeResultOutcome} (doc 04 "Result-tool re-nudge", 08 §4.10).
//   The bundle's getOutcome() is in-batch only.
//
// Pure / V8-safe: valibot + @valibot/to-json-schema (pure libs, as in src/runtime/tool.ts); no AI SDK/Convex.

import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { isTopLevelObjectSchema, stripJsonSchemaMeta } from "../../src/runtime/tool-schema.ts";
import type { EngineTool, EngineToolResult, ToolResultRecord } from "./types.ts";

/** Framework-injected result-capture tool names. Reserved at custom-tool validation time. */
export const FINISH_TOOL_NAME = "finish";
export const GIVE_UP_TOOL_NAME = "give_up";

/** Footer appended to user prompts / skill bodies when a `result` schema is set. */
export function buildResultFooter(): string {
	return [
		"",
		`When the task is complete, call the \`${FINISH_TOOL_NAME}\` tool with your final answer as its arguments. The arguments are validated against the required schema; if validation fails you will receive an error and may try again.`,
		`If you determine that you cannot complete the task or cannot produce a result that conforms to the required schema, call the \`${GIVE_UP_TOOL_NAME}\` tool with a clear \`reason\`.`,
		`Do not respond with the answer in plain text — only a successful \`${FINISH_TOOL_NAME}\` (or \`${GIVE_UP_TOOL_NAME}\`) call counts.`,
	].join("\n");
}

/** Follow-up prompt sent when the LLM ends a turn without calling `finish` or `give_up`. */
export function buildResultFollowUpPrompt(): string {
	return [
		`You ended your turn without calling \`${FINISH_TOOL_NAME}\` or \`${GIVE_UP_TOOL_NAME}\`.`,
		`Either call \`${FINISH_TOOL_NAME}\` with your final answer, or call \`${GIVE_UP_TOOL_NAME}\` with a reason if you cannot determine the answer.`,
	].join(" ");
}

/** Append the result footer to a prompt when a result schema is set. */
export function buildPromptText(text: string, hasSchema: boolean): string {
	return hasSchema ? [text, buildResultFooter()].join("\n") : text;
}

/** Outcome of a result-schema run. `pending` means neither result tool fired. */
export type ResultOutcome<T = unknown> =
	| { type: "pending" }
	| { type: "finished"; value: T }
	| { type: "gave_up"; reason: string };

export interface ResultToolBundle<T> {
	tools: EngineTool[];
	/** In-batch outcome only — DURABLE outcome comes from {@link computeResultOutcome}. */
	getOutcome(): ResultOutcome<T>;
}

const FINISH_DESCRIPTION =
	`Call this tool when the task is complete. Provide your final answer as the arguments. ` +
	`The arguments are validated against the required schema; if validation fails you will ` +
	`receive an error message and may try again. ` +
	`The first successful \`${FINISH_TOOL_NAME}\` call wins — once the task is finished, do ` +
	`not call \`${FINISH_TOOL_NAME}\` again.`;

const GIVE_UP_DESCRIPTION =
	`Call this tool only if you have determined that you cannot complete the task or ` +
	`cannot produce a result that conforms to the required schema. Provide a clear \`reason\`. ` +
	`This ends the task with a failure.`;

const GIVE_UP_PARAMETERS = {
	type: "object",
	properties: {
		reason: {
			type: "string",
			minLength: 1,
			description: "A clear explanation of why the task cannot be completed.",
		},
	},
	required: ["reason"],
	additionalProperties: false,
};

/** True when a JSON Schema describes a top-level object (valid as provider tool parameters as-is). */
function isObjectJsonSchema(schema: unknown): boolean {
	return !!schema && typeof schema === "object" && (schema as { type?: unknown }).type === "object";
}

/** Wrap a non-object result JSON Schema in a `{ result }` envelope (provider tool args must be objects). */
export function resultFinishParameters(jsonSchema: unknown): unknown {
	return isObjectJsonSchema(jsonSchema)
		? jsonSchema
		: {
				type: "object",
				properties: { result: jsonSchema },
				required: ["result"],
				additionalProperties: false,
			};
}

/**
 * Shared finish/give_up bundle. `parseFinish` validates the (already-unwrapped) candidate; a `{ok:false}`
 * throws so the dispatcher encodes an error tool-result the model can fix. A successful call persists the
 * value in `details` ({@link computeResultOutcome} reads it back) and sets `terminate: true`.
 */
function buildResultBundle<T>(
	finishParameters: unknown,
	parseFinish: (args: Record<string, unknown>) => { ok: true; value: T } | { ok: false; message: string },
): ResultToolBundle<T> {
	let outcome: ResultOutcome<T> = { type: "pending" };

	const finishTool: EngineTool = {
		name: FINISH_TOOL_NAME,
		description: FINISH_DESCRIPTION,
		parameters: finishParameters,
		async execute(args) {
			if (outcome.type !== "pending") return alreadyDone(outcome);
			const parsed = parseFinish(args);
			if (!parsed.ok) throw new Error(parsed.message);
			outcome = { type: "finished", value: parsed.value };
			return {
				content: [{ type: "text", text: "Result accepted. The task is complete." }],
				details: { tool: FINISH_TOOL_NAME, result: parsed.value },
				terminate: true,
			};
		},
	};

	const giveUpTool: EngineTool = {
		name: GIVE_UP_TOOL_NAME,
		description: GIVE_UP_DESCRIPTION,
		parameters: GIVE_UP_PARAMETERS,
		async execute(args) {
			if (outcome.type !== "pending") return alreadyDone(outcome);
			const reason = (args as { reason: unknown }).reason;
			if (typeof reason !== "string" || reason.trim().length === 0) {
				throw new Error(`\`${GIVE_UP_TOOL_NAME}\` requires a non-empty \`reason\` string.`);
			}
			outcome = { type: "gave_up", reason };
			return {
				content: [{ type: "text", text: "Acknowledged." }],
				details: { tool: GIVE_UP_TOOL_NAME, reason },
				terminate: true,
			};
		},
	};

	return { tools: [finishTool, giveUpTool], getOutcome: () => outcome };
}

/**
 * Build the per-call finish/give_up pair for a VALIBOT schema (the in-process path used by the invoke
 * layer): finish args are `v.safeParse`d to enforce refinements + obtain the typed/transformed output; a
 * failure throws → the dispatcher encodes it as an error tool-result the model can fix.
 */
export function createResultTools<S extends v.GenericSchema>(
	schema: S,
): ResultToolBundle<v.InferOutput<S>> {
	const wrapped = !isTopLevelObjectSchema(schema);
	const innerJsonSchema = stripJsonSchemaMeta(
		toJsonSchema(schema, { errorMode: "ignore" }) as Record<string, unknown>,
	);
	const finishParameters = wrapped
		? {
				type: "object",
				properties: { result: innerJsonSchema },
				required: ["result"],
				additionalProperties: false,
			}
		: innerJsonSchema;

	return buildResultBundle<v.InferOutput<S>>(finishParameters, (args) => {
		const candidate = wrapped ? (args as { result: unknown }).result : args;
		const parsed = v.safeParse(schema, candidate);
		if (!parsed.success) {
			const issues = parsed.issues
				.map((i) => i.message + (i.path ? ` (at ${formatIssuePath(i.path)})` : ""))
				.join("; ");
			return {
				ok: false,
				message:
					`Result does not match the required schema: ${issues}. ` +
					`Please call \`${FINISH_TOOL_NAME}\` again with a corrected payload.`,
			};
		}
		return { ok: true, value: parsed.output };
	});
}

/**
 * Build the per-call finish/give_up pair from a JSON Schema (the journal-crossable path the durable engine
 * uses: valibot schemas can't be serialized onto the workflow journal, so the result schema is frozen on
 * the plan as JSON Schema). The provider validates args against the schema before returning the tool call,
 * so finish CAPTURES the structurally-valid value; valibot-level refinement re-validation is layered on by
 * the invoke layer (P6) before the CallHandle resolves `PromptResultResponse<T>`.
 */
export function createResultToolsFromJsonSchema(jsonSchema: unknown): ResultToolBundle<unknown> {
	const wrapped = !isObjectJsonSchema(jsonSchema);
	return buildResultBundle<unknown>(resultFinishParameters(jsonSchema), (args) => ({
		ok: true,
		value: wrapped ? (args as { result: unknown }).result : args,
	}));
}

/**
 * Derive the DURABLE result outcome from the persisted tool-result rows of a run.
 * This is the loop's source of truth across the journaled action split — the
 * `finish`/`give_up` tool results carry the validated value / reason in `details`.
 * Returns the first terminal result found, else `pending`.
 */
export function computeResultOutcome(toolResults: ToolResultRecord[]): ResultOutcome {
	for (const r of toolResults) {
		if (r.isError) continue;
		const details = extractDetails(r.result);
		if (r.toolName === FINISH_TOOL_NAME && details && "result" in details) {
			return { type: "finished", value: (details as { result: unknown }).result };
		}
		if (
			r.toolName === GIVE_UP_TOOL_NAME &&
			details &&
			typeof (details as { reason?: unknown }).reason === "string"
		) {
			return { type: "gave_up", reason: (details as { reason: string }).reason };
		}
	}
	return { type: "pending" };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Pull the `details` object off a persisted EngineToolResult-shaped value. */
function extractDetails(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	return details as Record<string, unknown>;
}

function alreadyDone(outcome: ResultOutcome): EngineToolResult {
	const detail =
		outcome.type === "finished"
			? "A result was already submitted; the task is complete."
			: "The task was already given up; it cannot be resumed.";
	return {
		content: [{ type: "text", text: `${detail} Do not call this tool again.` }],
		details: { alreadyDone: true },
	};
}

function formatIssuePath(path: ReadonlyArray<{ key?: unknown }>): string {
	return path
		.map((p) => (typeof p.key === "number" ? `[${p.key}]` : `.${String(p.key ?? "?")}`))
		.join("")
		.replace(/^\./, "");
}
