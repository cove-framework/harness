// New (Convex backend) · @cove/runtime — the channel registry (doc 06 P11). name → ChannelAdapter, resolved
// by the generic `/channels/<name>` route in http.ts and by reply.dispatch. Eight ship-first adapters; the
// deferred + obsolete sets are documented (not built) below. Plain module (no Convex functions).

import { discordAdapter } from "./discord/index.ts";
import { githubAdapter } from "./github/index.ts";
import { googleChatAdapter } from "./googlechat/index.ts";
import { linearAdapter } from "./linear/index.ts";
import { notionAdapter } from "./notion/index.ts";
import { slackAdapter } from "./slack/index.ts";
import { teamsAdapter } from "./teams/index.ts";
import { telegramAdapter } from "./telegram/index.ts";
import type { ChannelAdapter } from "./types.ts";

/** The ship-first channel set. A `/channels/<key>` POST resolves its adapter here. */
export const channelRegistry: Record<string, ChannelAdapter> = {
	slack: slackAdapter,
	github: githubAdapter,
	teams: teamsAdapter,
	discord: discordAdapter,
	telegram: telegramAdapter,
	linear: linearAdapter,
	notion: notionAdapter,
	"google-chat": googleChatAdapter,
};

// Deferred ship-first channels — same ChannelAdapter contract, scheduled after this set, intentionally NOT
// built yet: intercom, resend, salesforce-marketing-cloud, zendesk.
// TBD (not yet scoped): messenger, whatsapp, twilio, shopify, stripe.
// SQL storage backends (postgres/libsql/mysql/mongodb/redis) are OBSOLETE (D1) — collapsed into the single
// Convex adapter; no adapter code exists (doc 08 §5).
