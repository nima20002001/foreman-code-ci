import { expect, it } from 'vitest'
import { agentConversation, type AgentConversationRow } from './agentChatRepository.js'

it('keeps a retired conversation native identity and origin readable without changing its stored facts', () => {
  const row: AgentConversationRow = {
    id: 'conversation',
    agent_key: 'saved-chat',
    workspace_id: 'workspace',
    workflow_id: 'workflow',
    workflow_node_id: 'node',
    agent_id: 'agent',
    agent_configuration_version_id: 'saved-configuration',
    origin_run_id: 'run',
    origin_execution_id: 'execution',
    harness: 'opencode',
    provider_version: 'saved-provider-version',
    native_session_id: 'saved-session',
    active_request_id: null,
    active_native_turn_id: null,
    cancel_requested: false,
    turn_state: 'idle',
    last_error: null,
    revision: '7',
    pending_interaction: null,
    last_result: null,
    record: {
      origin: { kind: 'run_execution', runId: 'run', executionId: 'execution', sourceNativeSessionId: 'source-session' },
      workingDirectory: '/saved/project',
      runtimeDirectory: '/saved/runtime',
    },
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-02T00:00:00.000Z'),
  }
  const saved = structuredClone(row)
  expect(agentConversation(row)).toMatchObject({
    id: row.id,
    harness: 'opencode',
    agentConfigurationVersionId: 'saved-configuration',
    origin: row.record.origin,
    nativeSession: { nativeSessionId: 'saved-session', providerVersion: 'saved-provider-version' },
  })
  expect(row).toEqual(saved)
})
