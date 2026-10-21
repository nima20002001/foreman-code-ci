import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import type { CodexChatFiles } from '../src/modules/harnesses/codexFiles/runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { until } from './fixtures/codex-test-helpers.js'
import { prepareCodexFileTurn } from '../src/modules/harnesses/codexFiles/index.js'
import { filePorts, fileScope, sourceRef } from './fixtures/codex-file-runtime-helpers.js'
import { nativeNonSubmission } from '../src/modules/conversations/nativeNonSubmission.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const kind of ['agent', 'operator'] as const) {
    it(`${kind} persists a late prompt rejection before failed cleanup and settles it after service restart`, async () => {
      const {
        database, native, repository, messages, resolver, authority, services, request, sendAgent,
        createOperator, sendOperator, readOperator, restartAgentService,
      } = fixture
      await native.flag('late-reject-turn-start')
      const ports = filePorts()
      let cleanupFails = true
      const files: CodexChatFiles = {
        prepare: async ({ session, signal }) => prepareCodexFileTurn({
          ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: session.nativeSessionId,
          admissionId: 'input-admission', executionHostId: 'execution-host-a', projectMode: 'read', allowMutation: false,
          allowedTools: ['files.list', 'files.read'], expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
        }, { ...ports.dependencies, files: ports.files, host: { ...ports.host, close: async () => {
          if (cleanupFails) throw new Error('Host closure is unconfirmed.')
          await ports.host.close()
        } } }, signal),
      }
      if (kind === 'agent') fixture.agentFiles = files
      else fixture.operatorFiles = files
      const id = kind === 'agent'
        ? (await sendAgent({ ...request('late', null), content: 'late-reject' })).state.conversation!.id
        : await createOperator()
      if (kind === 'operator') await sendOperator(id, 'late', 'late-reject')
      try {
        const rejected = await until(async () => {
          if (kind === 'agent') await fixture.agentChat.recover()
          else await fixture.operatorChat.reconcileActive()
          const row = kind === 'agent' ? await repository.get(id) : await messages.active(id)
          return row && nativeNonSubmission(row.record, 'late') || undefined
        })
        assert.equal(rejected.operation, 'turn_submission')
        assert.equal(rejected.result.error?.code, 'CODEX_TURN_START_REJECTED')
        const row = kind === 'agent' ? await repository.get(id) : await messages.active(id)
        assert.equal(row!.active_request_id, 'late')
        assert.equal(row!.active_native_turn_id, null)
        assert.equal((await native.wire('turn/start')).length, 1)
      } finally { cleanupFails = false }
      if (kind === 'agent') {
        await fixture.agentChat.shutdown()
        restartAgentService()
      } else {
        await fixture.operatorChat.shutdown()
        fixture.operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
          resolver, native.directory, authority)
        services.operatorChat = fixture.operatorChat
      }
      await until(async () => {
        if (kind === 'agent') {
          await fixture.agentChat.recover()
          return (await repository.turn(id, 'late'))?.delivery === 'failed' || undefined
        }
        await fixture.operatorChat.reconcileActive()
        return (await readOperator(id)).turnState === 'error' || undefined
      })
      assert(ports.events.includes('host:close'))
      assert.equal((await native.wire('turn/start')).length, 1)
      await native.unflag('late-reject-turn-start')
      if (kind === 'agent') {
        await sendAgent(request('retry', id))
        await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
      } else {
        await sendOperator(id, 'retry')
        await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
      }
      assert.equal((await native.wire('turn/start')).length, 2)
    })
  }
})
