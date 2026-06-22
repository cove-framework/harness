// Ported from flue · @flue/react · packages/react/src/use-agent.ts (split) → @cove/react
// One half of flue's `useFlueAgent` split: the SUBMIT side. Owns the submit call
// (the client's `agents.send`, backed by `api.invoke.submitPrompt`) and stores the
// returned `{ requestId, submissionId }`. No event subscription here — that is
// `useRunEvents`. `useResolvedCoveClient` resolves the client from a prop, a
// `<CoveProvider>`, or the ambient `ConvexReactClient`.

import { useCallback, useState } from "react";
import type { AgentPromptImage, CoveReactiveClient } from "./client-types.ts";
import { useResolvedCoveClient } from "./provider.tsx";

export type AgentPromptStatus = "idle" | "submitting" | "submitted" | "error";

export interface UseAgentPromptOptions {
	/** Explicit reactive client (otherwise resolved from provider/ambient). */
	client?: CoveReactiveClient;
	/** Target agent instance id. Defaults to `'default'`. */
	instanceId?: string;
	/** Harness name. Defaults to the backend default. */
	harnessName?: string;
	/** Session name. Defaults to the backend default. */
	sessionName?: string;
	/** Model override for submitted prompts. */
	model?: string;
}

export interface SubmitPromptOptions {
	images?: AgentPromptImage[];
	instanceId?: string;
	harnessName?: string;
	sessionName?: string;
	model?: string;
}

export interface UseAgentPromptResult {
	/** Admit one prompt; resolves with the admission ids and stores them on the hook. */
	submit(message: string, options?: SubmitPromptOptions): Promise<void>;
	/** `agentRequests` id of the most recent submission, or `undefined`. */
	requestId: string | undefined;
	/** Correlation id of the most recent submission, or `undefined`. */
	submissionId: string | undefined;
	/** Submission lifecycle state for the most recent submit. */
	status: AgentPromptStatus;
	/** Error from the most recent failed submit. */
	error: Error | undefined;
}

export function useAgentPrompt(options: UseAgentPromptOptions = {}): UseAgentPromptResult {
	const client = useResolvedCoveClient(options.client);
	const [requestId, setRequestId] = useState<string | undefined>(undefined);
	const [submissionId, setSubmissionId] = useState<string | undefined>(undefined);
	const [status, setStatus] = useState<AgentPromptStatus>("idle");
	const [error, setError] = useState<Error | undefined>(undefined);

	const submit = useCallback(
		async (message: string, submitOptions: SubmitPromptOptions = {}) => {
			setStatus("submitting");
			setError(undefined);
			try {
				const receipt = await client.agents.send({
					message,
					images: submitOptions.images,
					instanceId: submitOptions.instanceId ?? options.instanceId,
					harnessName: submitOptions.harnessName ?? options.harnessName,
					sessionName: submitOptions.sessionName ?? options.sessionName,
					model: submitOptions.model ?? options.model,
				});
				setRequestId(receipt.requestId);
				setSubmissionId(receipt.submissionId);
				setStatus("submitted");
			} catch (caught) {
				const normalized = caught instanceof Error ? caught : new Error(String(caught));
				setError(normalized);
				setStatus("error");
				throw normalized;
			}
		},
		[client, options.instanceId, options.harnessName, options.sessionName, options.model],
	);

	return { submit, requestId, submissionId, status, error };
}
