// New (Convex backend) · @cove/runtime — the ChannelAdapter contract (doc 06 P11). One place the inbound +
// outbound channel shape lives: verify (raw-bytes signature) → mapPayload (→ submit | handshake | ignore) →
// postReply (after the run terminalizes). Pure types — no Convex runtime import, V8-safe — so both the route
// (convex/channels/inbound.ts) and the per-channel tests import it. The four-step pipeline + reply trigger are
// fixed (D14: reuse agentRequests, no inbound table); each provider only supplies its adapter.

/** Per-channel signature/JWT verification result (over the RAW request bytes). */
export type VerifyResult = { ok: true } | { ok: false; status: number; message?: string };

/** Reply-address state captured at admission and frozen on the request row so a finished run can reply. */
export interface ReplyContext {
	/** Channel name (the channelRegistry key). */
	provider: string;
	/** Primary reply target (channel id / chat id / issue url / space — channel-specific). */
	target: string;
	/** Thread/parent id to reply in-thread (Slack thread_ts, Discord/Telegram message id, …). */
	threadId?: string;
	/** A one-shot response URL (Slack response_url, Discord interaction webhook), if the channel uses one. */
	responseUrl?: string;
	/** Channel-specific extra addressing (team id, serviceUrl, org id, …). */
	addressing?: unknown;
}

/** What an inbound event maps to: admit a run, answer a handshake, or ignore (bot echo / non-message). */
export type MapResult =
	| { kind: "submit"; spec: SubmitSpec }
	| { kind: "handshake"; body: unknown }
	| { kind: "ignore" };

/** The admission spec a mapped inbound event produces. */
export interface SubmitSpec {
	message: string;
	instanceId: string;
	sessionName: string;
	/** Provider-scoped dedup id (a replayed delivery with the same id is a no-op). */
	eventId: string;
	replyContext: ReplyContext;
	model?: string;
}

/** The terminal run state postReply addresses (read off the finalized agentRequests row). */
export interface TerminalResult {
	status: "completed" | "failed" | "cancelled";
	finalText?: string;
	result?: unknown;
	error?: string;
}

/**
 * A channel adapter. `verify`/`mapPayload` run inline in the inbound V8 httpAction; `postReply` runs later in
 * the reply.dispatch action (after the run terminalizes). No box, no LLM — channels admit + reply only (08 §3).
 */
export interface ChannelAdapter {
	/** channelRegistry key + the `/channels/<name>` path segment. */
	name: string;
	/** Verify the provider signature/JWT over the RAW bytes (read once, before JSON.parse). */
	verify(req: Request, rawBody: string): Promise<VerifyResult>;
	/**
	 * Map the parsed payload to an action. `req` is passed so channels can read routing headers
	 * (GitHub `x-github-event`/`x-github-delivery`, etc.). An ignore/handshake branch avoids self-reply loops.
	 */
	mapPayload(parsed: unknown, req: Request): MapResult;
	/** Post the terminal result back to the channel (after finalize; exactly once via the repliedAt guard). */
	postReply(replyContext: ReplyContext, terminal: TerminalResult): Promise<void>;
}
