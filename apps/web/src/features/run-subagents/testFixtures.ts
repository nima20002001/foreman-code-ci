import { RunSubagentSchema, RunSubagentMessageSchema, RunSubagentToolSchema, subagentCapabilities, type RunSubagent } from '@foreman-code/contracts/subagents'
import { runA } from '../run-board/testFixtures'

export const scope = { workspaceId: runA.workspaceId, workflowId: runA.workflowId, runId: runA.runId }
export const timestamp = '2026-10-03T01:00:00.000Z'
export const child = (overrides: Partial<RunSubagent> = {}) => RunSubagentSchema.parse({
  schemaVersion: 1, id: 'child-1', revision: '4', ...scope, workflowVersionId: runA.workflowVersionId,
  parentNodeId: 'node-x', parentAgentId: 'agent-x', parentExecutionId: 'execution-1', parentAttemptKey: 'execution-1:1',
  parentSubagentId: null, provider: 'codex', nativeMode: 'codex-multi-agent-v2',
  native: { parentSessionId: 'native-parent', childSessionId: 'native-child' },
  profile: { deviceId: 'device-1', harnessInstanceId: 'harness-1', providerVersion: '0.154.0' },
  name: 'Research', status: 'running', evidence: 'confirmed',
  firstObservedAt: timestamp, startedAt: timestamp, finishedAt: null, lastObservedAt: timestamp,
  coverage: { transcript: 'partial', tools: 'partial', gaps: true },
  capabilities: subagentCapabilities('codex-multi-agent-v2'), ...overrides,
})
export const detail = (record = child()) => ({ subagent: record, availableActions: { sendInput: false, interrupt: false, blockedReason: 'NO_QUALIFIED_CONTROL' } })
export const message = (id = 'message-1', text = 'Child answer') => RunSubagentMessageSchema.parse({
  id, subagentId: 'child-1', revision: '1', sequence: 1, nativeMessageId: id, role: 'assistant', text,
  final: true, occurredAt: timestamp, source: { executionId: 'execution-1', sequence: 1 },
  truncation: { truncated: true, originalBytes: 25000 },
})
export const tool = () => RunSubagentToolSchema.parse({
  id: 'tool-1', subagentId: 'child-1', revision: '1', sequence: 2, nativeToolId: 'native-tool', name: 'read_file',
  status: 'completed', input: { path: 'README.md' }, output: 'Read result', startedAt: timestamp, finishedAt: timestamp,
  source: { executionId: 'execution-1', sequence: 2 }, truncation: { truncated: true, originalBytes: 35000 },
})
export const base = '*/api/management/workspaces/:workspaceId/runs/:runId/subagents'

export const receipt = (overrides = {}) => ({ schemaVersion: 1, id: 'receipt-1', principalId: 'principal-1',
  operation: 'run_subagent_input_v1', commandId: 'command-1', workspaceId: scope.workspaceId, runId: scope.runId,
  subagentId: 'child-1', expectedRevision: '4', nativeGeneration: 'generation-1', nativeTurnId: 'turn-1',
  nativeCorrelationId: 'native-command-1', state: 'acknowledged', acceptedAt: timestamp, updatedAt: timestamp, ...overrides })
