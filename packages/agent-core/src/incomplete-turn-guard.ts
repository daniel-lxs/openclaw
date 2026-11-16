import { streamAgentResponse, type ExecutedToolCallBatch } from "./agent-stream-response.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  NON_FINAL_RESPONSE_LIMIT_CODE,
} from "./incomplete-turn.js";
import { createFailureMessage } from "./turn-interruption.js";

/** Bound tool-free nonterminal responses within one loop invocation. */
export function createIncompleteTurnGuard() {
  let nonFinalResponses = 0;
  return {
    reset() {
      nonFinalResponses = 0;
    },
    async streamResponse(
      ...args: Parameters<typeof streamAgentResponse>
    ): ReturnType<typeof streamAgentResponse> {
      if (nonFinalResponses <= DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT) {
        return streamAgentResponse(...args);
      }
      const [context, config, , emit, newMessages] = args;
      const reason =
        "The model repeatedly returned a non-final response without tool progress. Stopped instead of requesting another response.";
      const message = {
        ...createFailureMessage(config.model, new Error(reason), false),
        endTurn: true,
        errorCode: NON_FINAL_RESPONSE_LIMIT_CODE,
        content: [{ type: "text" as const, text: reason }],
      };
      context.messages.push(message);
      newMessages.push(message);
      await emit({ type: "message_start", message });
      await emit({ type: "message_end", message });
      return { message, executedIds: new Set<string>(), batches: [], continuationRequired: false };
    },
    shouldContinue(
      response: Awaited<ReturnType<typeof streamAgentResponse>>,
      toolBatch: ExecutedToolCallBatch | undefined,
    ): boolean {
      const { message } = response;
      // Commentary is not progress. Tools and committed user input reset the streak.
      nonFinalResponses =
        message.stopReason === "stop" &&
        message.endTurn === false &&
        toolBatch === undefined &&
        !response.continuationRequired
          ? nonFinalResponses + 1
          : 0;
      return (
        response.continuationRequired ||
        (message.stopReason === "stop" && message.endTurn === false && !toolBatch?.terminate) ||
        (toolBatch !== undefined && !toolBatch.terminate)
      );
    },
  };
}
