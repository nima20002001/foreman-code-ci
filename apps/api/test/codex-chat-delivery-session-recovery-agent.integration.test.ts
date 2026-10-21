import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { until } from './fixtures/codex-test-helpers.js'
import { nativeNonSubmission } from '../src/modules/conversations/nativeNonSubmission.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  it('Agent recovery binds the original late session, settles its unsent prompt, and never creates again', async () => {
    const { native, repository, request, sendAgent, readAgent } = fixture
    await native.flag('late-thread-start')
    const admitted = await sendAgent(request('late', null))
    const id = admitted.state.conversation!.id
    await until(async () => (await repository.turn(id, 'late'))?.delivery === 'unknown' || undefined)
    assert.equal((await readAgent()).availability.canSend, false)
    const recovered = await until(async () => {
      await fixture.agentChat.recover()
      const row = await repository.get(id)
      return row?.native_session_id ? row : undefined
    })
    assert.equal(recovered.record.sessionCreation?.requestId, 'late')
    assert.equal((await repository.turn(id, 'late'))?.delivery, 'failed')
    assert.equal((await sendAgent(request('late', id))).replayed, true)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 0)
    await sendAgent(request('retry', id))
    await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
    assert.equal((await repository.get(id))!.native_session_id, recovered.native_session_id)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })

  it('Agent retains non-submission across restart when recovered creation settlement fails', async () => {
    const { database, native, repository, request, sendAgent, restartAgentService } = fixture
    await native.flag('late-thread-start')
    await database.pool.query(`create function fail_chat_settlement() returns trigger language plpgsql as $$
      begin
        if old.active_request_id='late' and new.active_request_id is null then
          raise exception 'Settlement persistence fault';
        end if;
        return new;
      end $$`)
    await database.pool.query(`create trigger fail_chat_settlement before update on operator_conversations
      for each row execute function fail_chat_settlement()`)
    const admitted = await sendAgent(request('late', null))
    const id = admitted.state.conversation!.id
    const bound = await until(async () => {
      await fixture.agentChat.recover()
      const row = await repository.get(id)
      return row?.native_session_id && nativeNonSubmission(row.record, 'late') ? row : undefined
    })
    assert.equal(bound.active_request_id, 'late')
    assert.equal(bound.record.nativeNonSubmission?.operation, 'turn_submission')
    assert.equal((await native.wire('turn/start')).length, 0)
    await fixture.agentChat.shutdown()
    restartAgentService()
    await database.pool.query('drop trigger fail_chat_settlement on operator_conversations')
    await until(async () => {
      await fixture.agentChat.recover()
      return (await repository.turn(id, 'late'))?.delivery === 'failed' || undefined
    })
    assert.equal((await native.wire('thread/read')).length, 0)
    assert.equal((await native.wire('thread/start')).length, 1)
    await native.unflag('late-thread-start')
    await sendAgent(request('retry', id))
    await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
    assert.equal((await repository.get(id))!.native_session_id, bound.native_session_id)
    assert.equal((await native.wire('thread/start')).length, 1)
    assert.equal((await native.wire('turn/start')).length, 1)
  })
})
