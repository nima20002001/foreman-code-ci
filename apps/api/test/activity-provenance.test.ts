import { expect, it } from 'vitest'
import type pg from 'pg'
import { PostgresOperatorActivityRepository, type ActivityMutationFence } from '../src/modules/conversations/operatorActivityRepository.js'
import type { OperatorActivityChange } from '../src/modules/conversations/operatorActivity.js'

function fixture(initialSource: ActivityMutationFence['source'] = { connectionId: 'original', transportSequence: 2, nativeSequence: '7' }) {
  let record: OperatorActivityChange = { id: 'tool', requestId: 'request', kind: 'tool', title: 'Tool', status: 'running', output: 'transport' }
  let source = initialSource
  let revision = 0
  const client = { query: async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('select id,harness')) return { rows: [{ id: 'conversation', harness: 'codex' }], rowCount: 1 }
    if (sql.startsWith('select record,source_provenance')) return { rows: [{ record, source_provenance: source }], rowCount: 1 }
    if (sql.startsWith('insert into operator_conversation_activity')) {
      record = JSON.parse(values[3] as string); source = JSON.parse(values[4] as string); revision++
      return { rows: [{ record, sequence: '1', revision: String(revision) }], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversations')) return { rows: [{ revision: String(revision) }], rowCount: 1 }
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected SQL: ${sql}`)
  }, release() {} }
  const pool = { connect: async () => client } as unknown as pg.Pool
  const repository = new PostgresOperatorActivityRepository(pool)
  const append = (output: string, fence: ActivityMutationFence) => repository.append('conversation', 'request', { ...record, output }, fence)
  return { append, source: () => source, revision: () => revision }
}

it('history correction retains original private watermarks and rejects later stale transport', async () => {
  const f = fixture()
  expect(await f.append('history', { authoritativeReconciliation: true, source: { system: 'codex_history', connectionId: 'original' } })).toBeDefined()
  expect(f.source()).toMatchObject({ system: 'codex_history', connectionId: 'original', transportSequence: 2, nativeSequence: '7' })
  expect(await f.append('stale', { source: { connectionId: 'original', transportSequence: 1 } })).toBeUndefined()
  expect(f.revision()).toBe(1)
})

it('history without transport identity retains the original watermark', async () => {
  const f = fixture()
  expect(await f.append('history', { authoritativeReconciliation: true, source: { system: 'codex_history' } })).toBeDefined()
  expect(f.source()).toMatchObject({ connectionId: 'original', transportSequence: 2, nativeSequence: '7' })
})

it('a different connection never inherits the original transport watermark', async () => {
  const f = fixture()
  expect(await f.append('history', { authoritativeReconciliation: true, source: { connectionId: 'different', system: 'codex_history' } })).toBeDefined()
  expect(f.source()).toMatchObject({ connectionId: 'different' })
  expect(f.source()?.transportSequence).toBeUndefined()
})

it('history never fabricates a missing native or transport watermark', async () => {
  const f = fixture({})
  expect(await f.append('history', { authoritativeReconciliation: true, source: { system: 'codex_history' } })).toBeDefined()
  expect(f.source()?.connectionId).toBeUndefined()
  expect(f.source()?.nativeSequence).toBeUndefined()
  expect(f.source()?.transportSequence).toBeUndefined()
})

it('retained native watermarks still reject stale authoritative correction', async () => {
  const f = fixture()
  expect(await f.append('stale history', { authoritativeReconciliation: true, source: { nativeSequence: '6' } })).toBeUndefined()
  expect(f.revision()).toBe(0)
  expect(f.source()).toMatchObject({ nativeSequence: '7', transportSequence: 2 })
})
