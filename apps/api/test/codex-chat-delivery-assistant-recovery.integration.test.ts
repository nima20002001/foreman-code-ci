import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { agentMessage, emit, state, until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const kind of ['agent', 'operator'] as const) {
    it(`${kind} recovers every completed assistant item after startup persistence fails without resending`, async () => {
      const {
        database, native, repository, request, sendAgent, readAgent, createOperator, sendOperator,
        readOperator,
      } = fixture
      await native.flag('hold-turn-start-ack')
      await database.pool.query(`create function fail_native_turn_identity() returns trigger language plpgsql as $$
        begin
          if new.active_phase='submitted' and old.active_phase is distinct from 'submitted' then
            raise exception 'Native identity persistence fault';
          end if;
          return new;
        end $$`)
      await database.pool.query(`create trigger fail_native_turn_identity before update on operator_conversations
        for each row execute function fail_native_turn_identity()`)
      const id = kind === 'agent' ? (await sendAgent({ ...request('retained', null), content: 'wait' })).state.conversation!.id
        : await createOperator()
      if (kind === 'operator') await sendOperator(id, 'retained', 'wait')
      const nativeRequest = await until(async () => (await native.wire('turn/start'))[0])
      const sessionId = String((nativeRequest.params as { threadId: string }).threadId)
      const turn = await until(async () => (await state(native.directory, sessionId)).turns[0])
      const commentary = agentMessage('commentary', 'Before the final answer', 'commentary')
      const answer = agentMessage('answer', 'The final answer')
      const params = { threadId: sessionId, turnId: turn.id }
      await emit(native.directory, { method: 'item/started', params: {
        ...params, startedAtMs: 1, item: { ...commentary, text: '' },
      } })
      await emit(native.directory, { method: 'item/agentMessage/delta', params: {
        ...params, itemId: commentary.id, delta: commentary.text,
      } })
      await emit(native.directory, { method: 'item/completed', params: {
        ...params, completedAtMs: 2, item: commentary,
      } })
      await emit(native.directory, { id: nativeRequest.id, result: { turn } })
      await until(async () => kind === 'agent'
        ? (await repository.turn(id, 'retained'))?.delivery === 'unknown' || undefined
        : (await readOperator(id)).turnState === 'uncertain' || undefined)
      assert(Array.isArray(turn.items))
      await emit(native.directory, { method: 'turn/completed', params: { threadId: sessionId, turn: {
        ...turn, status: 'completed', completedAt: 3, items: [...turn.items, commentary, answer],
      } } })
      await until(async () => (await state(native.directory, sessionId)).turns[0]!.status === 'completed' || undefined)
      await database.pool.query('drop trigger fail_native_turn_identity on operator_conversations')
      await until(async () => {
        if (kind === 'agent') {
          await fixture.agentChat.recover()
          return (await repository.turn(id, 'retained'))?.delivery === 'completed' || undefined
        }
        await fixture.operatorChat.reconcileActive()
        return (await readOperator(id)).turnState === 'idle' || undefined
      })
      const readback = kind === 'agent' ? await readAgent() : await readOperator(id)
      assert.deepEqual(readback.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
        [commentary.text, answer.text])
      assert.equal((await native.wire('turn/start')).length, 1)
    })

  }
})
