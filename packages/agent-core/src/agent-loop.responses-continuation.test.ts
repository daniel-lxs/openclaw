import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "../../../test/helpers/openai-responses-sse.js";
import { streamOpenAIResponses } from "../../ai/src/providers/openai-responses.js";
import { buildOpenAIResponsesParams } from "../../ai/src/transports/openai-responses-params-internal.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../ai/src/utils/system-prompt-cache-boundary.js";
import {
  captureAgentLoop,
  config,
  createTurnSequenceStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  model as baseModel,
  reply,
  user,
} from "./agent-loop.test-support.js";
import { Agent } from "./agent.js";
import { setInternalBeforeRequest } from "./internal-hooks.js";
import type { Message, Model } from "./llm.js";
import type { AgentEvent, AgentMessage } from "./types.js";

// Closing snapshots hide aliased text-delta doubling; inspect live updates through real SSE.

const WIRE_TEXT = "夜班巡检记录：雾笛、备用灯与无线电均正常。";
const DELTAS = ["夜班巡检记录：", "雾笛、备用灯与无", "线电均正常。"];

it("prepares each live agent's prompt once across interleaved requests and refreshes changed bytes", async () => {
  const model: Model = {
    ...baseModel,
    provider: "openai",
    api: "openai-responses",
    compat: { supportsInstructions: true },
  };
  const prompts = Array.from(
    { length: 65 },
    (_, i) => `Session ${i}${SYSTEM_PROMPT_CACHE_BOUNDARY}Keep 🦞.\ud800`,
  );
  const requests: string[] = [];
  const agents = prompts.map(
    (systemPrompt) =>
      new Agent({
        initialState: { model, systemPrompt },
        streamFn: (_model, context) => {
          const params = buildOpenAIResponsesParams(model, context, undefined);
          requests.push(params.instructions ?? "");
          return reply(makeAssistantMessage([{ type: "text", text: "done" }]));
        },
      }),
  );
  const replacements = vi.spyOn(String.prototype, "replaceAll");
  try {
    for (let round = 0; round < 2; round++) {
      for (const agent of agents) {
        await agent.prompt("continue");
      }
    }
    const expected = prompts.map((_, i) => `Session ${i}\nKeep 🦞.`);
    expect(requests).toEqual([...expected, ...expected]);
    expect(
      replacements.mock.calls.filter(([marker]) => marker === SYSTEM_PROMPT_CACHE_BOUNDARY),
    ).toHaveLength(65);
    const first = agents[0];
    assert(first);
    first.state.systemPrompt = `Changed${SYSTEM_PROMPT_CACHE_BOUNDARY}Now 🦀.\udc00`;
    await first.prompt("continue");
    expect(requests.at(-1)).toBe("Changed\nNow 🦀.");
    expect(
      replacements.mock.calls.filter(([marker]) => marker === SYSTEM_PROMPT_CACHE_BOUNDARY),
    ).toHaveLength(66);
  } finally {
    replacements.mockRestore();
  }
});

function providerEvents(): Record<string, unknown>[] {
  const item = {
    type: "message",
    id: "msg_1",
    status: "completed",
    content: [{ type: "output_text", text: WIRE_TEXT }],
  };
  const textPart = { item_id: "msg_1", content_index: 0 };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      ...textPart,
      part: { type: "output_text", text: "" },
    },
    ...DELTAS.map((delta) => ({
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      ...textPart,
      text: WIRE_TEXT,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        end_turn: true,
        output: [item],
        usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
      },
    },
  ];
}

function messageUpdateTexts(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => {
    if (
      event.type !== "message_update" ||
      !("content" in event.message) ||
      typeof event.message.content === "string"
    ) {
      return [];
    }
    return event.message.content.flatMap((block) =>
      block.type === "text" && block.text.length > 0 ? [block.text] : [],
    );
  });
}

