import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { calls, until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery({ manualLateReplies: true })

  it('Agent idle-exit failure is retryable and resumes the stored session without another creation', async () => {
    const { native, repository, request, sendAgent, readAgent } = fixture
    const admitted = await sendAgent(request('first', null))
    const id = admitted.state.conversation!.id
    await until(async () => (await repository.turn(id, 'first'))?.delivery === 'completed' || undefined)
    const sessionId = (await repository.get(id))!.native_session_id
    await native.flag('idle-exit')
    await until(async () => (await calls(native.directory)).some((entry) => entry.exited) || undefined)
    await sendAgent(request('unsent', id))
    await until(async () => (await repository.turn(id, 'unsent'))?.delivery === 'failed' || undefined)
    assert.equal((await readAgent()).availability.canSend, true)
    assert.equal((await native.wire('turn/start')).length, 1)
    await native.unflag('idle-exit')
    await sendAgent(request('retry', id))
    await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
    assert.equal((await repository.get(id))!.native_session_id, sessionId)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 2)
  })

  it('a changed Agent creation marker refuses a late session binding and preserves the original prompt fence', async () => {
    const { database, native, repository, request, sendAgent } = fixture
    let creation: {
      manager: CodexAppServerSessionManager
      input: Parameters<CodexAppServerSessionManager['createSession']>[0]
    } | undefined
    const create = CodexAppServerSessionManager.prototype.createSession
    const observed = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession')
      .mockImplementation(function (this: CodexAppServerSessionManager, ...args) {
        creation = { manager: this, input: args[0] }
        return create.call(this, ...args)
      })
    try {
      await native.flag('late-thread-start')
      const admitted = await sendAgent(request('late', null))
      const id = admitted.state.conversation!.id
      await until(async () => (await repository.turn(id, 'late'))?.delivery === 'unknown' || undefined)
      await database.pool.query(`update operator_conversations set record=jsonb_set(record,'{sessionCreation,requestId}',to_jsonb($2::text)) where id=$1`,
        [id, 'another-owner'])
      assert(creation)
      const { manager, input } = creation
      await native.flag('release-late-creation')
      await until(async () => {
        try {
          return await manager.reconcileSessionCreation(input)
        } catch (error) {
          if (error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_SESSION_CREATION_UNCERTAIN') {
            return undefined
          }
          throw error
        }
      })
      await fixture.agentChat.recover()
      assert.equal((await repository.get(id))!.native_session_id, null)
      assert.equal((await repository.turn(id, 'late'))?.delivery, 'unknown')
      assert.equal((await native.wire('turn/start')).length, 0)
    } finally {
      observed.mockRestore()
    }
  })

  it('Agent creation binding rejects a different request, configuration, harness or prior turn', async () => {
    const { database, native, repository, request, sendAgent } = fixture
    await native.flag('late-thread-start')
    const admitted = await sendAgent(request('late', null))
    const id = admitted.state.conversation!.id
    await until(async () => (await repository.turn(id, 'late'))?.delivery === 'unknown' || undefined)
    const row = (await repository.get(id))!
    const session = { harness: 'codex' as const, providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'foreign-session' }
    for (const [requestId, configurationId, harness] of [
      ['another-request', row.agent_configuration_version_id, 'codex'],
      ['late', 'another-configuration', 'codex'],
      ['late', row.agent_configuration_version_id, 'claude'],
    ] as const) {
      await assert.rejects(repository.bindCreatedSession(id, requestId, configurationId, { ...session, harness },
        { outcome: 'failed', error: { code: 'FIXTURE_NATIVE_REJECTION', message: 'Native creation was rejected.', retryable: true } }),
        { code: 'AGENT_CHAT_SESSION_CONFLICT' })
      assert.deepEqual(await repository.get(id), row)
    }
    await database.pool.query('update operator_conversations set active_native_turn_id=$2 where id=$1', [id, 'prior-turn'])
    await assert.rejects(repository.bindCreatedSession(id, 'late', row.agent_configuration_version_id, session,
      { outcome: 'failed', error: { code: 'FIXTURE_NATIVE_REJECTION', message: 'Native creation was rejected.', retryable: true } }),
      { code: 'AGENT_CHAT_SESSION_CONFLICT' })
    assert.equal((await repository.get(id))!.native_session_id, null)
    assert.equal((await native.wire('turn/start')).length, 0)
  })
})
