import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, SessionPreferencesSchema } from '@foreman-code/contracts'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import type { AgentConversationRow, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import { memorySessionControlPool } from './support/sessionControls.js'

it.each(['uninitialized', 'initialized'] as const)(
  'stops polling a restarted local Codex creation with %s lost memory without replay', async state => {
    const f = workerConversationFixture('agent')
    const configuration = AgentConfigurationVersionSchema.parse(f.configuration)
    delete configuration.harnessProfileSelection
    const now = new Date()
    const row: AgentConversationRow = { id: f.binding.owner.conversationId, agent_key: 'agent-key',
      workspace_id: configuration.workspaceId, workflow_id: 'workflow', workflow_node_id: 'node',
      agent_id: configuration.agentId, agent_configuration_version_id: configuration.id,
      origin_run_id: null, origin_execution_id: null, harness: 'codex', native_session_id: null,
      provider_version: null, active_request_id: 'original-request', active_native_turn_id: null,
      cancel_requested: false, turn_state: 'uncertain', last_error: null, revision: 1,
      pending_interaction: null, last_result: null, created_at: now, updated_at: now,
      record: { origin: { kind: 'fresh' }, workingDirectory: '/fixture/project', runtimeDirectory: '/fixture/project',
        sessionCreation: { requestId: 'original-request' } } }
    const restore = vi.fn(async () => structuredClone(row))
    const repository = { open: async () => [structuredClone(row)], get: async () => structuredClone(row),
      restoreUnsettled: restore, unconfirmedSteers: async () => [], nextQueued: async () => undefined,
      markSessionUnavailable: async (_id: string, message: string) => { row.record.sessionUnavailable = message },
      abandon: async () => {},
    } as unknown as PostgresAgentChatRepository
    const native = new CodexAppServerSessionManager('/uncreated/codex')
    const initialize = vi.fn(async () => ({ manager: native }))
    const admitted = createAdmittedNativeManager('codex', initialize).manager
    const dispose = vi.spyOn(admitted, 'dispose')
    const managers = Object.assign(() => admitted, { release: vi.fn() })
    const pool = memorySessionControlPool()
    const workflows = { getAgentConfiguration: async () => configuration }
    const chat = new AgentChatService(pool as unknown as pg.Pool, repository, {} as never,
      workflows as never, {} as never, managers, row.record.workingDirectory)
    vi.useFakeTimers()
    try {
      // Preferences initialize the admitted wrapper before reconciliation in ordinary production recovery.
      if (state === 'initialized') await admitted.configureSessionPreferences?.(SessionPreferencesSchema.parse({}))
      await chat.recover()
      expect(row.record.sessionUnavailable).toEqual(expect.any(String))
      expect(row.native_session_id).toBeNull()
      expect(row.record.sessionCreation?.requestId).toBe('original-request')
      expect(managers.release).toHaveBeenCalledWith(row.id)
      expect(dispose).toHaveBeenCalledOnce()
      const reads = restore.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(restore).toHaveBeenCalledTimes(reads)
      expect(initialize).toHaveBeenCalledTimes(state === 'initialized' ? 1 : 0)
    } finally {
      await chat.shutdown()
      await native.dispose?.()
      vi.useRealTimers()
    }
  })
