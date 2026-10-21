import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

function fixture(overrides: Record<string, unknown> = {}) {
  const current = { id: 'conversation', requestId: 'A', sessionId: 'session', principalId: 'owner',
    nativeTurnId: 'native-A', receiptTurnId: 'native-A', phase: 'submitted', state: 'active',
    deleted: false, kind: 'operator', receiptPresent: true, cancelRequested: false, ...overrides }
  let mutations = 0
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    const [id, requestId, turnId, sessionId, principalId] = args
    const owned = id === current.id && requestId === current.requestId && sessionId === current.sessionId
      && principalId === current.principalId && !current.deleted && current.kind === 'operator' && current.receiptPresent
      && (current.nativeTurnId === null || current.nativeTurnId === turnId)
      && (current.receiptTurnId === null || current.receiptTurnId === turnId)
    if (!owned) return { rows: [], rowCount: 0 }
    const state = current.cancelRequested ? 'canceling' : 'active'
    const unchanged = current.nativeTurnId === turnId && current.receiptTurnId === turnId
      && current.phase === 'submitted' && current.state === state
    if (unchanged && !sql.includes('select id from existing')) return { rows: [], rowCount: 0 }
    if (!unchanged) {
      mutations++
      Object.assign(current, { nativeTurnId: turnId, receiptTurnId: turnId, phase: 'submitted', state })
    }
    return { rows: [{ id }], rowCount: 1 }
  })
  const repository = new PostgresOperatorConversationRepository({ query } as unknown as pg.Pool)
  return { repository, query, current, mutations: () => mutations }
}
const owner = { nativeSessionId: 'session', principalId: 'owner' }

it('accepts the exact retained ACK repeatedly without a revision or receipt mutation', async () => {
  const f = fixture()
  expect(await f.repository.submitted('conversation', 'A', 'native-A', owner)).toBe(true)
  expect(await f.repository.submitted('conversation', 'A', 'native-A', owner)).toBe(true)
  expect(f.mutations()).toBe(0)
  const [sql, args] = f.query.mock.calls[0]!
  expect(args).toEqual(['conversation', 'A', 'native-A', 'session', 'owner'])
  for (const fence of ['c.native_session_id=$4', 'c.owner_principal_id=$5', 'c.active_request_id=$2',
    "c.kind='operator'", 'c.deleted_at is null', 'for update', 't.native_turn_id=$3']) expect(sql).toContain(fence)
})

it('persists a first acknowledgement once before allowing identical observation', async () => {
  const f = fixture({ nativeTurnId: null, receiptTurnId: null, phase: 'submitting' })
  expect(await f.repository.submitted('conversation', 'A', 'native-A', owner)).toBe(true)
  expect(await f.repository.submitted('conversation', 'A', 'native-A', owner)).toBe(true)
  expect(f.mutations()).toBe(1)
})

it('accepts the exact repeated ACK without changing a pending cancellation', async () => {
  const f = fixture({ cancelRequested: true, state: 'canceling' })
  expect(await f.repository.submitted('conversation', 'A', 'native-A', owner)).toBe(true)
  expect(f.current.cancelRequested).toBe(true)
  expect(f.current.state).toBe('canceling')
  expect(f.mutations()).toBe(0)
})

for (const [name, changes] of Object.entries({
  'different conversation': { id: 'other' }, 'later request': { requestId: 'B' }, 'different session': { sessionId: 'replacement' },
  'different principal': { principalId: 'other' }, 'different native turn': { nativeTurnId: 'other-turn' },
  'conflicting receipt': { receiptTurnId: 'other-turn' }, 'settled owner': { requestId: null },
  'deleted owner': { deleted: true }, 'Agent conversation': { kind: 'agent' },
  'missing receipt': { receiptPresent: false },
})) it(`refuses an identical-looking ACK under a ${name}`, async () => {
  const f = fixture(changes)
  expect(await f.repository.submitted('conversation', 'A', 'native-A', owner)).toBe(false)
  expect(f.mutations()).toBe(0)
})
