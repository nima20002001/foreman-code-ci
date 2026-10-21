import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type pg from 'pg'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { CodexAppServerSessionManager, } from '../src/modules/harnesses/codexAppServer.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'

const session: NativeSessionReference = { harness: 'codex', providerVersion: RECORDED_CODEX_VERSION, nativeSessionId: 'thread' }
const identity = { expectedTurnId: 'target', clientCorrelationId: 'steer-correlation' }
function turn(items: unknown[], id = 'target', itemsView = 'full') { return { id, itemsView, status: 'completed', items } }
function user(clientId: string) { return { type: 'userMessage', id: `native-item-${clientId}`, clientId, content: [] } }

/** Executes the REAL adapter's evidence reader against a scripted RPC transport, never a binary/provider. */
function codex(pages: unknown[], threadId = session.nativeSessionId) {
  const manager = new CodexAppServerSessionManager('unused-fixture-binary', RECORDED_CODEX_VERSION)
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let index = 0
  const owner = { session, disposed: false, closed: false, phase: 'active', streamActive: true,
    activeTurnId: 'later', activeCorrelationId: 'later-correlation', pending: 'later-approval',
    cancellation: { turnId: 'later' }, events: [] as unknown[],
    transport: { request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'thread/read') return { thread: { id: threadId } }
      assert.equal(method, 'thread/turns/list', 'evidence discovery must never mutate native work')
      assert.equal(params.threadId, session.nativeSessionId)
      assert.equal(params.itemsView, 'full')
      assert.ok(index < pages.length, 'unexpected extra history read')
      return pages[index++]
    } } }
  const internal = manager as unknown as { runtimes: Map<string, typeof owner>; synchronize(): never }
  internal.runtimes.set(session.nativeSessionId, owner)
  internal.synchronize = () => { throw new Error('a steer lookup must not synchronize/retarget the active owner') }
  const unchanged = () => {
    assert.equal(owner.activeTurnId, 'later')
    assert.equal(owner.activeCorrelationId, 'later-correlation')
    assert.equal(owner.phase, 'active')
    assert.equal(owner.streamActive, true)
    assert.equal(owner.pending, 'later-approval')
    assert.deepEqual(owner.cancellation, { turnId: 'later' })
    assert.deepEqual(owner.events, [])
    assert.equal(owner.closed, false)
    assert.equal(owner.disposed, false)
  }
  return { manager, calls, unchanged }
}

describe('G1 exact steer evidence in the Codex adapter', () => {
  it('A2-PF-05 reads a batch across pages without replacing a later active owner', async () => {
    const f = codex([{ data: [turn([user('later-correlation')], 'later')], nextCursor: 'older' },
      { data: [turn([user('original-correlation'), user(identity.clientCorrelationId), user('second-steer')])], nextCursor: null }])
    const evidence = await f.manager.reconcileSteers(session, [identity, { ...identity, clientCorrelationId: 'second-steer' }])
    assert.deepEqual(evidence, [
      { nativeSessionId: 'thread', nativeTurnId: 'target', correlationId: identity.clientCorrelationId },
      { nativeSessionId: 'thread', nativeTurnId: 'target', correlationId: 'second-steer' },
    ])
    assert.equal(f.calls.length, 3)
    assert.equal(f.calls[2]!.params.cursor, 'older')
    f.unchanged()
  })

  for (const [name, candidate] of [
    ['terminal target without steer', turn([user('original-correlation')])],
    ['wrong target', turn([user(identity.clientCorrelationId)], 'different-turn')],
    ['partial items', turn([user(identity.clientCorrelationId)], 'target', 'summary')],
    ['assistant text with same id', turn([{ type: 'agentMessage', id: identity.clientCorrelationId, text: 'not an input receipt' }])],
  ] as const) {
    it(`A2-PF-05 does not invent acceptance from ${name}`, async () => {
      const f = codex([{ data: [candidate], nextCursor: null }])
      assert.deepEqual(await f.manager.reconcileSteers(session, [identity]), [])
      f.unchanged()
    })
  }

  it('A2-PF-05 rejects a different thread before interpreting its turns', async () => {
    const f = codex([], 'wrong-thread')
    await assert.rejects(f.manager.reconcileSteers(session, [identity]), /another thread/)
    assert.equal(f.calls.length, 1); f.unchanged()
  })

  it('A2-PF-05 rejects repeated cursors and ambiguous correlations without returning partial proof', async () => {
    const repeated = codex([{ data: [], nextCursor: 'same' }, { data: [], nextCursor: 'same' }])
    await assert.rejects(repeated.manager.reconcileSteers(session, [identity]), /repeated a history cursor/)
    repeated.unchanged()
    const ambiguous = codex([{ data: [turn([user(identity.clientCorrelationId)]), turn([user(identity.clientCorrelationId)], 'other')], nextCursor: null }])
    await assert.rejects(ambiguous.manager.reconcileSteers(session, [identity]), /More than one native turn/)
    ambiguous.unchanged()
  })

  it('A2-PF-05 honors an aborted receipt read without any RPC or replay', async () => {
    const f = codex([])
    await assert.rejects(f.manager.reconcileSteers(session, [identity], AbortSignal.abort(new Error('stopped'))), /stopped/)
    assert.deepEqual(f.calls, []); f.unchanged()
  })
})

