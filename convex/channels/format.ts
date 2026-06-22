// New (Convex backend) · @cove/runtime — shared outbound reply text. Every channel's postReply renders the
// terminal run state to a human string the same way (completed → finalText, failed → the error, cancelled).
import type { TerminalResult } from "./types.ts";

export function replyText(terminal: TerminalResult): string {
	if (terminal.status === "completed") return terminal.finalText?.trim() || "(the agent returned no text)";
	if (terminal.status === "failed") return `⚠️ The agent run failed: ${terminal.error ?? "unknown error"}`;
	return "(the agent run was cancelled)";
}
