// Ported from flue · @flue/runtime · packages/runtime/src/compaction.ts → @cove/runtime — the PURE half (no
// LLM I/O), adapted to cove's AgentMessage (src/runtime/messages.ts). Context compaction for long sessions:
// when context approaches the model window, older messages are summarized into a structured CompactionEntry.
// Trigger modes: (1) threshold — tokens > (contextWindow - reserveTokens), compact, no retry; (2) overflow —
// the provider signalled context overflow, compact then retry. This module decides WHEN + WHAT to compact and
// serializes the slice + carries the summarization prompts. The summarization model call (flue's compact()/
// generateSummary) becomes a Convex "use node" action — the compact workflow step — which consumes
// prepareCompaction()'s output; that integration + the CompactionEntry append are the P12 wiring remainder.
// Pure / V8-safe: only cove's message types, no AI SDK, no Convex.

import type {
	AgentMessage,
	AssistantMessage,
	SignalMessage,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "./messages.ts";

// ─── Settings ───────────────────────────────────────────────────────────────

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

/** Defaults when no user config + no model metadata. Real sessions derive via deriveCompactionDefaults. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 20000,
	keepRecentTokens: 8000,
};

/**
 * Model-aware defaults: reserve is capped at the model's max output (reserving more than the model can emit
 * wastes context); the preserved tail stays flat. For tiny-window models, clamp reserve to a third of the
 * window so threshold compaction can fire usefully instead of on every turn.
 */
export function deriveCompactionDefaults(input: {
	contextWindow: number;
	maxTokens: number;
}): CompactionSettings {
	const reserveCap = input.maxTokens > 0 ? input.maxTokens : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	let reserveTokens = Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, reserveCap);
	if (input.contextWindow > 0 && reserveTokens * 2 >= input.contextWindow) {
		reserveTokens = Math.max(1024, Math.floor(input.contextWindow / 3));
	}
	return { enabled: true, reserveTokens, keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens };
}

// ─── Token Estimation ───────────────────────────────────────────────────────

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant") {
		const a = msg as AssistantMessage;
		if (a.stopReason !== "aborted" && a.stopReason !== "error" && a.usage) return a.usage;
	}
	return undefined;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		const usage = getAssistantUsage(msg);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** chars/4 heuristic. Conservative (overestimates). */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case "user": {
			const { content } = message as UserMessage;
			if (typeof content === "string") chars = content.length;
			else for (const block of content) if (block.type === "text") chars += block.text.length;
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			for (const block of (message as AssistantMessage).content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			return Math.ceil(chars / 4);
		}
		case "toolResult": {
			for (const block of (message as ToolResultMessage).content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "image") chars += 4800; // approximate image token cost
			}
			return Math.ceil(chars / 4);
		}
		case "signal":
			return Math.ceil((message as SignalMessage).content.length / 4);
	}
	return 0;
}

export function estimateContextTokens(messages: AgentMessage[]): number {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) estimated += estimateTokens(message);
		return estimated;
	}
	let trailing = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		const m = messages[i];
		if (m) trailing += estimateTokens(m);
	}
	return calculateContextTokens(usageInfo.usage) + trailing;
}

export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled) return false;
	if (contextWindow <= 0) return false; // unknown window — skip threshold; overflow recovery still runs
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ─── File Operation Tracking ──────────────────────────────────────────────────

export interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

function createFileOps(): FileOps {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOps): void {
	if (message.role !== "assistant") return;
	for (const block of (message as AssistantMessage).content) {
		if (block.type !== "toolCall") continue;
		const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
		if (!path) continue;
		if (block.name === "read") fileOps.read.add(path);
		else if (block.name === "write") fileOps.written.add(path);
		else if (block.name === "edit") fileOps.edited.add(path);
	}
}