/** SQL-boundary fixture: validates statements and transaction order. This is not a PostgreSQL execution. */
function unknownStorage(failActivity = false) {
  const calls: string[] = []
  const owner = { id: 'conversation', active_request_id: 'first' as string | null, active_native_turn_id: 'native-first' as string | null,
    cancel_requested: true, pending_interaction: { identity: 'pending-approval' } as object | null }
  let delivery = 'accepted'
  const activity = [
    { request: 'first', status: 'running', revision: 1 }, { request: 'first', status: 'pending', revision: 1 },
    { request: 'first', status: 'completed', revision: 2 }, { request: 'other', status: 'running', revision: 1 },
  ]
  const query = async (sql: string, values: unknown[] = []) => {
    const compact = sql.replace(/\s+/g, ' ').trim()
    calls.push(compact)
    const result = { rows: [] as unknown[], rowCount: 0 }
    if (['begin', 'commit', 'rollback'].includes(compact)) return result
    assert.equal(values[0], 'conversation')
    if (compact.startsWith('select id from operator_conversations') || compact.startsWith('select * from operator_conversations')) {
      assert.match(compact, /for update$/)
      return { rows: [structuredClone(owner)], rowCount: 1 }
    }
    assert.ok(calls.slice(0, -1).some((call) => /operator_conversations.*for update$/.test(call)), 'lock must precede receipt/activity mutations')
    if (compact.startsWith("update operator_conversation_turns set delivery='unknown'")) {
      assert.match(compact, /conversation_id=\$1 and request_id=\$2 and delivery in \('submitting','accepted'\)/)
      assert.equal(values[1], 'first')
      if (['submitting', 'accepted'].includes(delivery)) { delivery = 'unknown'; return { rows: [], rowCount: 1 } }
    } else if (compact.startsWith('update operator_conversation_activity') && compact.includes('exists')) {
      assert.equal(values[1], 'first')
      assert.match(compact, /where conversation_id=\$1 and request_id=\$2 and record->>'status' in \('pending','running'\)/)
      assert.match(compact, /t.conversation_id=\$1 and t.request_id=\$2 and t.delivery='unknown'/)
      assert.match(compact, /jsonb_set\(record,'\{status\}','"unknown"'::jsonb\)/)
      if (failActivity) throw new Error('activity write failed')
      if (delivery === 'unknown') for (const entry of activity) if (entry.request === 'first' && ['pending', 'running'].includes(entry.status)) {
        entry.status = 'unknown'; entry.revision++
      }
    } else if (compact.startsWith("update operator_conversations set turn_state='uncertain'")) {
      assert.match(compact, /where id=\$1 and active_request_id=\$2/)
      assert.doesNotMatch(compact, /cancel_requested=|pending_interaction=|active_request_id=null|active_native_turn_id=null/)
      return { rows: [], rowCount: owner.active_request_id === values[1] ? 1 : 0 }
    } else if (compact.startsWith('update operator_conversation_turns set delivery=$3,delivery_error=')) {
      assert.equal(values[1], 'first'); delivery = String(values[2]); return { rows: [], rowCount: 1 }
    } else if (compact.startsWith('update operator_conversation_turns set delivery=$3,updated_at=')) {
      assert.match(compact, /intent='steer'.*delivery='accepted'/)
    } else if (compact.startsWith('update operator_conversation_activity')) {
      assert.match(compact, /request_id=\$2 and record->>'status' in \('pending','running'\)/)
    } else if (compact.startsWith('update operator_conversations set active_request_id=null')) {
      owner.active_request_id = null; owner.active_native_turn_id = null; owner.cancel_requested = false; owner.pending_interaction = null
    } else if (compact.startsWith('update operator_conversations set revision=revision+1')) {
      // Non-active steer status changes also invalidate the public state revision.
    } else assert.fail(`unhandled SQL: ${compact}`)
    return result
  }
  const client = { query, release() { calls.push('release') } }
  const pool = { query, connect: async () => client } as unknown as pg.Pool
  return { repository: new PostgresAgentChatRepository(pool), calls, owner, activity, delivery: () => delivery,
    terminal: () => { delivery = 'canceled'; owner.active_request_id = null } }
}

