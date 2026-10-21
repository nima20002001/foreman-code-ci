import type { AgentChatCapabilities, AgentChatState, AgentChatTurn, AgentConversation } from "./agentChat.js";

/** Frozen NIM-2682 fixtures shared by backend tests and web MSW handlers. Deterministic, no secrets. */
const at = "2026-09-27T12:00:00.000Z";
const agentChatFixtureContext = {
  workspaceId: "workspace-fixture", workflowId: "workflow-fixture", workflowNodeId: "node-coder", agentId: "agent-coder",
} as const;

export const codexChatCapabilities: AgentChatCapabilities = {
  harness: "codex", providerVersion: "0.157.1", steer: "native_expected_turn",
  interruptAndSend: true, queueNextTurn: true, resume: true, unavailable: {},
};
export const claudeChatCapabilities: AgentChatCapabilities = {
  harness: "claude", providerVersion: "2.1.128", steer: "unavailable",
  interruptAndSend: true, queueNextTurn: true, resume: true, unavailable: {},
};
const steerUnavailableCapabilities: AgentChatCapabilities = {
  ...claudeChatCapabilities, steer: "unavailable",
  unavailable: { steer: "Claude cannot add input to a running turn. Queue it or interrupt and send." },
};

const conversation: AgentConversation = {
  id: "agent-conversation-fixture", ...agentChatFixtureContext, agentConfigurationVersionId: "agent-config-fixture",
  harness: "codex", origin: { kind: "fresh" },
  nativeSession: { nativeSessionId: "codex-thread-fixture", providerVersion: "0.157.1" }, createdAt: at, updatedAt: at,
};
const turn = (requestId: string, sequence: string, delivery: AgentChatTurn["delivery"], extra: Partial<AgentChatTurn> = {}): AgentChatTurn => ({
  requestId, sequence, intent: "next_turn", delivery, messageId: `message-${requestId}`, createdAt: at, updatedAt: at, ...extra,
});
const userMessage = (requestId: string, content: string) => ({
  id: `message-${requestId}`, conversationId: conversation.id, requestId, role: "user" as const, content, createdAt: at,
});
const base: AgentChatState = {
  context: { ...agentChatFixtureContext }, conversation: null, sessionState: "none",
  availability: { canSend: true }, capabilities: codexChatCapabilities, activeTurn: null,
  turns: [], messages: [], hasEarlierMessages: false, activities: [], revision: 0,
};

export const agentChatFixtures = {
  /** No conversation yet: first send creates the native session. */
  empty: base,
  /** First turn running with public activity and a partial reply. */
  active: {
    ...base, conversation, sessionState: "active", revision: 3,
    activeTurn: { requestId: "request-1", nativeTurnId: "turn-1", startedAt: at },
    turns: [turn("request-1", "1", "accepted", { nativeTurnId: "turn-1" })],
    messages: [userMessage("request-1", "Summarize the repository."),
      { id: "message-reply-1", conversationId: conversation.id, requestId: "request-1", role: "assistant", content: "Reading the README",
        nativeMessageComplete: false, createdAt: at }],
    activities: [{ id: "activity-1", requestId: "request-1", sequence: "1", revision: 1, kind: "file_read", title: "Read README.md", status: "completed" }],
  },
  /** Active turn with a queued next turn and an accepted steer. */
  activeWithQueue: {
    ...base, conversation, sessionState: "active", revision: 5,
    activeTurn: { requestId: "request-1", nativeTurnId: "turn-1", startedAt: at },
    turns: [turn("request-1", "1", "accepted", { nativeTurnId: "turn-1" }),
      turn("request-2", "2", "accepted", { intent: "steer", targetNativeTurnId: "turn-1", nativeTurnId: "turn-1" }),
      turn("request-3", "3", "queued")],
    messages: [userMessage("request-1", "Summarize the repository."), userMessage("request-2", "Focus on the API."),
      userMessage("request-3", "Then list open TODOs.")],
  },
  /** Finished conversation: composer continues the same native session. */
  idleAfterCompletion: {
    ...base, conversation, sessionState: "idle", revision: 7,
    turns: [turn("request-1", "1", "completed", { nativeTurnId: "turn-1" })],
    messages: [userMessage("request-1", "Summarize the repository."),
      { id: "message-reply-1", conversationId: conversation.id, requestId: "request-1", role: "assistant", content: "It is a workflow engine.",
        nativeMessageComplete: true, createdAt: at }],
    lastResult: { outcome: "succeeded" },
  },
  /** Submission could not be proven. The UI must not offer a blind resend. */
  unknownDelivery: {
    ...base, conversation, sessionState: "uncertain", revision: 4,
    turns: [turn("request-1", "1", "unknown", { error: { code: "DELIVERY_UNCONFIRMED", message: "The provider did not confirm this message." } })],
    messages: [userMessage("request-1", "Summarize the repository.")],
  },
  failed: {
    ...base, conversation, sessionState: "error", revision: 4,
    turns: [turn("request-1", "1", "failed", { error: { code: "NATIVE_TURN_FAILED", message: "Codex exited before finishing." } })],
    messages: [userMessage("request-1", "Summarize the repository.")],
    lastResult: { outcome: "failed", error: { code: "NATIVE_TURN_FAILED", message: "Codex exited before finishing.", retryable: true } },
  },
  /** The selected Run still owns this Agent's native work. */
  runActive: {
    ...base, context: { ...agentChatFixtureContext, runId: "run-fixture" }, availability: {
      canSend: false, reason: "run_active", message: "This Agent is working in the selected Run. Chat opens when the Run finishes.",
    },
  },
  /** Stored native session cannot be resumed (storage removed or provider changed). */
  sessionMissing: {
    ...base, conversation, sessionState: "unavailable", revision: 9,
    availability: { canSend: false, reason: "native_session_missing", message: "The native session for this chat no longer exists." },
    capabilities: { ...codexChatCapabilities, resume: false, unavailable: { resume: "Codex no longer has this thread." } },
    messages: [userMessage("request-1", "Summarize the repository.")],
  },
  steerUnavailable: {
    ...base, conversation: { ...conversation, harness: "claude" }, sessionState: "active", revision: 3,
    capabilities: steerUnavailableCapabilities,
    activeTurn: { requestId: "request-1", startedAt: at },
    turns: [turn("request-1", "1", "accepted")],
    messages: [userMessage("request-1", "Summarize the repository.")],
  },
} satisfies Record<string, AgentChatState>;