it("openai-responses live message updates grow strictly, never doubling the opening", async () => {
  const server = createServer((_req, res) => writeOpenAiResponsesSse(res, providerEvents()));
  const baseUrl = await listenLoopback(server);
  try {
    const model: Model<"openai-responses"> = {
      ...baseModel,
      name: "Test model",
      provider: "volcengine-plan",
      api: "openai-responses",
      baseUrl: `${baseUrl}/v1`,
      contextWindow: 8192,
      maxTokens: 256,
    };
    const run = captureAgentLoop(
      [user("Report the night watch log.")],
      { systemPrompt: "", messages: [], tools: [] },
      { ...config, model },
      undefined,
      (_loopModel, context, options) =>
        streamOpenAIResponses(model, context, { ...options, apiKey: "test-key" }),
    );
    await run.result;

    const updates = messageUpdateTexts(run.events);
    expect(updates.length).toBeGreaterThan(0);
    for (const [index, text] of updates.entries()) {
      expect(WIRE_TEXT.startsWith(text)).toBe(true);
      if (index > 0) {
        expect(text.startsWith(updates[index - 1] ?? "")).toBe(true);
      }
    }
    expect(updates.at(-1)).toBe(WIRE_TEXT);
  } finally {
    server.close();
  }
});

describe("Agent next-turn preparation", () => {
  const model = baseModel;

  it.each([false, true])(
    "adopts committed messages at request boundaries without persistence events (abort=%s)",
    async (abortContinuation) => {
      const initial = makeAssistantMessage([{ type: "text", text: "initial background result" }]);
      const continuation = makeAssistantMessage([
        { type: "text", text: "later background result" },
      ]);
      let pending: AgentMessage[] | undefined = [initial];
      const requests: Message[][] = [];
      const events: AgentEvent[] = [];
      const tool = {
        ...makeTool("lookup"),
        execute: async () => {
          pending = [continuation];
          return { content: [{ type: "text" as const, text: "lookup result" }], details: {} };
        },
      };
      const agent = new Agent({
        initialState: { model, tools: [tool] },
        streamFn: createTurnSequenceStream(
          [
            [makeCall("lookup")],
            [{ type: "text", text: "lookup complete" }],
            [{ type: "text", text: "follow-up complete" }],
          ],
          requests,
        ),
        prepareNextTurn: () => ({ model: { ...model, id: "next-model" } }),
      });
      agent.subscribe((event) => void events.push(event));
      setInternalBeforeRequest(agent, async () => {
        const messages = pending;
        pending = undefined;
        if (abortContinuation && messages?.includes(continuation)) {
          agent.abort();
        }
        return messages;
      });

      await agent.prompt("run lookup");
      expect(requests).toHaveLength(abortContinuation ? 1 : 2);
      expect(requests[0]?.at(-1)).toEqual(initial);
      if (!abortContinuation) {
        expect(requests[1]?.at(-1)).toEqual(continuation);
      }
      expect(events.at(-1)).toMatchObject({
        type: "agent_end",
        messages: expect.arrayContaining([initial, continuation]),
      });
      expect(
        events.some(
          (event) =>
            event.type === "message_end" &&
            (event.message === initial || event.message === continuation),
        ),
      ).toBe(false);

      await agent.prompt("follow up");
      for (const artifact of [initial, continuation]) {
        expect(requests.at(-1)?.filter((message) => message === artifact)).toHaveLength(1);
        expect(agent.state.messages.filter((message) => message === artifact)).toHaveLength(1);
      }
    },
  );
});