export function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((f) => !modified.has(f)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

// ─── Message Serialization ─────────────────────────────────────────────────────

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Serialize messages to text so the summarization model doesn't treat it as a conversation to continue. */
export function serializeConversation(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const { content } = msg as UserMessage;
			const text =
				typeof content === "string"
					? content
					: content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("");
			if (text) parts.push(`[User]: ${text}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];
			for (const block of (msg as AssistantMessage).content) {
				if (block.type === "text") textParts.push(block.text);
				else if (block.type === "thinking") thinkingParts.push(block.thinking);
				else if (block.type === "toolCall") {
					const argsStr = Object.entries(block.arguments)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}
			if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
			if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
		} else if (msg.role === "toolResult") {
			const text = (msg as ToolResultMessage).content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
		}
	}
	return parts.join("\n\n");
}

// ─── Summarization Prompts (consumed by the compact action) ─────────────────────

export const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints/preferences/requirements mentioned, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary: PRESERVE all existing info, ADD new progress/decisions/context, MOVE "In Progress"→"Done" when completed, UPDATE "Next Steps", PRESERVE exact file paths/function names/error messages, remove what's no longer relevant. Use the same section format as the initial summary.`;

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ─── Cut Point Detection ────────────────────────────────────────────────────────

/** Valid cut points: user or assistant messages. Never cut at toolResult. */
function findValidCutPoints(messages: AgentMessage[], start: number, end: number): number[] {
	const cutPoints: number[] = [];
	for (let i = start; i < end; i++) {
		const role = messages[i]?.role;
		if (role === "user" || role === "assistant") cutPoints.push(i);
	}
	return cutPoints;
}

function findTurnStartIndex(messages: AgentMessage[], index: number, start: number): number {
	for (let i = index; i >= start; i--) if (messages[i]?.role === "user") return i;
	return -1;
}

interface CutPointResult {
	firstKeptIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

function findCutPoint(
	messages: AgentMessage[],
	start: number,
	end: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(messages, start, end);
	if (cutPoints.length === 0) return { firstKeptIndex: start, turnStartIndex: -1, isSplitTurn: false };

	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0] ?? start;
	for (let i = end - 1; i >= start; i--) {
		const message = messages[i];
		if (!message) continue;
		accumulatedTokens += estimateTokens(message);
		if (accumulatedTokens >= keepRecentTokens) {
			for (const cutPoint of cutPoints) {
				if (cutPoint >= i) {
					cutIndex = cutPoint;
					break;
				}
			}
			break;
		}
	}

	const isUserMessage = messages[cutIndex]?.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(messages, cutIndex, start);
	return {
		firstKeptIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ─── Compaction Preparation (pure — no I/O) ─────────────────────────────────────

export interface CompactionPreparation {
	firstKeptIndex: number;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary: string | undefined;
	fileOps: FileOps;
	settings: CompactionSettings;
}

/** Find the cut point, extract the slice to summarize, and track file ops. No I/O. */
export function prepareCompaction(
	messages: AgentMessage[],
	settings: CompactionSettings,
	previousCompaction?: {
		summary: string;
		firstKeptIndex: number;
		details?: { readFiles: string[]; modifiedFiles: string[] };
	},
): CompactionPreparation | undefined {
	if (messages.length === 0) return undefined;

	const boundaryStart = previousCompaction ? previousCompaction.firstKeptIndex : 0;
	const boundaryEnd = messages.length;
	const tokensBefore = estimateContextTokens(messages);

	const cutPoint = findCutPoint(messages, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	if (cutPoint.firstKeptIndex <= boundaryStart) return undefined;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex;
	const messagesToSummarize = messages.slice(boundaryStart, historyEnd);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? messages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex)
		: [];

	const fileOps = createFileOps();
	if (previousCompaction?.details) {
		for (const f of previousCompaction.details.readFiles ?? []) fileOps.read.add(f);
		for (const f of previousCompaction.details.modifiedFiles ?? []) fileOps.edited.add(f);
	}
	for (const msg of messagesToSummarize) extractFileOpsFromMessage(msg, fileOps);
	for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);

	return {
		firstKeptIndex: cutPoint.firstKeptIndex,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary: previousCompaction?.summary,
		fileOps,
		settings,
	};
}

// ─── Incremental-compaction helpers (pragmatic-refactor Phase 4) ─────────────────

/** The prior-compaction boundary {@link prepareCompaction} consumes for an incremental (UPDATE) summary. */
export interface PreviousCompaction {
	summary: string;
	firstKeptIndex: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
}

/**
 * Translate a persisted compaction boundary (an entry id) into the numeric `firstKeptIndex` that
 * {@link prepareCompaction} expects, computed against the SAME rebuilt context it will slice.
 * `entryIds` is `contextEntries.map((c) => c.entry?.id)`. Returns `undefined` — meaning "summarize fresh,
 * not incrementally" — when there is no prior compaction or its boundary is not on the current context
 * path (e.g. the kept entry was filtered out), which avoids a `firstKeptIndex: undefined → broken slice`.
 */
export function resolvePreviousCompaction(
	entryIds: ReadonlyArray<string | undefined>,
	latest:
		| { summary: string; firstKeptEntryId: string; details?: { readFiles: string[]; modifiedFiles: string[] } }
		| undefined,
): PreviousCompaction | undefined {
	if (!latest) return undefined;
	const firstKeptIndex = entryIds.findIndex((id) => id === latest.firstKeptEntryId);
	if (firstKeptIndex < 0) return undefined;
	return { summary: latest.summary, firstKeptIndex, details: latest.details };
}

/** Combine the history summary with an optional split-turn prefix summary into the stored summary body. */
export function combineSummaries(historySummary: string, prefixSummary: string | undefined): string {
	return prefixSummary
		? `${historySummary}\n\n---\n**Turn Context (split turn):**\n${prefixSummary}`
		: historySummary;
}