describe('G1 repository evidence/uncertainty boundaries', () => {
  it('A-R07 settles unconfirmed public activity to unknown without releasing ownership, Stop or approval', async () => {
    const f = unknownStorage()
    await f.repository.abandon('conversation', 'first', 'delivery is unconfirmed')
    await f.repository.abandon('conversation', 'first', 'still unconfirmed')
    assert.equal(f.delivery(), 'unknown')
    assert.deepEqual(f.activity.map((entry) => [entry.status, entry.revision]), [['unknown', 2], ['unknown', 2], ['completed', 2], ['running', 1]])
    assert.equal(f.owner.active_request_id, 'first'); assert.equal(f.owner.active_native_turn_id, 'native-first')
    assert.equal(f.owner.cancel_requested, true); assert.deepEqual(f.owner.pending_interaction, { identity: 'pending-approval' })
    assert.equal(await f.repository.finish('conversation', 'first', { outcome: 'canceled' }), true)
    assert.equal(f.delivery(), 'canceled'); assert.equal(f.owner.active_request_id, null); assert.equal(f.owner.cancel_requested, false)
  })

  it('A-R07 cannot downgrade a terminal receipt/activity on a late uncertainty write', async () => {
    const f = unknownStorage(); f.terminal()
    const before = structuredClone(f.activity)
    await f.repository.unknown('conversation', 'first', 'late stream error')
    assert.equal(f.delivery(), 'canceled')
    assert.deepEqual(f.activity, before)
  })

  it('A2-PF-05 a provisional steer changing to unknown bumps readback without changing active ownership', async () => {
    const calls: string[] = []
    const query = async (sql: string) => {
      const compact = sql.replace(/\s+/g, ' ').trim(); calls.push(compact)
      if (compact.startsWith("update operator_conversation_turns set delivery='unknown'")) return { rows: [], rowCount: 1 }
      if (compact.startsWith("update operator_conversations set turn_state='uncertain'")) {
        assert.match(compact, /where id=\$1 and active_request_id=\$2/)
        return { rows: [], rowCount: 0 } // The steer is not the active request.
      }
      return { rows: [], rowCount: 0 }
    }
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
    await new PostgresAgentChatRepository(pool).unknown('conversation', 'steer', 'unconfirmed')
    assert.ok(calls.some((call) => call.startsWith('update operator_conversations set revision=revision+1')))
    assert.equal(calls.at(-1), 'commit')
  })

  it('A-R07 rolls back instead of committing half an uncertainty/activity transition', async () => {
    const f = unknownStorage(true)
    await assert.rejects(f.repository.unknown('conversation', 'first', 'uncertain'), /activity write failed/)
    assert.ok(f.calls.includes('rollback')); assert.ok(!f.calls.includes('commit'))
    assert.equal(f.calls.at(-1), 'release')
  })

  for (const delivery of ['completed', 'failed', 'canceled'] as const) {
    it(`A2-PF-05 positive recovered evidence uses the durable target's ${delivery} receipt atomically`, async () => {
      const calls: string[] = []
      const query = async (sql: string, values: unknown[] = []) => {
        const compact = sql.replace(/\s+/g, ' ').trim(); calls.push(compact)
        if (compact.startsWith('select delivery')) {
          assert.match(calls.at(-2)!, /operator_conversations.*for update$/)
          assert.deepEqual(values, ['conversation', 'native-first'])
          assert.match(compact, /conversation_id=\$1 and native_turn_id=\$2 and intent <> 'steer'/)
          return { rows: [{ delivery }], rowCount: 1 }
        }
        if (compact.startsWith('update operator_conversation_turns')) {
          assert.deepEqual(values, ['conversation', 'steer', 'native-first', delivery])
          assert.match(compact, /intent='steer' and target_native_turn_id=\$3 and delivery in \('submitting','unknown'\)/)
        }
        assert.doesNotMatch(compact, /set active_request_id|set active_native_turn_id/)
        return { rows: [], rowCount: 1 }
      }
      const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
      await new PostgresAgentChatRepository(pool).steerAccepted('conversation', 'steer', 'native-first')
      assert.equal(calls[0], 'begin'); assert.equal(calls.at(-1), 'commit')
    })
  }

  it('A2-PF-05 reads provisional/unknown steers and their same-conversation original target', async () => {
    const rows = [{ requestId: 'steer', targetNativeTurnId: 'native-first', targetRequestId: 'first', delivery: 'submitting' }]
    const pool = { query: async (sql: string, values: unknown[]) => {
      const compact = sql.replace(/\s+/g, ' ')
      assert.deepEqual(values, ['conversation'])
      assert.match(compact, /t.conversation_id=s.conversation_id/)
      assert.match(compact, /t.intent <> 'steer' and t.native_turn_id=s.target_native_turn_id/)
      assert.match(compact, /s.conversation_id=\$1 and s.intent='steer' and s.delivery in \('submitting','unknown'\)/)
      assert.doesNotMatch(compact, /update|insert|delete/)
      return { rows, rowCount: rows.length }
    } } as unknown as pg.Pool
    assert.deepEqual(await new PostgresAgentChatRepository(pool).unconfirmedSteers('conversation'), rows)
  })
})
