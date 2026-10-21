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

  for (const kind of ['agent', 'operator'] as Array<'agent' | 'operator'>) {
    for (const restart of [false, true]) {
      it(`${kind} settles a known unsent attachment after cleanup retry${restart ? ' across restart' : ''}`, async () => {
        const {
          database, native, repository, messages, resolver, authority, services, request, sendAgent, readAgent,
          createOperator, sendOperator, readOperator, restartAgentService,
        } = fixture
        const ports = filePorts()
        let cleanupFails = true
        let preparationFails = true
        let rechecks = 0
        let closureAttempts = 0
        const files: CodexChatFiles = {
          prepare: async ({ session, signal }) => prepareCodexFileTurn({
            ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: session.nativeSessionId,
            admissionId: 'input-admission', executionHostId: 'execution-host-a', projectMode: 'read', allowMutation: false,
            allowedTools: ['files.list', 'files.read'], expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
          }, { ...ports.dependencies, files: ports.files, source: {
            ...ports.dependencies.source, recheck: async () => {
              rechecks++
              if (preparationFails && rechecks === 2) throw new Error('Attachment disappeared before submission.')
              return ports.dependencies.source.recheck()
            },
          }, host: { ...ports.host, close: async () => {
            closureAttempts++
            if (cleanupFails) throw new Error('Host closure is unconfirmed.')
            await ports.host.close()
          } } }, signal),
        }
        if (kind === 'agent') fixture.agentFiles = files
        else fixture.operatorFiles = files
        const id = kind === 'agent' ? (await sendAgent(request('unsent', null))).state.conversation!.id
          : await createOperator()
        if (kind === 'operator') await sendOperator(id, 'unsent')
        try {
          await until(async () => {
            const row = kind === 'agent' ? await repository.get(id) : await messages.active(id)
            return closureAttempts >= 2 && row && nativeNonSubmission(row.record, 'unsent') || undefined
          })
          assert.equal((await native.wire('turn/start')).length, 0)
          if (kind === 'agent') assert.equal((await readAgent()).availability.canSend, false)
          else {
            assert.equal((await readOperator(id)).activeRequestId, 'unsent')
            const terminal = await messages.terminal(id, 'unsent')
            assert.equal(terminal?.observation.result.outcome, 'failed')
            assert.equal(terminal?.closureState, 'pending')
          }
        } finally { cleanupFails = false }
        if (restart) {
          if (kind === 'agent') {
            await fixture.agentChat.shutdown()
            restartAgentService()
          } else {
            await fixture.operatorChat.shutdown()
            fixture.operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
              resolver, native.directory, authority)
            services.operatorChat = fixture.operatorChat
          }
        }
        await until(async () => {
          if (kind === 'agent') {
            await fixture.agentChat.recover()
            return (await repository.turn(id, 'unsent'))?.delivery === 'failed' || undefined
          }
          await fixture.operatorChat.reconcileActive()
          return (await readOperator(id)).turnState === 'error' || undefined
        })
        assert(ports.events.includes('host:close'))
        assert(closureAttempts >= 3)
        assert.equal((await native.wire('turn/start')).length, 0)
        assert.equal((await native.wire('thread/read')).length, 0)
        preparationFails = false
        if (kind === 'agent') {
          await sendAgent(request('retry', id))
          await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
        } else {
          await sendOperator(id, 'retry')
          await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
        }
        assert.equal((await native.wire('thread/start')).length, 1)
        assert.equal((await native.wire('turn/start')).length, 1)
      })
    }
  }
})
