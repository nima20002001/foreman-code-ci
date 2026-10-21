import type { AgentIdentity, ExecutionRef, CoordinatorConsultationBinding, LogicalWorkRef } from './agentIdentity.js';
import type { EngineChatReadback } from './workflowChat.js';
import type { MemoryBoard, MemoryCard } from './memoryBoards.js';

/** Deterministic public contract examples; these are not persisted/native acceptance evidence. */
const createdAt = '2026-10-20T00:00:00.000Z';
const agent: AgentIdentity = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'master',
  agentId: 'agent-master', productRole: 'master', displayName: 'Master', configurationVersionId: 'configuration-master' };
const execution: ExecutionRef = { runId: 'run', workflowVersionId: 'version', executionId: 'execution', activationId: 'activation', attempt: 1 };
const work: LogicalWorkRef = { kind: 'activation', runId: 'run', workflowVersionId: 'version', activationId: 'activation' };
const binding: CoordinatorConsultationBinding = { runId: 'run', workflowVersionId: 'version',
  waitingActivationId: 'activation', delegationGroupId: 'delegation', consultationId: 'consultation',
  nativeSessionId: 'session', purpose: 'consultation' };
const node = { workspaceId: agent.workspaceId, workflowId: agent.workflowId, workflowNodeId: agent.workflowNodeId, agentId: agent.agentId };
const capabilities = { steer: 'native_expected_turn' as const, queue: true, interruptAndSend: true };
const nativeMessage = { id: 'native-message', role: 'assistant' as const, content: 'Working on the task.',
  revision: '2', sequence: '1', acceptedModel: { harness: 'codex' as const, model: 'contract-fixture' }, createdAt };
const executionReadback: EngineChatReadback = {
  target: { kind: 'workflow_execution', agent: node, execution }, state: 'active', capabilities,
  messages: [{ ...nativeMessage, provenance: { kind: 'execution', execution } }], receipts: [],
  nextCursor: null, hasMore: false, revision: 2,
};
const consultationReadback: EngineChatReadback = {
  target: { kind: 'workflow_coordinator', agent: node, runId: binding.runId, waitingActivationId: binding.waitingActivationId },
  state: 'waiting_children', capabilities,
  messages: [{ ...nativeMessage, provenance: { kind: 'consultation', binding } }], receipts: [],
  nextCursor: null, hasMore: false, revision: 2,
};
const board: MemoryBoard = { id: 'board', scope: { kind: 'workflow', workspaceId: 'workspace', workflowId: 'workflow' }, revision: 1 };
const card: MemoryCard = { id: 'card', boardId: board.id, title: 'Shared task', body: '', status: 'doing',
  completionKind: null, reason: null, assignee: node, linkedNodes: [node], revision: 1, createdAt, updatedAt: createdAt };

export const collaborationContractFixtures = { createdAt, agent, node, execution, work, binding,
  nativeMessage, executionReadback, consultationReadback, board, card };
