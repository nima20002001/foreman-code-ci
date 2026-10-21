import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentChatStateSchema } from "../src/agentChat.js";
import {
  AgentChatInterruptToolInputSchema, AgentChatReadToolInputSchema, AgentChatReadToolOutputSchema, AgentChatSendToolInputSchema,
  ReadSelectedRunChatRequestSchema, ReadSelectedRunChatResponseSchema, SendSelectedRunChatRequestSchema,
} from "../src/selectedRunChat.js";

const target = { workspaceId: "workspace-a", workflowId: "workflow-a", runId: "run-a", workflowNodeId: "node-a" };
const selection = { ...target, executionId: "execution-a" };
const key = { ...selection, agentId: "agent-a", conversationId: "conversation-a" };
const now = "2026-09-28T00:00:00.000Z";
function state() {
  return AgentChatStateSchema.parse({ context: { ...target, agentId: key.agentId }, conversation: {
    id: key.conversationId, workspaceId: key.workspaceId, workflowId: key.workflowId, workflowNodeId: key.workflowNodeId,
    agentId: key.agentId, agentConfigurationVersionId: "configuration-a", harness: "codex",
    origin: { kind: "run_execution", runId: key.runId, executionId: key.executionId, sourceNativeSessionId: "run-source" },
    nativeSession: { nativeSessionId: "chat-child", providerVersion: "fixture" }, createdAt: now, updatedAt: now,
  }, sessionState: "idle", availability: { canSend: true }, capabilities: { harness: "codex", providerVersion: "fixture",
    steer: "native_expected_turn", resume: true, queueNextTurn: true, interruptAndSend: true, unavailable: {} },
  activeTurn: null, turns: [], messages: [], hasEarlierMessages: false, activities: [], revision: 1 });
}
const selected = () => ({ kind: "selected", selection, key, state: state() });

describe("SCH-06 additive historical chat envelopes", () => {
  it("accepts only the complete matching selected identity and scopes every readback page", () => {
    expect(ReadSelectedRunChatResponseSchema.parse(selected()).kind).toBe("selected");
    for (const field of ["workspaceId", "workflowId", "runId", "workflowNodeId", "executionId", "agentId", "conversationId"] as const) {
      expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), key: { ...key, [field]: "other" } }).success).toBe(false);
    }
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), history: { conversationId: "other", messages: [], nextCursor: null } }).success).toBe(false);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), receipts: { conversationId: "other", turns: [], nextCursor: null } }).success).toBe(false);
    const wrongState = state(); wrongState.context.runId = "other";
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), state: wrongState }).success).toBe(false);
  });

  it("does not invent a conversation/key when no conversation exists", () => {
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), key: null }).success).toBe(false);
    const absent = { ...state(), conversation: null, sessionState: "none", revision: 0 };
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), state: absent, key: null }).success).toBe(true);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), state: absent }).success).toBe(false);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected(), state: absent, key: null,
      history: { conversationId: key.conversationId, messages: [], nextCursor: null } }).success).toBe(false);
  });

  it("requires execution selection without silently manufacturing a usable session", () => {
    const choice = { kind: "execution_selection_required", target,
      executions: [{ executionId: "e-1", attempt: 1 }, { executionId: "e-2", attempt: 2 }], hasMoreExecutions: false };
    expect(ReadSelectedRunChatResponseSchema.safeParse(choice).success).toBe(true);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...choice, executions: choice.executions.slice(0, 1) }).success).toBe(false);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ kind: "unavailable", target, reason: "legacy_run" }).success).toBe(true);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ kind: "unavailable", target, reason: "execution_missing" }).success).toBe(true);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...choice, key }).success).toBe(false);
  });

  it("has strict HTTP/service inputs: Agent identity and message context cannot override the snapshot", () => {
    expect(ReadSelectedRunChatRequestSchema.safeParse({ selection }).success).toBe(true);
    expect(ReadSelectedRunChatRequestSchema.safeParse({ selection: { ...selection, agentId: "forged" } }).success).toBe(false);
    const message = { requestId: "message-a", content: "Continue", expectedConversationId: null };
    expect(SendSelectedRunChatRequestSchema.parse({ selection, message }).message.intent).toBe("next_turn");
    expect(SendSelectedRunChatRequestSchema.safeParse({ selection: target, message }).success).toBe(false);
    expect(SendSelectedRunChatRequestSchema.safeParse({ selection, message: { ...message, context: { agentId: "forged" } } }).success).toBe(false);
  });

  it("keeps legacy MCP input/output shapes while advertising exact historical selectors", () => {
    const { workspaceId, ...query } = state().context;
    const { workspaceId: selectedWorkspace, ...historical } = selection;
    expect(selectedWorkspace).toBe(workspaceId);
    expect(AgentChatReadToolInputSchema.safeParse({ workspaceId, query }).success).toBe(true);
    expect(AgentChatReadToolInputSchema.safeParse({ workspaceId, selection: historical, history: {}, receipts: {} }).success).toBe(true);
    expect(AgentChatReadToolInputSchema.safeParse({ workspaceId, query, selection: historical }).success).toBe(false);
    expect(AgentChatReadToolInputSchema.safeParse({ workspaceId }).success).toBe(false);
    expect(AgentChatReadToolOutputSchema.safeParse(state()).success).toBe(true);
    expect(AgentChatReadToolOutputSchema.safeParse(selected()).success).toBe(true);
    expect(AgentChatReadToolOutputSchema.safeParse({ ...state(), ...selected() }).success).toBe(false);
    expect(z.toJSONSchema(AgentChatReadToolOutputSchema).type).toBe("object");
    expect(z.toJSONSchema(AgentChatReadToolInputSchema).properties).toHaveProperty("history");
    expect(z.toJSONSchema(AgentChatReadToolInputSchema).properties).toHaveProperty("selection");
  });

  it("accepts only one MCP send form and unwraps the frozen key only to project interrupt input", () => {
    const { workspaceId, ...historical } = selection;
    const { workspaceId: selectedWorkspace, ...context } = state().context;
    expect(selectedWorkspace).toBe(workspaceId);
    const message = { requestId: "send", content: "Hello", expectedConversationId: null };
    const request = { ...message, context };
    expect(AgentChatSendToolInputSchema.safeParse({ workspaceId, request }).success).toBe(true);
    expect(AgentChatSendToolInputSchema.safeParse({ workspaceId, selection: historical, message }).success).toBe(true);
    expect(AgentChatSendToolInputSchema.safeParse({ workspaceId, request, selection: historical, message }).success).toBe(false);
    expect(AgentChatSendToolInputSchema.safeParse({ workspaceId, message }).success).toBe(false);
    expect(AgentChatInterruptToolInputSchema.safeParse({ workspaceId, conversationId: key.conversationId, requestId: "stop",
      selection: { ...historical, agentId: key.agentId } }).success).toBe(true);
  });
});
