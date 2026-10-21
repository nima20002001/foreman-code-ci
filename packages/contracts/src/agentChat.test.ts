import { describe, expect, it } from "vitest";

import { AgentChatStateSchema, SendAgentChatMessageRequestSchema, agentChatFixtures } from "./agentChat.js";
import { ReadSelectedRunChatResponseSchema } from './selectedRunChat.js';
import { CHAT_MAX_MESSAGE_JSON_BYTES } from './chatInput.js';

describe("agent chat contract", () => {
  it.each(['starting', 'running', 'completed'] as const)('accepts an empty %s source transcript at revision zero', state => {
    const context = { ...agentChatFixtures.empty.context, runId: 'source-run' };
    const sourceTranscript = { executionId: 'source-execution', state, revision: '0',
      messages: [], hasEarlierMessages: false };
    const value = { ...agentChatFixtures.empty, context, sourceTranscript };
    expect(AgentChatStateSchema.parse(value).sourceTranscript).toEqual(sourceTranscript);
    const target = { workspaceId: context.workspaceId, workflowId: context.workflowId,
      workflowNodeId: context.workflowNodeId, runId: context.runId, executionId: sourceTranscript.executionId };
    const selected = ReadSelectedRunChatResponseSchema.parse({ kind: 'selected', selection: target, key: null, state: value });
    expect(selected).toMatchObject({ kind: 'selected', state: { sourceTranscript } });
  });

  it.each(['starting', 'running', 'completed'] as const)('accepts a %s source transcript without creating a conversation', state => {
    const context = { ...agentChatFixtures.empty.context, runId: 'source-run' };
    const sourceTranscript = { executionId: 'source-execution', state, revision: '1',
      messages: [{ id: 'source-item', role: 'assistant', content: 'Public execution text' }], hasEarlierMessages: false };
    const value = { ...agentChatFixtures.empty, context, sourceTranscript };
    expect(AgentChatStateSchema.parse(value).sourceTranscript).toEqual(sourceTranscript);
    const target = { workspaceId: context.workspaceId, workflowId: context.workflowId,
      workflowNodeId: context.workflowNodeId, runId: context.runId };
    const selected = { kind: 'selected', selection: { ...target, executionId: 'source-execution' }, key: null, state: value };
    expect(ReadSelectedRunChatResponseSchema.safeParse(selected).success).toBe(true);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected,
      selection: { ...selected.selection, executionId: 'other-execution' } }).success).toBe(false);
  });

  it.each(Object.entries(agentChatFixtures))("parses the %s fixture", (_name, state) => {
    expect(AgentChatStateSchema.parse(state)).toEqual(state);
  });

  it("defaults intent to next_turn and requires an explicit expected conversation", () => {
    const parsed = SendAgentChatMessageRequestSchema.parse({ requestId: "r", content: "hi", expectedConversationId: null,
      context: { workflowId: "w", workflowNodeId: "n", agentId: "a" } });
    expect(parsed.intent).toBe("next_turn");
    expect(() => SendAgentChatMessageRequestSchema.parse({ requestId: "r", content: "hi",
      context: { workflowId: "w", workflowNodeId: "n", agentId: "a" } })).toThrow();
  });
});

it('accepts pasted logs within the encoded request budget and rejects character, UTF-8 and JSON overflow', () => {
  const request = { requestId: 'pasted-log', expectedConversationId: null,
    context: { workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' } };
  const content = 'x'.repeat(CHAT_MAX_MESSAGE_JSON_BYTES - 1024);
  expect(SendAgentChatMessageRequestSchema.parse({ ...request, content }).content).toBe(content);
  for (const oversized of ['x'.repeat(1_000_001), '界'.repeat(350_000), '\u0001'.repeat(200_000),
    'x'.repeat(CHAT_MAX_MESSAGE_JSON_BYTES - 2)]) {
    expect(SendAgentChatMessageRequestSchema.safeParse({ ...request, content: oversized }).success).toBe(false);
  }
});
