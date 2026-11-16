import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { NON_FINAL_RESPONSE_LIMIT_CODE } from "./incomplete-turn.js";
import { withAssistantTurnTaint } from "./turn-taint.js";
import type { AgentEvent, AgentMessage } from "./types.js";

/** Canonical empty aborted/error assistant recorded when a run ends without output. */
export function createFailureMessage(
  model: Model,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function createNonFinalResponseLimitMessage(model: Model): AssistantMessage {
  const reason =
    "The model repeatedly returned a non-final response without tool progress. Stopped instead of requesting another response.";
  return {
    ...createFailureMessage(model, new Error(reason), false),
    endTurn: true,
    errorCode: NON_FINAL_RESPONSE_LIMIT_CODE,
    content: [{ type: "text", text: reason }],
  };
}

/** Complete an aborted loop; callers return immediately when this reports true. */
export async function stopAbortedAgentLoop(params: {
  model: Model;
  signal: AbortSignal | undefined;
  newMessages: AgentMessage[];
  emit: (event: AgentEvent) => Promise<void> | void;
  turnOpen: boolean;
  turnTainted: boolean;
  isLocalError?: (error: unknown) => boolean;
}): Promise<boolean> {
  const { signal, newMessages, emit } = params;
  if (!signal?.aborted) {
    return false;
  }
  if (params.isLocalError?.(signal.reason)) {
    throw signal.reason;
  }
  // Persist an aborted assistant outcome so session post-processing does not
  // compact or continue from the preceding toolUse message.
  const abortedMessage = withAssistantTurnTaint(
    createFailureMessage(
      params.model,
      signal.reason instanceof Error ? signal.reason : new Error("Agent run aborted"),
      true,
    ),
    params.turnTainted,
  );
  newMessages.push(abortedMessage);
  if (!params.turnOpen) {
    await emit({ type: "turn_start" });
  }
  await emit({ type: "message_start", message: abortedMessage });
  await emit({ type: "message_end", message: abortedMessage });
  await emit({ type: "turn_end", message: abortedMessage, toolResults: [] });
  if (!isTurnHandoffAbort(signal)) {
    await appendInterruptedTurnMessage(newMessages, emit);
  }
  await emit({ type: "agent_end", messages: newMessages });
  return true;
}

// Not re-exported from the package barrel on purpose: these helpers are
// internal loop/harness plumbing, not public agent-core API surface.
const INTERRUPTED_TURN_GUIDANCE = `<turn_aborted>
The previous turn was interrupted. Any running background processes may still be active. If any tools or commands were aborted, they may have partially executed.
</turn_aborted>`;

/**
 * Aborts that end a turn as an intentional handoff (e.g. yield-style tools)
 * mark it with an abort reason carrying `turnHandoff: true`. Interruption
 * guidance is skipped for them: the next turn would otherwise be told tools
 * may have partially executed after a clean, deliberate stop.
 */
export function isTurnHandoffAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason: unknown = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { turnHandoff?: unknown }).turnHandoff === true
  );
}

export async function appendInterruptedTurnMessage(
  messages: AgentMessage[],
  emit: (event: AgentEvent) => Promise<void> | void,
): Promise<void> {
  const interruption: AgentMessage = {
    role: "custom",
    customType: "openclaw:turn-aborted",
    content: INTERRUPTED_TURN_GUIDANCE,
    display: false,
    timestamp: Date.now(),
  };
  messages.push(interruption);
  await emit({ type: "message_start", message: interruption });
  await emit({ type: "message_end", message: interruption });
}