it.each([
  {
    label: "streamed commentary without a snapshot",
    phase: "commentary",
    streamed: true,
    continueWork: true,
  },
  {
    label: "a final snapshot after streamed commentary",
    phase: "commentary",
    streamed: true,
    withFinal: true,
    continueWork: false,
  },
  { label: "snapshot commentary", phase: "commentary", continueWork: true },
  { label: "repeated commentary", repeated: true, continueWork: false },
  { label: "new user input after commentary", repeated: true, steer: true, continueWork: false },
  {
    label: "commentary after tool progress",
    phase: "commentary",
    afterTool: true,
    continueWork: true,
  },
  { label: "a snapshot refusal", phase: "commentary", refusal: true, continueWork: false },
  {
    label: "a streamed refusal without a snapshot",
    phase: "commentary",
    refusal: true,
    streamed: true,
    continueWork: false,
  },
  { label: "explicit continuation", phase: "commentary", endTurn: false, continueWork: true },
  { label: "explicit turn end", phase: "commentary", endTurn: true, continueWork: false },
  { label: "final answer", phase: "final_answer", continueWork: false },
  { label: "unphased answer", continueWork: false },
  {
    label: "commentary followed by a final answer",
    phase: "commentary",
    withFinal: true,
    continueWork: false,
  },
])(
  "Responses follows through after $label without overriding terminal answers",
  async ({
    phase,
    streamed,
    endTurn,
    withFinal,
    refusal,
    repeated,
    afterTool,
    steer,
    continueWork,
  }) => {
    const requests: Record<string, unknown>[] = [];
    const executed: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body) as Record<string, unknown>);
        const index = requests.length;
        const textItem = (id: string, text: string, messagePhase?: string) => ({
          type: "message",
          id,
          role: "assistant",
          status: "completed",
          ...(messagePhase ? { phase: messagePhase } : {}),
          content:
            refusal && id === "msg_progress"
              ? [{ type: "refusal", refusal: "I cannot help with that request." }]
              : [{ type: "output_text", text, annotations: [] }],
        });
        const output =
          // The fourth response is a fixture escape hatch so the unfixed loop fails without hanging.
          (repeated && index < (steer ? 3 : 4)) || (afterTool && index === 3)
            ? [textItem("msg_" + index, "Still checking " + index, "commentary")]
            : index === 2
              ? [
                  {
                    type: "function_call",
                    id: "fc_check",
                    call_id: "call_check",
                    name: "check",
                    arguments: "{}",
                    status: "completed",
                  },
                ]
              : index === 1
                ? [
                    textItem("msg_progress", "I'll look into it now.", phase),
                    ...(withFinal
                      ? [textItem("msg_answer", "Already checked.", "final_answer")]
                      : []),
                  ]
                : [textItem("msg_final", "The check passed.", "final_answer")];
        writeOpenAiResponsesSse(res, [
          ...(streamed
            ? output.slice(0, 1).map((item, output_index) => ({
                type: "response.output_item.done",
                output_index,
                item,
              }))
            : []),
          {
            type: "response.completed",
            response: {
              id: "resp_" + index,
              status: "completed",
              ...(index === 1 && endTurn !== undefined ? { end_turn: endTurn } : {}),
              output: streamed && !withFinal ? [] : output,
              usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
            },
          },
        ]);
      });
    });
    const baseUrl = await listenLoopback(server);
    const responseModel: Model<"openai-responses"> = {
      ...baseModel,
      provider: "openai",
      api: "openai-responses",
      baseUrl: baseUrl + "/v1",
      contextWindow: 8192,
      maxTokens: 256,
    };
    let steered = false;
    try {
      const run = captureAgentLoop(
        [user("Check the result and report it.")],
        { systemPrompt: "", messages: [], tools: [makeTool("check", executed)] },
        {
          ...config,
          model: responseModel,
          getSteeringMessages: async () => {
            if (steer && requests.length === 2 && !steered) {
              steered = true;
              return [user("Finish from the current state.")];
            }
            return [];
          },
        },
        undefined,
        (_model, context, options) =>
          streamOpenAIResponses(responseModel, context, { ...options, apiKey: "test-key" }),
      );
      const result = await run.result;
      expect(executed).toEqual(continueWork ? ["check"] : []);
      expect(requests).toHaveLength(
        steer ? 3 : repeated ? 2 : afterTool ? 4 : continueWork ? 3 : 1,
      );
      if (repeated && !steer) {
        expect(result.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "error",
          errorCode: "non_final_response_limit",
        });
        const assistants = result.filter((message) => message.role === "assistant");
        expect(assistants.map((message) => message.usage.output)).toEqual([12, 12, 0]);
        expect(assistants.slice(0, 2)).toMatchObject([
          { content: [{ text: "Still checking 1" }] },
          { content: [{ text: "Still checking 2" }] },
        ]);
      }
      expect(run.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
      if (continueWork || steer) {
        expect(result.at(-1)).toMatchObject({
          role: "assistant",
          content: [expect.objectContaining({ text: "The check passed." })],
        });
      }
      if (continueWork) {
        expect(requests[1]?.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "message", role: "assistant", phase: "commentary" }),
          ]),
        );
        expect(requests[2]?.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "call_check",
              output: "check result",
            }),
          ]),
        );
        expect(JSON.stringify(requests)).not.toContain("openai_responses_terminal");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
